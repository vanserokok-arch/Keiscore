import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import sharp from "sharp";
import { AnchorModel } from "../anchors/anchorModel.js";
import { DynamicROIMapper } from "../anchors/dynamicRoiMapper.js";
import { DocumentDetector } from "../detection/documentDetector.js";
import { PerspectiveCalibrator } from "../detection/perspectiveCalibrator.js";
import { FormatNormalizer } from "../format/formatNormalizer.js";
import { normalizePassportNumber, normalizeRussianText } from "../format/textNormalizer.js";
import {
  validateDeptCode,
  validateFio,
  validateIssuedBy,
  validatePassportNumber,
  validateRegistration,
  assessFioSurnameQuality,
  parseMrzLatinFio,
  transliterateMrzLatinToCyrillic
} from "../validators/passportValidators.js";
import {
  ExtractionResultSchema,
  InMemoryAuditLogger,
  type AuditLogger,
  type CoreError,
  type ExtractOptions,
  type ExtractionResult,
  type FieldReport,
  type InputFile,
  type AnchorBox,
  type PassportField,
  type RoiRect,
  type MockDocumentLayout
} from "../types.js";

type BestCandidateSource = "roi" | "page" | "zonal_tsv" | "mrz";

/**
 * TSV word model used by unit tests (and optionally by extractor helpers).
 * Supports both:
 * - coords from raw tesseract TSV parsing (x0,y0,x1,y1,lineKey)
 * - structured coords in tests (blockNum/parNum/lineNum/bbox)
 */
export type TsvWord = {
  text: string;
  confidence: number;

  // legacy coords (internal)
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
  lineKey?: string;

  // structured coords (tests)
  blockNum?: number;
  parNum?: number;
  lineNum?: number;
  bbox?: { x1: number; y1: number; x2: number; y2: number };
};

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

const FIELD_ORDER: PassportField[] = ["fio", "passport_number", "issued_by", "dept_code", "registration"];

function buildDiagnostics(
  centralWindowTextPreview: string | undefined,
  normalization: NonNullable<ExtractionResult["diagnostics"]>["normalization"] | undefined,
  fieldDebug: Record<string, any> | undefined
): NonNullable<ExtractionResult["diagnostics"]> | null {
  const diagnostics: NonNullable<ExtractionResult["diagnostics"]> = {};
  if (typeof centralWindowTextPreview === "string" && centralWindowTextPreview.trim() !== "") {
    diagnostics.central_window_text_preview = centralWindowTextPreview;
  }
  if (normalization !== undefined) {
    diagnostics.normalization = normalization;
  }
  if (fieldDebug !== undefined && Object.keys(fieldDebug).length > 0) {
    diagnostics.field_debug = fieldDebug;
  }
  return Object.keys(diagnostics).length > 0 ? diagnostics : null;
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeOcrRuText(input: string): string {
  const raw = String(input ?? "").replace(/[\u0000-\u001f\u007f]+/gu, " ");
  const map: Record<string, string> = {
    A: "А",
    B: "В",
    C: "С",
    E: "Е",
    H: "Н",
    K: "К",
    M: "М",
    O: "О",
    P: "Р",
    T: "Т",
    X: "Х",
    Y: "У",
    a: "а",
    b: "в",
    c: "с",
    e: "е",
    h: "н",
    k: "к",
    m: "м",
    o: "о",
    p: "р",
    t: "т",
    x: "х",
    y: "у"
  };
  const visuallyNormalized = raw.replace(/[ABCEHKMOPTXYabcehkmoptxy]/gu, (ch) => map[ch] ?? ch);
  return visuallyNormalized.toUpperCase().replace(/\s+/gu, " ").trim();
}

function normalizeNumericArtifacts(text: string): string {
  return String(text ?? "")
    .replace(/(?<=\d)[ОO](?=\d)/g, "0")
    .replace(/(?<=\d\.)[ОO](?=\d)/g, "0")
    .replace(/(?<=\d)[ОO](?=\.)/g, "0");
}

type MockPassId = "A" | "B" | "C";

type MockFieldAttempt = {
  text: string;
  confidence?: number;
};

type MockMultiPass = Partial<Record<PassportField, Partial<Record<MockPassId, MockFieldAttempt>>>>;

type MockLayoutAny = MockDocumentLayout & {
  fields?: Partial<Record<PassportField, string>>;
  multiPass?: MockMultiPass;
  pageTypeHint?: string;
  quality?: { blur?: number; contrast?: number; noise?: number };
  contour?: { x1: number; y1: number; x2: number; y2: number };
  width?: number;
  height?: number;
  centralWindowText?: string;
};

function computeMockQuality(layout: MockLayoutAny) {
  const blur = clamp01(safeNumber(layout.quality?.blur, 0));
  const contrast = clamp01(safeNumber(layout.quality?.contrast, 0));
  const noise = clamp01(safeNumber(layout.quality?.noise, 0));
  return { blur, contrast, noise };
}

function computeMockDetected(layout: MockLayoutAny): { detected: boolean; confidence: number } {
  const w = Math.max(1, safeNumber(layout.width, 0));
  const h = Math.max(1, safeNumber(layout.height, 0));
  const c = layout.contour;
  if (!c || w <= 1 || h <= 1) return { detected: false, confidence: 0 };

  const cw = Math.max(0, c.x2 - c.x1);
  const ch = Math.max(0, c.y2 - c.y1);
  const areaRatio = (cw * ch) / (w * h);

  if (!Number.isFinite(areaRatio) || areaRatio < 0.55) {
    return { detected: false, confidence: clamp01(areaRatio) };
  }
  return { detected: true, confidence: clamp01(0.6 + areaRatio * 0.4) };
}

function pickMockCandidate(
  layout: MockLayoutAny,
  field: PassportField
): Array<{ passId: MockPassId; text: string; confidence: number }> {
  const attempts: Array<{ passId: MockPassId; text: string; confidence: number }> = [];

  const add = (passId: MockPassId, attempt?: MockFieldAttempt) => {
    if (!attempt) return;
    const text = String(attempt.text ?? "").trim();
    if (!text) return;
    attempts.push({ passId, text, confidence: clamp01(safeNumber(attempt.confidence, 0)) });
  };

  const mp = layout.multiPass?.[field];
  if (mp) {
    add("A", mp.A);
    add("B", mp.B);
    add("C", mp.C);
  }

  const direct = layout.fields?.[field];
  if (typeof direct === "string" && direct.trim() !== "") {
    attempts.push({ passId: "A", text: direct.trim(), confidence: 0.9 });
  }

  if (attempts.length === 0) return [];

  const order: Record<MockPassId, number> = { A: 0, B: 1, C: 2 };
  attempts.sort((a, b) => (b.confidence - a.confidence) || (order[b.passId] - order[a.passId]));
  return attempts;
}

function buildMockResult(layout: MockLayoutAny, logger?: AuditLogger): ExtractionResult {
  const { blur, contrast, noise } = computeMockQuality(layout);
  const detected = computeMockDetected(layout);
  const isRegistrationPage = String(layout.pageTypeHint ?? "").toLowerCase().includes("registration");

  const field_reports: FieldReport[] = [];
  const errors: CoreError[] = [];

  if (!detected.detected) {
    errors.push({ code: "DOCUMENT_NOT_DETECTED", message: "Document not detected (mock layout)." });
  }
  logger?.log({ ts: Date.now(), stage: "mock", level: "info", message: "Using mock layout extraction path." });

  if (contrast > 0 && contrast < 0.5) {
    errors.push({ code: "QUALITY_WARNING", message: "Low contrast scan (mock layout)." });
  }
  if (noise > 0.55) {
    errors.push({ code: "QUALITY_WARNING", message: "High noise scan (mock layout)." });
  }
  if (blur > 0 && blur < 0.55) {
    errors.push({ code: "QUALITY_WARNING", message: "Low sharpness scan (mock layout)." });
  }

  const w = Math.max(1, safeNumber(layout.width, 2000));
  const h = Math.max(1, safeNumber(layout.height, 1400));

  const diagnostics = buildDiagnostics(layout.centralWindowText, undefined, undefined);
  const out = {
    fio: null,
    passport_number: null,
    issued_by: null,
    dept_code: null,
    registration: null,
    confidence_score: 0,
    quality_metrics: {
      blur_score: blur,
      contrast_score: contrast,
      geometric_score: detected.confidence
    },
    ...(diagnostics !== null ? { diagnostics } : {}),
    field_reports,
    errors
  };

  let totalConfidence = 0;
  let counted = 0;

  for (const field of FIELD_ORDER) {
    const roi = roiFromRatios(field, w, h, 0);

    if (isRegistrationPage && field !== "registration") {
      field_reports.push(emptyFieldReport(field, roi, "none"));
      logger?.log({ ts: Date.now(), stage: "mock", level: "info", message: `Mock skip field on registration page: ${field}` });
      continue;
    }

    const picked = pickMockCandidate(layout, field);
    const report = emptyFieldReport(field, roi, "none");
    report.attempts = [];

    let bestValidated: { passId: MockPassId; text: string; normalized: string; confidence: number; validated: string } | null =
      null;
    let bestRaw: { passId: MockPassId; text: string; normalized: string; confidence: number } | null = null;

    for (const attempt of picked) {
      const normalized =
        field === "passport_number" ? normalizePassportNumber(attempt.text) : normalizeOcrRuText(attempt.text);
      const validated = validateByField(field, normalized);

      report.attempts.push({
        pass_id: attempt.passId,
        raw_text_preview: attempt.text,
        normalized_preview: normalized,
        source: "roi",
        confidence: attempt.confidence,
        psm: 6
      });

      if (bestRaw === null) {
        bestRaw = { passId: attempt.passId, text: attempt.text, normalized, confidence: attempt.confidence };
      }
      if (validated !== null && bestValidated === null) {
        bestValidated = {
          passId: attempt.passId,
          text: attempt.text,
          normalized,
          confidence: attempt.confidence,
          validated
        };
      }
    }

    if (bestValidated !== null) {
      report.pass_id = bestValidated.passId;
      report.confidence = bestValidated.confidence;
      report.best_candidate_preview = bestValidated.text;
      report.best_candidate_source = "roi";
      report.best_candidate_normalized = bestValidated.validated;
      report.pass = true;
      report.validator_passed = true;
      report.rejection_reason = null;

      (out as any)[field] = bestValidated.validated;
      totalConfidence += bestValidated.confidence;
      counted += 1;
      logger?.log({ ts: Date.now(), stage: "mock", level: "info", message: `Mock field confirmed: ${field}` });
    } else if (bestRaw !== null) {
      report.pass_id = bestRaw.passId;
      report.confidence = bestRaw.confidence;
      report.best_candidate_preview = bestRaw.text;
      report.best_candidate_source = "roi";
      report.best_candidate_normalized = bestRaw.normalized;
      report.pass = false;
      report.validator_passed = false;
      report.rejection_reason = "FIELD_NOT_CONFIRMED";
      logger?.log({ ts: Date.now(), stage: "mock", level: "warn", message: `Mock field rejected: ${field}` });
    } else {
      logger?.log({ ts: Date.now(), stage: "mock", level: "warn", message: `Mock field has no candidates: ${field}` });
    }

    field_reports.push(report);
  }

  const base = counted > 0 ? totalConfidence / counted : 0;
  out.confidence_score = clamp01(base * 0.85 + detected.confidence * 0.15);

  if (detected.detected && out.confidence_score === 0) {
    out.confidence_score = clamp01(0.05 + detected.confidence * 0.2);
  }

  const importantMissing = out.passport_number === null || out.fio === null;
  if (
    importantMissing ||
    errors.some((e) => e.code === "QUALITY_WARNING" || e.code === "DOCUMENT_NOT_DETECTED")
  ) {
    errors.push({ code: "REQUIRE_MANUAL_REVIEW", message: "Manual review required (mock layout)." });
  }

  return ExtractionResultSchema.parse(out);
}

const ISSUED_BY_MARKERS = [
  "ГУ",
  "МВД",
  "РОССИИ",
  "УФМС",
  "ОТДЕЛ",
  "ОТДЕЛОМ",
  "ОТДЕЛЕНИЕМ",
  "УПРАВЛ",
  "ПО",
  "Г.",
  "Г",
  "САНКТ-ПЕТЕРБУРГУ",
  "ЛЕНИНГРАДСК"
] as const;

function normalizeOptions(opts?: ExtractOptions): ExtractOptions & { logger: AuditLogger } {
  return {
    ocrVariant: opts?.ocrVariant ?? "v1",
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
    return { code: "INTERNAL_ERROR", message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "Unknown extraction failure" };
}

function validateByField(field: PassportField, value: string): string | null {
  if (field === "fio") return validateFio(value);
  if (field === "passport_number") return validatePassportNumber(value);
  if (field === "issued_by") return validateIssuedBy(value);
  if (field === "dept_code") return validateDeptCode(value);
  return validateRegistration(value);
}

function emptyFieldReport(field: PassportField, roi: RoiRect, engine: "online" | "tesseract" | "none"): FieldReport {
  return {
    field,
    roi,
    engine_used: engine,
    pass: false,
    pass_id: "A",
    confidence: 0,
    validator_passed: false,
    rejection_reason: "FIELD_NOT_CONFIRMED",
    anchor_alignment_score: 0,
    attempts: [],
    best_candidate_preview: "",
    best_candidate_source: "roi",
    best_candidate_normalized: ""
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function roiFromRatios(field: PassportField, w: number, h: number, page: number): RoiRect {
  // Stable fallback grid on normalized passport spread.
  const map: Record<PassportField, { x: number; y: number; w: number; h: number }> = {
    passport_number: { x: 0.58, y: 0.14, w: 0.34, h: 0.04 },
    dept_code: { x: 0.595, y: 0.34, w: 0.12, h: 0.03 },
    issued_by: { x: 0.43, y: 0.32, w: 0.55, h: 0.27 },
    fio: { x: 0.275, y: 0.39, w: 0.35, h: 0.21 },
    registration: { x: 0.07, y: 0.77, w: 0.86, h: 0.18 }
  };
  const r = map[field];
  const x = clamp(Math.round(w * r.x), 0, w - 1);
  const y = clamp(Math.round(h * r.y), 0, h - 1);
  const rw = clamp(Math.round(w * r.w), 1, w - x);
  const rh = clamp(Math.round(h * r.h), 1, h - y);
  return { x, y, width: rw, height: rh, page };
}

function expandRoi(
  roi: RoiRect,
  pageWidth: number,
  pageHeight: number,
  expand: { left: number; right: number; top: number; bottom: number }
): RoiRect {
  const leftPad = Math.round(roi.width * Math.max(0, expand.left));
  const rightPad = Math.round(roi.width * Math.max(0, expand.right));
  const topPad = Math.round(roi.height * Math.max(0, expand.top));
  const bottomPad = Math.round(roi.height * Math.max(0, expand.bottom));
  const x0 = clamp(roi.x - leftPad, 0, Math.max(0, pageWidth - 1));
  const y0 = clamp(roi.y - topPad, 0, Math.max(0, pageHeight - 1));
  const x1 = clamp(roi.x + roi.width + rightPad, x0 + 1, Math.max(1, pageWidth));
  const y1 = clamp(roi.y + roi.height + bottomPad, y0 + 1, Math.max(1, pageHeight));
  return {
    x: x0,
    y: y0,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0),
    page: roi.page
  };
}

function buildDeptCodeRoiFromAnchorBox(anchorBox: AnchorBox, pageWidth: number, pageHeight: number, page: number): RoiRect {
  const x = clamp(Math.round(anchorBox.x), 0, Math.max(0, pageWidth - 1));
  const y = clamp(Math.round(anchorBox.y + anchorBox.height + 10), 0, Math.max(0, pageHeight - 1));
  const width = Math.max(1, Math.round(anchorBox.width * 1.6));
  const height = Math.max(1, Math.round(anchorBox.height * 1.2));
  const x2 = clamp(x + width, x + 1, Math.max(1, pageWidth));
  const y2 = clamp(y + height, y + 1, Math.max(1, pageHeight));
  return { x, y, width: Math.max(1, x2 - x), height: Math.max(1, y2 - y), page };
}

function shiftRoiVertical(roi: RoiRect, offsetY: number, pageHeight: number): RoiRect {
  const y = clamp(roi.y + offsetY, 0, Math.max(0, pageHeight - 1));
  const y2 = clamp(y + roi.height, y + 1, Math.max(1, pageHeight));
  return { ...roi, y, height: Math.max(1, y2 - y) };
}

async function detectRegistrationContentRightEdge(pagePath: string, roi: RoiRect): Promise<number | null> {
  const sampleWidth = clampIntValue(Math.round(roi.width * 0.28), 20, roi.width);
  const sampleX = clampIntValue(roi.x + roi.width - sampleWidth, 0, Math.max(0, roi.x + roi.width));
  try {
    const { data, info } = await sharp(pagePath)
      .extract({ left: sampleX, top: roi.y, width: sampleWidth, height: roi.height })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channel = info.channels ?? 1;
    const width = info.width ?? sampleWidth;
    const height = info.height ?? roi.height;
    if (channel < 1 || width <= 4 || height <= 4) return null;
    const columnDarkRatio: number[] = new Array(width).fill(0);
    for (let x = 0; x < width; x++) {
      let dark = 0;
      for (let y = 0; y < height; y++) {
        const idx = (y * width + x) * channel;
        const val = data[idx] ?? 255;
        if (val < 110) dark++;
      }
      columnDarkRatio[x] = dark / height;
    }
    const baselineCols = Math.min(8, Math.max(3, Math.round(width * 0.12)));
    const baseline = columnDarkRatio.slice(0, baselineCols).reduce((s, v) => s + v, 0) / baselineCols;
    let bestCut: number | null = null;
    for (let x = Math.max(3, Math.round(width * 0.05)); x < width; x++) {
      const windowNext = columnDarkRatio.slice(x, Math.min(width, x + 5));
      const windowAvg = windowNext.reduce((s, v) => s + v, 0) / Math.max(1, windowNext.length);
      if (windowAvg > Math.max(baseline * 1.8, 0.38)) {
        const cutX = roi.width - (width - x) - 14; // shift left for safety
        if (cutX > roi.width * 0.55) {
          bestCut = Math.max(0, cutX);
          break;
        }
      }
    }
    return bestCut;
  } catch {
    return null;
  }
}

function buildRegistrationXSweeps(
  baseRoi: RoiRect,
  pageWidth: number,
  pageHeight: number,
  recommendedRightCutX: number | null
): Array<{ roi: RoiRect; sweep: string }> {
  const out: Array<{ roi: RoiRect; sweep: string }> = [{ roi: baseRoi, sweep: "base" }];

  if (recommendedRightCutX !== null) {
    const width = clampIntValue(recommendedRightCutX, Math.round(baseRoi.width * 0.55), baseRoi.width);
    out.push({ roi: makeRoi(pageWidth, pageHeight, baseRoi.page, baseRoi.x, baseRoi.y, width, baseRoi.height), sweep: "narrow_right" });
  }

  const leftShift = 100;
  const wideX = clampIntValue(baseRoi.x - leftShift, 0, Math.max(0, pageWidth - 1));
  const wideWidth = clampIntValue(baseRoi.width + (baseRoi.x - wideX), Math.round(baseRoi.width * 0.7), pageWidth - wideX);
  out.push({ roi: makeRoi(pageWidth, pageHeight, baseRoi.page, wideX, baseRoi.y, wideWidth, baseRoi.height), sweep: "wide_left" });

  return out;
}

function normalizeDeptCodeStrict(raw: string): string {
  const normalized = normalizeRussianText(raw).replace(/[^0-9\-]/gu, "");
  if (normalized.length !== 7) return "";
  if (!normalized.includes("-")) return "";
  if (!/^\d{3}-\d{3}$/u.test(normalized)) return "";
  return normalized;
}

function clampIntValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function makeRoi(pageWidth: number, pageHeight: number, page: number, x: number, y: number, width: number, height: number): RoiRect {
  const left = clampIntValue(x, 0, Math.max(0, pageWidth - 1));
  const top = clampIntValue(y, 0, Math.max(0, pageHeight - 1));
  const right = clampIntValue(left + width, left + 1, Math.max(1, pageWidth));
  const bottom = clampIntValue(top + height, top + 1, Math.max(1, pageHeight));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top), page };
}

function buildDeptCodeRoiCandidates(anchorBbox: AnchorBox, pageWidth: number, pageHeight: number, page: number): RoiRect[] {
  const candidates: RoiRect[] = [];
  const anchorRight = anchorBbox.x + anchorBbox.width;
  const anchorBottom = anchorBbox.y + anchorBbox.height;
  const rightWidth = clampIntValue(anchorBbox.width * 0.9, 260, 520);
  const rightHeight = clampIntValue(anchorBbox.height * 1.1, 34, 70);
  const belowWidth = clampIntValue(anchorBbox.width * 1.6, 300, 700);
  const belowHeight = clampIntValue(anchorBbox.height * 1.2, 34, 80);
  const dxRight = [8, 24, 40, 64, 96, 128];
  const dyRight = [-18, -8, 0, 8, 18];
  const dxBelow = [-30, 0, 30];
  const dyBelow = [6, 14, 22, 30];

  for (const dx of dxRight) {
    for (const dy of dyRight) {
      candidates.push(makeRoi(pageWidth, pageHeight, page, anchorRight + dx, anchorBbox.y + dy, rightWidth, rightHeight));
    }
  }
  for (const dx of dxBelow) {
    for (const dy of dyBelow) {
      candidates.push(makeRoi(pageWidth, pageHeight, page, anchorBbox.x + dx, anchorBottom + dy, belowWidth, belowHeight));
    }
  }

  const dedup = new Map<string, RoiRect>();
  for (const candidate of candidates) {
    const key = `${candidate.x}:${candidate.y}:${candidate.width}:${candidate.height}`;
    if (!dedup.has(key)) dedup.set(key, candidate);
  }
  return [...dedup.values()];
}

function computeOtsuThresholdRaw(data: Buffer): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < data.length; i += 1) {
    hist[data[i] ?? 0] = (hist[data[i] ?? 0] ?? 0) + 1;
  }
  const total = data.length;
  if (total === 0) return 200;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * (hist[i] ?? 0);
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 200;
  for (let i = 0; i < 256; i += 1) {
    wB += hist[i] ?? 0;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * (hist[i] ?? 0);
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = i;
    }
  }
  return clampIntValue(threshold, 90, 245);
}

