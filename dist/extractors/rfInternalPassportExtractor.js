import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { execa } from "execa";
import { AnchorModel } from "../anchors/anchorModel.js";
import { DynamicROIMapper } from "../anchors/dynamicRoiMapper.js";
import { DocumentDetector } from "../detection/documentDetector.js";
import { PerspectiveCalibrator } from "../detection/perspectiveCalibrator.js";
import { OcrEngineRouter } from "../engines/ocrRouter.js";
import { RETRY_ROI_PADDING_RATIO } from "../engines/roiPreprocessor.js";
import { FormatNormalizer } from "../format/formatNormalizer.js";
import { ScoringEngine } from "../scoring/scoringEngine.js";
import { validateDeptCode, validateFio, validateIssuedBy, validatePassportNumber, validateRegistration } from "../validators/passportValidators.js";
import { ExtractionResultSchema, InMemoryAuditLogger } from "../types.js";
const BASE_RESULT = {
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
const FIELD_ORDER = [
    "fio",
    "passport_number",
    "issued_by",
    "dept_code",
    "registration"
];
function normalizeOptions(opts) {
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
function toCoreError(error) {
    if (typeof error === "object" &&
        error !== null &&
        "coreError" in error &&
        typeof error.coreError === "object") {
        return error.coreError;
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
function validateByField(field, value) {
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
function appendFilteredErrors(target, incoming) {
    for (const item of incoming) {
        if (item.code === "PAGE_CLASSIFICATION_FAILED") {
            continue;
        }
        target.push(item);
    }
}
function emptyFieldReport(fieldRoi, engine) {
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
    };
}
export class RfInternalPassportExtractor {
    static async extract(input, opts) {
        const options = await normalizeOptionsForRfPassport(input, normalizeOptions(opts));
        const logger = options.logger;
        const errors = [];
        let normalizedForCleanup = null;
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
            const anchors = await AnchorModel.findAnchors(normalized, detection, calibration, logger, options.debugUnsafeIncludeRawText === true);
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
            // Keep anchor model pageType as-is and allow mapping even when it is "unknown".
            const anchorsForMapping = anchors;
            const rois = await DynamicROIMapper.map(normalized, detection, calibration, anchorsForMapping, logger);
            const roiCrops = await DynamicROIMapper.attachRoiImagePaths(normalized, rois, logger);
            const primaryRouterResult = await OcrEngineRouter.run(roiCrops, normalized, options, logger).finally(async () => {
                await DynamicROIMapper.cleanupRoiImagePaths(roiCrops);
            });
            const mergedAttempts = [...primaryRouterResult.attempts];
            const mergedErrors = [...primaryRouterResult.errors];
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
                const retryRouterResult = await OcrEngineRouter.run(retryRoiCrops, normalized, {
                    ...options,
                    _numericOnly: true,
                    _retryPaddingRatio: RETRY_ROI_PADDING_RATIO,
                    _passLabel: "numeric-retry"
                }, logger).finally(async () => {
                    await DynamicROIMapper.cleanupRoiImagePaths(retryRoiCrops);
                });
                mergedAttempts.push(...retryRouterResult.attempts);
                mergedErrors.push(...retryRouterResult.errors);
                winningPass = retryRouterResult.attempts.length > 0 ? "numeric-retry" : "primary";
            }
            appendFilteredErrors(errors, mergedErrors);
            const pageFallbackAttempts = await buildPageFallbackAttempts(normalized, logger);
            if (pageFallbackAttempts.length > 0) {
                mergedAttempts.push(...pageFallbackAttempts);
            }
            const field_reports = roiCrops.map((fieldRoi) => {
                const attempts = filterAttemptsByField(mergedAttempts, fieldRoi.field);
                const validation = validateByPassOrderDetailed(fieldRoi.field, attempts);
                const validated = validation.validated;
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
                                best_candidate_preview: bestCandidatePreview(attempts)
                            }
                            : {})
                    };
                }
                return {
                    field: fieldRoi.field,
                    roi: fieldRoi.roi,
                    engine_used: validated.engine_used,
                    pass: true,
                    pass_id: validated.pass_id,
                    confidence: validated.confidence,
                    validator_passed: true,
                    rejection_reason: null,
                    anchor_alignment_score: alignmentScore,
                    ...(fieldRoi.roiImagePath === undefined ? {} : { roiImagePath: fieldRoi.roiImagePath }),
                    ...(validated.postprocessed_roi_image_path === undefined
                        ? {}
                        : { postprocessed_roi_image_path: validated.postprocessed_roi_image_path }),
                    ...(options.debugUnsafeIncludeRawText
                        ? {
                            attempts: toAttemptPreviews(attempts),
                            best_candidate_preview: bestCandidatePreview(attempts)
                        }
                        : {})
                };
            });
            const resultValues = {
                fio: null,
                passport_number: null,
                issued_by: null,
                dept_code: null,
                registration: null
            };
            for (const field of FIELD_ORDER) {
                const attempts = filterAttemptsByField(mergedAttempts, field);
                const validated = validateByPassOrder(field, attempts);
                if (validated !== null) {
                    resultValues[field] = validated.text;
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
            if (anchors.pageType === "unknown" &&
                validatedFieldCount === 0 &&
                !errors.some((item) => item.code === "DOCUMENT_NOT_DETECTED")) {
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
            const result = {
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
            const parsed = ExtractionResultSchema.parse(result);
            return parsed;
        }
        catch (error) {
            const coreError = toCoreError(error);
            if (coreError.code === "UNSUPPORTED_FORMAT") {
                const structured = new Error(coreError.message);
                structured.coreError = coreError;
                throw structured;
            }
            appendFilteredErrors(errors, [coreError]);
            const fallbackRois = FIELD_ORDER.map((field, index) => ({
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
        }
        finally {
            if (normalizedForCleanup !== null) {
                await FormatNormalizer.cleanupPdfPageArtifacts(normalizedForCleanup);
            }
        }
    }
}
async function normalizeOptionsForRfPassport(input, options) {
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
function isPdfInput(input) {
    if (input.kind === "path") {
        return extname(input.path).toLowerCase() === ".pdf";
    }
    return extname(input.filename).toLowerCase() === ".pdf";
}
async function estimatePdfPageCount(input) {
    const buffer = input.kind === "path" ? await readFile(input.path) : input.data;
    const content = buffer.toString("latin1");
    const matches = content.match(/\/Type\s*\/Page\b/g);
    return Math.max(1, matches?.length ?? 1);
}
function filterAttemptsByField(attempts, field) {
    const passOrder = { A: 0, B: 1, C: 2 };
    return attempts
        .filter((attempt) => attempt.field === field)
        .sort((left, right) => passOrder[left.pass_id] - passOrder[right.pass_id]);
}
function validateByPassOrder(field, attempts) {
    return validateByPassOrderDetailed(field, attempts).validated;
}
function validateByPassOrderDetailed(field, attempts) {
    const preferredOrder = ["A", "B", "C"];
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
                return { validated: { ...attempt, text: normalized }, reason: "VALIDATED" };
            }
        }
    }
    const best = [...attempts].sort((left, right) => right.confidence - left.confidence)[0];
    return {
        validated: null,
        reason: best === undefined ? "NO_OCR_ATTEMPTS" : `VALIDATOR_REJECTED:${toPreview(best.text, 40)}`
    };
}
function allFieldsUnconfirmed(attempts) {
    return FIELD_ORDER.every((field) => validateByPassOrder(field, filterAttemptsByField(attempts, field)) === null);
}
function expandNumericRois(rois, maxWidth, maxHeight, ratio) {
    return rois
        .filter((roi) => roi.field === "passport_number" || roi.field === "dept_code")
        .map((roi) => ({
        ...roi,
        roi: expandRoi(roi.roi, maxWidth, maxHeight, ratio)
    }));
}
function expandRoi(roi, maxWidth, maxHeight, ratio) {
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
function clamp(value, min, max) {
    if (value < min) {
        return min;
    }
    if (value > max) {
        return max;
    }
    return value;
}
function computeAnchorAlignment(fieldRoi, anchors, geometricScore) {
    const anchorMap = {
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
    const inside = point.x >= fieldRoi.roi.x && point.x <= x2 && point.y >= fieldRoi.roi.y && point.y <= y2;
    if (inside) {
        return Math.max(0.8, geometricScore);
    }
    return Math.max(0.45, geometricScore * 0.8);
}
function toAttemptPreviews(attempts) {
    return attempts.map((attempt) => ({
        pass_id: attempt.pass_id,
        raw_text_preview: toPreview(attempt.raw_text ?? attempt.text, 200),
        normalized_preview: toPreview(attempt.normalized_text ?? attempt.text, 200),
        ...(Number.isFinite(attempt.confidence) ? { confidence: attempt.confidence } : {}),
        ...(attempt.psm !== undefined ? { psm: attempt.psm } : {})
    }));
}
function bestCandidatePreview(attempts) {
    if (attempts.length === 0) {
        return "";
    }
    const best = [...attempts].sort((left, right) => right.confidence - left.confidence)[0];
    if (best === undefined) {
        return "";
    }
    return toPreview(best.normalized_text ?? best.text, 200);
}
function toPreview(value, maxChars) {
    const trimmed = value.trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return `${trimmed.slice(0, maxChars)}...`;
}
async function buildPageFallbackAttempts(normalized, logger) {
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
        const issuedLine = buildTextLinesFromRows(rows).find((line) => line.text.length >= 18 &&
            /(САНКТ|ЛЕНИНГРАД|ОБЛ|РОСС|ФЕДЕРАЦ|ПЕТЕРБУРГ)/u.test(line.text));
        const attempts = [];
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
        if (issuedLine !== undefined) {
            const base = issuedLine.text.trim();
            const withMarker = /(ГУ|МВД|УФМС|ОТДЕЛ)/u.test(base) || base.length < 12 ? base : `ОТДЕЛ ${base}`;
            attempts.push({
                field: "issued_by",
                pass_id: "C",
                text: withMarker,
                confidence: Math.max(0.25, Math.min(0.62, issuedLine.confidence / 100)),
                bbox: issuedLine.bbox,
                engine_used: "tesseract",
                psm: 6
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
    }
    catch (error) {
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
function parsePageTsvRows(tsv) {
    const rows = tsv.split(/\r?\n/u);
    const out = [];
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
        if (![left, top, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
            continue;
        }
        out.push({
            text,
            confidence: Number.isFinite(confidence) ? confidence : 0,
            bbox: { x1: left, y1: top, x2: left + width, y2: top + height }
        });
    }
    return out.sort((a, b) => b.confidence - a.confidence);
}
function buildTextLinesFromRows(rows) {
    const sorted = [...rows].sort((a, b) => (a.bbox.y1 === b.bbox.y1 ? a.bbox.x1 - b.bbox.x1 : a.bbox.y1 - b.bbox.y1));
    const lines = [];
    for (const row of sorted) {
        const last = lines[lines.length - 1];
        if (last === undefined || Math.abs(last.bbox.y1 - row.bbox.y1) > 28) {
            lines.push({ ...row });
            continue;
        }
        last.text = `${last.text} ${row.text}`.trim();
        last.confidence = Math.max(last.confidence, row.confidence);
        last.bbox = {
            x1: Math.min(last.bbox.x1, row.bbox.x1),
            y1: Math.min(last.bbox.y1, row.bbox.y1),
            x2: Math.max(last.bbox.x2, row.bbox.x2),
            y2: Math.max(last.bbox.y2, row.bbox.y2)
        };
    }
    return lines;
}
function buildDiagnostics(includeRawTextDebug, anchors) {
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
//# sourceMappingURL=rfInternalPassportExtractor.js.map