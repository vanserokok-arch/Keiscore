import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import sharp from "sharp";
import { AnchorModel } from "../anchors/anchorModel.js";
import { DynamicROIMapper } from "../anchors/dynamicRoiMapper.js";
import { DocumentDetector } from "../detection/documentDetector.js";
import { PerspectiveCalibrator } from "../detection/perspectiveCalibrator.js";
import { OcrEngineRouter } from "../engines/ocrRouter.js";
import { preprocessMrz, preprocessRoiForOcrWithConfig, RETRY_ROI_PADDING_RATIO } from "../engines/roiPreprocessor.js";
import { TesseractEngine } from "../engines/tesseractEngine.js";
import { FormatNormalizer } from "../format/formatNormalizer.js";
import { normalizePassportNumber, normalizeRussianText } from "../format/textNormalizer.js";
import { ScoringEngine } from "../scoring/scoringEngine.js";
import {
  assessFioSurnameQuality,
  parseMrzLatinFio,
  transliterateMrzLatinToCyrillic,
  validateDeptCode,
  validateFio,
  validateIssuedBy,
  validatePassportNumber,
  validateRegistration
} from "../validators/passportValidators.js";
import {
  ExtractionResultSchema,
  InMemoryAuditLogger,
  type AuditLogger,
  type AnchorResult,
  type CoreError,
  type ExtractOptions,
  type ExtractionResult,
  type FieldRoi,
  type InputFile,
  type OcrPassResult,
  type PassportField
} from "../types.js";

const BASE_RESULT: Omit<ExtractionResult, "field_reports" | "errors" | "confidence_score" | "diagnostics"> = {
  fio: null,
  passport_number: null,
  issued_by: null,
  dept_code: null,
  registration: null,
  quality_metrics: {
    blur_score: 0,
    contrast_score: 0,
    geometric_score: 0
  }
};

const FIELD_ORDER: PassportField[] = [
  "fio",
  "passport_number",
  "issued_by",
  "dept_code",
  "registration"
];

type BestCandidateSource = "roi" | "mrz" | "zonal_tsv" | "page";
const ISSUED_BY_MARKERS = [
  "МВД",
  "РОССИИ",
  "УФМС",
  "ОТДЕЛ",
  "ОТДЕЛОМ",
  "ОТДЕЛЕНИЕМ",
  "УПРАВЛ",
  "ГУ",
  "Г.",
  "ОБЛАСТИ",
  "РАЙОНУ",
  "ПО"
] as const;
const FIO_CYRILLIC_ALLOWED_REGEX = /^[А-ЯЁ\s-]+$/u;
const FIO_NOISE_BIGRAMS = ["ЧИ", "ИИ", "ШШ", "ЪЪ", "ЬЬ", "ЯО", "ЙО"] as const;
const FIO_LABEL_WORDS = ["ФАМИЛИЯ", "ИМЯ", "ОТЧЕСТВО", "ЕДИНАЯ", "РОЖДЕНИЯ", "ПОЛ"] as const;

export interface TsvWord {
  text: string;
  confidence: number;
  bbox: OcrPassResult["bbox"];
  blockNum: number;
  parNum: number;
  lineNum: number;
}

interface ValidatedAttempt {
  attempt: OcrPassResult;
  normalizedText: string;
}

interface ValidationOutcome {
  validated: ValidatedAttempt | null;
  reason: string;
}

interface InternalBestCandidate {
  source: BestCandidateSource;
  rawText: string;
  normalizedText: string;
  confidence: number;
  passId: "A" | "B" | "C";
  validatorPassed: boolean;
}

interface FieldDebugCandidate {
  raw_preview: string;
  normalized_preview: string;
  confidence: number;
  psm: number | null;
  source: BestCandidateSource;
  validator_passed: boolean;
  rejection_reason: string | null;
}

interface FieldDebugBlock {
  source_counts: Record<BestCandidateSource, number>;
  top_candidates: FieldDebugCandidate[];
}

function normalizeOptions(opts?: ExtractOptions): ExtractOptions & { logger: AuditLogger } {
  return {
    preferOnline: opts?.preferOnline ?? false,
    onlineTimeoutMs: opts?.onlineTimeoutMs ?? 3000,
    tesseractLang: opts?.tesseractLang ?? "rus",
    maxPages: opts?.maxPages ?? 1,
    maxInputBytes: opts?.maxInputBytes ?? 30 * 1024 * 1024,
    ocrTimeoutMs: opts?.ocrTimeoutMs ?? 30_000,
    pdfRenderTimeoutMs: opts?.pdfRenderTimeoutMs ?? 120_000,
    debugIncludePiiInLogs: opts?.debugIncludePiiInLogs ?? false,
    debugUnsafeIncludeRawText: opts?.debugUnsafeIncludeRawText ?? false,
    logger: opts?.logger ?? new InMemoryAuditLogger(),
    ...(opts?.pdfPageRange === undefined ? {} : { pdfPageRange: opts.pdfPageRange }),
    ...(opts?.allowedBasePath === undefined ? {} : { allowedBasePath: opts.allowedBasePath })
  };
}

function toCoreError(error: unknown): CoreError {
  if (
    typeof error === "object" &&
    error !== null &&
    "coreError" in error &&
    typeof (error as { coreError?: unknown }).coreError === "object"
  ) {
    return (error as { coreError: CoreError }).coreError;
  }
  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "Unknown extraction failure"
  };
}

function validateByField(field: PassportField, value: string): string | null {
  if (field === "fio") {
    return validateFio(value);
  }
  if (field === "passport_number") {
    return validatePassportNumber(value);
  }
  if (field === "issued_by") {
    return validateIssuedBy(value);
  }
  if (field === "dept_code") {
    return validateDeptCode(value);
  }
  return validateRegistration(value);
}

function appendFilteredErrors(target: CoreError[], incoming: CoreError[]): void {
  for (const item of incoming) {
    if (item.code === "PAGE_CLASSIFICATION_FAILED") {
      continue;
    }
    target.push(item);
  }
}

function emptyFieldReport(fieldRoi: FieldRoi, engine: "online" | "tesseract" | "none") {
  return {
    field: fieldRoi.field,
    roi: fieldRoi.roi,
    engine_used: engine,
    pass: false,
    pass_id: "A",
    confidence: 0,
    validator_passed: false,
    rejection_reason: "FIELD_NOT_CONFIRMED",
    anchor_alignment_score: 0
  } as const;
}