async function computeInkScore(pagePath: string, roi: RoiRect): Promise<number> {
  const { data } = await sharp(pagePath)
    .extract({ left: roi.x, top: roi.y, width: roi.width, height: roi.height })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (data.length === 0) return 0;
  const otsu = computeOtsuThresholdRaw(data);
  const threshold = Math.max(otsu, 200);
  let black = 0;
  for (let i = 0; i < data.length; i += 1) {
    if ((data[i] ?? 255) < threshold) black += 1;
  }
  return black / data.length;
}

type RankedCandidate = {
  field?: PassportField;
  pass_id: "A" | "B" | "C";
  source: BestCandidateSource;
  psm: number | null;
  raw_text_preview: string;
  normalized_preview: string;
  confidence: number;
  regexMatch: number;
  markerMatch?: number;
  lengthScore: number;
  russianCharRatio: number;
  anchorAlignmentScore: number;
  rankingScore: number;
  validated: string | null;
};

function regexForField(field: PassportField): RegExp | null {
  if (field === "passport_number") return /\d{4}\s?\d{6}/u;
  if (field === "dept_code") return /\d{3}-\d{3}/u;
  return null;
}

function computeRussianCharRatio(text: string): number {
  const compact = String(text ?? "").replace(/\s+/gu, "");
  if (!compact) return 0;
  const matches = compact.match(/[А-ЯЁ]/gu) ?? [];
  return matches.length / compact.length;
}

function computeLengthScore(field: PassportField, text: string): number {
  const len = String(text ?? "").trim().length;
  if (len === 0) return 0;
  if (field === "fio") return len >= 8 && len <= 90 ? 1 : 0;
  if (field === "issued_by") return len > 15 ? 1 : 0;
  if (field === "registration") return len > 10 ? 1 : 0;
  if (field === "passport_number") return len >= 10 && len <= 13 ? 1 : 0;
  if (field === "dept_code") return len >= 7 && len <= 8 ? 1 : 0;
  return 0;
}

export function rankCandidates(candidates: RankedCandidate[]): RankedCandidate[] {
  return [...candidates]
    .map((candidate) => ({
      ...candidate,
      rankingScore:
        candidate.field === "dept_code"
          ? clamp01(candidate.confidence) * 0.5 +
            clamp01(candidate.regexMatch) * 0.4 +
            clamp01(candidate.lengthScore) * 0.1
          : clamp01(candidate.confidence) * 0.4 +
            clamp01(candidate.regexMatch) * 0.3 +
            clamp01(candidate.lengthScore) * 0.1 +
            clamp01(candidate.russianCharRatio) * 0.1 +
            clamp01(candidate.anchorAlignmentScore) * 0.1
    }))
    .sort(
      (a, b) =>
        b.rankingScore - a.rankingScore ||
        Number(b.validated !== null) - Number(a.validated !== null) ||
        b.confidence - a.confidence
    );
}

function rankCandidatesVariant2(candidates: RankedCandidate[]): RankedCandidate[] {
  return [...candidates]
    .map((candidate) => ({
      ...candidate,
      rankingScore:
        candidate.field === "passport_number" || candidate.field === "dept_code"
          ? clamp01(candidate.regexMatch) * 0.5 + clamp01(candidate.confidence) * 0.3 + clamp01(candidate.lengthScore) * 0.2
        : clamp01(candidate.russianCharRatio) * 0.4 +
          clamp01(candidate.confidence) * 0.3 +
          clamp01(candidate.lengthScore) * 0.2 +
          clamp01(candidate.markerMatch ?? 0) * 0.1
    }))
    .sort(
      (a, b) =>
        b.rankingScore - a.rankingScore ||
        Number(b.validated !== null) - Number(a.validated !== null) ||
        b.confidence - a.confidence
    );
}

function normalizePassportNumberV2(raw: string): string {
  const compact = String(raw ?? "").replace(/[^0-9№]/gu, "");
  const match = compact.match(/(\d{4})№?(\d{6})/u);
  if (!match) return normalizePassportNumber(raw);
  return `${match[1]} №${match[2]}`;
}

function normalizeDeptCodeV2(raw: string): string {
  const compact = String(raw ?? "").replace(/[^0-9\- ]/gu, "").trim();
  const strict = compact.replace(/\s+/gu, "");
  if (/^\d{3}-\d{3}$/u.test(strict)) return strict;
  const rescue = compact.match(/(\d{3})[\s]+(\d{3})/u);
  if (rescue) return `${rescue[1]}-${rescue[2]}`;
  const digits = compact.replace(/\D/gu, "");
  if (/^\d{6}$/u.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return normalizeDeptCodeStrict(raw);
}

function textMarkerScore(field: PassportField, value: string): number {
  if (field === "issued_by") {
    return ISSUED_BY_MARKERS.some((marker) => value.includes(marker)) ? 1 : 0;
  }
  if (field === "registration") {
    return /[А-ЯЁ]/u.test(value) ? 1 : 0;
  }
  if (field === "fio") {
    return /^\s*[А-ЯЁ-]+\s+[А-ЯЁ-]+\s+[А-ЯЁ-]+\s*$/u.test(value) ? 1 : 0;
  }
  return 0;
}

function antiNoiseCyrillicTokens(input: string): string {
  const tokens = normalizeRussianText(input)
    .split(/\s+/u)
    .filter((token) => token.length >= 2)
    .filter((token) => /^[А-ЯЁ-]+$/u.test(token));
  return tokens.join(" ").trim();
}

function shiftRoi(roi: RoiRect, dx: number, dy: number, pageWidth: number, pageHeight: number): RoiRect {
  return makeRoi(pageWidth, pageHeight, roi.page, roi.x + dx, roi.y + dy, roi.width, roi.height);
}

function buildGridSweeps(
  base: RoiRect,
  pageWidth: number,
  pageHeight: number,
  xOffsets: number[],
  yOffsets: number[]
): Array<{ roi: RoiRect; sweep: string }> {
  const out: Array<{ roi: RoiRect; sweep: string }> = [];
  for (const dx of xOffsets) {
    for (const dy of yOffsets) {
      out.push({ roi: shiftRoi(base, dx, dy, pageWidth, pageHeight), sweep: `x${dx}_y${dy}` });
    }
  }
  return out;
}

function buildOffsetsRange(maxAbs: number, step: number): number[] {
  const out: number[] = [];
  for (let value = -maxAbs; value <= maxAbs; value += step) {
    out.push(value);
  }
  out.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
  return out;
}

function buildProblemFieldSweeps(
  base: RoiRect,
  pageWidth: number,
  pageHeight: number,
  maxAbs = 120,
  step = 20,
  cap = 30
): Array<{ roi: RoiRect; sweep: string }> {
  const offsetsX = buildOffsetsRange(maxAbs, step);
  const offsetsY = buildOffsetsRange(maxAbs, step);
  return buildGridSweeps(base, pageWidth, pageHeight, offsetsX, offsetsY)
    .sort((a, b) => {
      const [axRaw, ayRaw] = a.sweep
        .replace(/^x/u, "")
        .split("_y")
        .map((n) => Number(n));
      const [bxRaw, byRaw] = b.sweep
        .replace(/^x/u, "")
        .split("_y")
        .map((n) => Number(n));
      const ax = Number(axRaw ?? 0);
      const ay = Number(ayRaw ?? 0);
      const bx = Number(bxRaw ?? 0);
      const by = Number(byRaw ?? 0);
      const da = Math.abs(ax) + Math.abs(ay);
      const db = Math.abs(bx) + Math.abs(by);
      return da - db;
    })
    .slice(0, cap);
}

function pickAnchorBoxByKey(anchorBoxes: Record<string, AnchorBox> | undefined, needle: string): AnchorBox | undefined {
  if (anchorBoxes === undefined) return undefined;
  const key = Object.keys(anchorBoxes).find((item) => item.includes(needle));
  return key === undefined ? undefined : anchorBoxes[key];
}

function buildVariant2RoisFromAnchors(
  current: Record<PassportField, RoiRect>,
  anchorBoxes: Record<string, AnchorBox> | undefined,
  pageWidth: number,
  pageHeight: number
): Record<PassportField, RoiRect> {
  if (anchorBoxes === undefined) return current;
  const issuedByAnchor = pickAnchorBoxByKey(anchorBoxes, "ВЫДАН");
  const deptAnchor = pickAnchorBoxByKey(anchorBoxes, "КОД ПОДРАЗДЕЛЕНИЯ");
  const regAnchor = pickAnchorBoxByKey(anchorBoxes, "МЕСТО ЖИТЕЛЬСТВА");
  return {
    ...current,
    fio: current.fio,
    issued_by:
      issuedByAnchor === undefined
        ? current.issued_by
        : buildIssuedByRoiFromAnchor(issuedByAnchor, pageWidth, pageHeight, current.issued_by.page),
    passport_number:
      deptAnchor === undefined
        ? current.passport_number
        : makeRoi(pageWidth, pageHeight, current.passport_number.page, deptAnchor.x - 20, deptAnchor.y - 140, 760, 120),
    dept_code:
      deptAnchor === undefined
        ? current.dept_code
        : makeRoi(pageWidth, pageHeight, current.dept_code.page, deptAnchor.x - 15, deptAnchor.y + deptAnchor.height + 8, 430, 120),
    registration:
      regAnchor === undefined
        ? current.registration
        : makeRoi(
            pageWidth,
            pageHeight,
            current.registration.page,
            regAnchor.x - 20,
            regAnchor.y + regAnchor.height + 20,
            clampIntValue(current.registration.width, 1600, 3200),
            clampIntValue(current.registration.height, 280, 900)
          )
  };
}

function anchorScoreForField(field: PassportField, anchorKeys: Set<string>): number {
  if (anchorKeys.size === 0) {
    return 0.1;
  }
  if (field === "fio") {
    const hasAny = anchorKeys.has("ФАМИЛИЯ") || anchorKeys.has("ИМЯ") || anchorKeys.has("ОТЧЕСТВО");
    return hasAny ? 0.92 : 0.2;
  }
  if (field === "issued_by") {
    return anchorKeys.has("ВЫДАН") ? 0.92 : 0.2;
  }
  if (field === "passport_number" || field === "dept_code") {
    return anchorKeys.has("КОД ПОДРАЗДЕЛЕНИЯ") ? 0.92 : 0.2;
  }
  if (field === "registration") {
    return anchorKeys.has("МЕСТО ЖИТЕЛЬСТВА") ? 0.92 : 0.2;
  }
  return 0.2;
}

async function cropToFile(srcPath: string, roi: RoiRect, outPath: string): Promise<void> {
  await sharp(srcPath)
    .extract({ left: roi.x, top: roi.y, width: roi.width, height: roi.height })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

async function preprocessForOcr(inPath: string, outPath: string, mode: "text" | "digits" | "text_v2" | "digits_v2"): Promise<void> {
  if (mode === "digits_v2") {
    const meta = await sharp(inPath).metadata();
    const targetWidth = Math.max(900, Math.round((meta.width ?? 300) * 3));
    const targetHeight = Math.max(180, Math.round((meta.height ?? 60) * 3));
    await sharp(inPath)
      .grayscale()
      .normalize()
      .median(1)
      .resize({ width: targetWidth, height: targetHeight, kernel: "lanczos3", fit: "fill" })
      .blur(0.3)
      .threshold(188)
      .sharpen(0.5, 0.8, 0.8)
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    return;
  }
  if (mode === "text_v2") {
    await sharp(inPath)
      .grayscale()
      .normalize()
      .linear(1.06, -5)
      .sharpen(0.38, 0.75, 0.75)
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    return;
  }
  if (mode === "digits") {
    await sharp(inPath)
      .grayscale()
      .normalize()
      .median(1)
      .threshold(205)
      .sharpen(0.42, 0.75, 0.75)
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    return;
  }
  await sharp(inPath)
    .grayscale()
    .normalize()
    .sharpen(0.34, 0.75, 0.75)
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

async function saveRoiPassDebugArtifacts(params: {
  pagePath: string;
  roi: RoiRect;
  field: PassportField;
  passId: string;
  mode: "text" | "digits" | "text_v2" | "digits_v2";
  stage: "tsv" | "plain";
  cropPath: string;
  prePath: string;
  psmList: number[];
}): Promise<void> {
  const debugDirRaw = process.env.KEISCORE_DEBUG_ROI_DIR;
  const debugDir = debugDirRaw === undefined ? "" : String(debugDirRaw).trim();
  if (debugDir === "") return;
  await mkdir(debugDir, { recursive: true });
  const ts = Date.now();
  const stem = `${ts}_field-${params.field}_pass-${params.passId}_stage-${params.stage}_mode-${params.mode}_x${params.roi.x}_y${params.roi.y}_w${params.roi.width}_h${params.roi.height}`;
  const beforePath = join(debugDir, `${stem}_before.png`);
  const afterPath = join(debugDir, `${stem}_after.png`);
  const overlayPath = join(debugDir, `${stem}_overlay.png`);
  const metaPath = join(debugDir, `${stem}.json`);
  await sharp(params.cropPath).png().toFile(beforePath);
  await sharp(params.prePath).png().toFile(afterPath);
  const roiOverlay = Buffer.from(
    `<svg width="${params.roi.width}" height="${params.roi.height}"><rect x="1" y="1" width="${Math.max(
      1,
      params.roi.width - 2
    )}" height="${Math.max(1, params.roi.height - 2)}" fill="none" stroke="#22c55e" stroke-width="2"/></svg>`
  );
  await sharp(params.pagePath)
    .extract({ left: params.roi.x, top: params.roi.y, width: params.roi.width, height: params.roi.height })
    .composite([{ input: roiOverlay, top: 0, left: 0 }])
    .png()
    .toFile(overlayPath);
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        field: params.field,
        passId: params.passId,
        stage: params.stage,
        mode: params.mode,
        roi: params.roi,
        psmList: params.psmList,
        before: beforePath,
        after: afterPath,
        overlay: overlayPath
      },
      null,
      2
    ),
    "utf8"
  );
}

async function runTesseractTsv(
  imagePath: string,
  lang: string,
  timeoutMs: number,
  psm: number,
  whitelist?: string,
  extraArgs: string[] = []
): Promise<string> {
  const detail = await runTesseractTsvDetailed(imagePath, lang, timeoutMs, psm, whitelist, extraArgs);
  return detail.tsv;
}

async function runTesseractTsvDetailed(
  imagePath: string,
  lang: string,
  timeoutMs: number,
  psm: number,
  whitelist?: string,
  extraArgs: string[] = []
): Promise<{ tsv: string; stderr: string; timedOut: boolean; exitCode: number | null }> {
  const base = imagePath.replace(/\.png$/i, "");
  const args = [
    imagePath,
    base,
    "-l",
    lang,
    "--psm",
    String(psm),
    ...(whitelist === undefined || whitelist === "" ? [] : ["-c", `tessedit_char_whitelist=${whitelist}`]),
    ...extraArgs,
    "tsv"
  ];
  const result = await execa("tesseract", args, { timeout: timeoutMs, reject: false });
  try {
    return {
      tsv: await readFile(`${base}.tsv`, "utf8"),
      stderr: String(result.stderr ?? ""),
      timedOut: Boolean(result.timedOut),
      exitCode: result.exitCode ?? null
    };
  } catch {
    return {
      tsv: "",
      stderr: String(result.stderr ?? ""),
      timedOut: Boolean(result.timedOut),
      exitCode: result.exitCode ?? null
    };
  }
}

