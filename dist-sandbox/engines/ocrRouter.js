import { OnlineEngine } from "./onlineEngine.js";
import { TesseractEngine } from "./tesseractEngine.js";
const PASS_ORDER = ["A", "B", "C"];
const NUMERIC_FIELDS = new Set(["passport_number", "dept_code"]);
function toErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return "Unknown engine error";
}
export class OcrEngineRouter {
    static async run(rois, input, opts, logger) {
        const onlineAvailability = await OnlineEngine.pingOnline();
        const tesseractAvailability = await TesseractEngine.detectAvailability();
        const selectedEngine = selectPrimaryEngine(opts.preferOnline === true, onlineAvailability.available, tesseractAvailability.available);
        logger.log({
            ts: Date.now(),
            stage: "ocr-router",
            level: "info",
            message: "OCR engine selected",
            data: {
                selectedEngine,
                onlineAvailable: onlineAvailability.available,
                tesseractAvailable: tesseractAvailability.available
            }
        });
        const errors = [];
        if (selectedEngine === "none") {
            errors.push({
                code: "ENGINE_UNAVAILABLE",
                message: "No OCR engine is available on this host.",
                details: {
                    onlineAvailable: onlineAvailability.available,
                    tesseractAvailable: tesseractAvailability.available
                }
            });
            return { engineUsed: "none", candidates: [], attempts: [], errors };
        }
        const attempts = [];
        const candidates = [];
        const timeoutMs = opts.ocrTimeoutMs ?? 30_000;
        for (const roi of rois) {
            if (opts._numericOnly === true && !NUMERIC_FIELDS.has(roi.field)) {
                continue;
            }
            let bestCandidate = null;
            for (const passId of PASS_ORDER) {
                try {
                    const candidate = await runWithFallback(selectedEngine, roi, input, opts.tesseractLang ?? "rus", passId, timeoutMs, tesseractAvailability.available, opts.debugUnsafeIncludeRawText === true, opts._retryPaddingRatio, logger);
                    if (candidate !== null) {
                        attempts.push({
                            field: roi.field,
                            pass_id: passId,
                            text: candidate.text,
                            confidence: candidate.confidence,
                            bbox: candidate.bbox ?? {
                                x1: roi.roi.x,
                                y1: roi.roi.y,
                                x2: roi.roi.x + roi.roi.width,
                                y2: roi.roi.y + roi.roi.height
                            },
                            engine_used: candidate.engine_used ?? selectedEngine,
                            ...(candidate.raw_text !== undefined ? { raw_text: candidate.raw_text } : {}),
                            ...(candidate.normalized_text !== undefined
                                ? { normalized_text: candidate.normalized_text }
                                : {}),
                            ...(candidate.psm !== undefined ? { psm: candidate.psm } : {}),
                            ...(candidate.postprocessed_roi_image_path !== undefined
                                ? { postprocessed_roi_image_path: candidate.postprocessed_roi_image_path }
                                : {})
                        });
                        if (bestCandidate === null || candidate.confidence > bestCandidate.confidence) {
                            bestCandidate = candidate;
                        }
                    }
                }
                catch (error) {
                    errors.push({
                        code: "FIELD_NOT_CONFIRMED",
                        message: `OCR candidate unavailable for field: ${roi.field}`,
                        details: {
                            engine: selectedEngine,
                            passId,
                            reason: toErrorMessage(error)
                        }
                    });
                }
            }
            if (bestCandidate !== null) {
                candidates.push(bestCandidate);
                logger.log({
                    ts: Date.now(),
                    stage: "ocr-router",
                    level: "info",
                    message: "Best OCR candidate selected.",
                    data: {
                        field: roi.field,
                        winnerPass: bestCandidate.pass_id ?? null,
                        winnerPsm: bestCandidate.psm ?? null,
                        confidence: bestCandidate.confidence,
                        passLabel: opts._passLabel ?? "primary"
                    }
                });
            }
            else {
                errors.push({
                    code: "FIELD_NOT_CONFIRMED",
                    message: `OCR candidate unavailable for field: ${roi.field}`,
                    details: {
                        engine: selectedEngine
                    }
                });
            }
        }
        return {
            engineUsed: selectedEngine,
            candidates,
            attempts,
            errors
        };
    }
}
function selectPrimaryEngine(preferOnline, onlineAvailable, tesseractAvailable) {
    if (preferOnline && onlineAvailable) {
        return "online";
    }
    if (tesseractAvailable) {
        return "tesseract";
    }
    if (onlineAvailable) {
        return "online";
    }
    return "none";
}
async function runWithFallback(primaryEngine, roi, input, lang, passId, timeoutMs, tesseractAvailable, debugUnsafeIncludeRawText, retryPaddingRatio, logger) {
    try {
        if (primaryEngine === "online") {
            return await OnlineEngine.runOcrOnRoi(roi, input, passId, timeoutMs);
        }
        return await TesseractEngine.runOcrOnRoi(roi, input, lang, passId, timeoutMs, debugUnsafeIncludeRawText, logger, retryPaddingRatio);
    }
    catch (error) {
        if (primaryEngine === "online" && tesseractAvailable) {
            logger.log({
                ts: Date.now(),
                stage: "ocr-router",
                level: "warn",
                message: "Online OCR failed, falling back to tesseract.",
                data: { field: roi.field, passId, reason: toErrorMessage(error) }
            });
            return TesseractEngine.runOcrOnRoi(roi, input, lang, passId, timeoutMs, debugUnsafeIncludeRawText, logger, retryPaddingRatio);
        }
        throw error;
    }
}
//# sourceMappingURL=ocrRouter.js.map