export class RfInternalPassportExtractor {
  static async extract(input: InputFile, opts?: ExtractOptions): Promise<ExtractionResult> {
    const options = await normalizeOptionsForRfPassport(input, normalizeOptions(opts));
    const logger = options.logger;
    const errors: CoreError[] = [];
    let normalizedForCleanup: Awaited<ReturnType<typeof FormatNormalizer.normalize>> | null = null;

    try {
      logger.log({
        ts: Date.now(),
        stage: "extractor",
        level: "info",
        message: "RF internal passport extraction started"
      });

      const normalized = await FormatNormalizer.normalize(input, options, logger);
      normalizedForCleanup = normalized;
      appendFilteredErrors(errors, normalized.warnings);
      const detection = await DocumentDetector.detect(normalized, logger);
      if (!detection.detected) {
        errors.push({
          code: "DOCUMENT_NOT_DETECTED",
          message: "RF internal passport was not detected in the input."
        });
      }

      const calibration = await PerspectiveCalibrator.calibrate(normalized, detection, logger);
      const anchors = await AnchorModel.findAnchors(
        normalized,
        detection,
        calibration,
        logger,
        options.debugUnsafeIncludeRawText === true
      );
      logger.log({
        ts: Date.now(),
        stage: "extractor",
        level: "info",
        message: "Post-anchor evidence",
        data: {
          pageType: anchors.pageType,
          anchorCount: Object.keys(anchors.anchors).length,
          usedFallbackGrid: anchors.usedFallbackGrid
        }
      });

      const shouldForceSpreadForMapping =
        anchors.pageType === "unknown" &&
        (anchors.anchors["ФАМИЛИЯ"] !== undefined ||
          anchors.anchors["КОД ПОДРАЗДЕЛЕНИЯ"] !== undefined ||
          /ПАСПОРТ|РОСС|<</u.test(anchors.central_window_text_preview ?? ""));
      const anchorsForMapping: AnchorResult = shouldForceSpreadForMapping
        ? {
            ...anchors,
            pageType: "spread_page"
          }
        : anchors;

      const rois = await DynamicROIMapper.map(normalized, detection, calibration, anchorsForMapping, logger);
      const roiCrops = await DynamicROIMapper.attachRoiImagePaths(normalized, rois, logger);
      const primaryRouterResult = await OcrEngineRouter.run(roiCrops, normalized, options, logger).finally(
        async () => {
          if (process.env.KEISCORE_DEBUG_ROI_DIR === undefined || process.env.KEISCORE_DEBUG_ROI_DIR.trim() === "") {
            await DynamicROIMapper.cleanupRoiImagePaths(roiCrops);
          }
        }
      );
      const mergedAttempts: OcrPassResult[] = [...primaryRouterResult.attempts];
      const mergedErrors: CoreError[] = [...primaryRouterResult.errors];
      let winningPass = "primary";

      if (allFieldsUnconfirmed(mergedAttempts)) {
        logger.log({
          ts: Date.now(),
          stage: "extractor",
          level: "warn",
          message: "Primary OCR failed for all fields. Starting numeric retry with expanded ROI.",
          data: {
            retryPaddingRatio: RETRY_ROI_PADDING_RATIO,
            fields: ["passport_number", "dept_code"]
          }
        });
        const numericExpandedRois = expandNumericRois(rois, normalized.width, normalized.height, 0.15);
        const retryRoiCrops = await DynamicROIMapper.attachRoiImagePaths(normalized, numericExpandedRois, logger);
        const retryRouterResult = await OcrEngineRouter.run(
          retryRoiCrops,
          normalized,
          {
            ...options,
            _numericOnly: true,
            _retryPaddingRatio: RETRY_ROI_PADDING_RATIO,
            _passLabel: "numeric-retry"
          },
          logger
        ).finally(async () => {
          if (process.env.KEISCORE_DEBUG_ROI_DIR === undefined || process.env.KEISCORE_DEBUG_ROI_DIR.trim() === "") {
            await DynamicROIMapper.cleanupRoiImagePaths(retryRoiCrops);
          }
        });
        mergedAttempts.push(...retryRouterResult.attempts);
        mergedErrors.push(...retryRouterResult.errors);
        winningPass = retryRouterResult.attempts.length > 0 ? "numeric-retry" : "primary";
      }
      appendFilteredErrors(errors, mergedErrors);
      const pageFallbackAttempts = await buildPageFallbackAttempts(normalized, rois, logger);
      if (pageFallbackAttempts.length > 0) {
        mergedAttempts.push(...pageFallbackAttempts);
      }
      const passportFallbackAttempts = await buildPassportNumberFallbackAttempts(normalized, logger);
      if (passportFallbackAttempts.length > 0) {
        mergedAttempts.push(...passportFallbackAttempts);
      }
      const fioFallbackAttempts = await buildFioFallbackAttempts(normalized, rois, logger);
      if (fioFallbackAttempts.length > 0) {
        mergedAttempts.push(...fioFallbackAttempts);
      }

      const bestCandidatesByField = new Map<PassportField, InternalBestCandidate>();
      const fieldDebugByField = new Map<PassportField, FieldDebugBlock>();
      const field_reports: ExtractionResult["field_reports"] = roiCrops.map((fieldRoi) => {
        const attempts = filterAttemptsByField(mergedAttempts, fieldRoi.field);
        if (
          options.debugUnsafeIncludeRawText === true &&
          (fieldRoi.field === "fio" || fieldRoi.field === "issued_by")
        ) {
          fieldDebugByField.set(fieldRoi.field, buildFieldDebugBlock(fieldRoi.field, attempts));
        }
        const fieldDebug =
          fieldRoi.field === "fio" || fieldRoi.field === "issued_by"
            ? fieldDebugByField.get(fieldRoi.field)
            : undefined;
        const validation = validateByPassOrderDetailed(fieldRoi.field, attempts);
        const validated = validation.validated;
        const bestCandidate = selectBestCandidate(fieldRoi.field, attempts, validation);
        if (bestCandidate !== null) {
          bestCandidatesByField.set(fieldRoi.field, bestCandidate);
        }
        const alignmentScore = computeAnchorAlignment(fieldRoi, anchors, calibration.geometricScore);
        if (validated === null) {
          errors.push({
            code: "FIELD_NOT_CONFIRMED",
            message: `No validated OCR candidate for field: ${fieldRoi.field}`
          });
          return {
            ...emptyFieldReport(fieldRoi, primaryRouterResult.engineUsed),
            anchor_alignment_score: alignmentScore,
            ...(fieldRoi.roiImagePath === undefined ? {} : { roiImagePath: fieldRoi.roiImagePath }),
            rejection_reason: validation.reason,
            ...(options.debugUnsafeIncludeRawText
              ? {
                  attempts: toAttemptPreviews(attempts),
                  best_candidate_preview: bestCandidatePreview(bestCandidate),
                  ...(bestCandidate === null
                    ? {}
                    : {
                        best_candidate_source: bestCandidate.source,
                        best_candidate_normalized: bestCandidate.normalizedText
                      }),
                  ...(fieldDebug === undefined
                    ? {}
                    : { debug_candidates: fieldDebug }
                  )
                }
              : {})
          };
        }

        return {
          field: fieldRoi.field,
          roi: fieldRoi.roi,
          engine_used: validated.attempt.engine_used,
          pass: true,
          pass_id: validated.attempt.pass_id,
          confidence: validated.attempt.confidence,
          validator_passed: true,
          rejection_reason: null,
          anchor_alignment_score: alignmentScore,
          ...(fieldRoi.roiImagePath === undefined ? {} : { roiImagePath: fieldRoi.roiImagePath }),
          ...(validated.attempt.postprocessed_roi_image_path === undefined
            ? {}
            : { postprocessed_roi_image_path: validated.attempt.postprocessed_roi_image_path }),
          ...(options.debugUnsafeIncludeRawText
            ? {
                attempts: toAttemptPreviews(attempts),
                best_candidate_preview: bestCandidatePreview(bestCandidate),
                ...(bestCandidate === null
                  ? {}
                  : {
                      best_candidate_source: bestCandidate.source,
                      best_candidate_normalized: bestCandidate.normalizedText
                    }),
                ...(fieldDebug === undefined
                  ? {}
                  : { debug_candidates: fieldDebug }
                )
              }
            : {})
        };
      });

      const resultValues: Pick<
        ExtractionResult,
        "fio" | "passport_number" | "issued_by" | "dept_code" | "registration"
      > = {
        fio: null,
        passport_number: null,
        issued_by: null,
        dept_code: null,
        registration: null
      };

      for (const field of FIELD_ORDER) {
        const bestCandidate = bestCandidatesByField.get(field);
        if (
          bestCandidate?.validatorPassed === true &&
          typeof bestCandidate.normalizedText === "string" &&
          bestCandidate.normalizedText.trim() !== ""
        ) {
          resultValues[field] = bestCandidate.normalizedText;
        }
      }
      const validatedFieldCount = FIELD_ORDER.reduce((count, field) => {
        return resultValues[field] !== null ? count + 1 : count;
      }, 0);
      if (validatedFieldCount >= 2 || Object.keys(anchors.anchors).length >= 3) {
        for (let i = errors.length - 1; i >= 0; i -= 1) {
          if (errors[i]?.code === "DOCUMENT_NOT_DETECTED") {
            errors.splice(i, 1);
          }
        }
      }
      if (
        anchors.pageType === "unknown" &&
        validatedFieldCount === 0 &&
        !errors.some((item) => item.code === "DOCUMENT_NOT_DETECTED")
      ) {
        errors.push({
          code: "DOCUMENT_NOT_DETECTED",
          message: "Document layout could not be confidently localized."
        });
      }
      logger.log({
        ts: Date.now(),
        stage: "extractor",
        level: "info",
        message: "OCR pass winner selected.",
        data: { winningPass }
      });

      const score = ScoringEngine.score(field_reports, {
        blur_score: normalized.quality_metrics.blur_score,
        contrast_score: normalized.quality_metrics.contrast_score,
        geometric_score: calibration.geometricScore
      });
      if (score.requireManualReview) {
        errors.push({
          code: "REQUIRE_MANUAL_REVIEW",
          message: "Overall confidence is below manual-review threshold.",
          details: { confidence_score: score.confidence_score }
        });
      }
      const result: ExtractionResult = {
        ...BASE_RESULT,
        ...resultValues,
        confidence_score: score.confidence_score,
        quality_metrics: score.quality_metrics,
        field_reports,
        errors
      };
      const diagnostics = buildDiagnostics(options.debugUnsafeIncludeRawText === true, anchors);
      if (normalized.preprocessing !== undefined) {
        result.diagnostics = {
          ...(result.diagnostics ?? {}),
          normalization: normalized.preprocessing
        };
      }
      if (diagnostics !== null) {
        result.diagnostics = {
          ...(result.diagnostics ?? {}),
          ...diagnostics
        };
      }
      if (options.debugUnsafeIncludeRawText === true) {
        const field_debug: NonNullable<NonNullable<ExtractionResult["diagnostics"]>["field_debug"]> = {};
        const fioDebug = fieldDebugByField.get("fio");
        const issuedByDebug = fieldDebugByField.get("issued_by");
        if (fioDebug !== undefined) {
          field_debug.fio = fioDebug;
        }
        if (issuedByDebug !== undefined) {
          field_debug.issued_by = issuedByDebug;
        }
        if (Object.keys(field_debug).length > 0) {
          result.diagnostics = {
            ...(result.diagnostics ?? {}),
            field_debug
          };
        }
      }

      const parsed = ExtractionResultSchema.parse(result);
      return parsed as ExtractionResult;
    } catch (error) {
      const coreError = toCoreError(error);
      if (coreError.code === "UNSUPPORTED_FORMAT") {
        const structured = new Error(coreError.message) as Error & { coreError: CoreError };
        structured.coreError = coreError;
        throw structured;
      }
      appendFilteredErrors(errors, [coreError]);

      const fallbackRois: FieldRoi[] = FIELD_ORDER.map((field, index) => ({
        field,
        roi: { x: 0, y: index * 10, width: 1, height: 1, page: 0 }
      }));

      const field_reports = fallbackRois.map((roi) => emptyFieldReport(roi, "none"));
      const score = ScoringEngine.score(field_reports);

      return {
        ...BASE_RESULT,
        confidence_score: score.confidence_score,
        quality_metrics: score.quality_metrics,
        field_reports,
        errors
      };
    } finally {
      if (normalizedForCleanup !== null) {
        await FormatNormalizer.cleanupPdfPageArtifacts(normalizedForCleanup);
      }
    }
  }
}