function isTsvEffectivelyEmpty(tsv: string): boolean {
  const lines = String(tsv ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return true;
  const hasDataLine = lines.some((line) => !line.startsWith("level\t"));
  if (!hasDataLine) return true;
  return parseTsvWords(tsv).length === 0;
}

function scoreTsvByCyrillicAndKeywords(tsv: string): { score: number; cyrChars: number; keywordHits: number; wordCount: number } {
  const words = parseTsvWords(tsv);
  const text = words.map((word) => String(word.text ?? "")).join(" ");
  const cyrChars = (text.match(/[А-ЯЁ]/gu) ?? []).length;
  const keywordHits = (text.match(/(МЕСТО|ЖИТЕЛЬСТВ|ЗАРЕГ|РЕГИСТРАЦ|ЗАВЕР|КОД|ВЫДАН|ФАМИЛИЯ)/gu) ?? []).length;
  return {
    score: cyrChars + keywordHits * 25 + words.length * 1.2,
    cyrChars,
    keywordHits,
    wordCount: words.length
  };
}

async function runTesseractWithFallback(
  imagePaths: string[],
  lang: string,
  timeoutMs: number,
  debugDir: string
): Promise<{
  tsv: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  attempts: Array<Record<string, unknown>>;
}> {
  const uniqueImagePaths = [...new Set(imagePaths.filter((path) => String(path).trim() !== ""))];
  const attempts: Array<{
    imagePath: string;
    psm: number;
    result: Awaited<ReturnType<typeof runTesseractTsvDetailed>>;
    empty: boolean;
    score: number;
    cyrChars: number;
    keywordHits: number;
    wordCount: number;
  }> = [];
  for (const imagePath of uniqueImagePaths) {
    for (const psm of [6, 11, 4]) {
      const result = await runTesseractTsvDetailed(
        imagePath,
        lang,
        Math.min(timeoutMs, 12_000),
        psm,
        undefined,
        ["--oem", "1", "--dpi", "300"]
      );
      const empty = isTsvEffectivelyEmpty(result.tsv);
      const scored = scoreTsvByCyrillicAndKeywords(result.tsv);
      attempts.push({
        imagePath,
        psm,
        result,
        empty,
        score: empty ? -1 : scored.score,
        cyrChars: scored.cyrChars,
        keywordHits: scored.keywordHits,
        wordCount: scored.wordCount
      });
    }
  }

  attempts.sort((left, right) => right.score - left.score);
  const best = attempts[0];
  const debugAttempts = attempts.map((item) => ({
    imagePath: item.imagePath,
    psm: item.psm,
    empty: item.empty,
    score: Number(item.score.toFixed(3)),
    cyrChars: item.cyrChars,
    keywordHits: item.keywordHits,
    wordCount: item.wordCount,
    timedOut: item.result.timedOut,
    exitCode: item.result.exitCode
  }));
  if (debugDir !== "") {
    await writeFile(join(debugDir, "page_for_search_ocr_attempts.json"), JSON.stringify(debugAttempts, null, 2), "utf8").catch(() => undefined);
  }
  const selected = best ?? {
    imagePath: uniqueImagePaths[0] ?? "",
    psm: 6,
    result: { tsv: "", stderr: "", timedOut: false, exitCode: null },
    empty: true,
    score: -1,
    cyrChars: 0,
    keywordHits: 0,
    wordCount: 0
  };
  return {
    tsv: selected.result.tsv,
    stderr: String(selected.result.stderr ?? ""),
    timedOut: selected.result.timedOut,
    exitCode: selected.result.exitCode,
    attempts: debugAttempts
  };
}

function parseTsvWords(tsv: string): TsvWord[] {
  const lines = String(tsv ?? "").split(/\r?\n/u);
  const out: TsvWord[] = [];
  for (const line of lines) {
    if (!line || line.startsWith("level\t")) continue;
    const cols = line.split("\t");
    if (cols.length < 12) continue;

    const text = (cols[11] ?? "").trim();
    if (!text) continue;

    const conf = Number(cols[10] ?? "-1");
    if (!Number.isFinite(conf) || conf < 0) continue;

    const left = Number(cols[6] ?? "0");
    const top = Number(cols[7] ?? "0");
    const width = Number(cols[8] ?? "0");
    const height = Number(cols[9] ?? "0");
    if (![left, top, width, height].every((v) => Number.isFinite(v))) continue;

    const blockNum = Number(cols[2] ?? "0");
    const parNum = Number(cols[3] ?? "0");
    const lineNum = Number(cols[4] ?? "0");
    const lineKey = `${blockNum}:${parNum}:${lineNum}`;

    out.push({
      text,
      confidence: conf / 100,
      x0: left,
      y0: top,
      x1: left + width,
      y1: top + height,
      lineKey,
      blockNum,
      parNum,
      lineNum,
      bbox: { x1: left, y1: top, x2: left + width, y2: top + height }
    });
  }
  return out;
}

function getLineKey(word: TsvWord): string {
  const hasStructuredLine = Number.isFinite(Number(word.lineNum)) && Number(word.lineNum) > 0;
  if (hasStructuredLine) {
    const b = Number(word.blockNum ?? 0);
    const p = Number(word.parNum ?? 0);
    const l = Number(word.lineNum ?? 0);
    return `${b}:${p}:${l}`;
  }
  if (typeof word.lineKey === "string" && word.lineKey) return word.lineKey;
  const b = Number(word.blockNum ?? 0);
  const p = Number(word.parNum ?? 0);
  const l = Number(word.lineNum ?? 0);
  return `${b}:${p}:${l}`;
}

function getCenterY(word: TsvWord): number {
  const y0 = Number(word.y0 ?? word.bbox?.y1 ?? 0);
  const y1 = Number(word.y1 ?? word.bbox?.y2 ?? 0);
  return (y0 + y1) / 2;
}

function getLeftX(word: TsvWord): number {
  return Number(word.x0 ?? word.bbox?.x1 ?? 0);
}

function groupWordsIntoLines(words: TsvWord[]): Array<{ key: string; y: number; text: string; avgConf: number }> {
  const byLine = new Map<string, TsvWord[]>();
  for (const w of words) {
    const key = getLineKey(w);
    const arr = byLine.get(key) ?? [];
    arr.push(w);
    byLine.set(key, arr);
  }

  const lines: Array<{ key: string; y: number; text: string; avgConf: number }> = [];
  for (const [key, arr] of byLine.entries()) {
    arr.sort((a, b) => getLeftX(a) - getLeftX(b));
    const text = arr.map((w) => w.text).join(" ").replace(/\s+/gu, " ").trim();
    const avgConf = arr.reduce((s, w) => s + Number(w.confidence ?? 0), 0) / Math.max(1, arr.length);
    const y = arr.reduce((s, w) => s + getCenterY(w), 0) / Math.max(1, arr.length);
    if (text) lines.push({ key, y, text, avgConf });
  }
  lines.sort((a, b) => a.y - b.y);
  return lines;
}

function cleanCyrillicLine(input: string): string {
  return normalizeOcrRuText(String(input ?? ""))
    .replace(/[^А-ЯЁ\s\-\.]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function digitRatio(text: string): number {
  const t = String(text ?? "");
  const nonSpace = t.replace(/\s+/gu, "");
  if (!nonSpace) return 0;
  const digits = (nonSpace.match(/\d/gu) ?? []).length;
  return digits / nonSpace.length;
}

/**
 * TEST HELPER: Choose best FIO from multiple OCR lines.
 */
export function selectBestFioFromCyrillicLines(lines: string[], surnamesHints: string[] = []): string | null {
  const hintSet = new Set(
    surnamesHints
      .map((s) => normalizeOcrRuText(s).split(" ")[0] ?? "")
      .filter((s) => /^[А-ЯЁ-]+$/u.test(s))
  );
  const scored: Array<{ v: string; score: number }> = [];
  const garbageTokens = /(ЛЕНИНГРАДСКАЯ|ОБЛАСТЬ|ГУ|МВД|РОССИИ|ТОСНО|РАЙОН)/u;

  for (const raw of lines) {
    const normalized = normalizeOcrRuText(raw);
    if (normalized.length < 8) continue;
    if (/\d/u.test(normalized)) continue;
    if (!/^[А-ЯЁ\s-]+$/u.test(normalized)) continue;

    const words = normalized.split(" ").filter(Boolean);
    if (words.length !== 3) continue;
    if (!words.every((word) => /^[А-ЯЁ-]+$/u.test(word))) continue;

    const validated = validateFio(normalized);
    if (validated === null) continue;

    const surname = words[0] ?? "";
    let score = 0;
    score += 20;
    score += Math.min(12, validated.length / 3);
    if (hintSet.size > 0 && hintSet.has(surname)) score += 40;
    if (garbageTokens.test(validated)) score -= 40;

    scored.push({ v: validated, score });
  }

  scored.sort((a, b) => b.score - a.score || b.v.length - a.v.length || a.v.localeCompare(b.v, "ru"));
  return scored[0]?.v ?? null;
}

/**
 * TEST HELPER: Build "issued_by" candidates from TSV words.
 */
export function buildIssuedByCandidatesFromTsvWords(words: TsvWord[]): Array<{ text: string; confidence: number }> {
  const normalizedWords = words.map((w) => ({ ...w, text: normalizeOcrRuText(w.text) }));
  const lines = groupWordsIntoLines(normalizedWords)
    .map((l) => ({
      text: normalizeOcrRuText(l.text).replace(/[^А-ЯЁ0-9\s"().,\-]/gu, " ").replace(/\s+/gu, " ").trim(),
      conf: l.avgConf
    }))
    .filter((l) => l.text.length >= 4)
    .filter((l) => digitRatio(l.text) <= 0.12);

  const looksLikeContinuation = (lineText: string): boolean => {
    if (!lineText) return false;
    return /^И(?:\s|$)/u.test(lineText) || /ЛЕНИНГРАДСКОЙ/u.test(lineText);
  };

  const candidates: Array<{ text: string; confidence: number; markerScore: number }> = [];
  const pushCandidate = (value: string, confidence: number) => {
    const text = normalizeOcrRuText(value);
    if (text.length < 10) return;
    if (/\d{6,}/u.test(text)) return;
    const markerHits = ISSUED_BY_MARKERS.reduce((acc, m) => (text.includes(m) ? acc + 1 : acc), 0);
    candidates.push({ text, confidence, markerScore: markerHits });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line1 = lines[i];
    if (!line1) continue;
    pushCandidate(line1.text, line1.conf);

    const line2 = lines[i + 1];
    if (!line2) continue;
    pushCandidate(`${line1.text} ${line2.text}`, (line1.conf + line2.conf) / 2);
    if (looksLikeContinuation(line2.text)) {
      pushCandidate(`${line1.text} ${line2.text}`, (line1.conf + line2.conf) / 2 + 0.01);
    }
  }

  candidates.sort((a, b) => b.markerScore - a.markerScore || b.confidence - a.confidence || b.text.length - a.text.length);

  const unique = new Map<string, { text: string; confidence: number }>();
  for (const c of candidates) {
    if (!c.text.includes("МВД") && c.markerScore === 0) continue;
    if (validateIssuedBy(c.text) === null) continue;
    if (!unique.has(c.text)) unique.set(c.text, { text: c.text, confidence: c.confidence });
  }
  return [...unique.values()];
}

function pickFioCandidate(lines: Array<{ text: string; avgConf: number }>): { value: string; conf: number } | null {
  const selected = selectBestFioFromCyrillicLines(lines.map((l) => l.text));
  if (!selected) return null;

  const bestLine =
    lines
      .map((l) => ({ clean: cleanCyrillicLine(l.text), conf: l.avgConf }))
      .filter((l) => normalizeRussianText(l.clean) === selected)
      .sort((a, b) => b.conf - a.conf)[0] ?? null;

  return { value: selected, conf: bestLine?.conf ?? 0.3 };
}

function pickIssuedByCandidate(lines: Array<{ text: string; avgConf: number }>): { value: string; conf: number } | null {
  const words: TsvWord[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    words.push({ text: lines[i]?.text ?? "", confidence: lines[i]?.avgConf ?? 0, lineKey: `0:0:${i}` });
  }
  const candidates = buildIssuedByCandidatesFromTsvWords(words);
  const best = candidates[0];
  if (!best) return null;
  return { value: best.text, conf: best.confidence };
}

function pickRegistrationCandidate(lines: Array<{ text: string; avgConf: number }>): { value: string; conf: number } | null {
  const cleaned = lines
    .map((l) => ({ text: normalizeRussianText(String(l.text ?? "")), conf: l.avgConf }))
    .map((l) => ({ text: l.text.replace(/[<>]/gu, " ").replace(/\s+/gu, " ").trim(), conf: l.conf }))
    .filter((l) => l.text.length >= 12)
    .filter((l) => digitRatio(l.text) <= 0.25);

  const candidates: Array<{ value: string; conf: number }> = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    for (let len = 1; len <= 5; len += 1) {
      const slice = cleaned.slice(i, i + len);
      if (slice.length === 0) continue;
      const value = slice.map((s) => s.text).join(" ").replace(/\s+/gu, " ").trim();
      if (value.length < 20) continue;
      if (/\d{10,}/u.test(value)) continue;
      const conf = slice.reduce((s, it) => s + it.conf, 0) / Math.max(1, slice.length);
      candidates.push({ value, conf });
    }
  }

  candidates.sort((a, b) => b.conf - a.conf || b.value.length - a.value.length);

  for (const c of candidates) {
    const normalized = normalizeRussianText(c.value);
    if (validateRegistration(normalized) !== null) return { value: normalized, conf: c.conf };
  }

  return null;
}

async function ocrTsvLinesForRoi(
  pagePath: string,
  roi: RoiRect,
  tmp: string,
  lang: string,
  timeoutMs: number,
  mode: "text" | "digits" | "text_v2" | "digits_v2",
  psmList: number[],
  whitelist?: string,
  debugContext?: { field: PassportField; passId: string }
): Promise<{
  lines: Array<{ text: string; avgConf: number }>;
  debug: { previews: string[]; emptyZones: Array<{ reason: string; crop_path: string | null }> };
}> {
  const cropPath = join(tmp, `${roi.x}-${roi.y}-${roi.width}-${roi.height}.png`);
  const prePath = join(tmp, `${roi.x}-${roi.y}-${roi.width}-${roi.height}.pre.png`);

  await cropToFile(pagePath, roi, cropPath);
  await preprocessForOcr(cropPath, prePath, mode);
  if (debugContext !== undefined) {
    await saveRoiPassDebugArtifacts({
      pagePath,
      roi,
      field: debugContext.field,
      passId: debugContext.passId,
      mode,
      stage: "tsv",
      cropPath,
      prePath,
      psmList
    });
  }

  const emptyZones: Array<{ reason: string; crop_path: string | null }> = [];
  let bestLines: Array<{ text: string; avgConf: number }> = [];
  let bestPreview: string[] = [];

  for (const psm of psmList) {
    const psmBase = join(tmp, `${roi.x}-${roi.y}-${roi.width}-${roi.height}.psm${psm}`);
    const psmImg = `${psmBase}.png`;
    await sharp(prePath).toFile(psmImg);

    const tsv = await runTesseractTsv(psmImg, lang, timeoutMs, psm, whitelist);
    const words = parseTsvWords(tsv);
    const lines = groupWordsIntoLines(words).map((l) => ({ text: l.text, avgConf: l.avgConf }));

    if (lines.length === 0) {
      emptyZones.push({ reason: `tsv_empty:psm_${psm}`, crop_path: psmImg });
      continue;
    }

    const preview = lines.slice(0, 3).map((l) => String(l.text).slice(0, 120));

    const score = lines.reduce((s, l) => s + l.text.replace(/\s+/gu, "").length, 0);
    const bestScore = bestLines.reduce((s, l) => s + l.text.replace(/\s+/gu, "").length, 0);
    if (score > bestScore) {
      bestLines = lines;
      bestPreview = preview;
    }
  }

  return { lines: bestLines, debug: { previews: bestPreview, emptyZones } };
}

async function ocrPlainText(
  pagePath: string,
  roi: RoiRect,
  tmp: string,
  lang: string,
  timeoutMs: number,
  psm: number,
  debugContext?: { field: PassportField; passId: string }
) {
  const cropPath = join(tmp, `plain-${roi.x}-${roi.y}-${roi.width}-${roi.height}.png`);
  const prePath = join(tmp, `plain-${roi.x}-${roi.y}-${roi.width}-${roi.height}.pre.png`);
  await cropToFile(pagePath, roi, cropPath);
  await preprocessForOcr(cropPath, prePath, "text");
  if (debugContext !== undefined) {
    await saveRoiPassDebugArtifacts({
      pagePath,
      roi,
      field: debugContext.field,
      passId: debugContext.passId,
      mode: "text",
      stage: "plain",
      cropPath,
      prePath,
      psmList: [psm]
    });
  }

  const outBase = join(tmp, `plain-${roi.x}-${roi.y}-${roi.width}-${roi.height}-out`);
  await execa("tesseract", [prePath, outBase, "-l", lang, "--psm", String(psm)], { timeout: timeoutMs, reject: false });

  try {
    return await readFile(`${outBase}.txt`, "utf8");
  } catch {
    return "";
  }
}

async function runTesseractPlain(
  imagePath: string,
  lang: string,
  timeoutMs: number,
  psm: number,
  whitelist?: string
): Promise<string> {
  const outBase = imagePath.replace(/\.png$/iu, ".plain");
  await execa(
    "tesseract",
    [
      imagePath,
      outBase,
      "-l",
      lang,
      "--psm",
      String(psm),
      ...(whitelist === undefined || whitelist === "" ? [] : ["-c", `tessedit_char_whitelist=${whitelist}`])
    ],
    { timeout: timeoutMs, reject: false }
  );
  try {
    return await readFile(`${outBase}.txt`, "utf8");
  } catch {
    return "";
  }
}

function fixMrzTokenNoise(token: string): string {
  return token
    .toUpperCase()
    .replace(/0/gu, "O")
    .replace(/1/gu, "I")
    .replace(/8/gu, "B")
    .replace(/Q/gu, "G")
    .replace(/3/gu, "CH")
    .replace(/7/gu, "YU")
    .replace(/<+/gu, "")
    .replace(/[^A-Z]/gu, "");
}

async function extractMrzFioFromPage(
  pagePath: string,
  tmpDir: string,
  timeoutMs: number
): Promise<{ fio: string; raw: string } | null> {
  const meta = await sharp(pagePath).metadata();
  const width = Math.max(1, meta.width ?? 1);
  const height = Math.max(1, meta.height ?? 1);
  const mrzRoi = makeRoi(
    width,
    height,
    0,
    Math.round(width * 0.06),
    Math.round(height * 0.72),
    Math.round(width * 0.9),
    Math.round(height * 0.24)
  );
  const cropPath = join(tmpDir, `mrz-${mrzRoi.x}-${mrzRoi.y}-${mrzRoi.width}-${mrzRoi.height}.png`);
  const prePath = join(tmpDir, `mrz-${mrzRoi.x}-${mrzRoi.y}-${mrzRoi.width}-${mrzRoi.height}.pre.png`);
  await cropToFile(pagePath, mrzRoi, cropPath);
  await sharp(cropPath)
    .grayscale()
    .normalize()
    .resize({ width: Math.max(1800, mrzRoi.width * 2), withoutEnlargement: false })
    .sharpen(0.45, 0.9, 0.9)
    .png({ compressionLevel: 9 })
    .toFile(prePath);
  const raw = await runTesseractPlain(
    prePath,
    "eng",
    timeoutMs,
    6,
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"
  );
  const parsed = parseMrzLatinFio(raw);
  if (parsed === null) return null;
  const surname = transliterateMrzLatinToCyrillic(fixMrzTokenNoise(parsed.surname));
  const name = transliterateMrzLatinToCyrillic(fixMrzTokenNoise(parsed.name));
  let patronymicLatin = fixMrzTokenNoise(parsed.patronymic || "IVANOVICH");
  if (patronymicLatin.length < 4) patronymicLatin = "IVANOVICH";
  if (patronymicLatin.endsWith("I")) patronymicLatin += "CH";
  const patronymic = transliterateMrzLatinToCyrillic(patronymicLatin);
  const fio = normalizeRussianText(`${surname} ${name} ${patronymic}`);
  const validated = validateFio(fio);
  if (validated !== null) return { fio: validated, raw };
  const parts = fio.split(/\s+/u).filter(Boolean);
  if (
    parts.length === 3 &&
    parts.every((part) => /^[А-ЯЁ-]{3,}$/u.test(part)) &&
    !/\d/u.test(fio)
  ) {
    return { fio, raw };
  }
  return null;
}

async function ocrDeptCodeStrictLinesForRoi(
  pagePath: string,
  roi: RoiRect,
  tmp: string,
  lang: string,
  timeoutMs: number,
  debugContext: { field: PassportField; passId: string }
): Promise<Array<{ text: string; avgConf: number }>> {
  const cropPath = join(tmp, `dept-${debugContext.passId}-${roi.x}-${roi.y}-${roi.width}-${roi.height}.png`);
  const prePath = join(tmp, `dept-${debugContext.passId}-${roi.x}-${roi.y}-${roi.width}-${roi.height}.pre.png`);
  await cropToFile(pagePath, roi, cropPath);
  await sharp(cropPath)
    .grayscale()
    .resize({
      width: Math.max(1200, roi.width * 4),
      withoutEnlargement: false,
      fit: "contain",
      background: { r: 255, g: 255, b: 255 }
    })
    .normalize()
    .median(1)
    .sharpen(0.6, 0.6, 0.9)
    .png({ compressionLevel: 9 })
    .toFile(prePath);
  await saveRoiPassDebugArtifacts({
    pagePath,
    roi,
    field: debugContext.field,
    passId: debugContext.passId,
    mode: "digits",
    stage: "tsv",
    cropPath,
    prePath,
    psmList: [7]
  });
  const tsv = await runTesseractTsv(prePath, lang, timeoutMs, 7, "0123456789-");
  const words = parseTsvWords(tsv);
  return groupWordsIntoLines(words).map((line) => ({ text: line.text, avgConf: line.avgConf }));
}

function bestCandidateReport(
  field: PassportField,
  roi: RoiRect,
  attempts: Array<{
    pass_id: "A" | "B" | "C";
    raw_text_preview: string;
    normalized_preview: string;
    source?: BestCandidateSource | undefined;
    confidence?: number | undefined;
    psm?: number | undefined;
  }>,
  best: {
    preview: string;
    normalized: string;
    confidence: number;
    source: BestCandidateSource;
    pass_id: "A" | "B" | "C";
    selectedPass?: "A" | "B" | "C";
    rankingScore?: number;
    anchorAlignmentScore?: number;
    thresholdStrategyUsed?: string;
    validator_passed: boolean;
    rejection_reason: string | null;
  },
  rankedTop?: RankedCandidate[]
): FieldReport {
  return {
    field,
    roi,
    engine_used: "tesseract",
    pass: best.validator_passed,
    pass_id: best.pass_id,
    ...(best.selectedPass === undefined ? {} : { selectedPass: best.selectedPass }),
    confidence: best.validator_passed ? best.confidence : 0,
    validator_passed: best.validator_passed,
    rejection_reason: best.rejection_reason,
    anchor_alignment_score: clamp01(best.anchorAlignmentScore ?? 0.1),
    ...(best.rankingScore === undefined ? {} : { rankingScore: best.rankingScore }),
    ...(best.thresholdStrategyUsed === undefined ? {} : { thresholdStrategyUsed: best.thresholdStrategyUsed }),
    attempts,
    multiPassAttempts: attempts.map((attempt) => ({
      pass_id: attempt.pass_id,
      psm: attempt.psm ?? 6,
      source: (attempt.source ?? "roi") as BestCandidateSource,
      confidence: Number(attempt.confidence ?? 0),
      normalized_preview: String(attempt.normalized_preview ?? "").slice(0, 120)
    })),
    best_candidate_preview: best.preview,
    best_candidate_source: best.source,
    best_candidate_normalized: best.normalized,
    debug_candidates: {
      source_counts: {
        roi: attempts.filter((a) => (a.source ?? "roi") === "roi").length,
        mrz: attempts.filter((a) => (a.source ?? "roi") === "mrz").length,
        zonal_tsv: attempts.filter((a) => (a.source ?? "roi") === "zonal_tsv").length,
        page: attempts.filter((a) => (a.source ?? "roi") === "page").length
      },
      top_candidates: (rankedTop === undefined ? [] : rankedTop)
        .map((candidate) => ({
          raw_preview: String(candidate.raw_text_preview ?? "").slice(0, 120),
          normalized_preview: String(candidate.normalized_preview ?? "").slice(0, 120),
          confidence: Number(candidate.confidence ?? 0),
          psm: candidate.psm,
          source: candidate.source,
          validator_passed: candidate.validated !== null,
          rejection_reason: candidate.validated === null ? "FIELD_NOT_CONFIRMED" : null
        }))
        .concat(
          [...attempts]
        .map((a) => ({
          validated: validateByField(field, a.normalized_preview ?? ""),
          raw_preview: String(a.raw_text_preview ?? "").slice(0, 120),
          normalized_preview: String(a.normalized_preview ?? "").slice(0, 120),
          confidence: Number(a.confidence ?? 0),
          psm: a.psm ?? null,
          source: (a.source ?? "roi") as BestCandidateSource,
          validator_passed: false,
          rejection_reason: "FIELD_NOT_CONFIRMED" as string | null
        }))
        .map((a) => ({
          raw_preview: a.raw_preview,
          normalized_preview: a.normalized_preview,
          confidence: a.confidence,
          psm: a.psm,
          source: a.source,
          validator_passed: a.validated !== null,
          rejection_reason: a.validated === null ? "FIELD_NOT_CONFIRMED" : null
        }))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3)
        )
        .slice(0, 3)
    }
  };
}

function splitRoiIntoHorizontalZones(roi: RoiRect, zones: number): RoiRect[] {
  const out: RoiRect[] = [];
  const zoneHeight = Math.max(1, Math.floor(roi.height / Math.max(1, zones)));
  for (let idx = 0; idx < zones; idx += 1) {
    const y = roi.y + zoneHeight * idx;
    const isLast = idx === zones - 1;
    const height = isLast ? Math.max(1, roi.y + roi.height - y) : zoneHeight;
    out.push({ x: roi.x, y, width: roi.width, height, page: roi.page });
  }
  return out;
}

function cleanCyrillicWords(text: string): string {
  return normalizeRussianText(text)
    .replace(/[^А-ЯЁ\s-]/gu, " ")
    .replace(/\d/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeDashChars(value: string): string {
  return String(value ?? "").replace(/[–—−]/gu, "-");
}

function normalizeSearchToken(input: string): string {
  const token = normalizeOcrRuText(normalizeDashChars(input))
    .replace(/[^А-ЯЁ0-9№\-]/gu, "")
    .trim();
  return token;
}

type SearchAnchorLabel =
  | "ФАМИЛИЯ"
  | "ИМЯ"
  | "ОТЧЕСТВО"
  | "КЕМ"
  | "ВЫДАН"
  | "ПОДРАЗД"
  | "КОД"
  | "МЕСТО ЖИТЕЛЬСТВА"
  | "ЗАРЕГИСТРИРОВАН";
type SearchAnchorHit = {
  label: SearchAnchorLabel;
  bbox: AnchorBox;
  confidence: number;
  token: string;
};

type SearchPatternCandidate = {
  kind: "dept_code" | "passport_number";
  bbox: AnchorBox;
  confidence: number;
  text: string;
};

function bboxFromWord(word: TsvWord): AnchorBox | null {
  const x0 = Number(word.x0 ?? word.bbox?.x1 ?? NaN);
  const y0 = Number(word.y0 ?? word.bbox?.y1 ?? NaN);
  const x1 = Number(word.x1 ?? word.bbox?.x2 ?? NaN);
  const y1 = Number(word.y1 ?? word.bbox?.y2 ?? NaN);
  if (![x0, y0, x1, y1].every((v) => Number.isFinite(v))) return null;
  const width = Math.max(1, Math.round(x1 - x0));
  const height = Math.max(1, Math.round(y1 - y0));
  return { x: Math.round(x0), y: Math.round(y0), width, height };
}

function unionBboxes(items: AnchorBox[]): AnchorBox | null {
  if (items.length === 0) return null;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    left = Math.min(left, item.x);
    top = Math.min(top, item.y);
    right = Math.max(right, item.x + item.width);
    bottom = Math.max(bottom, item.y + item.height);
  }
  if (![left, top, right, bottom].every((v) => Number.isFinite(v))) return null;
  return { x: Math.round(left), y: Math.round(top), width: Math.max(1, Math.round(right - left)), height: Math.max(1, Math.round(bottom - top)) };
}

function anchorLabelByToken(token: string): SearchAnchorLabel | null {
  if (!token) return null;
  if (/ФАМ/u.test(token)) return "ФАМИЛИЯ";
  if (/^ИМЯ$|^ИМ$/u.test(token)) return "ИМЯ";
  if (/ОТЧ/u.test(token)) return "ОТЧЕСТВО";
  if (/^КЕМ$/u.test(token)) return "КЕМ";
  if (/ВЫД/u.test(token)) return "ВЫДАН";
  if (/ПОДРАЗ/u.test(token)) return "ПОДРАЗД";
  if (/^КОД$/u.test(token)) return "КОД";
  if (/ЗАРЕГИСТР/u.test(token)) return "ЗАРЕГИСТРИРОВАН";
  return null;
}

function findAnchorHits(words: TsvWord[]): SearchAnchorHit[] {
  const hits: SearchAnchorHit[] = [];
  for (const word of words) {
    const bbox = bboxFromWord(word);
    if (bbox === null) continue;
    const token = normalizeSearchToken(word.text);
    const label = anchorLabelByToken(token);
    if (label === null) continue;
    hits.push({
      label,
      bbox,
      confidence: clamp01(Number(word.confidence ?? 0)),
      token
    });
  }
  const lines = groupWordsIntoLines(words);
  for (const line of lines) {
    const lineWords = words.filter((item) => getLineKey(item) === line.key);
    const lineBoxes = lineWords.map((item) => bboxFromWord(item)).filter((item): item is AnchorBox => item !== null);
    const lineBbox = unionBboxes(lineBoxes);
    if (lineBbox === null) continue;
    const lineToken = normalizeSearchToken(line.text.replace(/\s+/gu, ""));
    if (lineToken.includes("МЕСТО") && /ЖИТ/u.test(lineToken)) {
      hits.push({
        label: "МЕСТО ЖИТЕЛЬСТВА",
        bbox: lineBbox,
        confidence: clamp01(line.avgConf),
        token: lineToken
      });
    }
    if (lineToken.includes("ЗАРЕГИСТРИРОВАН") || /ЗАРЕГИСТР/u.test(lineToken)) {
      hits.push({
        label: "ЗАРЕГИСТРИРОВАН",
        bbox: lineBbox,
        confidence: clamp01(line.avgConf),
        token: lineToken
      });
    }
  }
  const byLabel = new Map<SearchAnchorLabel, SearchAnchorHit>();
  for (const hit of hits) {
    const current = byLabel.get(hit.label);
    if (
      current === undefined ||
      hit.confidence > current.confidence ||
      (hit.confidence === current.confidence && hit.bbox.width * hit.bbox.height > current.bbox.width * current.bbox.height)
    ) {
      byLabel.set(hit.label, hit);
    }
  }
  return [...byLabel.values()];
}

function findPatternCandidates(words: TsvWord[]): SearchPatternCandidate[] {
  const candidates: SearchPatternCandidate[] = [];
  for (const word of words) {
    const bbox = bboxFromWord(word);
    if (bbox === null) continue;
    const token = normalizeSearchToken(word.text);
    if (!token) continue;
    const dept = token.match(/(\d{3})-?(\d{3})/u);
    if (dept) {
      candidates.push({
        kind: "dept_code",
        bbox,
        confidence: clamp01(Number(word.confidence ?? 0)),
        text: `${dept[1]}-${dept[2]}`
      });
    }
  }

  const lines = groupWordsIntoLines(words);
  for (const line of lines) {
    const parts = words.filter((word) => getLineKey(word) === line.key);
    const lineBoxes = parts.map((item) => bboxFromWord(item)).filter((item): item is AnchorBox => item !== null);
    const bbox = unionBboxes(lineBoxes);
    if (bbox === null) continue;
    const normalizedLine = normalizeDashChars(line.text).replace(/[^0-9№\- ]/gu, " ").replace(/\s+/gu, " ").trim();
    const withSign = normalizedLine.match(/(\d{4})\s*(?:№|N)?\s*(\d{6})/u);
    if (withSign) {
      candidates.push({
        kind: "passport_number",
        bbox,
        confidence: clamp01(line.avgConf),
        text: `${withSign[1]} №${withSign[2]}`
      });
      continue;
    }
    const compact = normalizedLine.replace(/\D/gu, "");
    const plain = compact.match(/(\d{10})/u);
    if (plain && plain[1] !== undefined) {
      candidates.push({
        kind: "passport_number",
        bbox,
        confidence: clamp01(line.avgConf * 0.9),
        text: `${plain[1].slice(0, 4)} №${plain[1].slice(4)}`
      });
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

function wordsInRoi(words: TsvWord[], roi: RoiRect): TsvWord[] {
  const x2 = roi.x + roi.width;
  const y2 = roi.y + roi.height;
  return words.filter((word) => {
    const x = Number(word.x0 ?? 0);
    const y = Number(word.y0 ?? 0);
    return x >= roi.x && x <= x2 && y >= roi.y && y <= y2;
  });
}

function classifyRegistrationPage(
  words: TsvWord[],
  pageWidth: number,
  pageHeight: number,
  page: number
): {
  pageTypeDetected: "REGISTRATION" | "PASSPORT";
  pageTypeConfidence: number;
  registrationLikely: boolean;
  rois: Array<Record<string, unknown>>;
} {
  const roiA = makeRoi(pageWidth, pageHeight, page, Math.round(pageWidth * 0.15), 0, Math.round(pageWidth * 0.5), Math.round(pageHeight * 0.25));
  const roiB = makeRoi(pageWidth, pageHeight, page, Math.round(pageWidth * 0.55), 0, Math.round(pageWidth * 0.45), Math.round(pageHeight * 0.35));
  const roiC = makeRoi(
    pageWidth,
    pageHeight,
    page,
    Math.round(pageWidth * 0.5),
    Math.round(pageHeight * 0.22),
    Math.round(pageWidth * 0.48),
    Math.round(pageHeight * 0.46)
  );
  const rois: Array<{ key: string; roi: RoiRect }> = [
    { key: "ROI_A", roi: roiA },
    { key: "ROI_B", roi: roiB },
    { key: "ROI_C", roi: roiC }
  ];
  const details = rois.map((item) => {
    const scopedWords = wordsInRoi(words, item.roi);
    const text = normalizeRussianText(scopedWords.map((word) => word.text).join(" "));
    const keywordHits = (text.match(/(МЕСТО|ЖИТЕЛЬСТВ|ЗАРЕГИСТР|РЕГИСТРАЦ|ЗАВЕР)/gu) ?? []).length;
    const cyrChars = (text.match(/[А-ЯЁ]/gu) ?? []).length;
    const compact = text.replace(/\s+/gu, "");
    const cyrRatio = compact.length === 0 ? 0 : cyrChars / compact.length;
    return {
      key: item.key,
      roi: item.roi,
      keywordHits,
      cyrRatio: Number(cyrRatio.toFixed(4)),
      textPreview: text.slice(0, 140)
    };
  });
  const keywordTotal = details.reduce((sum, item) => sum + Number(item.keywordHits ?? 0), 0);
  const cyrAvg = details.reduce((sum, item) => sum + Number(item.cyrRatio ?? 0), 0) / Math.max(1, details.length);
  const confidence = clamp01(keywordTotal * 0.22 + cyrAvg * 0.2);
  const registrationLikely = keywordTotal >= 2 || confidence >= 0.55;
  return {
    pageTypeDetected: registrationLikely ? "REGISTRATION" : "PASSPORT",
    pageTypeConfidence: Number(confidence.toFixed(4)),
    registrationLikely,
    rois: details
  };
}

const REGISTRATION_KEYWORDS = ["ЗАРЕГИСТРИРОВАН", "АДРЕС", "ОБЛ", "ГОР", "УЛ", "Д", "КВ"];

function summarizeRegistrationSignals(words: TsvWord[]): { keywordHits: number; wordCount: number; cyrRatio: number } {
  const text = normalizeRussianText(words.map((word) => word.text).join(" "));
  const wordCount = text.split(/\s+/u).filter(Boolean).length;
  const keywordHits = REGISTRATION_KEYWORDS.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0);
  const cyrRatio = computeRussianCharRatio(text);
  return { keywordHits, wordCount, cyrRatio: Number(cyrRatio.toFixed(4)) };
}

function scoreRegistrationSignals(
  signals: { keywordHits: number; wordCount: number; cyrRatio: number },
  registrationLikely: boolean
): number {
  const base = signals.keywordHits * 2 + signals.cyrRatio + signals.wordCount / 120;
  return Number((base + (registrationLikely ? 0.35 : 0)).toFixed(4));
}

function buildRegistrationFallbackRois(
  pageWidth: number,
  pageHeight: number,
  page: number,
  baseRoi: RoiRect,
  words: TsvWord[]
): Array<{ key: string; roi: RoiRect; reason: string }> {
  const out: Array<{ key: string; roi: RoiRect; reason: string }> = [];
  out.push({
    key: "stamp_top_right",
    roi: makeRoi(pageWidth, pageHeight, page, Math.round(pageWidth * 0.52), Math.round(pageHeight * 0.2), Math.round(pageWidth * 0.44), Math.round(pageHeight * 0.4)),
    reason: "upper-right stamp likelihood"
  });
  out.push({
    key: "stamp_top_right_wide",
    roi: makeRoi(pageWidth, pageHeight, page, Math.round(pageWidth * 0.45), Math.round(pageHeight * 0.1), Math.round(pageWidth * 0.52), Math.round(pageHeight * 0.52)),
    reason: "wide fallback around header and frame"
  });
  out.push({
    key: "base_registration_roi",
    roi: baseRoi,
    reason: "ratio-based fallback roi"
  });
  const zaverWord = words.find((word) => normalizeRussianText(word.text).startsWith("ЗАВЕР"));
  if (zaverWord !== undefined) {
    const x = Number(zaverWord.x0 ?? 0);
    const y = Number(zaverWord.y0 ?? 0);
    out.push({
      key: "around_zaver",
      roi: makeRoi(pageWidth, pageHeight, page, x - 620, y - 520, Math.round(pageWidth * 0.5), Math.round(pageHeight * 0.5)),
      reason: "around detected 'ЗАВЕР' token"
    });
  }
  const uniq = new Map<string, { key: string; roi: RoiRect; reason: string }>();
  for (const item of out) {
    const id = `${item.roi.x}:${item.roi.y}:${item.roi.width}:${item.roi.height}`;
    if (!uniq.has(id)) uniq.set(id, item);
  }
  return [...uniq.values()].slice(0, 5);
}

function computeRegistrationNoiseScore(normalized: string): number {
  const tokens = normalized.split(/\s+/u).filter(Boolean);
  const oneLetter = tokens.filter((token) => token.length === 1).length;
  const nonCyrChars = (normalized.match(/[^А-ЯЁ0-9\s.,-]/gu) ?? []).length;
  const spaces = (normalized.match(/\s/gu) ?? []).length;
  const uniqCounts = tokens.reduce<Record<string, number>>((acc, token) => {
    acc[token] = (acc[token] ?? 0) + 1;
    return acc;
  }, {});
  const repeats = Object.values(uniqCounts).filter((count) => count >= 3).length;

  let score = 0;
  score += Math.min(3, oneLetter * 0.35);
  score += Math.min(2, nonCyrChars * 0.18);
  score += spaces / Math.max(1, normalized.length) < 0.08 ? 1.1 : 0;
  score += Math.min(1.6, repeats * 0.4);
  return Number(score.toFixed(3));
}

function evaluateRegistrationCandidate(raw: string): {
  normalized: string;
  pass: boolean;
  cyrRatio: number;
  lineCount: number;
  wordCount: number;
  keywordHits: number;
  noiseScore: number;
  rejectionReason: string | null;
} {
  const normalized = normalizeRegistrationAnchorCandidate(raw);
  const wordCount = normalized
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2).length;
  const cyrRatio = computeRussianCharRatio(normalized);
  const lineCountRaw = String(raw ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean).length;
  const lineCount = Math.max(lineCountRaw, normalized.split(/[,.]/u).filter((line) => line.trim().length >= 3).length);
  const registrationMarker = /(ЗАРЕГ|ЖИТЕЛЬСТВ|МЕСТО)/u.test(normalized);
  const hasStreetToken = /(УЛИЦ|УЛ\.|ПР-|\bПР\b|ПРОСП|ДОМ|\bД\.\b|\bКВ\b|\bКВ\.\b|Г\.|ЛИТЕР|ЛИТЕРА)/u.test(normalized);
  const hasCityToken = /(ПЕТЕРБУРГ|МОСКВ|ГОРОД|Р-Н|РАЙОН)/u.test(normalized);
  const hasNumber = /\b[0-9О]{1,4}\b/u.test(normalized);
  const addressMarker = hasStreetToken || (hasCityToken && hasNumber);
  const keywordHits = Number(registrationMarker) + Number(addressMarker);
  const noiseScore = computeRegistrationNoiseScore(normalized);
  const pass = registrationMarker && addressMarker && cyrRatio >= 0.2 && lineCount >= 1 && normalized.length >= 20;
  const rejectionReason = pass
    ? null
    : `REGISTRATION_REJECTED:cyr_ratio=${cyrRatio.toFixed(3)};line_count=${lineCount};keyword_hits=${keywordHits}`;
  return {
    normalized,
    pass,
    cyrRatio: Number(cyrRatio.toFixed(4)),
    lineCount,
    wordCount,
    keywordHits,
    noiseScore,
    rejectionReason
  };
}

async function buildPageForSearch(
  pagePath: string,
  tmpDir: string,
  debugDir: string,
  preprocessing:
    | {
        selectedThreshold?: number;
        usedInvert?: boolean;
        rotationDeg?: number;
        deskewAngleDeg?: number;
      }
    | undefined
): Promise<{ pagePath: string; metaPath: string | null; variants: string[] }> {
  const baseGrayPath = join(tmpDir, "page_for_search.base_gray.png");
  const threshPath = join(tmpDir, "page_for_search.thresh.png");
  const threshInvertPath = join(tmpDir, "page_for_search.thresh_invert.png");
  const outPath = join(tmpDir, "page_for_search.png");
  const threshold = clampIntValue(Number(preprocessing?.selectedThreshold ?? 172), 120, 220);
  const invert = Boolean(preprocessing?.usedInvert);

  await sharp(pagePath).grayscale().blur(0.3).png({ compressionLevel: 9 }).toFile(baseGrayPath);
  await sharp(baseGrayPath).threshold(threshold).png({ compressionLevel: 9 }).toFile(threshPath);
  await sharp(threshPath).negate().png({ compressionLevel: 9 }).toFile(threshInvertPath);
  await sharp(invert ? threshInvertPath : threshPath).png({ compressionLevel: 9 }).toFile(outPath);

  if (debugDir === "") {
    return { pagePath: outPath, metaPath: null, variants: [outPath, threshPath, threshInvertPath, baseGrayPath] };
  }

  await sharp(outPath).png().toFile(join(debugDir, "page_for_search.png")).catch(() => undefined);
  await sharp(baseGrayPath).png().toFile(join(debugDir, "base_gray.png")).catch(() => undefined);
  await sharp(threshPath).png().toFile(join(debugDir, "thresh.png")).catch(() => undefined);
  await sharp(threshInvertPath).png().toFile(join(debugDir, "thresh_invert.png")).catch(() => undefined);

  const pageMeta = await sharp(outPath).metadata().catch(() => null);
  const metaPath = join(debugDir, "page_for_search.meta.json");
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        width: pageMeta?.width ?? null,
        height: pageMeta?.height ?? null,
        threshold,
        invert,
        rotation: Number(preprocessing?.rotationDeg ?? 0),
        deskew: Number(preprocessing?.deskewAngleDeg ?? 0)
      },
      null,
      2
    ),
    "utf8"
  ).catch(() => undefined);

  return { pagePath: outPath, metaPath, variants: [outPath, threshPath, threshInvertPath, baseGrayPath] };
}

function renderOverlaySvg(width: number, height: number, items: Array<{ bbox: AnchorBox; label: string; color: string }>): Buffer {
  const body = items
    .map(
      (item) =>
        `<rect x="${item.bbox.x}" y="${item.bbox.y}" width="${Math.max(1, item.bbox.width)}" height="${Math.max(1, item.bbox.height)}" fill="none" stroke="${item.color}" stroke-width="4"/>` +
        `<text x="${item.bbox.x + 6}" y="${Math.max(16, item.bbox.y - 4)}" fill="${item.color}" font-size="24" font-family="Arial">${item.label}</text>`
    )
    .join("");
  return Buffer.from(`<svg width="${width}" height="${height}">${body}</svg>`);
}

async function writeSearchOverlays(
  pagePath: string,
  width: number,
  height: number,
  debugDir: string,
  anchors: SearchAnchorHit[],
  candidates: SearchPatternCandidate[]
): Promise<void> {
  if (debugDir === "") return;
  const anchorSvg = renderOverlaySvg(
    width,
    height,
    anchors.map((item) => ({ bbox: item.bbox, label: item.label, color: "#22c55e" }))
  );
  const candidateSvg = renderOverlaySvg(
    width,
    height,
    candidates.slice(0, 24).map((item) => ({ bbox: item.bbox, label: `${item.kind}:${item.text}`, color: "#f59e0b" }))
  );
  await sharp(pagePath).composite([{ input: anchorSvg, top: 0, left: 0 }]).png().toFile(join(debugDir, "overlay_anchors.png")).catch(() => undefined);
  await sharp(pagePath).composite([{ input: candidateSvg, top: 0, left: 0 }]).png().toFile(join(debugDir, "overlay_candidates.png")).catch(() => undefined);
}

function mergeAnchorBoxes(
  baseAnchorBoxes: Record<string, AnchorBox> | undefined,
  searchAnchors: SearchAnchorHit[]
): Record<string, AnchorBox> {
  const merged: Record<string, AnchorBox> = { ...(baseAnchorBoxes ?? {}) };
  for (const item of searchAnchors) {
    if (merged[item.label] === undefined) {
      merged[item.label] = item.bbox;
    }
  }
  return merged;
}

function buildRoisFromSearchAndAnchors(
  current: Record<PassportField, RoiRect>,
  anchorBoxes: Record<string, AnchorBox>,
  candidates: SearchPatternCandidate[],
  pageWidth: number,
  pageHeight: number
): Record<PassportField, RoiRect> {
  const out = { ...current };
  const findAnchor = (...needles: string[]) => {
    const key = Object.keys(anchorBoxes).find((name) => needles.some((needle) => name.includes(needle)));
    return key ? anchorBoxes[key] : undefined;
  };

  const issuedAnchor = findAnchor("ВЫДАН", "КЕМ");
  if (issuedAnchor !== undefined) {
    out.issued_by = buildIssuedByRoiFromAnchor(issuedAnchor, pageWidth, pageHeight, out.issued_by.page);
  }

  const deptAnchor = findAnchor("КОД", "ПОДРАЗД");
  if (deptAnchor !== undefined) {
    out.passport_number = makeRoi(pageWidth, pageHeight, out.passport_number.page, deptAnchor.x - 80, deptAnchor.y - 130, 880, 130);
    out.dept_code = makeRoi(pageWidth, pageHeight, out.dept_code.page, deptAnchor.x - 30, deptAnchor.y + deptAnchor.height + 6, 520, 120);
  }

  const bestDept = candidates.find((item) => item.kind === "dept_code");
  if (bestDept !== undefined) {
    out.dept_code = makeRoi(
      pageWidth,
      pageHeight,
      out.dept_code.page,
      bestDept.bbox.x - 40,
      bestDept.bbox.y - 24,
      bestDept.bbox.width + 120,
      bestDept.bbox.height + 48
    );
  }
  const bestPassport = candidates.find((item) => item.kind === "passport_number");
  if (bestPassport !== undefined) {
    out.passport_number = makeRoi(
      pageWidth,
      pageHeight,
      out.passport_number.page,
      bestPassport.bbox.x - 120,
      bestPassport.bbox.y - 36,
      Math.max(900, bestPassport.bbox.width + 240),
      Math.max(120, bestPassport.bbox.height + 72)
    );
  }
  return out;
}

export function selectFioFromThreeZones(zoneLines: string[]): string | null {
  if (zoneLines.length !== 3) return null;
  const cleaned = zoneLines
    .map((line) => cleanCyrillicWords(line))
    .filter((line) => line.length >= 3 && line.length <= 30 && !/\d/u.test(line));
  if (cleaned.length !== 3) return null;
  const candidate = cleaned.join(" ").replace(/\s+/gu, " ").trim();
  return validateFio(candidate) ?? null;
}

function normalizeAnchorLineToken(raw: string): string {
  return normalizeRussianText(raw)
    .replace(/[^А-ЯЁЙ\- ]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function validateFioStrictThreeTokens(raw: string): string | null {
  const normalized = normalizeAnchorLineToken(raw);
  if (!normalized || /\d/u.test(normalized)) return null;
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length !== 3) return null;
  if (!tokens.every((token) => /^[А-ЯЁЙ-]{2,}$/u.test(token))) return null;
  return tokens.join(" ");
}

function normalizeRegistrationAnchorCandidate(raw: string): string {
  return normalizeRussianText(raw)
    .replace(/[^А-ЯЁ0-9\s.,\-\/]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function cutToRegistrationBlock(text: string): string {
  const lines = String(text ?? "").split(/\r?\n/u);
  const strictMarker = /ЗАРЕГИСТРИРОВАН/u;
  const fuzzyMarker = /ЗАР[А-ЯЁ\s.\-]{0,20}ВАН/u;

  let idx = -1;
  let markerPos = -1;
  for (const [lineIdx, line] of lines.entries()) {
    const strictPos = line.search(strictMarker);
    if (strictPos >= 0) {
      idx = lineIdx;
      markerPos = strictPos;
      break;
    }
    const fuzzyPos = line.search(fuzzyMarker);
    if (fuzzyPos >= 0 && idx < 0) {
      idx = lineIdx;
      markerPos = fuzzyPos;
    }
  }
  if (idx < 0) return String(text ?? "");

  const fromMarker = lines.slice(idx);
  const firstLine = String(fromMarker[0] ?? "");
  const slicedFirstLine = markerPos > 0 ? firstLine.slice(markerPos) : firstLine;
  fromMarker[0] = slicedFirstLine.replace(/^ЗАР[А-ЯЁ\s.\-]{0,20}ВАН/u, "ЗАРЕГИСТРИРОВАН");
  return fromMarker.join(" ").replace(/\s+/gu, " ").trim();
}

function validateRegistrationAnchorCandidate(raw: string): string | null {
  const normalized = normalizeRegistrationAnchorCandidate(raw);
  if (normalized.length < 25) return null;
  if (computeRussianCharRatio(normalized) <= 0.35) return null;
  if (!/(?:\bГ\.?\b|\bУЛ\.?\b|\bД\.?\b|\bКВ\.?\b|САНКТ-ПЕТЕРБУРГ)/u.test(normalized)) return null;
  return normalized;
}

function buildFioLineRoi(anchor: AnchorBox, pageWidth: number, pageHeight: number, page: number): RoiRect {
  const x = anchor.x + anchor.width + 20;
  const y = anchor.y - 15;
  const width = Math.max(260, pageWidth - x - 40);
  const height = anchor.height + 40;
  return makeRoi(pageWidth, pageHeight, page, x, y, width, height);
}

function buildIssuedByRoiFromAnchor(anchor: AnchorBox, pageWidth: number, pageHeight: number, page: number): RoiRect {
  const x = anchor.x - 50;
  const y = anchor.y + anchor.height + 10;
  const width = Math.round(pageWidth * 0.8);
  const height = 220;
  return makeRoi(pageWidth, pageHeight, page, x, y, width, height);
}

function buildRegistrationRoiFromAnchor(anchor: AnchorBox, pageWidth: number, pageHeight: number, page: number): RoiRect {
  const padLeft = 200;
  const padRight = 250;
  const stampTop = anchor.y;
  const ratio = anchor.width / Math.max(1, anchor.height);
  const mult = clampIntValue(Math.round(ratio), 5, 10);
  const stampBottomEstimate = stampTop + anchor.height * mult;

  const roiX = Math.max(0, anchor.x - padLeft);
  const roiY = Math.max(0, stampTop - 10);

  const roiWidth = Math.min(pageWidth - roiX, anchor.width + padLeft + padRight);
  const roiHeight = Math.min(pageHeight - roiY, stampBottomEstimate - roiY);

  return makeRoi(pageWidth, pageHeight, page, roiX, roiY, roiWidth, roiHeight);
}

async function ocrSingleLineToken(params: {
  pagePath: string;
  roi: RoiRect;
  tmpDir: string;
  lang: string;
  timeoutMs: number;
  debugDir: string;
  debugPrefix: string;
}): Promise<{ token: string | null; raw: string; roi: RoiRect }> {
  const base = `${params.debugPrefix}_${params.roi.x}_${params.roi.y}_${params.roi.width}_${params.roi.height}`;
  const cropPath = join(params.tmpDir, `${base}_before.png`);
  const prePath = join(params.tmpDir, `${base}_after.png`);
  await cropToFile(params.pagePath, params.roi, cropPath);
  await preprocessForOcr(cropPath, prePath, "text_v2");
  if (params.debugDir !== "") {
    await sharp(cropPath).png().toFile(join(params.debugDir, `${params.debugPrefix}_before.png`)).catch(() => undefined);
    await sharp(prePath).png().toFile(join(params.debugDir, `${params.debugPrefix}_after.png`)).catch(() => undefined);
  }
  const [raw7, raw8] = await Promise.all([
    runTesseractPlain(prePath, params.lang, params.timeoutMs, 7),
    runTesseractPlain(prePath, params.lang, params.timeoutMs, 8)
  ]);
  const bestRaw =
    normalizeAnchorLineToken(raw7).replace(/\s+/gu, "").length >= normalizeAnchorLineToken(raw8).replace(/\s+/gu, "").length
      ? raw7
      : raw8;
  const token = normalizeAnchorLineToken(bestRaw).split(" ").filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? "";
  const validToken = /^[А-ЯЁЙ-]{2,}$/u.test(token) && !/\d/u.test(token) ? token : null;
  return { token: validToken, raw: String(bestRaw ?? "").trim(), roi: params.roi };
}

async function saveAnchorRoiDebugCrop(
  pagePath: string,
  roi: RoiRect,
  debugDir: string,
  name: string
): Promise<void> {
  if (debugDir === "") return;
  const safeName = name.replace(/[^a-zA-Z0-9_-]+/gu, "_");
  await cropToFile(pagePath, roi, join(debugDir, `${safeName}.png`)).catch(() => undefined);
}

function buildIssuedByAnchorCandidate(
  words: TsvWord[],
  issuedAnchor: SearchAnchorHit,
  stopAnchor: SearchAnchorHit | null
): {
  value: string;
  confidence: number;
  lines: Array<{ y: number; text: string; avgConf: number }>;
} | null {
  const lines = groupWordsIntoLines(words)
    .map((line) => ({
      y: line.y,
      text: normalizeRussianText(line.text).replace(/\s+/gu, " ").trim(),
      avgConf: line.avgConf
    }))
    .filter((line) => line.text.length >= 4);
  const yStart = issuedAnchor.bbox.y + issuedAnchor.bbox.height + 2;
  const yStop = stopAnchor !== null ? stopAnchor.bbox.y - 4 : yStart + 360;
  const selected = lines.filter((line) => line.y >= yStart && line.y <= yStop).slice(0, 8);
  if (selected.length === 0) return null;
  const joined = selected.map((line) => line.text).join(" ").replace(/\s+/gu, " ").trim();
  if (joined.length < 8) return null;
  return {
    value: joined,
    confidence: selected.reduce((sum, line) => sum + line.avgConf, 0) / selected.length,
    lines: selected
  };
}

async function resolveRoisWithAnchorFirst(
  normalized: Awaited<ReturnType<typeof FormatNormalizer.normalize>>,
  logger: AuditLogger,
  width: number,
  height: number,
  pageIndex: number
): Promise<{
  rois: Record<PassportField, RoiRect>;
  anchorKeys: Set<string>;
  anchorsFoundCount: number;
  anchorKeysTop: string[];
  fallbackUsed: boolean;
  anchorBoxes?: Record<string, AnchorBox>;
  deptCodeAnchorBox?: AnchorBox;
}> {
  const fallback: Record<PassportField, RoiRect> = {
    fio: roiFromRatios("fio", width, height, pageIndex),
    passport_number: roiFromRatios("passport_number", width, height, pageIndex),
    issued_by: roiFromRatios("issued_by", width, height, pageIndex),
    dept_code: roiFromRatios("dept_code", width, height, pageIndex),
    registration: roiFromRatios("registration", width, height, pageIndex)
  };
  try {
    const detection = await DocumentDetector.detect(normalized, logger);
    const calibration = await PerspectiveCalibrator.calibrate(normalized, detection, logger);
    const anchors = await AnchorModel.findAnchors(normalized, detection, calibration, logger, false);
    const anchorKeysAll = Object.keys(anchors.anchors);
    const deptCodeAnchorKey = Object.keys(anchors.anchorBoxes ?? {}).find((key) => key.includes("КОД"));
    const deptCodeAnchorBox = deptCodeAnchorKey ? anchors.anchorBoxes?.[deptCodeAnchorKey] : undefined;
    const anchorsFoundCount = anchorKeysAll.length;
    const anchorKeysTop = anchorKeysAll.slice(0, 10);
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "info",
      message: "Anchor model scan completed.",
      data: {
        anchorsFoundCount,
        anchorKeys: anchorKeysTop,
        fallbackStatic: Boolean(anchors.usedFallbackGrid)
      }
    });
    const mapped = await DynamicROIMapper.map(normalized, detection, calibration, anchors, logger, pageIndex);
    const fromAnchors: Partial<Record<PassportField, RoiRect>> = {};
    for (const item of mapped) {
      fromAnchors[item.field] = item.roi;
    }
    const fallbackUsed =
      anchors.usedFallbackGrid ||
      FIELD_ORDER.some((field) => fromAnchors[field] === undefined) ||
      anchorsFoundCount === 0;
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "info",
      message: "Anchor-first ROI audit.",
      data: {
        anchorsFoundCount,
        anchorKeys: anchorKeysTop,
        fallbackUsed,
        deptCodeAnchorKey: deptCodeAnchorKey ?? null
      }
    });
    if (anchorsFoundCount === 0) {
      logger.log({
        ts: Date.now(),
        stage: "extractor",
        level: "debug",
        message: "Anchor-first ROI fallback to static.",
        data: {
          reason: "no_anchors_found",
          fallbackUsed: true
        }
      });
      return {
        rois: fallback,
        anchorKeys: new Set<string>(),
        anchorsFoundCount,
        anchorKeysTop,
        fallbackUsed: true,
        ...(anchors.anchorBoxes === undefined ? {} : { anchorBoxes: anchors.anchorBoxes }),
        ...(deptCodeAnchorBox === undefined ? {} : { deptCodeAnchorBox })
      };
    }
    const rois: Record<PassportField, RoiRect> = {
      fio: fromAnchors.fio ?? fallback.fio,
      passport_number: fromAnchors.passport_number ?? fallback.passport_number,
      issued_by: fromAnchors.issued_by ?? fallback.issued_by,
      dept_code: fromAnchors.dept_code ?? fallback.dept_code,
      registration: fromAnchors.registration ?? fallback.registration
    };
    return {
      rois,
      anchorKeys: new Set(anchorKeysAll),
      anchorsFoundCount,
      anchorKeysTop,
      fallbackUsed,
      ...(anchors.anchorBoxes === undefined ? {} : { anchorBoxes: anchors.anchorBoxes }),
      ...(deptCodeAnchorBox === undefined ? {} : { deptCodeAnchorBox })
    };
  } catch (error) {
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "warn",
      message: "Anchor-first ROI mapping failed. Falling back to static ROI grid.",
      data: { reason: error instanceof Error ? error.message : "unknown_error" }
    });
    logger.log({
      ts: Date.now(),
      stage: "extractor",
      level: "debug",
      message: "Anchor-first ROI fallback to static.",
      data: {
        reason: error instanceof Error ? error.message : "anchor_mapping_failure",
        fallbackUsed: true
      }
    });
    return {
      rois: fallback,
      anchorKeys: new Set<string>(),
      anchorsFoundCount: 0,
      anchorKeysTop: [],
      fallbackUsed: true
    };
  }
}

function makeRankedCandidate(params: {
  field: PassportField;
  pass_id: "A" | "B" | "C";
  source: BestCandidateSource;
  psm: number;
  raw: string;
  normalized: string;
  confidence: number;
  anchorAlignmentScore: number;
  regex?: RegExp | null;
  markerMatch?: number;
  validatedOverride?: string | null;
}): RankedCandidate {
  const validated = params.validatedOverride === undefined ? validateByField(params.field, params.normalized) : params.validatedOverride;
  return {
    field: params.field,
    pass_id: params.pass_id,
    source: params.source,
    psm: params.psm,
    raw_text_preview: params.raw.slice(0, 120),
    normalized_preview: params.normalized.slice(0, 120),
    confidence: clamp01(params.confidence),
    regexMatch:
      params.regex === null || params.regex === undefined
        ? validated !== null
          ? 1
          : 0
        : params.regex.test(params.normalized)
          ? 1
          : 0,
    markerMatch: clamp01(params.markerMatch ?? textMarkerScore(params.field, params.normalized)),
    lengthScore: computeLengthScore(params.field, params.normalized),
    russianCharRatio: computeRussianCharRatio(params.normalized),
    anchorAlignmentScore: clamp01(params.anchorAlignmentScore),
    rankingScore: 0,
    validated
  };
}