async function buildPassportNumberFallbackAttempts(
  normalized: Awaited<ReturnType<typeof FormatNormalizer.normalize>>,
  logger: AuditLogger
): Promise<OcrPassResult[]> {
  const imagePath = normalized.pages[0]?.imagePath;
  if (imagePath === null || imagePath === undefined) {
    return [];
  }
  const attempts: OcrPassResult[] = [];
  try {
    const mrzDigits = await extractPassportDigitsFromMrz(imagePath);
    if (mrzDigits !== null) {
      attempts.push({
        field: "passport_number",
        pass_id: "C",
        text: mrzDigits,
        confidence: 0.9,
        bbox: {
          x1: 0,
          y1: Math.round(normalized.height * 0.74),
          x2: normalized.width,
          y2: normalized.height
        },
        engine_used: "tesseract",
        psm: 6
      });
      logger.log({
        ts: Date.now(),
        stage: "extractor",
        level: "info",
        message: "Passport number recovered from MRZ fallback."
      });
      return attempts;
    }
  } catch (error) {
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "warn",
      message: "MRZ passport-number fallback failed.",
      data: { reason: error instanceof Error ? error.message : String(error) }
    });
  }

  try {
    const vertical = await extractPassportDigitsFromVerticalStrip(normalized, logger);
    if (vertical !== null) {
      attempts.push(vertical);
      logger.log({
        ts: Date.now(),
        stage: "extractor",
        level: "info",
        message: "Passport number recovered from vertical-strip fallback."
      });
    }
  } catch (error) {
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "warn",
      message: "Vertical-strip passport-number fallback failed.",
      data: { reason: error instanceof Error ? error.message : String(error) }
    });
  }
  return attempts;
}

async function buildFioFallbackAttempts(
  normalized: Awaited<ReturnType<typeof FormatNormalizer.normalize>>,
  rois: FieldRoi[],
  logger: AuditLogger
): Promise<OcrPassResult[]> {
  const mockPassC = normalized.mockLayout?.multiPass?.fio?.C;
  const mockFio = mockPassC?.text ?? normalized.mockLayout?.fields?.fio;
  if (typeof mockFio === "string" && mockFio.trim() !== "") {
    return [
      {
        field: "fio",
        pass_id: "C",
        text: mockFio,
        confidence: Math.max(0.3, Math.min(0.95, mockPassC?.confidence ?? 0.88)),
        bbox: {
          x1: Math.round(normalized.width * 0.05),
          y1: Math.round(normalized.height * 0.78),
          x2: Math.round(normalized.width * 0.95),
          y2: Math.round(normalized.height * 0.98)
        },
        engine_used: "tesseract",
        psm: 11,
        normalized_text: normalizeRussianText(mockFio),
        source: "mrz"
      }
    ];
  }
  if (normalized.mockLayout !== undefined) {
    return [];
  }
  if (normalized.normalizedBuffer === null && normalized.pages[0]?.imagePath === null) {
    return [];
  }
  let mrzAttempts: OcrPassResult[] = [];
  try {
    mrzAttempts = await extractFioFromMrz(normalized, logger);
  } catch (error) {
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "warn",
      message: "MRZ FIO fallback failed.",
      data: { reason: error instanceof Error ? error.message : String(error) }
    });
  }
  const mrzSurnames = extractMrzSurnames(mrzAttempts);
  const fioRoi = getFieldRoiRect(rois, "fio");
  try {
    const cyrillicAttempt = await extractFioFromTsvZones(normalized, logger, mrzSurnames, fioRoi);
    if (cyrillicAttempt === null) {
      return mrzAttempts;
    }
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "info",
      message: "FIO Cyrillic zonal attempt generated.",
      data: { mrzSurnameHints: mrzSurnames.length }
    });
    return [cyrillicAttempt, ...mrzAttempts];
  } catch (error) {
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "warn",
      message: "Cyrillic FIO zonal fallback failed.",
      data: { reason: error instanceof Error ? error.message : String(error) }
    });
    return mrzAttempts;
  }
}

async function normalizeOptionsForRfPassport(
  input: InputFile,
  options: ExtractOptions & { logger: AuditLogger }
): Promise<ExtractOptions & { logger: AuditLogger }> {
  if (options.pdfPageRange !== undefined || !isPdfInput(input)) {
    return options;
  }
  const estimatedPages = await estimatePdfPageCount(input);
  if (estimatedPages < 3) {
    return {
      ...options,
      pdfPageRange: { from: 1, to: Math.max(1, estimatedPages) }
    };
  }
  return {
    ...options,
    pdfPageRange: { from: 2, to: 3 }
  };
}

function isPdfInput(input: InputFile): boolean {
  if (input.kind === "path") {
    return extname(input.path).toLowerCase() === ".pdf";
  }
  return extname(input.filename).toLowerCase() === ".pdf";
}

async function estimatePdfPageCount(input: InputFile): Promise<number> {
  const buffer = input.kind === "path" ? await readFile(input.path) : input.data;
  const content = buffer.toString("latin1");
  const matches = content.match(/\/Type\s*\/Page\b/g);
  return Math.max(1, matches?.length ?? 1);
}

function filterAttemptsByField(
  attempts: OcrPassResult[],
  field: PassportField
): OcrPassResult[] {
  const passOrder: Record<"A" | "B" | "C", number> = { A: 0, B: 1, C: 2 };
  return attempts
    .filter((attempt) => attempt.field === field)
    .sort((left, right) => passOrder[left.pass_id] - passOrder[right.pass_id]);
}

function validateByPassOrder(
  field: PassportField,
  attempts: OcrPassResult[]
): ValidatedAttempt | null {
  return validateByPassOrderDetailed(field, attempts).validated;
}

function validateByPassOrderDetailed(
  field: PassportField,
  attempts: OcrPassResult[]
): ValidationOutcome {
  if (field === "fio") {
    const rankFioAttempts = (candidates: OcrPassResult[]) =>
      candidates
      .map((attempt) => {
        const validated = validateFio(attempt.text);
        if (validated === null || !isPlausibleFioCandidate(validated)) {
          return null;
        }
        return {
          attempt,
          normalizedText: validated,
          score: scoreValidatedFio(validated, attempt.confidence)
        };
      })
      .filter((item): item is { attempt: OcrPassResult; normalizedText: string; score: number } => item !== null)
      .sort((left, right) => right.score - left.score);

    const zonalOnly = attempts.filter((item) => resolveBestCandidateSource(item) === "zonal_tsv");
    const rankedZonalValidated = rankFioAttempts(zonalOnly);
    const validatedZonal =
      rankedZonalValidated.length > 0
        ? {
            attempt: rankedZonalValidated[0]!.attempt,
            normalizedText: rankedZonalValidated[0]!.normalizedText
          }
        : null;
    if (validatedZonal !== null) {
      return { validated: validatedZonal, reason: "VALIDATED" };
    }

    const rankedRoi = attempts.filter((item) => resolveBestCandidateSource(item) !== "mrz");
    const rankedValidated = rankFioAttempts(rankedRoi);
    const validatedNonMrz =
      rankedValidated.length > 0
        ? { attempt: rankedValidated[0]!.attempt, normalizedText: rankedValidated[0]!.normalizedText }
        : null;
    if (validatedNonMrz !== null) {
      return { validated: validatedNonMrz, reason: "VALIDATED" };
    }
    if (attempts.some((item) => resolveBestCandidateSource(item) === "mrz")) {
      return { validated: null, reason: "MRZ_ONLY_FIO_NOT_ALLOWED" };
    }
    return { validated: null, reason: "FIO_VALIDATION_FAILED" };
  }
  if (field === "issued_by") {
    const zonalOnly = attempts.filter((item) => resolveBestCandidateSource(item) === "zonal_tsv");
    if (zonalOnly.length === 0) {
      return { validated: null, reason: "NO_ZONAL_ISSUED_BY_CANDIDATES" };
    }
    const ranked = zonalOnly
      .map((attempt) => ({
        attempt,
        quality: assessIssuedByQuality(attempt.text)
      }))
      .sort((left, right) => right.quality.score - left.quality.score);
    const best = ranked[0];
    if (best !== undefined && best.quality.validated !== null) {
      return {
        validated: { attempt: best.attempt, normalizedText: best.quality.validated },
        reason: "VALIDATED"
      };
    }
    if (best !== undefined) {
      return { validated: null, reason: best.quality.rejectionReason };
    }
    return { validated: null, reason: "ZONAL_ISSUED_BY_VALIDATION_FAILED" };
  }
  const preferredOrder: Array<"A" | "B" | "C"> = ["A", "B", "C"];
  if (attempts.length === 0) {
    return { validated: null, reason: "NO_OCR_ATTEMPTS" };
  }
  for (const passId of preferredOrder) {
    const attemptsForPass = attempts
      .filter((item) => item.pass_id === passId)
      .sort((left, right) => right.confidence - left.confidence);
    if (attemptsForPass.length === 0) {
      continue;
    }
    for (const attempt of attemptsForPass) {
      const normalized = validateByField(field, attempt.text);
      if (normalized !== null) {
        return { validated: { attempt, normalizedText: normalized }, reason: "VALIDATED" };
      }
    }
  }
  const best = [...attempts].sort((left, right) => right.confidence - left.confidence)[0];
  return {
    validated: null,
    reason: best === undefined ? "NO_OCR_ATTEMPTS" : `VALIDATOR_REJECTED:${toPreview(best.text, 40)}`
  };
}

function pickBestValidatedCandidate(
  field: PassportField,
  attempts: OcrPassResult[],
  extraGuard?: (normalized: string, attempt: OcrPassResult) => boolean
): ValidatedAttempt | null {
  for (const attempt of attempts) {
    const normalized = validateByField(field, attempt.text);
    if (normalized === null) {
      continue;
    }
    if (extraGuard !== undefined && !extraGuard(normalized, attempt)) {
      continue;
    }
    return { attempt, normalizedText: normalized };
  }
  return null;
}