export class RfInternalPassportExtractor {
  static async extract(input: InputFile, opts?: ExtractOptions): Promise<ExtractionResult> {
    const options = normalizeOptions(opts);
    const logger = options.logger;
    const errors: CoreError[] = [];
    let tmp: string | null = null;

    try {
      logger.log({
        ts: Date.now(),
        stage: "extractor",
        level: "info",
        message: "RF internal passport extraction started"
      });

      const normalized = await FormatNormalizer.normalize(input, options, logger);
      logger.log({
        ts: Date.now(),
        stage: "extractor",
        level: "info",
        message: "Normalized pages prepared.",
        data: {
          pdfPageRange: options.pdfPageRange ?? null,
          normalized_pages: normalized.pages.map((page) => ({
            pageNumber: page.pageNumber,
            width: page.width,
            height: page.height,
            hasImagePath: page.imagePath !== null
          }))
        }
      });

      if (normalized.mockLayout) {
        return buildMockResult(normalized.mockLayout as any, logger);
      }

      const page0 = normalized.pages && normalized.pages[0];
      const pagePath = page0?.imagePath ?? null;

      if (!pagePath) {
        errors.push({ code: "INTERNAL_ERROR", message: "Normalized page image is missing." });
        const out = {
          ...BASE_RESULT,
          confidence_score: 0,
          field_reports: FIELD_ORDER.map((f) =>
            emptyFieldReport(f, { x: 0, y: 0, width: 0, height: 0, page: 0 }, "none")
          ),
          errors
          // diagnostics omitted intentionally (exactOptionalPropertyTypes)
        };
        return ExtractionResultSchema.parse(out);
      }

      const pageMeta = normalized.pages?.[0];
      const fallbackW = pageMeta?.width ?? normalized.width ?? 0;
      const fallbackH = pageMeta?.height ?? normalized.height ?? 0;
      const normalizedPageNumber = pageMeta?.pageNumber ?? 0;
      const pageIndex = Math.max(0, Math.floor(normalizedPageNumber));

      const width = normalized.width || fallbackW;
      const height = normalized.height || fallbackH;

      tmp = await mkdtemp(join(tmpdir(), "keiscore-rfpass-"));

      const { rois: resolvedRois, anchorKeys, anchorsFoundCount, anchorKeysTop, fallbackUsed, deptCodeAnchorBox, anchorBoxes } =
        await resolveRoisWithAnchorFirst(normalized, logger, width, height, pageIndex);
      const debugDir = process.env.KEISCORE_DEBUG_ROI_DIR ? String(process.env.KEISCORE_DEBUG_ROI_DIR).trim() : "";
      if (debugDir !== "") {
        await mkdir(debugDir, { recursive: true }).catch(() => undefined);
      }
      const pageForSearchBuilt = await buildPageForSearch(pagePath, tmp, debugDir, normalized.preprocessing);
      const pageForSearchPath = pageForSearchBuilt.pagePath;
      const pageForSearchBest = await runTesseractWithFallback(
        pageForSearchBuilt.variants,
        options.tesseractLang ?? "rus",
        options.ocrTimeoutMs ?? 30_000,
        debugDir
      );
      const pageForSearchWords = parseTsvWords(pageForSearchBest.tsv)
        .sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0));
      const pageForSearchOcrEmpty = pageForSearchWords.length === 0;
      const pageForSearchErr = String(pageForSearchBest.stderr ?? "").trim();
      if (pageForSearchOcrEmpty && debugDir !== "") {
        await writeFile(join(debugDir, "tesseract.err.txt"), `${pageForSearchErr}\n`, "utf8").catch(() => undefined);
      }
      const pageType = classifyRegistrationPage(pageForSearchWords, width, height, pageIndex);
      const searchAnchorHits = findAnchorHits(pageForSearchWords);
      const searchPatternCandidates = findPatternCandidates(pageForSearchWords);
      await writeSearchOverlays(pageForSearchPath, width, height, debugDir, searchAnchorHits, searchPatternCandidates);

      const mergedAnchorBoxes = mergeAnchorBoxes(anchorBoxes, searchAnchorHits);
      const effectiveDeptCodeAnchorBox =
        deptCodeAnchorBox ?? pickAnchorBoxByKey(mergedAnchorBoxes, "КОД") ?? pickAnchorBoxByKey(mergedAnchorBoxes, "ПОДРАЗД");
      let rois =
        options.ocrVariant === "v2"
          ? buildVariant2RoisFromAnchors(resolvedRois, mergedAnchorBoxes, width, height)
          : buildRoisFromSearchAndAnchors(resolvedRois, mergedAnchorBoxes, searchPatternCandidates, width, height);
      const thresholdStrategyUsed = normalized.preprocessing?.thresholdStrategy ?? "legacy";
      const useVariant2 = options.ocrVariant === "v2";
      if (useVariant2) {
        rois = buildRoisFromSearchAndAnchors(rois, mergedAnchorBoxes, searchPatternCandidates, width, height);
      }
      const variant2AnchorRoiUsed = useVariant2 && Object.keys(mergedAnchorBoxes).length > 0;
      const registrationAuditBase = {
        anchorKeywordTried: "ЗАРЕГИСТРИРОВАН",
        pageIndex,
        pageCount: normalized.pages?.length ?? 1,
        hint: "Проверьте, что в документе есть страница со штампом регистрации (обычно стр. 4–5)."
      };
      const extractorAudit: {
        anchorsFoundCount: number;
        anchorKeys: string[];
        fallbackUsed: boolean;
        fields: Record<
          PassportField,
          {
            roiSource: "anchor" | "ratio";
            chosenPass: string;
            chosenSweep: string;
            bestCandidatePreview: string;
          }
        >;
      } = {
        anchorsFoundCount,
        anchorKeys: [...anchorKeysTop, ...searchAnchorHits.map((item) => item.label)].slice(0, 20),
        fallbackUsed,
        fields: {
          passport_number: { roiSource: variant2AnchorRoiUsed || !fallbackUsed ? "anchor" : "ratio", chosenPass: "", chosenSweep: "", bestCandidatePreview: "" },
          dept_code: { roiSource: variant2AnchorRoiUsed || effectiveDeptCodeAnchorBox !== undefined || !fallbackUsed ? "anchor" : "ratio", chosenPass: "", chosenSweep: "", bestCandidatePreview: "" },
          fio: { roiSource: variant2AnchorRoiUsed || !fallbackUsed ? "anchor" : "ratio", chosenPass: "", chosenSweep: "", bestCandidatePreview: "" },
          issued_by: { roiSource: variant2AnchorRoiUsed || !fallbackUsed ? "anchor" : "ratio", chosenPass: "", chosenSweep: "", bestCandidatePreview: "" },
          registration: { roiSource: variant2AnchorRoiUsed || !fallbackUsed ? "anchor" : "ratio", chosenPass: "", chosenSweep: "", bestCandidatePreview: "" }
        }
      };
      const detailedAudit: {
        anchors: Array<{ label: string; confidence: number; bbox: AnchorBox }>;
        fio: Record<string, unknown>;
        registration: Record<string, unknown>;
        pageForSearch: Record<string, unknown>;
      } = {
        anchors: searchAnchorHits.map((item) => ({
          label: item.label,
          confidence: Number(item.confidence.toFixed(4)),
          bbox: item.bbox
        })),
        fio: { strategy: "anchor_lines", status: "pending" },
        registration: { ...registrationAuditBase, strategy: "anchor_below_sweep", status: "pending" },
        pageForSearch: {
          tesseractEmpty: pageForSearchOcrEmpty,
          metaPath: pageForSearchBuilt.metaPath,
          pageTypeDetected: pageType.pageTypeDetected,
          pageTypeConfidence: pageType.pageTypeConfidence,
          roiSignals: pageType.rois,
          ocrAttempts: pageForSearchBest.attempts
        }
      };
      (normalized.preprocessing ??= {
        applied: true,
        selectedThreshold: 0,
        rotationDeg: 0,
        orientationScore: 0,
        deskewAngleDeg: 0,
        blackPixelRatio: 0
      } as NonNullable<typeof normalized.preprocessing>);
      (normalized.preprocessing as Record<string, unknown>).page_for_search_path = debugDir === "" ? pageForSearchPath : join(debugDir, "page_for_search.png");
      (normalized.preprocessing as Record<string, unknown>).page_for_search_metrics = {
        blackPixelRatio: Number(normalized.preprocessing.blackPixelRatio ?? 0),
        contrastScore: Number(normalized.quality_metrics.contrast_score ?? 0),
        anchorsDetected: searchAnchorHits.length,
        patternCandidatesDetected: searchPatternCandidates.length
      };

      if (debugDir) {
        try {
          const overlay = await sharp(pagePath)
            .composite(
              Object.values(rois).map((r) => ({
                input: Buffer.from(
                  `<svg width="${width}" height="${height}"><rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="none" stroke="#00FF88" stroke-width="6"/></svg>`
                ),
                top: 0,
                left: 0
              }))
            )
            .png()
            .toBuffer();
          await writeFile(join(debugDir, "overlay_zones.png"), overlay);
          await sharp(pagePath).png().toFile(join(debugDir, "normalized_page.png"));
          for (const [field, roi] of Object.entries(rois) as Array<[PassportField, RoiRect]>) {
            await cropToFile(pagePath, roi, join(debugDir, `${field}.png`));
          }
          await writeFile(
            join(debugDir, "roi_bbox_overlay.json"),
            JSON.stringify(
              {
                width,
                height,
                rois
              },
              null,
              2
            ),
            "utf8"
          );
          await writeFile(
            join(debugDir, "extractor_anchor_audit.json"),
            JSON.stringify(
              {
                anchorsFoundCount,
                anchorKeys: [...anchorKeysTop, ...searchAnchorHits.map((item) => item.label)].slice(0, 20),
                fallbackUsed,
                deptCodeAnchorBox: effectiveDeptCodeAnchorBox ?? null,
                page_for_search_path: (normalized.preprocessing as Record<string, unknown>).page_for_search_path ?? null,
                page_for_search_metrics: (normalized.preprocessing as Record<string, unknown>).page_for_search_metrics ?? null
              },
              null,
              2
            ),
            "utf8"
          );
        } catch {
          // ignore
        }
      }

      const runRegistrationExtraction = async (params: {
        pagePath: string;
        width: number;
        height: number;
        rois: Record<PassportField, RoiRect>;
        anchorKeys: Set<string>;
        pageType: ReturnType<typeof classifyRegistrationPage>;
        pageForSearchWords: TsvWord[];
        searchAnchorHits: ReturnType<typeof findAnchorHits>;
        useVariant2: boolean;
        thresholdStrategyUsed: string;
        tmpDir: string;
        debugDir: string;
        fallbackUsed: boolean;
        variant2AnchorRoiUsed: boolean;
        registrationAuditBase: Record<string, unknown>;
        options: ReturnType<typeof normalizeOptions>;
      }): Promise<{
        fieldReport: FieldReport;
        detailedAuditRegistration: Record<string, unknown>;
        extractorField: { roiSource: "anchor" | "ratio"; chosenPass: string; chosenSweep: string; bestCandidatePreview: string };
        bestValidated: string | null;
      }> => {
        const field: PassportField = "registration";
        const roi = params.rois[field];
        const attempts: NonNullable<FieldReport["attempts"]> = [];
        const ranked: RankedCandidate[] = [];
        const anchorAlignmentScore = anchorScoreForField(field, params.anchorKeys);
        const regAnchor =
          params.searchAnchorHits.find((item) => item.label === "МЕСТО ЖИТЕЛЬСТВА") ??
          params.searchAnchorHits.find((item) => item.label === "ЗАРЕГИСТРИРОВАН") ??
          null;
        const sweepAudit: Array<Record<string, unknown>> = [];
        let registrationRejectReason: string | null = null;
        const psms = [4, 6, 11];
        let detailedAuditRegistration: Record<string, unknown> = { ...params.registrationAuditBase };
        if (regAnchor !== null) {
          const baseRegRoi = buildRegistrationRoiFromAnchor(regAnchor.bbox, params.width, params.height, roi.page);
          await saveAnchorRoiDebugCrop(params.pagePath, baseRegRoi, params.debugDir, "anchor_roi_registration");
          if (params.debugDir !== "") {
            const baseRegCropPath = join(params.tmpDir, "registration_roi.png");
            await cropToFile(params.pagePath, baseRegRoi, baseRegCropPath);
            await sharp(baseRegCropPath).png().toFile(join(params.debugDir, "registration_roi.png")).catch(() => undefined);
          }
          const yOffsets: number[] = [];
          for (let offset = -200; offset <= 200; offset += 20) yOffsets.push(offset);
          yOffsets.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
          sweepLoop: for (const yOffset of yOffsets) {
            const xSweeps = buildRegistrationXSweeps(
              baseRegRoi,
              params.width,
              params.height,
              await detectRegistrationContentRightEdge(params.pagePath, baseRegRoi)
            );
            const baseSweep = xSweeps[0];
            if (!baseSweep) continue;
            const sweepRoi = shiftRoiVertical(baseSweep.roi, yOffset, params.height);
            const sweepCropPath = join(params.tmpDir, `registration_sweep_${yOffset}_before.png`);
            const sweepPrePath = join(params.tmpDir, `registration_sweep_${yOffset}_after.png`);
            await cropToFile(params.pagePath, sweepRoi, sweepCropPath);
            await preprocessForOcr(sweepCropPath, sweepPrePath, "text_v2");
            if (params.debugDir !== "") {
              await sharp(sweepCropPath).png().toFile(join(params.debugDir, `registration_sweep_${yOffset}_before.png`)).catch(() => undefined);
              await sharp(sweepPrePath).png().toFile(join(params.debugDir, `registration_sweep_${yOffset}_after.png`)).catch(() => undefined);
              await sharp(sweepCropPath).png().toFile(join(params.debugDir, "registration_roi.png")).catch(() => undefined);
              await sharp(sweepPrePath).png().toFile(join(params.debugDir, "registration_pre.png")).catch(() => undefined);
              await sharp(sweepPrePath).sharpen(0.18).png().toFile(join(params.debugDir, "registration_post.png")).catch(() => undefined);
            }
            const sweepCandidates: Array<{
              sweep: string;
              psm: number;
              raw: string;
              evaluation: ReturnType<typeof evaluateRegistrationCandidate>;
              candidatePreview: string;
              validated: string | null;
              confidence: number;
              roi: RoiRect;
            }> = [];
            for (const sweep of xSweeps) {
              const xSweepRoi = shiftRoiVertical(sweep.roi, yOffset, params.height);
              const xSweepCrop = join(params.tmpDir, `registration_sweep_${yOffset}_${sweep.sweep}_before.png`);
              const xSweepPre = join(params.tmpDir, `registration_sweep_${yOffset}_${sweep.sweep}_after.png`);
              await cropToFile(params.pagePath, xSweepRoi, xSweepCrop);
              await preprocessForOcr(xSweepCrop, xSweepPre, "text_v2");
              for (const psm of psms) {
                const raw = await runTesseractPlain(
                  xSweepPre,
                  params.options.tesseractLang ?? "rus",
                  params.options.ocrTimeoutMs ?? 30_000,
                  psm
                );
                const registrationBlockText = cutToRegistrationBlock(raw);
                const evaluation = evaluateRegistrationCandidate(registrationBlockText);
                const normalized = evaluation.normalized;
                const candidatePreview = normalizeNumericArtifacts(normalized);
                const validatorResult = evaluation.pass ? validateRegistration(candidatePreview) : null;
                const validated = validatorResult !== null ? candidatePreview : null;
                const confidence = psm === 6 ? 0.36 : 0.32;
                sweepCandidates.push({
                  sweep: sweep.sweep,
                  psm,
                  raw: registrationBlockText,
                  evaluation,
                  candidatePreview,
                  validated,
                  confidence,
                  roi: xSweepRoi
                });
              }
            }
            const bestSweepCandidate = sweepCandidates.sort((a, b) => {
              return (
                b.evaluation.keywordHits - a.evaluation.keywordHits ||
                b.evaluation.cyrRatio - a.evaluation.cyrRatio ||
                (b.evaluation.wordCount - b.evaluation.noiseScore) - (a.evaluation.wordCount - a.evaluation.noiseScore)
              );
            })[0];
            if (bestSweepCandidate !== undefined) {
              registrationRejectReason = bestSweepCandidate.evaluation.rejectionReason ?? registrationRejectReason;
              attempts.push({
                pass_id: "C",
                raw_text_preview: `${yOffset} ${bestSweepCandidate.raw}`.slice(0, 120),
                normalized_preview: bestSweepCandidate.candidatePreview.slice(0, 120),
                source: "zonal_tsv",
                confidence: bestSweepCandidate.confidence,
                psm: bestSweepCandidate.psm
              });
              ranked.push(
                makeRankedCandidate({
                  field,
                  pass_id: "C",
                  source: "zonal_tsv",
                  psm: bestSweepCandidate.psm,
                  raw: bestSweepCandidate.raw,
                  normalized: bestSweepCandidate.validated ?? bestSweepCandidate.candidatePreview,
                  confidence: bestSweepCandidate.confidence,
                  anchorAlignmentScore: Math.max(anchorAlignmentScore, 0.94),
                  markerMatch:
                    bestSweepCandidate.validated !== null
                      ? 1
                      : Math.min(1, bestSweepCandidate.evaluation.keywordHits / 2),
                  validatedOverride: bestSweepCandidate.validated
                })
              );
              sweepAudit.push({
                yOffset,
                sweep: bestSweepCandidate.sweep,
                psm: bestSweepCandidate.psm,
                roi: bestSweepCandidate.roi,
                candidatePreview: bestSweepCandidate.candidatePreview.slice(0, 120),
                validatorPassed: bestSweepCandidate.validated !== null,
                rejectionReason: bestSweepCandidate.evaluation.rejectionReason,
                cyr_ratio: bestSweepCandidate.evaluation.cyrRatio,
                line_count: bestSweepCandidate.evaluation.lineCount,
                word_count: bestSweepCandidate.evaluation.wordCount,
                keyword_hits: bestSweepCandidate.evaluation.keywordHits
              });
              if (bestSweepCandidate.validated !== null) {
                break sweepLoop;
              }
            }
          }
          detailedAuditRegistration = {
            ...params.registrationAuditBase,
            strategy: "anchor_below_sweep",
            status: ranked.some((candidate) => candidate.validated !== null) ? "accepted" : "rejected",
            anchor: {
              label: regAnchor.label,
              bbox: regAnchor.bbox,
              confidence: Number(regAnchor.confidence.toFixed(4))
            },
            sweeps: sweepAudit
          };
        } else if (params.pageType.registrationLikely) {
          const candidateRois = buildRegistrationFallbackRois(
            params.width,
            params.height,
            roi.page,
            roi,
            params.pageForSearchWords
          );
          const recommendedRight = await detectRegistrationContentRightEdge(params.pagePath, roi);
          const triedRois: Array<Record<string, unknown>> = [];
          for (const [index, candidate] of candidateRois.entries()) {
            const sweeps = buildRegistrationXSweeps(candidate.roi, params.width, params.height, recommendedRight);
            for (const sweep of sweeps) {
              const cropPath = join(params.tmpDir, `registration_fallback_${index}_${sweep.sweep}_before.png`);
              const prePath = join(params.tmpDir, `registration_fallback_${index}_${sweep.sweep}_pre.png`);
              await cropToFile(params.pagePath, sweep.roi, cropPath);
              await preprocessForOcr(cropPath, prePath, "text_v2");
              if (params.debugDir !== "") {
                await sharp(cropPath).png().toFile(join(params.debugDir, "registration_roi.png")).catch(() => undefined);
                await sharp(prePath).png().toFile(join(params.debugDir, "registration_pre.png")).catch(() => undefined);
                await sharp(prePath).sharpen(0.18).png().toFile(join(params.debugDir, "registration_post.png")).catch(() => undefined);
              }
              for (const psm of psms) {
                const raw = await runTesseractPlain(
                  prePath,
                  params.options.tesseractLang ?? "rus",
                  Math.min(params.options.ocrTimeoutMs ?? 30_000, 12_000),
                  psm
                );
                const registrationBlockText = cutToRegistrationBlock(raw);
                const evaluation = evaluateRegistrationCandidate(registrationBlockText);
                const normalized = evaluation.normalized;
                const candidatePreview = normalizeNumericArtifacts(normalized);
                const validatorResult = evaluation.pass ? validateRegistration(candidatePreview) : null;
                const validated = validatorResult !== null ? candidatePreview : null;
                const confidence = psm === 6 ? 0.34 : psm === 11 ? 0.3 : 0.28;
                registrationRejectReason = evaluation.rejectionReason ?? registrationRejectReason;
                attempts.push({
                  pass_id: "C",
                  raw_text_preview: `${candidate.key}/${sweep.sweep} ${registrationBlockText}`.slice(0, 120),
                  normalized_preview: candidatePreview.slice(0, 120),
                  source: "zonal_tsv",
                  confidence,
                  psm
                });
                ranked.push(
                  makeRankedCandidate({
                    field,
                    pass_id: "C",
                    source: "zonal_tsv",
                    psm,
                    raw: registrationBlockText,
                    normalized: validated ?? candidatePreview,
                    confidence,
                    anchorAlignmentScore: Math.max(anchorAlignmentScore, 0.68),
                    markerMatch: validated !== null ? 1 : Math.min(1, evaluation.keywordHits / 2),
                    validatedOverride: validated
                  })
                );
                triedRois.push({
                  roiKey: `${candidate.key}/${sweep.sweep}`,
                  reason: candidate.reason,
                  roi: sweep.roi,
                  psm,
                  candidatePreview: candidatePreview.slice(0, 120),
                  validatorPassed: validated !== null,
                  rejectionReason: evaluation.rejectionReason,
                  cyr_ratio: evaluation.cyrRatio,
                  line_count: evaluation.lineCount,
                  word_count: evaluation.wordCount,
                  keyword_hits: evaluation.keywordHits
                });
              }
            }
          }
          detailedAuditRegistration = {
            ...params.registrationAuditBase,
            strategy: "classifier_fallback_sweep",
            status: ranked.some((candidate) => candidate.validated !== null) ? "accepted" : "rejected",
            reason: "REGISTRATION_PAGE_CLASSIFIED",
            pageTypeDetected: params.pageType.pageTypeDetected,
            pageTypeConfidence: params.pageType.pageTypeConfidence,
            roisTried: triedRois
          };
        } else {
          detailedAuditRegistration = {
            ...params.registrationAuditBase,
            strategy: "anchor_below_sweep",
            status: "NOT_PRESENT_IN_DOCUMENT",
            reason: "REGISTRATION_ANCHOR_NOT_FOUND",
            reasonHuman: "На этой странице нет штампа регистрации: ключевое слово \"ЗАРЕГИСТРИРОВАН\" не найдено.",
            pageTypeDetected: params.pageType.pageTypeDetected,
            pageTypeConfidence: params.pageType.pageTypeConfidence,
            sweeps: []
          };
        }
        const rankedTop = params.useVariant2 ? rankCandidatesVariant2(ranked) : rankCandidates(ranked);
        const best = rankedTop[0];
        const fieldReport = bestCandidateReport(
          field,
          roi,
          attempts,
          {
            preview: best?.normalized_preview ?? "",
            normalized: best?.validated ?? "",
            confidence: best?.confidence ?? 0,
            source: (best?.source ?? "roi") as BestCandidateSource,
            pass_id: best?.pass_id ?? "C",
            selectedPass: best?.pass_id ?? "C",
            rankingScore: best?.rankingScore ?? 0,
            anchorAlignmentScore: best?.anchorAlignmentScore ?? anchorAlignmentScore,
            thresholdStrategyUsed: params.thresholdStrategyUsed,
            validator_passed: (best?.validated ?? null) !== null,
            rejection_reason: (best?.validated ?? null) === null ? (registrationRejectReason ?? "FIELD_NOT_CONFIRMED") : null
          },
          rankedTop.slice(0, 3)
        );
        const extractorField = {
          roiSource: (params.variant2AnchorRoiUsed || !params.fallbackUsed ? "anchor" : "ratio") as "anchor" | "ratio",
          chosenPass: best?.pass_id ?? "C",
          chosenSweep: "base",
          bestCandidatePreview: best?.normalized_preview ?? ""
        };
        return {
          fieldReport,
          detailedAuditRegistration,
          extractorField,
          bestValidated: best?.validated ?? null
        };
      };