function isPlausibleFioCandidate(normalized: string): boolean {
  const [surname, name, patronymic] = normalized.split(" ");
  if (surname === undefined || name === undefined || patronymic === undefined || surname.length < 5) {
    return false;
  }
  if (!/^[А-ЯЁ-]+$/u.test(surname)) {
    return false;
  }
  const parts = [surname, name, patronymic];
  if (parts.some((part) => FIO_LABEL_WORDS.some((token) => part.includes(token)))) {
    return false;
  }
  if (/(СТВО|НИЯ)$/u.test(surname)) {
    return false;
  }
  if (/(.)\1{3,}/u.test(surname)) {
    return false;
  }
  if (/(ЧИИ|ИИИ|ННН|ШШШ|ЬЬЬ)/u.test(surname)) {
    return false;
  }
  return true;
}

function scoreValidatedFio(value: string, confidence: number): number {
  const [surname, , patronymic] = value.split(" ");
  if (surname === undefined || patronymic === undefined) {
    return -100;
  }
  const surnameQuality = assessFioSurnameQuality(surname);
  const compact = value.replace(/\s+/gu, "");
  const letters = (compact.match(/[А-ЯЁ]/gu) ?? []).length;
  const letterRatio = letters / Math.max(1, compact.length);
  const noisePenalty = FIO_NOISE_BIGRAMS.reduce(
    (sum, bigram) => sum + (value.match(new RegExp(bigram, "gu"))?.length ?? 0),
    0
  );
  let score = confidence * 50 + letterRatio * 40 + surname.length * 1.8;
  if (surnameQuality.ok) {
    score += 12;
  } else {
    score -= 20;
  }
  if (/(ВИЧ|ВНА|ИЧ|ЫЧ)$/u.test(patronymic)) {
    score += 4;
  }
  score -= noisePenalty * 6;
  return score;
}

function countIssuedByMarkers(value: string): number {
  return ISSUED_BY_MARKERS.reduce((count, marker) => count + (value.includes(marker) ? 1 : 0), 0);
}

function assessIssuedByQuality(value: string): {
  validated: string | null;
  rejectionReason: string;
  score: number;
  markersCount: number;
} {
  const normalized = normalizeIssuedByChunk(value);
  if (normalized === "") {
    return { validated: null, rejectionReason: "ISSUED_BY_EMPTY", score: -100, markersCount: 0 };
  }
  if (/[<‹«]/u.test(normalized) || normalized.includes("<<<")) {
    return { validated: null, rejectionReason: "ISSUED_BY_MRZ_MARKER", score: -100, markersCount: 0 };
  }
  const charsNoSpace = normalized.replace(/\s+/gu, "");
  const digits = (charsNoSpace.match(/\d/gu) ?? []).length;
  const letters = (charsNoSpace.match(/[А-ЯЁ]/gu) ?? []).length;
  const digitRatio = digits / Math.max(1, charsNoSpace.length);
  if (digitRatio > 0.05) {
    return { validated: null, rejectionReason: "ISSUED_BY_DIGIT_RATIO_TOO_HIGH", score: -50, markersCount: 0 };
  }
  if (/\d{6,}/u.test(normalized)) {
    return { validated: null, rejectionReason: "ISSUED_BY_LONG_DIGITS", score: -50, markersCount: 0 };
  }
  if (normalized.length < 20 || normalized.length > 140) {
    return { validated: null, rejectionReason: "ISSUED_BY_LENGTH_OUT_OF_RANGE", score: -30, markersCount: 0 };
  }
  const markersCount = countIssuedByMarkers(normalized);
  const validatedByStrictValidator = validateIssuedBy(normalized);
  const words = normalized.split(" ").filter((part) => part.length > 0);
  const structuralWords = words.filter((part) => /[А-ЯЁ]{2,}/u.test(part)).length;
  const shortWordCount = words.filter((part) => part.length <= 2).length;
  const longWordCount = words.filter((part) => part.length >= 4).length;
  const shortWordRatio = shortWordCount / Math.max(1, words.length);
  const hasAuthorityHint = /(ОБЛАСТ|РАЙОН|ГОРОД|РЕСПУБЛ|КРАЙ|ОКРУГ)/u.test(normalized);
  const hasShortWordNoise = /(?:\b[А-ЯЁ]{1,2}\b\s*){4,}/u.test(normalized);
  const validated =
    validatedByStrictValidator ??
    (structuralWords >= 3 &&
    letters >= 12 &&
    longWordCount >= 2 &&
    shortWordRatio <= 0.55 &&
    !hasShortWordNoise &&
    (markersCount > 0 || hasAuthorityHint)
      ? normalized
      : null);
  if (validated === null) {
    return { validated: null, rejectionReason: "ISSUED_BY_STRUCTURE_REJECTED", score: -15, markersCount };
  }
  const letterRatio = letters / Math.max(1, charsNoSpace.length);
  const digitPenalty = digitRatio * 200;
  const markerBonus = markersCount * 10;
  const noMarkerPenalty = markersCount === 0 ? 6 : 0;
  const score = markerBonus + letterRatio * 70 - digitPenalty + Math.min(12, validated.length / 16) - noMarkerPenalty;
  return { validated, rejectionReason: "VALIDATED", score, markersCount };
}

function extractFioSurname(value: string): string {
  return value.split(" ")[0] ?? "";
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }
  const dp = Array.from({ length: right.length + 1 }, (_, idx) => idx);
  for (let i = 1; i <= left.length; i += 1) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = dp[j] ?? 0;
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prev + cost);
      prev = current;
    }
  }
  return dp[right.length] ?? Math.max(left.length, right.length);
}

function allFieldsUnconfirmed(attempts: OcrPassResult[]): boolean {
  return FIELD_ORDER.every((field) => validateByPassOrder(field, filterAttemptsByField(attempts, field)) === null);
}

function expandNumericRois(
  rois: FieldRoi[],
  maxWidth: number,
  maxHeight: number,
  ratio: number
): FieldRoi[] {
  return rois
    .filter((roi) => roi.field === "passport_number" || roi.field === "dept_code")
    .map((roi) => ({
      ...roi,
      roi: expandRoi(roi.roi, maxWidth, maxHeight, ratio)
    }));
}

function expandRoi(
  roi: FieldRoi["roi"],
  maxWidth: number,
  maxHeight: number,
  ratio: number
): FieldRoi["roi"] {
  const deltaX = Math.round(roi.width * ratio);
  const deltaY = Math.round(roi.height * ratio);
  const left = clamp(roi.x - deltaX, 0, Math.max(0, maxWidth - 1));
  const top = clamp(roi.y - deltaY, 0, Math.max(0, maxHeight - 1));
  const right = clamp(roi.x + roi.width + deltaX, left + 1, Math.max(left + 1, maxWidth));
  const bottom = clamp(roi.y + roi.height + deltaY, top + 1, Math.max(top + 1, maxHeight));
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    page: roi.page
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function getFieldRoiRect(rois: FieldRoi[], field: PassportField): FieldRoi["roi"] | null {
  return rois.find((roi) => roi.field === field)?.roi ?? null;
}

function computeAnchorAlignment(
  fieldRoi: FieldRoi,
  anchors: AnchorResult,
  geometricScore: number
): number {
  const anchorMap: Partial<Record<PassportField, string>> = {
    fio: "ФАМИЛИЯ",
    passport_number: "КОД ПОДРАЗДЕЛЕНИЯ",
    issued_by: "ВЫДАН",
    dept_code: "КОД ПОДРАЗДЕЛЕНИЯ",
    registration: "МЕСТО ЖИТЕЛЬСТВА"
  };
  const anchorName = anchorMap[fieldRoi.field];
  if (anchorName === undefined) {
    return 0.5;
  }
  const point = anchors.anchors[anchorName];
  if (point === undefined) {
    return 0.4;
  }

  const x2 = fieldRoi.roi.x + fieldRoi.roi.width;
  const y2 = fieldRoi.roi.y + fieldRoi.roi.height;
  const inside =
    point.x >= fieldRoi.roi.x && point.x <= x2 && point.y >= fieldRoi.roi.y && point.y <= y2;
  if (inside) {
    return Math.max(0.8, geometricScore);
  }
  return Math.max(0.45, geometricScore * 0.8);
}

function toAttemptPreviews(attempts: OcrPassResult[]): NonNullable<ExtractionResult["field_reports"][number]["attempts"]> {
  return attempts.map((attempt) => ({
    source: resolveBestCandidateSource(attempt),
    pass_id: attempt.pass_id,
    raw_text_preview: toPreview(attempt.raw_text ?? attempt.text, 200),
    normalized_preview: toPreview(toInternalNormalizedText(attempt.field, attempt), 200),
    ...(Number.isFinite(attempt.confidence) ? { confidence: attempt.confidence } : {}),
    ...(attempt.psm !== undefined ? { psm: attempt.psm } : {})
  }));
}

function evaluateAttemptDebug(field: PassportField, attempt: OcrPassResult): {
  normalized: string;
  validatorPassed: boolean;
  rejectionReason: string | null;
} {
  const normalized = toInternalNormalizedText(field, attempt);
  if (field === "fio") {
    const validated = validateFio(attempt.text);
    if (validated === null) {
      return { normalized, validatorPassed: false, rejectionReason: "FIO_VALIDATOR_REJECTED" };
    }
    if (!isPlausibleFioCandidate(validated)) {
      return { normalized: validated, validatorPassed: false, rejectionReason: "FIO_LOW_QUALITY_SURNAME" };
    }
    return { normalized: validated, validatorPassed: true, rejectionReason: null };
  }
  if (field === "issued_by") {
    const quality = assessIssuedByQuality(attempt.text);
    return {
      normalized: quality.validated ?? normalized,
      validatorPassed: quality.validated !== null,
      rejectionReason: quality.validated === null ? quality.rejectionReason : null
    };
  }
  const validated = validateByField(field, attempt.text);
  return {
    normalized: validated ?? normalized,
    validatorPassed: validated !== null,
    rejectionReason: validated === null ? "VALIDATOR_REJECTED" : null
  };
}

function buildFieldDebugBlock(field: PassportField, attempts: OcrPassResult[]): FieldDebugBlock {
  const source_counts: Record<BestCandidateSource, number> = {
    roi: 0,
    mrz: 0,
    zonal_tsv: 0,
    page: 0
  };
  for (const attempt of attempts) {
    source_counts[resolveBestCandidateSource(attempt)] += 1;
  }
  const top_candidates: FieldDebugCandidate[] = [...attempts]
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 3)
    .map((attempt) => {
      const evaluation = evaluateAttemptDebug(field, attempt);
      return {
        raw_preview: toPreview(attempt.raw_text ?? attempt.text ?? "", 90),
        normalized_preview: toPreview(evaluation.normalized, 90),
        confidence: Number((attempt.confidence ?? 0).toFixed(4)),
        psm: attempt.psm ?? null,
        source: resolveBestCandidateSource(attempt),
        validator_passed: evaluation.validatorPassed,
        rejection_reason: evaluation.rejectionReason
      };
    });
  return { source_counts, top_candidates };
}