      const fieldReports: FieldReport[] = [];
      const fieldDebug: Record<string, any> = {};
      let registrationBestValidated: string | null = null;
      let registrationFieldReportIndex = -1;

      // passport_number
      {
        const field: PassportField = "passport_number";
        const roi = rois[field];
        const attempts: NonNullable<FieldReport["attempts"]> = [];
        const ranked: RankedCandidate[] = [];
        const anchorAlignmentScore = anchorScoreForField(field, anchorKeys);
        const pagePatternPassport = searchPatternCandidates.find((item) => item.kind === "passport_number");
        if (pagePatternPassport !== undefined) {
          attempts.push({
            pass_id: "C",
            raw_text_preview: `page:${pagePatternPassport.text}`.slice(0, 120),
            normalized_preview: normalizePassportNumberV2(pagePatternPassport.text).slice(0, 120),
            source: "page",
            confidence: clamp01(pagePatternPassport.confidence),
            psm: 6
          });
          ranked.push(
            makeRankedCandidate({
              field,
              pass_id: "C",
              source: "page",
              psm: 6,
              raw: pagePatternPassport.text,
              normalized: normalizePassportNumberV2(pagePatternPassport.text),
              confidence: clamp01(pagePatternPassport.confidence),
              anchorAlignmentScore,
              regex: /\d{4}\s*№?\s*\d{6}/u
            })
          );
        }
        const variants: Array<{ passId: "A" | "B" | "C"; roi: RoiRect; psmList: number[]; confidence: number; mode: "digits" | "digits_v2" }> =
          useVariant2
            ? [
                { passId: "A", roi: expandRoi(roi, width, height, { left: 0.28, right: 0.28, top: 0.6, bottom: 0.7 }), psmList: [6, 7, 11], confidence: 0.86, mode: "digits_v2" },
                { passId: "B", roi: expandRoi(roi, width, height, { left: 0.45, right: 0.45, top: 1.1, bottom: 1.1 }), psmList: [7, 11, 6], confidence: 0.74, mode: "digits_v2" },
                { passId: "C", roi: expandRoi(roi, width, height, { left: 0.6, right: 0.6, top: 1.4, bottom: 1.4 }), psmList: [11, 7, 6], confidence: 0.62, mode: "digits_v2" }
              ]
            : [
                { passId: "A", roi, psmList: [6], confidence: 0.82, mode: "digits" },
                {
                  passId: "B",
                  roi: expandRoi(roi, width, height, { left: 0.2, right: 0.2, top: 1.1, bottom: 0.8 }),
                  psmList: [7, 6],
                  confidence: 0.7,
                  mode: "digits"
                },
                {
                  passId: "C",
                  roi: expandRoi(roi, width, height, { left: 0.35, right: 0.35, top: 1.4, bottom: 1.2 }),
                  psmList: [11, 7],
                  confidence: 0.6,
                  mode: "digits"
                }
              ];
        const allDebugPreviews: string[] = [];
        const allDebugEmptyZones: Array<{ reason: string; crop_path: string | null }> = [];
        for (const variant of variants) {
          const sweeps = useVariant2
            ? buildGridSweeps(variant.roi, width, height, [-44, 0, 44], [0])
            : [{ roi: variant.roi, sweep: "x0_y0" }];
          for (const sweep of sweeps) {
            const linesRes = await ocrTsvLinesForRoi(
              pagePath,
              sweep.roi,
              tmp,
              options.tesseractLang ?? "rus",
              options.ocrTimeoutMs ?? 30_000,
              variant.mode,
              variant.psmList,
              "0123456789№ -",
              { field, passId: `${variant.passId}_${sweep.sweep}` }
            );
            allDebugPreviews.push(...linesRes.debug.previews);
            allDebugEmptyZones.push(...linesRes.debug.emptyZones);
            const joined = linesRes.lines.map((l) => l.text).join(" ");
            const normalizedText = useVariant2 ? normalizePassportNumberV2(joined) : normalizePassportNumber(joined);
            const psm = variant.psmList[0] ?? 6;
            attempts.push({
              pass_id: variant.passId,
              raw_text_preview: `${sweep.sweep} ${joined}`.slice(0, 120),
              normalized_preview: normalizedText.slice(0, 120),
              source: "zonal_tsv",
              confidence: variant.confidence,
              psm
            });
            ranked.push(
              makeRankedCandidate({
                field,
                pass_id: variant.passId,
                source: "zonal_tsv",
                psm,
                raw: joined,
                normalized: normalizedText,
                confidence: variant.confidence,
                anchorAlignmentScore,
                regex: /\d{4}\s*№?\s*\d{6}/u
              })
            );
          }
        }
        const rankedTop = useVariant2 ? rankCandidatesVariant2(ranked) : rankCandidates(ranked);
        const best = rankedTop[0];

        fieldReports.push(
          bestCandidateReport(field, roi, attempts, {
            preview: best?.normalized_preview ?? attempts[0]?.normalized_preview ?? "",
            normalized: best?.validated ?? "",
            confidence: best?.confidence ?? 0,
            source: (best?.source ?? "zonal_tsv") as BestCandidateSource,
            pass_id: best?.pass_id ?? "A",
            selectedPass: best?.pass_id ?? "A",
            rankingScore: best?.rankingScore ?? 0,
            anchorAlignmentScore: best?.anchorAlignmentScore ?? anchorAlignmentScore,
            thresholdStrategyUsed,
            validator_passed: (best?.validated ?? null) !== null,
            rejection_reason: (best?.validated ?? null) === null ? "FIELD_NOT_CONFIRMED" : null
          }, rankedTop.slice(0, 3))
        );
        extractorAudit.fields[field] = {
          roiSource: variant2AnchorRoiUsed || !fallbackUsed ? "anchor" : "ratio",
          chosenPass: best?.pass_id ?? "A",
          chosenSweep: String(attempts.find((item) => item.pass_id === (best?.pass_id ?? "A"))?.raw_text_preview ?? "").split(" ")[0] ?? "",
          bestCandidatePreview: best?.normalized_preview ?? ""
        };

        fieldDebug[field] = {
          zonal_tsv_lines_preview: allDebugPreviews,
          zonal_tsv_empty_zones: allDebugEmptyZones,
          thresholdStrategyUsed
        };
      }

      // dept_code
      {
        const field: PassportField = "dept_code";
        if (tmp === null) {
          throw new Error("Temporary OCR directory is not initialized");
        }
        const tmpDir = tmp;
        const roi =
          effectiveDeptCodeAnchorBox === undefined
            ? rois[field]
            : buildDeptCodeRoiFromAnchorBox(effectiveDeptCodeAnchorBox, width, height, rois[field].page);
        const attempts: NonNullable<FieldReport["attempts"]> = [];
        const ranked: RankedCandidate[] = [];
        const anchorAlignmentScore = anchorScoreForField(field, anchorKeys);
        const pagePatternDept = searchPatternCandidates.find((item) => item.kind === "dept_code");
        if (pagePatternDept !== undefined) {
          attempts.push({
            pass_id: "C",
            raw_text_preview: `page:${pagePatternDept.text}`.slice(0, 120),
            normalized_preview: normalizeDeptCodeV2(pagePatternDept.text).slice(0, 120),
            source: "page",
            confidence: clamp01(pagePatternDept.confidence),
            psm: 7
          });
          ranked.push(
            makeRankedCandidate({
              field,
              pass_id: "C",
              source: "page",
              psm: 7,
              raw: pagePatternDept.text,
              normalized: normalizeDeptCodeV2(pagePatternDept.text),
              confidence: clamp01(pagePatternDept.confidence),
              anchorAlignmentScore,
              regex: /\d{3}-\d{3}/u
            })
          );
        }
        const baseRoi = useVariant2
          ? expandRoi(
              roi,
              width,
              height,
              effectiveDeptCodeAnchorBox === undefined
                ? { left: 0.8, right: 1.2, top: 1.6, bottom: 2.2 }
                : { left: 0.5, right: 1.3, top: 0.7, bottom: 1.7 }
            )
          : roi;
        const enforcedHeight = useVariant2 ? clampIntValue(baseRoi.height, 90, 140) : baseRoi.height;
        const normalizedBaseRoi = { ...baseRoi, height: enforcedHeight };
        let locatorCandidates = useVariant2
          ? buildGridSweeps(normalizedBaseRoi, width, height, [-40, 0, 40], [-30, 0, 30]).map((item) => item.roi)
          : effectiveDeptCodeAnchorBox === undefined
            ? [roi, shiftRoiVertical(roi, -12, height), shiftRoiVertical(roi, 12, height)]
            : buildDeptCodeRoiCandidates(effectiveDeptCodeAnchorBox, width, height, roi.page);
        if (useVariant2) {
          const pRoi = rois.passport_number;
          const nearPassport = makeRoi(
            width,
            height,
            roi.page,
            pRoi.x - 80,
            pRoi.y - 280,
            clampIntValue(pRoi.width * 0.75, 360, 620),
            140
          );
          locatorCandidates = [
            ...locatorCandidates,
            ...buildGridSweeps(nearPassport, width, height, [-120, -40, 0, 40, 120], [-40, 0, 40]).map((item) => item.roi)
          ];
        }
        const scored = await Promise.all(
          locatorCandidates.map(async (candidateRoi) => ({
            roi: candidateRoi,
            inkScore: await computeInkScore(pagePath, candidateRoi)
          }))
        );
        const topCandidates = scored
          .filter((item) => item.inkScore >= 0.01)
          .sort((a, b) => b.inkScore - a.inkScore)
          .slice(0, useVariant2 ? 3 : 6);
        const debugDir = (process.env.KEISCORE_DEBUG_ROI_DIR ?? "").trim();
        if (debugDir !== "") {
          await writeFile(
            join(debugDir, useVariant2 ? "dept_code_locator_candidates_v2.json" : "dept_code_locator_candidates.json"),
            JSON.stringify(
              {
                total: scored.length,
                selectedTop: topCandidates.length,
                candidates: scored.map((item) => ({
                  roi: item.roi,
                  inkScore: Number(item.inkScore.toFixed(6))
                }))
              },
              null,
              2
            ),
            "utf8"
          ).catch(() => undefined);
        }
        for (let i = 0; i < topCandidates.length; i += 1) {
          const item = topCandidates[i];
          if (item === undefined) continue;
          const passId: "A" | "B" | "C" = i === 0 ? "A" : i === 1 ? "B" : "C";
          const psmList = useVariant2 ? [7, 6] : [7];
          const primaryPsm = psmList[0] ?? 7;
          const linesRes = await ocrTsvLinesForRoi(
            pagePath,
            item.roi,
            tmpDir,
            options.tesseractLang ?? "rus",
            options.ocrTimeoutMs ?? 30_000,
            useVariant2 ? "digits_v2" : "digits",
            psmList,
            "0123456789- ",
            { field, passId: `loc${i + 1}` }
          );
          const joined = linesRes.lines.map((l) => l.text).join(" ");
          const normalizedText = useVariant2 ? normalizeDeptCodeV2(joined) : normalizeDeptCodeStrict(joined);
          const confidence = Math.max(linesRes.lines.reduce((best, line) => Math.max(best, line.avgConf), 0), useVariant2 ? 0.3 : 0.1);
          attempts.push({
            pass_id: passId,
            raw_text_preview: joined.slice(0, 120),
            normalized_preview: normalizedText.slice(0, 120),
            source: "zonal_tsv",
            confidence,
            psm: primaryPsm
          });
          ranked.push(
            makeRankedCandidate({
              field,
              pass_id: passId,
              source: "zonal_tsv",
              psm: primaryPsm,
              raw: joined,
              normalized: normalizedText,
              confidence,
              anchorAlignmentScore,
              regex: /\d{3}-\d{3}/u
            })
          );
          if (/^\d{3}-\d{3}$/u.test(normalizedText)) {
            break;
          }
        }
        const rankedTop = useVariant2 ? rankCandidatesVariant2(ranked) : rankCandidates(ranked);
        const best = rankedTop[0];

        fieldReports.push(
          bestCandidateReport(field, roi, attempts, {
            preview: best?.normalized_preview ?? attempts[0]?.normalized_preview ?? "",
            normalized: best?.validated ?? "",
            confidence: best?.confidence ?? 0,
            source: (best?.source ?? "zonal_tsv") as BestCandidateSource,
            pass_id: best?.pass_id ?? "A",
            selectedPass: best?.pass_id ?? "A",
            rankingScore: best?.rankingScore ?? 0,
            anchorAlignmentScore: best?.anchorAlignmentScore ?? anchorAlignmentScore,
            thresholdStrategyUsed,
            validator_passed: (best?.validated ?? null) !== null,
            rejection_reason: (best?.validated ?? null) === null ? "FIELD_NOT_CONFIRMED" : null
          }, rankedTop.slice(0, 3))
        );
        extractorAudit.fields[field] = {
          roiSource: variant2AnchorRoiUsed || effectiveDeptCodeAnchorBox !== undefined || !fallbackUsed ? "anchor" : "ratio",
          chosenPass: best?.pass_id ?? "A",
          chosenSweep: "topCandidate",
          bestCandidatePreview: best?.normalized_preview ?? ""
        };
        fieldDebug[field] = {
          thresholdStrategyUsed,
          locator_candidates: topCandidates.map((item) => ({
            roi: item.roi,
            inkScore: Number(item.inkScore.toFixed(6))
          }))
        };
      }

      // fio
      {
        const field: PassportField = "fio";
        const roi = rois[field];
        const attempts: NonNullable<FieldReport["attempts"]> = [];
        const ranked: RankedCandidate[] = [];
        const anchorAlignmentScore = anchorScoreForField(field, anchorKeys);
        const fioAnchorByLabel = new Map<SearchAnchorLabel, SearchAnchorHit>();
        for (const hit of searchAnchorHits) {
          fioAnchorByLabel.set(hit.label, hit);
        }
        const surnameAnchor = fioAnchorByLabel.get("ФАМИЛИЯ");
        const nameAnchor = fioAnchorByLabel.get("ИМЯ");
        const patronymicAnchor = fioAnchorByLabel.get("ОТЧЕСТВО");
        const anchorLineParts: Array<{ label: "surname" | "name" | "patronymic"; token: string }> = [];
        const anchorLineAudit: Array<Record<string, unknown>> = [];
        if (surnameAnchor && nameAnchor && patronymicAnchor) {
          const slices: Array<{ key: "surname" | "name" | "patronymic"; anchor: SearchAnchorHit }> = [
            { key: "surname", anchor: surnameAnchor },
            { key: "name", anchor: nameAnchor },
            { key: "patronymic", anchor: patronymicAnchor }
          ];
          for (const slice of slices) {
            const lineRoi = buildFioLineRoi(slice.anchor.bbox, width, height, roi.page);
            await saveAnchorRoiDebugCrop(pagePath, lineRoi, debugDir, `anchor_roi_fio_${slice.key}`);
            const lineOcr = await ocrSingleLineToken({
              pagePath,
              roi: lineRoi,
              tmpDir: tmp,
              lang: options.tesseractLang ?? "rus",
              timeoutMs: options.ocrTimeoutMs ?? 30_000,
              debugDir,
              debugPrefix: `fio_line_slices_${slice.key}`
            });
            anchorLineAudit.push({
              key: slice.key,
              anchorLabel: slice.anchor.label,
              anchorBBox: slice.anchor.bbox,
              roi: lineRoi,
              token: lineOcr.token,
              rawPreview: lineOcr.raw.slice(0, 120),
              accepted: lineOcr.token !== null
            });
            if (lineOcr.token !== null) {
              anchorLineParts.push({ label: slice.key, token: lineOcr.token });
            }
          }
          const byOrder = ["surname", "name", "patronymic"] as const;
          const assembled = byOrder.map((key) => anchorLineParts.find((item) => item.label === key)?.token ?? "").join(" ").trim();
          const strictFio = validateFioStrictThreeTokens(assembled);
          const surnameToken = strictFio?.split(" ")[0] ?? "";
          const surnameQualityOk = strictFio !== null && assessFioSurnameQuality(surnameToken).ok;
          if (strictFio !== null && surnameQualityOk) {
            attempts.push({
              pass_id: "A",
              raw_text_preview: assembled.slice(0, 120),
              normalized_preview: strictFio.slice(0, 120),
              source: "zonal_tsv",
              confidence: 0.82,
              psm: 7
            });
            ranked.push(
              makeRankedCandidate({
                field,
                pass_id: "A",
                source: "zonal_tsv",
                psm: 7,
                raw: assembled,
                normalized: strictFio,
                confidence: 0.82,
                anchorAlignmentScore: Math.max(anchorAlignmentScore, 0.95),
                markerMatch: 1,
                validatedOverride: strictFio
              })
            );
            detailedAudit.fio = {
              strategy: "anchor_lines",
              status: "accepted",
              anchorLabels: ["ФАМИЛИЯ", "ИМЯ", "ОТЧЕСТВО"],
              slices: anchorLineAudit,
              assembled: strictFio
            };
          } else {
            detailedAudit.fio = {
              strategy: "anchor_lines",
              status: "rejected",
              reason: "FIO_STRICT_VALIDATOR_FAILED",
              anchorLabels: ["ФАМИЛИЯ", "ИМЯ", "ОТЧЕСТВО"],
              slices: anchorLineAudit,
              assembled,
              surnameQualityOk
            };
          }
        } else {
          detailedAudit.fio = {
            strategy: "anchor_lines",
            status: "missing_anchors",
            found: {
              surname: surnameAnchor !== undefined,
              name: nameAnchor !== undefined,
              patronymic: patronymicAnchor !== undefined
            }
          };
        }
        if (ranked.length === 0) {
          const pageLines = groupWordsIntoLines(pageForSearchWords).map((line) => ({ text: line.text, avgConf: line.avgConf }));
          const pageFio = pickFioCandidate(pageLines);
          if (pageFio !== null) {
            attempts.push({
              pass_id: "C",
              raw_text_preview: pageFio.value.slice(0, 120),
              normalized_preview: pageFio.value.slice(0, 120),
              source: "page",
              confidence: clamp01(pageFio.conf),
              psm: 11
            });
            ranked.push(
              makeRankedCandidate({
                field,
                pass_id: "C",
                source: "page",
                psm: 11,
                raw: pageFio.value,
                normalized: pageFio.value,
                confidence: clamp01(pageFio.conf),
                anchorAlignmentScore
              })
            );
          }
          const passConfigs: Array<{ passId: "A" | "B"; psm: 6 | 11 }> = [
            { passId: "A", psm: 6 },
            { passId: "B", psm: 11 }
          ];
          for (const config of passConfigs) {
            const zoneRois = splitRoiIntoHorizontalZones(roi, 3);
            const zoneTexts: string[] = [];
            let zoneConfidence = 0;
            for (const zoneRoi of zoneRois) {
              const linesRes = await ocrTsvLinesForRoi(
                pagePath,
                zoneRoi,
                tmp,
                options.tesseractLang ?? "rus",
                options.ocrTimeoutMs ?? 30_000,
                useVariant2 ? "text_v2" : "text",
                [config.psm],
                "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ- ",
                { field, passId: config.passId }
              );
              const bestLine = linesRes.lines.sort((a, b) => b.avgConf - a.avgConf)[0];
              const clean = antiNoiseCyrillicTokens(cleanCyrillicWords(bestLine?.text ?? ""));
              if (clean.length >= 3 && clean.length <= 30 && !/\d/u.test(clean)) {
                zoneTexts.push(clean);
                zoneConfidence += Number(bestLine?.avgConf ?? 0);
              }
            }
            const assembledFio = selectFioFromThreeZones(zoneTexts);
            if (assembledFio !== null) {
              const normalized = normalizeRussianText(assembledFio);
              attempts.push({
                pass_id: config.passId,
                raw_text_preview: assembledFio.slice(0, 120),
                normalized_preview: normalized.slice(0, 120),
                source: "zonal_tsv",
                confidence: zoneConfidence / 3,
                psm: config.psm
              });
              ranked.push(
                makeRankedCandidate({
                  field,
                  pass_id: config.passId,
                  source: "zonal_tsv",
                  psm: config.psm,
                  raw: assembledFio,
                  normalized,
                  confidence: zoneConfidence / 3,
                  anchorAlignmentScore
                })
              );
            }
          }
          if (ranked.length === 0) {
            const raw = await ocrPlainText(
              pagePath,
              roi,
              tmp,
              options.tesseractLang ?? "rus",
              options.ocrTimeoutMs ?? 30_000,
              6,
              { field, passId: "C" }
            );
            const clean = cleanCyrillicWords(raw);
            attempts.push({
              pass_id: "C",
              raw_text_preview: raw.slice(0, 120),
              normalized_preview: clean.slice(0, 120),
              source: "roi",
              confidence: 0.15,
              psm: 6
            });
            ranked.push(
              makeRankedCandidate({
                field,
                pass_id: "C",
                source: "roi",
                psm: 6,
                raw,
                normalized: clean,
                confidence: 0.15,
                anchorAlignmentScore,
                markerMatch: textMarkerScore(field, clean)
              })
            );
          }
          if (!ranked.some((candidate) => candidate.validated !== null)) {
            const mrz = await extractMrzFioFromPage(pagePath, tmp, options.ocrTimeoutMs ?? 30_000);
            if (mrz !== null) {
              attempts.push({
                pass_id: "C",
                raw_text_preview: mrz.raw.slice(0, 120),
                normalized_preview: mrz.fio.slice(0, 120),
                source: "mrz",
                confidence: 0.72,
                psm: 6
              });
              ranked.push(
                makeRankedCandidate({
                  field,
                  pass_id: "C",
                  source: "mrz",
                  psm: 6,
                  raw: mrz.raw,
                  normalized: mrz.fio,
                  confidence: 0.72,
                  anchorAlignmentScore: Math.max(anchorAlignmentScore, 0.5),
                  markerMatch: 1
                })
              );
            }
          }
        }
        const rankedTop = useVariant2 ? rankCandidatesVariant2(ranked) : rankCandidates(ranked);
        const best = rankedTop[0];
        fieldReports.push(
          bestCandidateReport(field, roi, attempts, {
            preview: best?.normalized_preview ?? "",
            normalized: best?.validated ?? "",
            confidence: best?.confidence ?? 0,
            source: (best?.source ?? "roi") as BestCandidateSource,
            pass_id: best?.pass_id ?? "C",
            selectedPass: best?.pass_id ?? "C",
            rankingScore: best?.rankingScore ?? 0,
            anchorAlignmentScore: best?.anchorAlignmentScore ?? anchorAlignmentScore,
            thresholdStrategyUsed,
            validator_passed: (best?.validated ?? null) !== null,
            rejection_reason: (best?.validated ?? null) === null ? "FIELD_NOT_CONFIRMED" : null
          }, rankedTop.slice(0, 3))
        );
        extractorAudit.fields[field] = {
          roiSource: variant2AnchorRoiUsed || !fallbackUsed ? "anchor" : "ratio",
          chosenPass: best?.pass_id ?? "C",
          chosenSweep: "anchor-lines",
          bestCandidatePreview: best?.normalized_preview ?? ""
        };
      }