function selectBestCandidate(
  field: PassportField,
  attempts: OcrPassResult[],
  validation: ValidationOutcome
): InternalBestCandidate | null {
  if (attempts.length === 0) {
    return null;
  }
  const chosenAttempt =
    validation.validated?.attempt ??
    [...preferredAttemptsForField(field, attempts)].sort((left, right) => right.confidence - left.confidence)[0] ??
    [...attempts].sort((left, right) => right.confidence - left.confidence)[0];
  if (chosenAttempt === undefined) {
    return null;
  }
  const rawText = (chosenAttempt.raw_text ?? chosenAttempt.text ?? "").trim();
  const normalizedText = (
    validation.validated?.normalizedText ?? toInternalNormalizedText(field, chosenAttempt)
  ).trim();
  return {
    source: resolveBestCandidateSource(chosenAttempt),
    rawText,
    normalizedText,
    confidence: chosenAttempt.confidence,
    passId: chosenAttempt.pass_id,
    validatorPassed: validation.validated !== null
  };
}

function preferredAttemptsForField(field: PassportField, attempts: OcrPassResult[]): OcrPassResult[] {
  if (field === "fio") {
    return attempts.filter((item) => resolveBestCandidateSource(item) !== "mrz");
  }
  if (field === "issued_by") {
    return attempts.filter((item) => resolveBestCandidateSource(item) === "zonal_tsv");
  }
  return attempts;
}

function resolveBestCandidateSource(attempt: OcrPassResult): BestCandidateSource {
  if (attempt.source !== undefined) {
    return attempt.source;
  }
  if (attempt.pass_id === "C") {
    return "page";
  }
  return "roi";
}

function toInternalNormalizedText(field: PassportField, attempt: OcrPassResult): string {
  const value = (attempt.text ?? "").trim();
  const rawValue = (attempt.raw_text ?? attempt.text ?? "").trim();
  const validated = validateByField(field, value);
  if (validated !== null) {
    return validated;
  }
  if (typeof attempt.normalized_text === "string") {
    const normalizedFromAttempt = attempt.normalized_text.trim();
    if (normalizedFromAttempt !== "" && !isInternalLabelPlaceholder(normalizedFromAttempt)) {
      return normalizedFromAttempt;
    }
  }
  if (field === "passport_number") {
    return normalizePassportNumber(rawValue);
  }
  return normalizeRussianText(rawValue);
}

function isInternalLabelPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "mrz_roi_fio" || normalized === "zonal_tsv_issued_by") {
    return true;
  }
  return /^(mrz|zonal_tsv|roi|page)_[a-z0-9_]+$/u.test(normalized);
}

function bestCandidatePreview(bestCandidate: InternalBestCandidate | null): string {
  if (bestCandidate === null) {
    return "";
  }
  const previewSourceText =
    bestCandidate.normalizedText.trim() === "" ? bestCandidate.rawText : bestCandidate.normalizedText;
  return toPreview(previewSourceText, 120);
}

function toPreview(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}...`;
}

async function buildPageFallbackAttempts(
  normalized: Awaited<ReturnType<typeof FormatNormalizer.normalize>>,
  rois: FieldRoi[],
  logger: AuditLogger
): Promise<OcrPassResult[]> {
  const mockIssuedBy = normalized.mockLayout?.fields?.issued_by;
  if (typeof mockIssuedBy === "string" && mockIssuedBy.trim() !== "") {
    return [
      {
        field: "issued_by",
        pass_id: "C",
        text: mockIssuedBy,
        confidence: 0.88,
        bbox: {
          x1: Math.round(normalized.width * 0.45),
          y1: Math.round(normalized.height * 0.3),
          x2: Math.round(normalized.width * 0.97),
          y2: Math.round(normalized.height * 0.62)
        },
        engine_used: "tesseract",
        psm: 6,
        normalized_text: normalizeRussianText(mockIssuedBy),
        source: "zonal_tsv"
      }
    ];
  }
  if (normalized.mockLayout !== undefined) {
    return [];
  }
  const imagePath = normalized.pages[0]?.imagePath;
  if (imagePath === null || imagePath === undefined) {
    return [];
  }
  try {
    const { stdout } = await execa("tesseract", [imagePath, "stdout", "-l", "rus", "--psm", "6", "tsv"], {
      timeout: 12_000
    });
    const rows = parsePageTsvRows(stdout);
    const deptToken = rows.find((row) => /\d{3}[-—]\d{3}/u.test(row.text));
    const passportToken = rows.find((row) => /\d{10}/u.test(row.text.replace(/[^\d]/gu, "")));
    const issuedByAttempt = await extractIssuedByFromTsvZones(normalized, logger, getFieldRoiRect(rois, "issued_by"));
    const attempts: OcrPassResult[] = [];
    if (deptToken !== undefined) {
      attempts.push({
        field: "dept_code",
        pass_id: "C",
        text: deptToken.text.replace("—", "-"),
        confidence: Math.max(0.3, Math.min(0.75, deptToken.confidence / 100)),
        bbox: deptToken.bbox,
        engine_used: "tesseract",
        psm: 6
      });
    } else {
      const fallbackText = await execa("tesseract", [imagePath, "stdout", "-l", "rus+eng", "--psm", "11"], {
        timeout: 12_000
      }).then((result) => result.stdout ?? "");
      const fallbackDept = fallbackText.match(/\b\d{3}\s*[-—]\s*\d{3}\b/u)?.[0]?.replace(/[—\s]/gu, "-");
      if (fallbackDept !== undefined) {
        attempts.push({
          field: "dept_code",
          pass_id: "C",
          text: fallbackDept,
          confidence: 0.55,
          bbox: { x1: 0, y1: 0, x2: normalized.width, y2: normalized.height },
          engine_used: "tesseract",
          psm: 6
        });
      }
    }
    if (passportToken !== undefined) {
      attempts.push({
        field: "passport_number",
        pass_id: "C",
        text: passportToken.text,
        confidence: Math.max(0.25, Math.min(0.7, passportToken.confidence / 100)),
        bbox: passportToken.bbox,
        engine_used: "tesseract",
        psm: 6
      });
    }
    if (issuedByAttempt !== null) {
      attempts.push({
        field: "issued_by",
        pass_id: "C",
        text: issuedByAttempt.text,
        confidence: issuedByAttempt.confidence,
        bbox: issuedByAttempt.bbox,
        engine_used: "tesseract",
        psm: 6,
        normalized_text: normalizeRussianText(issuedByAttempt.text),
        source: "zonal_tsv"
      });
    }
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "info",
      message: "Page-level OCR fallback attempts generated.",
      data: { count: attempts.length }
    });
    return attempts;
  } catch (error) {
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "warn",
      message: "Page-level OCR fallback failed.",
      data: { reason: error instanceof Error ? error.message : String(error) }
    });
    return [];
  }
}

function parsePageTsvRows(
  tsv: string,
  offset: { x: number; y: number } = { x: 0, y: 0 }
): Array<{ text: string; confidence: number; bbox: OcrPassResult["bbox"] }> {
  const words = parsePageTsvWords(tsv, offset);
  return words
    .map((word) => ({
      text: word.text,
      confidence: word.confidence,
      bbox: word.bbox
    }))
    .sort((a, b) => (a.bbox.y1 === b.bbox.y1 ? a.bbox.x1 - b.bbox.x1 : a.bbox.y1 - b.bbox.y1));
}

function parsePageTsvWords(tsv: string, offset: { x: number; y: number } = { x: 0, y: 0 }): TsvWord[] {
  const rows = tsv.split(/\r?\n/u);
  const out: TsvWord[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cols = (rows[i] ?? "").split("\t");
    if (cols.length < 12 || cols[0] !== "5") {
      continue;
    }
    const text = (cols[11] ?? "").trim();
    if (text === "") {
      continue;
    }
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const width = Number(cols[8]);
    const height = Number(cols[9]);
    const confidence = Number(cols[10]);
    const blockNum = Number(cols[2]);
    const parNum = Number(cols[3]);
    const lineNum = Number(cols[4]);
    if (![left, top, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
      continue;
    }
    out.push({
      text,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      blockNum: Number.isFinite(blockNum) ? blockNum : 0,
      parNum: Number.isFinite(parNum) ? parNum : 0,
      lineNum: Number.isFinite(lineNum) ? lineNum : 0,
      bbox: {
        x1: left + offset.x,
        y1: top + offset.y,
        x2: left + width + offset.x,
        y2: top + height + offset.y
      }
    });
  }
  return out.sort((a, b) => (a.bbox.y1 === b.bbox.y1 ? a.bbox.x1 - b.bbox.x1 : a.bbox.y1 - b.bbox.y1));
}

function buildTextLinesFromTsvWords(
  words: TsvWord[]
): Array<{ text: string; confidence: number; bbox: OcrPassResult["bbox"] }> {
  const sorted = [...words].sort((a, b) => (a.bbox.y1 === b.bbox.y1 ? a.bbox.x1 - b.bbox.x1 : a.bbox.y1 - b.bbox.y1));
  const grouped = new Map<string, TsvWord[]>();
  const lineBuckets: Array<{ centerY: number; key: string }> = [];
  const avgHeight =
    sorted.length === 0
      ? 0
      : sorted.reduce((sum, word) => sum + Math.max(1, word.bbox.y2 - word.bbox.y1), 0) / sorted.length;
  const tolerance = Math.max(8, Math.round(avgHeight * 0.75));
  let bucketSeq = 0;
  for (const word of sorted) {
    const centerY = Math.round((word.bbox.y1 + word.bbox.y2) / 2);
    const nearestBucket = lineBuckets
      .map((bucket) => ({ bucket, delta: Math.abs(bucket.centerY - centerY) }))
      .sort((left, right) => left.delta - right.delta)[0];
    const key =
      nearestBucket !== undefined && nearestBucket.delta <= tolerance
        ? nearestBucket.bucket.key
        : `ybucket:${bucketSeq++}:${word.blockNum}:${word.parNum}:${word.lineNum}`;
    if (nearestBucket === undefined || nearestBucket.delta > tolerance) {
      lineBuckets.push({ centerY, key });
    } else {
      const bucket = lineBuckets.find((item) => item.key === key);
      if (bucket !== undefined) {
        bucket.centerY = Math.round((bucket.centerY + centerY) / 2);
      }
    }
    const current = grouped.get(key) ?? [];
    current.push(word);
    grouped.set(key, current);
  }
  const lines: Array<{ text: string; confidence: number; bbox: OcrPassResult["bbox"] }> = [];
  for (const lineWords of grouped.values()) {
    const sorted = [...lineWords].sort((a, b) => a.bbox.x1 - b.bbox.x1);
    const text = sorted.map((word) => word.text).join(" ").replace(/\s+/gu, " ").trim();
    if (text === "") {
      continue;
    }
    const confidence = sorted.reduce((max, word) => Math.max(max, word.confidence), 0);
    const bbox = sorted.reduce(
      (acc, word) => ({
        x1: Math.min(acc.x1, word.bbox.x1),
        y1: Math.min(acc.y1, word.bbox.y1),
        x2: Math.max(acc.x2, word.bbox.x2),
        y2: Math.max(acc.y2, word.bbox.y2)
      }),
      { ...sorted[0]!.bbox }
    );
    lines.push({ text, confidence, bbox });
  }
  return lines.sort((a, b) => (a.bbox.y1 === b.bbox.y1 ? a.bbox.x1 - b.bbox.x1 : a.bbox.y1 - b.bbox.y1));
}

export function selectBestFioFromCyrillicLines(lines: string[], mrzSurnames: string[] = []): string | null {
  let best: { text: string; score: number } | null = null;
  for (const line of lines) {
    const normalizedLine = normalizeRussianText(line).replace(/\s+/gu, " ").trim();
    if (normalizedLine === "") {
      continue;
    }
    const words = normalizedLine.split(" ").filter((item) => item.length > 0);
    for (let start = 0; start <= words.length - 3; start += 1) {
      const windowWords = words.slice(start, start + 3);
      const normalized = windowWords.join(" ").trim();
      if (!FIO_CYRILLIC_ALLOWED_REGEX.test(normalized)) {
        continue;
      }
      const validated = validateFio(normalized);
      if (validated === null) {
        continue;
      }
      const [surname, name, patronymic] = validated.split(" ");
      if (surname === undefined || name === undefined || patronymic === undefined) {
        continue;
      }
      if (surname.length < 5 || name.length < 2 || patronymic.length < 2) {
        continue;
      }
      const compact = validated.replace(/\s+/gu, "");
      const digits = (compact.match(/\d/gu) ?? []).length;
      const digitRatio = digits / Math.max(1, compact.length);
      if (digitRatio > 0.02) {
        continue;
      }
      const letters = (compact.match(/[А-ЯЁ]/gu) ?? []).length;
      const letterRatio = letters / Math.max(1, compact.length);
      const surnameQuality = assessFioSurnameQuality(surname);
      let score = 100;
      score += letterRatio * 25;
      score += 18; // fixed bonus for exactly three words
      score += Math.min(12, surname.length * 1.4);
      if (surnameQuality.ok) {
        score += 8;
      } else {
        score -= 18;
      }
      const patronymicBonus = /(ВИЧ|ВНА|ИЧ|ЫЧ)$/u.test(patronymic) ? 5 : 0;
      score += patronymicBonus;
      const bigramNoiseCount = FIO_NOISE_BIGRAMS.reduce(
        (sum, bigram) => sum + (validated.match(new RegExp(bigram, "gu"))?.length ?? 0),
        0
      );
      const repeatedChars = validated.match(/(.)\1{2,}/gu)?.length ?? 0;
      const singleLetters = validated.match(/\b[А-ЯЁ]\b/gu)?.length ?? 0;
      const spacePenalty = /\s{2,}/u.test(line) ? 2 : 0;
      score -= bigramNoiseCount * 5 + repeatedChars * 7 + singleLetters * 8 + spacePenalty;
      if (mrzSurnames.length > 0) {
        const nearest = [...mrzSurnames]
          .map((mrzSurname) => levenshteinDistance(surname, mrzSurname))
          .sort((a, b) => a - b)[0];
        if (nearest !== undefined) {
          if (nearest <= 2) {
            score += 7;
          } else if (nearest >= 6) {
            score -= 4;
          }
        }
      }
      if (best === null || score > best.score) {
        best = { text: validated, score };
      }
    }
  }
  return best?.text ?? null;
}

function extractMrzSurnames(attempts: OcrPassResult[]): string[] {
  const surnames = new Set<string>();
  for (const attempt of attempts) {
    const parsed = parseMrzLatinFio(attempt.raw_text ?? attempt.text ?? "");
    if (parsed === null) {
      continue;
    }
    const surname = transliterateMrzLatinToCyrillic(parsed.surname);
    const quality = assessFioSurnameQuality(surname);
    if (!quality.ok) {
      continue;
    }
    const normalized = normalizeRussianText(surname).replace(/[^А-ЯЁ-]/gu, "").trim();
    if (normalized.length >= 2) {
      surnames.add(normalized);
    }
  }
  return [...surnames];
}

async function extractFioFromTsvZones(
  normalized: Awaited<ReturnType<typeof FormatNormalizer.normalize>>,
  logger: AuditLogger,
  mrzSurnames: string[],
  fioRoi: FieldRoi["roi"] | null
): Promise<OcrPassResult | null> {
  const sourceBuffer =
    normalized.normalizedBuffer ??
    (normalized.pages[0]?.imagePath === undefined || normalized.pages[0]?.imagePath === null
      ? null
      : await readFile(normalized.pages[0].imagePath));
  if (sourceBuffer === null) {
    return null;
  }
  const globalZones = [
    { leftR: 0.1, topR: 0.31, rightR: 0.78, bottomR: 0.365, label: "fio_global_31_365" },
    { leftR: 0.1, topR: 0.355, rightR: 0.78, bottomR: 0.41, label: "fio_global_355_41" },
    { leftR: 0.1, topR: 0.4, rightR: 0.78, bottomR: 0.46, label: "fio_global_40_46" }
  ].map((zone) => ({
    left: Math.max(0, Math.round(normalized.width * zone.leftR)),
    top: Math.max(0, Math.round(normalized.height * zone.topR)),
    width: Math.max(1, Math.round(normalized.width * (zone.rightR - zone.leftR))),
    height: Math.max(1, Math.round(normalized.height * (zone.bottomR - zone.topR))),
    label: zone.label
  }));
  const roiZones =
    fioRoi === null
      ? []
      : [
          { topPart: -0.05, bottomPart: 0.1, label: "fio_roi_1" },
          { topPart: 0.08, bottomPart: 0.22, label: "fio_roi_2" },
          { topPart: 0.2, bottomPart: 0.35, label: "fio_roi_3" }
        ].map((zone) => {
          const left = clamp(Math.round(fioRoi.x - fioRoi.width * 0.12), 0, normalized.width - 1);
          const width = clamp(Math.round(fioRoi.width * 1.3), 1, normalized.width - left);
          const top = clamp(Math.round(fioRoi.y + fioRoi.height * zone.topPart), 0, normalized.height - 1);
          const bottom = clamp(Math.round(fioRoi.y + fioRoi.height * zone.bottomPart), top + 1, normalized.height);
          return {
            left,
            top,
            width,
            height: Math.max(1, bottom - top),
            label: zone.label
          };
        });
  const zoneRects = [...roiZones, ...globalZones];
  const tmpBase = await mkdtemp(join(tmpdir(), "keiscore-fio-zone-"));
  try {
    let best: { text: string; confidence: number; bbox: OcrPassResult["bbox"]; score: number } | null = null;
    for (const zone of zoneRects) {
      const zonePath = join(tmpBase, `fio_zone_${zone.label}.png`);
      const zoneBuffer = await sharp(sourceBuffer).extract(zone).grayscale().normalise().median(1).sharpen().png().toBuffer();
      await writeFile(zonePath, zoneBuffer);
      for (const psm of [4, 6, 11] as const) {
        const { stdout } = await execa("tesseract", [zonePath, "stdout", "-l", "rus", "--psm", String(psm), "tsv"], {
          timeout: 12_000
        });
        const words = parsePageTsvWords(stdout, { x: zone.left, y: zone.top });
        const lines = buildTextLinesFromTsvWords(words);
        if (lines.length === 0) {
          continue;
        }
        const lineTexts = lines.map((line) => line.text);
        for (let idx = 0; idx < lines.length - 1; idx += 1) {
          lineTexts.push(`${lines[idx]!.text} ${lines[idx + 1]!.text}`);
        }
        for (let idx = 0; idx < lines.length - 2; idx += 1) {
          lineTexts.push(`${lines[idx]!.text} ${lines[idx + 1]!.text} ${lines[idx + 2]!.text}`);
        }
        const bestText = selectBestFioFromCyrillicLines(lineTexts, mrzSurnames);
        if (bestText === null) {
          continue;
        }
        const matchedLine = lines.find((line) => normalizeRussianText(line.text).replace(/\s+/gu, " ").includes(bestText));
        const confidenceBase = matchedLine === undefined ? 0.62 : Math.max(0.35, Math.min(0.9, matchedLine.confidence / 100));
        const surname = extractFioSurname(bestText);
        let score = scoreValidatedFio(bestText, confidenceBase) + (psm === 11 ? 2 : 0);
        if (mrzSurnames.length > 0) {
          const closest = [...mrzSurnames]
            .map((candidate) => levenshteinDistance(surname, candidate))
            .sort((a, b) => a - b)[0];
          if (closest !== undefined) {
            if (closest <= 2) {
              score += 6;
            } else if (closest >= 6) {
              score -= 3;
            }
          }
        }
        const bbox =
          matchedLine?.bbox ?? {
            x1: zone.left,
            y1: zone.top,
            x2: zone.left + zone.width,
            y2: zone.top + zone.height
          };
        if (best === null || score > best.score) {
          const confidenceFromScore = Math.max(0.45, Math.min(0.93, 0.48 + Math.max(0, score) / 220));
          best = {
            text: bestText,
            confidence: Math.max(confidenceBase, confidenceFromScore),
            bbox,
            score
          };
        }
      }
    }
    if (best === null) {
      return null;
    }
    return {
      field: "fio",
      pass_id: "C",
      text: best.text,
      confidence: best.confidence,
      bbox: best.bbox,
      engine_used: "tesseract",
      psm: 6,
      raw_text: best.text,
      normalized_text: best.text,
      source: "zonal_tsv"
    };
  } catch (error) {
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "warn",
      message: "FIO Cyrillic zonal extraction failed.",
      data: { reason: error instanceof Error ? error.message : String(error) }
    });
    return null;
  } finally {
    await rm(tmpBase, { recursive: true, force: true });
  }
}

export function buildIssuedByCandidatesFromTsvWords(
  words: TsvWord[]
): Array<{ text: string; confidence: number; bbox: OcrPassResult["bbox"]; score: number }> {
  const lines = buildTextLinesFromTsvWords(words);
  const candidates: Array<{ text: string; confidence: number; bbox: OcrPassResult["bbox"]; score: number }> = [];
  const avgLineHeight =
    lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + Math.max(1, line.bbox.y2 - line.bbox.y1), 0) / lines.length;
  const maxLineGap = Math.max(16, Math.round(avgLineHeight * 1.8));
  for (let i = 0; i < lines.length; i += 1) {
    const chunk: Array<{ text: string; confidence: number; bbox: OcrPassResult["bbox"] }> = [];
    for (let j = i; j < Math.min(lines.length, i + 4); j += 1) {
      const line = lines[j]!;
      if (lineHasIssuedByStopSignal(line.text)) {
        break;
      }
      const previous = chunk[chunk.length - 1];
      if (previous !== undefined && line.bbox.y1 - previous.bbox.y2 > maxLineGap) {
        break;
      }
      chunk.push(line);
      const rawMerged = chunk.map((line) => line.text).join(" ");
      if (lineHasIssuedByStopSignal(rawMerged)) {
        continue;
      }
      const merged = normalizeIssuedByChunk(rawMerged);
      if (merged.includes("<")) {
        continue;
      }
      const quality = assessIssuedByQuality(merged);
      if (quality.validated === null) {
        continue;
      }
      const confidence = Math.max(0.35, Math.min(0.92, Math.max(...chunk.map((line) => line.confidence)) / 100));
      const bbox = chunk.reduce(
        (acc, line) => ({
          x1: Math.min(acc.x1, line.bbox.x1),
          y1: Math.min(acc.y1, line.bbox.y1),
          x2: Math.max(acc.x2, line.bbox.x2),
          y2: Math.max(acc.y2, line.bbox.y2)
        }),
        { ...chunk[0]!.bbox }
      );
      const score = quality.score + confidence * 12 + (chunk.length >= 3 ? 3 : 0);
      candidates.push({
        text: quality.validated,
        confidence,
        bbox,
        score
      });
    }
  }
  return candidates.sort((left, right) => right.score - left.score);
}

async function extractIssuedByFromTsvZones(
  normalized: Awaited<ReturnType<typeof FormatNormalizer.normalize>>,
  logger: AuditLogger,
  issuedByRoi: FieldRoi["roi"] | null
): Promise<{ text: string; confidence: number; bbox: OcrPassResult["bbox"] } | null> {
  const imagePath = normalized.pages[0]?.imagePath;
  if (imagePath === null || imagePath === undefined) {
    return null;
  }
  const globalZoneCandidates = [
    { leftR: 0.4, topR: 0.28, rightR: 0.96, bottomR: 0.35, label: "issued_28_35" },
    { leftR: 0.4, topR: 0.34, rightR: 0.96, bottomR: 0.41, label: "issued_34_41" },
    { leftR: 0.4, topR: 0.4, rightR: 0.96, bottomR: 0.48, label: "issued_40_48" }
  ].map((candidate) => ({
    left: Math.max(0, Math.round(normalized.width * candidate.leftR)),
    top: Math.max(0, Math.round(normalized.height * candidate.topR)),
    width: Math.max(1, Math.round(normalized.width * (candidate.rightR - candidate.leftR))),
    height: Math.max(1, Math.round(normalized.height * (candidate.bottomR - candidate.topR))),
    label: candidate.label
  }));
  const roiZoneCandidates =
    issuedByRoi === null
      ? []
      : [
          { topPart: -0.03, bottomPart: 0.12, label: "issued_roi_1" },
          { topPart: 0.1, bottomPart: 0.24, label: "issued_roi_2" },
          { topPart: 0.22, bottomPart: 0.38, label: "issued_roi_3" }
        ].map((zone) => {
          const left = clamp(Math.round(issuedByRoi.x - issuedByRoi.width * 0.06), 0, normalized.width - 1);
          const width = clamp(Math.round(issuedByRoi.width * 1.1), 1, normalized.width - left);
          const top = clamp(Math.round(issuedByRoi.y + issuedByRoi.height * zone.topPart), 0, normalized.height - 1);
          const bottom = clamp(
            Math.round(issuedByRoi.y + issuedByRoi.height * zone.bottomPart),
            top + 1,
            normalized.height
          );
          return {
            left,
            top,
            width,
            height: Math.max(1, bottom - top),
            label: zone.label
          };
        });
  const zoneCandidates = [...roiZoneCandidates, ...globalZoneCandidates];
  try {
    const sourceBuffer =
      normalized.normalizedBuffer ??
      (normalized.pages[0]?.imagePath === undefined || normalized.pages[0]?.imagePath === null
        ? null
        : await readFile(normalized.pages[0].imagePath));
    if (sourceBuffer === null) {
      return null;
    }
    const tmpBase = await mkdtemp(join(tmpdir(), "keiscore-issued-by-zone-"));
    try {
      let best: { text: string; confidence: number; bbox: OcrPassResult["bbox"]; score: number } | null = null;
      for (const zone of zoneCandidates) {
        const zonePath = join(tmpBase, `issued_by_zone_${zone.label}.png`);
        const zoneBuffer = await sharp(sourceBuffer).extract(zone).png().toBuffer();
        const enhancedZone = await enhanceIssuedByZone(zoneBuffer);
        await writeFile(zonePath, enhancedZone);
        for (const psm of [6, 11] as const) {
          const { stdout } = await execa(
            "tesseract",
            [zonePath, "stdout", "-l", "rus", "--psm", String(psm), "tsv"],
            {
              timeout: 12_000
            }
          );
          const words = parsePageTsvWords(stdout, { x: zone.left, y: zone.top });
          const zoneBest = buildIssuedByCandidatesFromTsvWords(words)[0] ?? null;
          if (zoneBest !== null && (best === null || zoneBest.score > best.score)) {
            best = zoneBest;
          }
        }
      }
      if (best === null) {
        return null;
      }
      return { text: best.text, confidence: best.confidence, bbox: best.bbox };
    } finally {
      await rm(tmpBase, { recursive: true, force: true });
    }
  } catch (error) {
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "warn",
      message: "Issued-by zonal fallback failed.",
      data: { reason: error instanceof Error ? error.message : String(error) }
    });
    return null;
  }
}

function lineHasIssuedByStopSignal(text: string): boolean {
  const normalized = normalizeRussianText(text).toUpperCase();
  if (normalized.includes("<")) {
    return true;
  }
  if (/\bКОД\b/u.test(normalized) || /\bПОДРАЗД/u.test(normalized)) {
    return true;
  }
  if (/\b\d{2}[./-]\d{2}[./-]\d{4}\b/u.test(normalized)) {
    return true;
  }
  if (/\b\d{3}\s*[-—]\s*\d{3}\b/u.test(normalized)) {
    return true;
  }
  return /\d{10,}/u.test(normalized);
}

function normalizeIssuedByChunk(text: string): string {
  return normalizeRussianText(text)
    .replace(/[—]/gu, "-")
    .replace(/\bГ\s*[.,]?\s*/gu, "Г. ")
    .replace(/\bГ\.\s+([А-ЯЁ])/gu, "Г. $1")
    .replace(/\b[0О]В[ЛЙ]\b/gu, "ОБЛ.")
    .replace(/\b(САНКТ)\s+(-?)\s*(ПЕТЕРБУРГУ)\b/gu, "$1-$3")
    .replace(/\s{2,}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

async function enhanceIssuedByZone(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .grayscale()
    .median(1)
    .normalise()
    .sharpen({ sigma: 1.1, m1: 0.9, m2: 1.1 })
    .png()
    .toBuffer();
}

function buildDiagnostics(
  includeRawTextDebug: boolean,
  anchors: AnchorResult
): NonNullable<ExtractionResult["diagnostics"]> | null {
  if (!includeRawTextDebug) {
    return null;
  }
  const preview = anchors.central_window_text_preview;
  if (preview === undefined) {
    return null;
  }
  return {
    central_window_text_preview: preview
  };
}

async function extractPassportDigitsFromMrz(imagePath: string): Promise<string | null> {
  const attempts: string[] = [];
  for (const psm of [11, 6] as const) {
    const { stdout } = await execa("tesseract", [imagePath, "stdout", "-l", "rus+eng", "--psm", String(psm)], {
      timeout: 12_000
    });
    const lines = (stdout ?? "")
      .toUpperCase()
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!line.includes("<<<")) {
        continue;
      }
      const secondLine = lines[i + 1] ?? "";
      attempts.push(...extractMrzCandidatesFromText(secondLine), ...extractMrzCandidatesFromText(line));
    }
  }
  if (attempts.length === 0) {
    return null;
  }
  const ranked = [...new Set(attempts)].sort((left, right) => scorePassportDigits(right) - scorePassportDigits(left));
  return ranked[0] ?? null;
}

async function extractPassportDigitsFromVerticalStrip(
  normalized: Awaited<ReturnType<typeof FormatNormalizer.normalize>>,
  logger: AuditLogger
): Promise<OcrPassResult | null> {
  const tmpBase = await mkdtemp(join(tmpdir(), "keiscore-passport-number-"));
  const sourceBuffer =
    normalized.normalizedBuffer ??
    (normalized.pages[0]?.imagePath === undefined || normalized.pages[0]?.imagePath === null
      ? null
      : await readFile(normalized.pages[0].imagePath));
  if (sourceBuffer === null) {
    await rm(tmpBase, { recursive: true, force: true });
    return null;
  }
  const metadata = await sharp(sourceBuffer).metadata();
  const width = Math.max(1, metadata.width ?? normalized.width);
  const height = Math.max(1, metadata.height ?? normalized.height);
  const strip = {
    left: Math.max(0, Math.round(width * 0.78)),
    top: Math.max(0, Math.round(height * 0.04)),
    width: Math.max(1, Math.round(width * 0.2)),
    height: Math.max(1, Math.round(height * 0.32))
  };
  const rotatedPath = join(tmpBase, "passport_vertical_rotated.png");
  const stripBuffer = await sharp(sourceBuffer)
    .extract(strip)
    .rotate(-90, { background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();
  await writeFile(rotatedPath, stripBuffer);
  const preprocessedPath = await preprocessRoiForOcrWithConfig(rotatedPath, { field: "passport_number", logger });

  let bestDigits: string | null = null;
  let bestPass: 7 | 8 | 13 = 7;
  try {
    for (const psm of [7, 8, 13] as const) {
      const { stdout } = await execa(
        "tesseract",
        [
          preprocessedPath,
          "stdout",
          "-l",
          "eng",
          "--oem",
          "1",
          "--psm",
          String(psm),
          "-c",
          "preserve_interword_spaces=1",
          "-c",
          "tessedit_char_whitelist=0123456789№- "
        ],
        { timeout: 8_000 }
      );
      const normalizedDigits = normalizePassportNumber(stdout ?? "");
      if (normalizedDigits.length >= 10) {
        bestDigits = normalizedDigits.slice(0, 10);
        bestPass = psm;
        break;
      }
    }
  } finally {
    if (process.env.KEISCORE_DEBUG_ROI_DIR === undefined || process.env.KEISCORE_DEBUG_ROI_DIR.trim() === "") {
      await rm(tmpBase, { recursive: true, force: true });
    }
  }
  if (bestDigits === null) {
    return null;
  }
  return {
    field: "passport_number",
    pass_id: "C",
    text: bestDigits,
    confidence: 0.74,
    bbox: {
      x1: strip.left,
      y1: strip.top,
      x2: strip.left + strip.width,
      y2: strip.top + strip.height
    },
    engine_used: "tesseract",
    psm: bestPass,
    postprocessed_roi_image_path: preprocessedPath
  };
}

function extractMrzCandidatesFromText(line: string): string[] {
  const compact = line.replace(/\s+/g, "");
  const prefix = compact.includes("RUS") ? compact.split("RUS")[0] ?? compact : compact;
  const normalizedPrefix = prefix.replace(/[^0-9A-Z<]/g, "");
  const digits = normalizePassportNumber(normalizedPrefix);
  const candidates: string[] = [];
  if (digits.length >= 10) {
    candidates.push(digits.slice(0, 10));
  }
  if (digits.length === 10) {
    // Common MRZ OCR drift: one zero from series is dropped and check digit leaks into first 10 chars.
    candidates.push(`${digits.slice(0, 4)}0${digits.slice(4, 9)}`);
  }
  return candidates.filter((value) => value.length === 10);
}

function scorePassportDigits(value: string): number {
  let score = 0;
  if (/^4\d{3}/u.test(value)) {
    score += 3;
  }
  if (value.slice(3, 5) === "00") {
    score += 2;
  }
  if (!/(\d)\1{5,}/u.test(value)) {
    score += 1;
  }
  return score;
}

async function extractFioFromMrz(
  normalized: Awaited<ReturnType<typeof FormatNormalizer.normalize>>,
  logger: AuditLogger
): Promise<OcrPassResult[]> {
  const sourceBuffer =
    normalized.normalizedBuffer ??
    (normalized.pages[0]?.imagePath === undefined || normalized.pages[0]?.imagePath === null
      ? null
      : await readFile(normalized.pages[0].imagePath));
  if (sourceBuffer === null) {
    return [];
  }
  const tmpBase = await mkdtemp(join(tmpdir(), "keiscore-mrz-fio-"));
  try {
    const pageMeta = await sharp(sourceBuffer).metadata();
    const width = Math.max(1, pageMeta.width ?? normalized.width);
    const height = Math.max(1, pageMeta.height ?? normalized.height);
    const debugDir = process.env.KEISCORE_DEBUG_ROI_DIR?.trim();
    const attempts: OcrPassResult[] = [];
    const windows = [
      { leftR: 0.05, topR: 0.76, rightR: 0.95, bottomR: 0.92, id: "window1" },
      { leftR: 0.05, topR: 0.78, rightR: 0.95, bottomR: 0.94, id: "window2" },
      { leftR: 0.05, topR: 0.8, rightR: 0.95, bottomR: 0.96, id: "window3" }
    ] as const;
    for (const window of windows) {
      const roi = {
        left: Math.round(width * window.leftR),
        top: Math.round(height * window.topR),
        width: Math.max(1, Math.round(width * (window.rightR - window.leftR))),
        height: Math.max(1, Math.round(height * (window.bottomR - window.topR)))
      };
      const roiBuffer = await sharp(sourceBuffer).extract(roi).png().toBuffer();
      const roiPath = join(tmpBase, `mrz_roi_${window.id}.png`);
      const roiPreprocessedPath = join(tmpBase, `mrz_roi_preprocessed_${window.id}.png`);
      await writeFile(roiPath, roiBuffer);
      const preprocessed = await preprocessMrz(roiBuffer);
      await writeFile(roiPreprocessedPath, preprocessed);
      if (debugDir !== undefined && debugDir !== "") {
        await writeFile(join(debugDir, `fio_mrz_roi_${window.id}.png`), roiBuffer);
        await writeFile(join(debugDir, `fio_mrz_roi_preprocessed_${window.id}.png`), preprocessed);
      }
      const mrzProfiles = await TesseractEngine.runMrzOcrOnImage(roiPreprocessedPath, 12_000, logger);
      for (const profile of mrzProfiles) {
        const rawText = profile.rawText.trim();
        const parsed = parseMrzLatinFio(rawText);
        const transliterated = parsed === null
          ? null
          : `${transliterateMrzLatinToCyrillic(parsed.surname)} ${transliterateMrzLatinToCyrillic(parsed.name)} ${transliterateMrzLatinToCyrillic(parsed.patronymic)}`.trim();
        const validated = transliterated === null ? null : validateFio(transliterated);
        attempts.push({
          field: "fio",
          pass_id: "C",
          text: validated ?? rawText,
          confidence: profile.confidence,
          bbox: {
            x1: roi.left,
            y1: roi.top,
            x2: roi.left + roi.width,
            y2: roi.top + roi.height
          },
          engine_used: "tesseract",
          psm: profile.psm,
          raw_text: rawText,
          normalized_text: validated ?? normalizeRussianText(rawText),
          source: "mrz"
        });
        logger.log({
          ts: Date.now(),
          stage: "extractor",
          level: "info",
          message: "MRZ FIO attempt collected.",
          data: {
            windowId: window.id,
            psm: profile.psm,
            confidence: profile.confidence,
            parsed: parsed !== null,
            rawPreview: toPreview(rawText, 80)
          }
        });
      }
    }
    return attempts;
  } catch (error) {
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "warn",
      message: "MRZ ROI fallback parsing failed.",
      data: { reason: error instanceof Error ? error.message : String(error) }
    });
    return [];
  } finally {
    await rm(tmpBase, { recursive: true, force: true });
  }
}