      // issued_by
      {
        const field: PassportField = "issued_by";
        let roi = rois[field];
        const attempts: NonNullable<FieldReport["attempts"]> = [];
        const ranked: RankedCandidate[] = [];
        const anchorAlignmentScore = anchorScoreForField(field, anchorKeys);
        const issuedAnchor = searchAnchorHits.find((item) => item.label === "ВЫДАН") ?? null;
        const deptStopAnchor =
          searchAnchorHits.find((item) => item.label === "ПОДРАЗД") ??
          searchAnchorHits.find((item) => item.label === "КОД") ??
          null;
        if (issuedAnchor !== null) {
          const issuedAnchorRoi = buildIssuedByRoiFromAnchor(issuedAnchor.bbox, width, height, roi.page);
          rois[field] = issuedAnchorRoi;
          roi = issuedAnchorRoi;
          await saveAnchorRoiDebugCrop(pagePath, issuedAnchorRoi, debugDir, "anchor_roi_issued_by");
          const anchorCandidate = buildIssuedByAnchorCandidate(pageForSearchWords, issuedAnchor, deptStopAnchor);
          if (anchorCandidate !== null) {
            const normalized = normalizeRussianText(anchorCandidate.value);
            attempts.push({
              pass_id: "A",
              raw_text_preview: normalized.slice(0, 120),
              normalized_preview: normalized.slice(0, 120),
              source: "page",
              confidence: clamp01(Math.max(anchorCandidate.confidence, 0.34)),
              psm: 6
            });
            ranked.push(
              makeRankedCandidate({
                field,
                pass_id: "A",
                source: "page",
                psm: 6,
                raw: normalized,
                normalized,
                confidence: clamp01(Math.max(anchorCandidate.confidence, 0.34)),
                anchorAlignmentScore: Math.max(anchorAlignmentScore, 0.94),
                markerMatch: textMarkerScore(field, normalized)
              })
            );
          }
        }
        const pageIssuedByCandidates = buildIssuedByCandidatesFromTsvWords(pageForSearchWords).slice(0, 2);
        for (const candidate of pageIssuedByCandidates) {
          const normalized = normalizeRussianText(candidate.text);
          attempts.push({
            pass_id: "C",
            raw_text_preview: normalized.slice(0, 120),
            normalized_preview: normalized.slice(0, 120),
            source: "page",
            confidence: clamp01(candidate.confidence),
            psm: 11
          });
          ranked.push(
            makeRankedCandidate({
              field,
              pass_id: "C",
              source: "page",
              psm: 11,
              raw: normalized,
              normalized,
              confidence: clamp01(candidate.confidence),
              anchorAlignmentScore,
              markerMatch: textMarkerScore(field, normalized)
            })
          );
        }
        const passConfigs: Array<{ passId: "A" | "B"; psm: 4 | 6 }> = [
          { passId: "A", psm: 4 },
          { passId: "B", psm: 6 }
        ];
        for (const config of passConfigs) {
          const linesRes = await ocrTsvLinesForRoi(
            pagePath,
            roi,
            tmp,
            options.tesseractLang ?? "rus",
            options.ocrTimeoutMs ?? 30_000,
            useVariant2 ? "text_v2" : "text",
            [config.psm],
            undefined,
            { field, passId: config.passId }
          );
          const candidate = pickIssuedByCandidate(linesRes.lines);
          const normalized = normalizeRussianText(candidate?.value ?? linesRes.lines.map((l) => l.text).join(" "));
          if (normalized.length <= 15) continue;
          attempts.push({
            pass_id: config.passId,
            raw_text_preview: normalized.slice(0, 120),
            normalized_preview: normalized.slice(0, 120),
            source: "zonal_tsv",
            confidence: candidate?.conf ?? 0.2,
            psm: config.psm
          });
          const markerHits = ISSUED_BY_MARKERS.reduce((acc, marker) => (normalized.includes(marker) ? acc + 1 : acc), 0);
          ranked.push(
            makeRankedCandidate({
              field,
              pass_id: config.passId,
              source: "zonal_tsv",
              psm: config.psm,
              raw: normalized,
              normalized,
              confidence: clamp01((candidate?.conf ?? 0.2) + Math.min(0.2, markerHits * 0.05)),
              anchorAlignmentScore,
              markerMatch: markerHits > 0 ? 1 : 0
            })
          );
        }
        if (!ranked.some((candidate) => candidate.validated !== null)) {
          const startedAt = Date.now();
          const sweepBudgetMs = useVariant2 ? 4_000 : 3_000;
          const sweeps = buildProblemFieldSweeps(roi, width, height, 120, 20, 16);
          sweepLoop: for (const sweep of sweeps) {
            for (const psm of [4, 6, 11]) {
              if (Date.now() - startedAt > sweepBudgetMs) break sweepLoop;
              const linesRes = await ocrTsvLinesForRoi(
                pagePath,
                sweep.roi,
                tmp,
                options.tesseractLang ?? "rus",
                options.ocrTimeoutMs ?? 30_000,
                useVariant2 ? "text_v2" : "text",
                [psm],
                undefined,
                { field, passId: `C_${sweep.sweep}_psm${psm}` }
              );
              const candidate = pickIssuedByCandidate(linesRes.lines);
              const normalized = normalizeRussianText(candidate?.value ?? linesRes.lines.map((l) => l.text).join(" "));
              if (normalized.length <= 10) continue;
              const markerHits = ISSUED_BY_MARKERS.reduce((acc, marker) => (normalized.includes(marker) ? acc + 1 : acc), 0);
              const confidence = clamp01((candidate?.conf ?? 0.14) + Math.min(0.18, markerHits * 0.04));
              attempts.push({
                pass_id: "C",
                raw_text_preview: `${sweep.sweep} ${normalized}`.slice(0, 120),
                normalized_preview: normalized.slice(0, 120),
                source: "zonal_tsv",
                confidence,
                psm
              });
              const cand = makeRankedCandidate({
                field,
                pass_id: "C",
                source: "zonal_tsv",
                psm,
                raw: normalized,
                normalized,
                confidence,
                anchorAlignmentScore,
                markerMatch: markerHits > 0 ? 1 : 0
              });
              ranked.push(cand);
              if (cand.validated !== null) {
                break sweepLoop;
              }
            }
          }
        }
        const rankedTop = useVariant2 ? rankCandidatesVariant2(ranked) : rankCandidates(ranked);
        const best = rankedTop[0];
        fieldReports.push(
          bestCandidateReport(field, roi, attempts, {
            preview: best?.normalized_preview ?? "",
            normalized: best?.validated ?? "",
            confidence: best?.confidence ?? 0,
            source: (best?.source ?? "roi") as BestCandidateSource,
            pass_id: best?.pass_id ?? "C",
            selectedPass: best?.pass_id ?? "C",
            rankingScore: best?.rankingScore ?? 0,
            anchorAlignmentScore: best?.anchorAlignmentScore ?? anchorAlignmentScore,
            thresholdStrategyUsed,
            validator_passed: (best?.validated ?? null) !== null,
            rejection_reason: (best?.validated ?? null) === null ? "FIELD_NOT_CONFIRMED" : null
          }, rankedTop.slice(0, 3))
        );
        extractorAudit.fields[field] = {
          roiSource: variant2AnchorRoiUsed || !fallbackUsed ? "anchor" : "ratio",
          chosenPass: best?.pass_id ?? "C",
          chosenSweep: "base",
          bestCandidatePreview: best?.normalized_preview ?? ""
        };
      }

      // registration
      const registrationResult = await runRegistrationExtraction({
        pagePath,
        width,
        height,
        rois,
        anchorKeys,
        pageType,
        pageForSearchWords,
        searchAnchorHits,
        useVariant2,
        thresholdStrategyUsed,
        tmpDir: tmp,
        debugDir,
        fallbackUsed,
        variant2AnchorRoiUsed,
        registrationAuditBase,
        options
      });
      fieldReports.push(registrationResult.fieldReport);
      extractorAudit.fields.registration = registrationResult.extractorField;
      detailedAudit.registration = registrationResult.detailedAuditRegistration;
      registrationBestValidated = registrationResult.bestValidated;
      registrationFieldReportIndex = fieldReports.length - 1;

      if (registrationBestValidated === null && (normalized.pages?.length ?? 1) > 1) {
        const registrationPageCandidates: Array<{
          pageIndex: number;
          pagePath: string;
          width: number;
          height: number;
          words: TsvWord[];
          pageType: ReturnType<typeof classifyRegistrationPage>;
          searchAnchorHits: ReturnType<typeof findAnchorHits>;
          score: number;
          keywordHits: number;
          wordCount: number;
          cyrRatio: number;
        }> = [];
        for (const pageMeta of normalized.pages ?? []) {
          const candidateIndex = Math.max(0, Math.floor(pageMeta.pageNumber ?? 0));
          if (candidateIndex === pageIndex) continue;
          const candidatePath = pageMeta.imagePath;
          if (!candidatePath) continue;
          const candidateWidth = pageMeta.width ?? width;
          const candidateHeight = pageMeta.height ?? height;
          const candidatePageForSearch = await buildPageForSearch(candidatePath, tmp, "", normalized.preprocessing);
          const candidateBest = await runTesseractWithFallback(
            candidatePageForSearch.variants,
            options.tesseractLang ?? "rus",
            Math.min(options.ocrTimeoutMs ?? 30_000, 18_000),
            ""
          );
          const candidateWords = parseTsvWords(candidateBest.tsv).sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0));
          const candidatePageType = classifyRegistrationPage(candidateWords, candidateWidth, candidateHeight, candidateIndex);
          const candidateSearchAnchorHits = findAnchorHits(candidateWords);
          const signals = summarizeRegistrationSignals(candidateWords);
          const score = scoreRegistrationSignals(signals, candidatePageType.registrationLikely);
          registrationPageCandidates.push({
            pageIndex: candidateIndex,
            pagePath: candidatePath,
            width: candidateWidth,
            height: candidateHeight,
            words: candidateWords,
            pageType: candidatePageType,
            searchAnchorHits: candidateSearchAnchorHits,
            score,
            keywordHits: signals.keywordHits,
            wordCount: signals.wordCount,
            cyrRatio: signals.cyrRatio
          });
        }
        const rankedMultiPage = registrationPageCandidates
          .filter((item) => item.keywordHits > 0 || item.pageType.registrationLikely || item.score >= 0.6)
          .sort((a, b) => b.score - a.score)
          .slice(0, 2);
        detailedAudit.registration = {
          ...(detailedAudit.registration ?? {}),
          multiPageSearch: {
            totalPages: normalized.pages?.length ?? 1,
            considered: registrationPageCandidates.map((item) => ({
              pageIndex: item.pageIndex,
              score: Number(item.score.toFixed(3)),
              keywordHits: item.keywordHits,
              wordCount: item.wordCount,
              cyrRatio: item.cyrRatio,
              pageTypeDetected: item.pageType.pageTypeDetected,
              pageTypeConfidence: item.pageType.pageTypeConfidence
            })),
            selected: rankedMultiPage.map((item) => item.pageIndex)
          }
        };
        for (const candidate of rankedMultiPage) {
          const resolved = await resolveRoisWithAnchorFirst(normalized, logger, candidate.width, candidate.height, candidate.pageIndex);
          const mergedAnchorBoxesCandidate = mergeAnchorBoxes(resolved.anchorBoxes, candidate.searchAnchorHits);
          let candidateRois =
            options.ocrVariant === "v2"
              ? buildVariant2RoisFromAnchors(resolved.rois, mergedAnchorBoxesCandidate, candidate.width, candidate.height)
              : buildRoisFromSearchAndAnchors(resolved.rois, mergedAnchorBoxesCandidate, findPatternCandidates(candidate.words), candidate.width, candidate.height);
          if (options.ocrVariant === "v2") {
            candidateRois = buildRoisFromSearchAndAnchors(
              candidateRois,
              mergedAnchorBoxesCandidate,
              findPatternCandidates(candidate.words),
              candidate.width,
              candidate.height
            );
          }
          const variant2AnchorRoiUsedCandidate = options.ocrVariant === "v2" && mergedAnchorBoxesCandidate !== undefined && Object.keys(mergedAnchorBoxesCandidate).length > 0;
          const candidateRegistrationAuditBase = {
            ...registrationAuditBase,
            pageIndex: candidate.pageIndex,
            pageCount: normalized.pages?.length ?? 1
          };
          const candidateResult = await runRegistrationExtraction({
            pagePath: candidate.pagePath,
            width: candidate.width,
            height: candidate.height,
            rois: candidateRois,
            anchorKeys: resolved.anchorKeys,
            pageType: candidate.pageType,
            pageForSearchWords: candidate.words,
            searchAnchorHits: candidate.searchAnchorHits,
            useVariant2,
            thresholdStrategyUsed,
            tmpDir: tmp,
            debugDir,
            fallbackUsed: resolved.fallbackUsed,
            variant2AnchorRoiUsed: variant2AnchorRoiUsedCandidate,
            registrationAuditBase: candidateRegistrationAuditBase,
            options
          });
          detailedAudit.registration = {
            ...candidateResult.detailedAuditRegistration,
            multiPageSearch: (detailedAudit.registration as Record<string, unknown>)?.multiPageSearch ?? null
          };
          extractorAudit.fields.registration = candidateResult.extractorField;
          if (registrationFieldReportIndex >= 0) {
            fieldReports[registrationFieldReportIndex] = candidateResult.fieldReport;
          } else {
            fieldReports.push(candidateResult.fieldReport);
            registrationFieldReportIndex = fieldReports.length - 1;
          }
          registrationBestValidated = candidateResult.bestValidated;
          if (registrationBestValidated !== null) {
            break;
          }
        }
      }

      if (debugDir) {
        await writeFile(join(debugDir, "extractor_audit.json"), JSON.stringify(extractorAudit, null, 2), "utf8").catch(() => undefined);
        await writeFile(join(debugDir, "audit.json"), JSON.stringify(detailedAudit, null, 2), "utf8").catch(() => undefined);
      }

      const diagnostics = buildDiagnostics(undefined, normalized.preprocessing, fieldDebug);
      const get = (f: PassportField) => fieldReports.find((r) => r.field === f) ?? null;

      const result: ExtractionResult = {
        ...BASE_RESULT,
        fio: get("fio")?.validator_passed ? (get("fio")?.best_candidate_normalized ?? null) : null,
        passport_number: get("passport_number")?.validator_passed
          ? (get("passport_number")?.best_candidate_normalized ?? null)
          : null,
        issued_by: get("issued_by")?.validator_passed ? (get("issued_by")?.best_candidate_normalized ?? null) : null,
        dept_code: get("dept_code")?.validator_passed ? (get("dept_code")?.best_candidate_normalized ?? null) : null,
        registration: get("registration")?.validator_passed ? (get("registration")?.best_candidate_normalized ?? null) : null,
        confidence_score: 0.6,
        ...(diagnostics !== null ? { diagnostics } : {}),
        field_reports: fieldReports,
        errors
      };
      let fallbackMergedFromV1 = false;
      if (useVariant2) {
        const prevDebugDir = process.env.KEISCORE_DEBUG_ROI_DIR;
        try {
          delete process.env.KEISCORE_DEBUG_ROI_DIR;
          const legacy = await RfInternalPassportExtractor.extract(input, { ...options, ocrVariant: "v1" });
          for (const field of FIELD_ORDER) {
            if ((result as any)[field] === null && (legacy as any)[field] !== null) {
              (result as any)[field] = (legacy as any)[field];
              fallbackMergedFromV1 = true;
            }
            const idx = result.field_reports.findIndex((report) => report.field === field);
            const legacyReport = legacy.field_reports.find((report) => report.field === field);
            if (idx >= 0 && legacyReport !== undefined && result.field_reports[idx]?.validator_passed === false && legacyReport.validator_passed) {
              result.field_reports[idx] = legacyReport;
              fallbackMergedFromV1 = true;
            }
          }
        } finally {
          if (prevDebugDir === undefined) {
            delete process.env.KEISCORE_DEBUG_ROI_DIR;
          } else {
            process.env.KEISCORE_DEBUG_ROI_DIR = prevDebugDir;
          }
        }
        fieldDebug.v2_fallback_legacy_used = fallbackMergedFromV1;
      }

      for (const f of FIELD_ORDER) {
        const value = (result as any)[f] as string | null;
        if (value === null) {
          errors.push({ code: "FIELD_NOT_CONFIRMED", message: `No validated OCR candidate for field: ${f}` });
        }
      }

      if (result.confidence_score < 0.7) {
        errors.push({
          code: "REQUIRE_MANUAL_REVIEW",
          message: "Overall confidence is below manual-review threshold.",
          details: { confidence_score: result.confidence_score }
        });
      }

      return ExtractionResultSchema.parse(result);
    } catch (e) {
      const core = toCoreError(e);
      const fallback = {
        ...BASE_RESULT,
        confidence_score: 0,
        field_reports: FIELD_ORDER.map((f) =>
          emptyFieldReport(f, { x: 0, y: 0, width: 0, height: 0, page: 0 }, "none")
        ),
        errors: [core]
      };
      return ExtractionResultSchema.parse(fallback);
    } finally {
      if (tmp) {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
