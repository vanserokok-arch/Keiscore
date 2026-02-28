import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { preprocessRoiForOcrWithConfig } from "./roiPreprocessor.js";
import { normalizeDeptCode, normalizePassportNumber, normalizeRussianText } from "../format/textNormalizer.js";
export class TesseractEngine {
    static async detectAvailability() {
        try {
            const result = await execa("tesseract", ["--version"]);
            const firstLine = result.stdout.split(/\r?\n/u)[0]?.trim();
            if (firstLine === undefined || firstLine === "") {
                return { available: true };
            }
            return {
                available: true,
                version: firstLine
            };
        }
        catch {
            return { available: false };
        }
    }
    static async runOcrOnRoi(roi, _input, lang, passId, timeoutMs, debugUnsafeIncludeRawText = false, logger, retryPaddingRatio) {
        const execute = async () => {
            if (roi.roiImagePath === undefined || roi.roiImagePath.trim() === "") {
                throw new Error(`ROI image path is missing for field: ${roi.field}`);
            }
            const fieldConfig = FIELD_OCR_CONFIG[roi.field];
            const psm = psmForFieldAndPass(roi.field, passId);
            const preprocessedPath = await preprocessRoiForOcrWithConfig(roi.roiImagePath, {
                field: roi.field,
                ...(retryPaddingRatio === undefined ? {} : { extraPaddingRatio: retryPaddingRatio }),
                ...(logger === undefined ? {} : { logger })
            });
            try {
                const args = [
                    preprocessedPath,
                    "stdout",
                    "-l",
                    lang,
                    "--oem",
                    "1",
                    "--psm",
                    String(psm),
                    "-c",
                    "preserve_interword_spaces=1",
                    ...(fieldConfig.whitelist === undefined
                        ? []
                        : ["-c", `tessedit_char_whitelist=${fieldConfig.whitelist}`]),
                    "tsv"
                ];
                const result = await execa("tesseract", args, { timeout: timeoutMs, reject: false });
                if (typeof result.exitCode === "number" && result.exitCode !== 0) {
                    throw new Error(`Tesseract failed with exit code ${result.exitCode}: ${trimToLength(result.stderr, 300)}`);
                }
                const parsed = parseTsv(result.stdout);
                const normalizedText = normalizeByField(roi.field, parsed.normalizedText);
                if (normalizedText === "") {
                    return null;
                }
                const confidence = normalizeConfidence(parsed.confidence);
                logger?.log({
                    ts: Date.now(),
                    stage: "tesseract-engine",
                    level: "info",
                    message: "OCR pass completed.",
                    data: {
                        field: roi.field,
                        passId,
                        psm,
                        confidence,
                        whitelist: fieldConfig.whitelist ?? null,
                        roiPath: roi.roiImagePath
                    }
                });
                return {
                    field: roi.field,
                    text: normalizedText,
                    ...(debugUnsafeIncludeRawText
                        ? {
                            raw_text: parsed.rawText,
                            normalized_text: normalizedText,
                            psm,
                            ...(typeof result.exitCode === "number" ? { exit_code: result.exitCode } : {}),
                            stderr: trimToLength(result.stderr, 300)
                        }
                        : {}),
                    confidence,
                    bbox: {
                        x1: roi.roi.x,
                        y1: roi.roi.y,
                        x2: roi.roi.x + roi.roi.width,
                        y2: roi.roi.y + roi.roi.height
                    },
                    engine_used: "tesseract",
                    pass_id: passId,
                    psm,
                    postprocessed_roi_image_path: preprocessedPath
                };
            }
            finally {
                await cleanupPreprocessedPath(preprocessedPath);
            }
        };
        return withTimeout(execute(), timeoutMs);
    }
}
const FIELD_OCR_CONFIG = {
    fio: {
        psmByPass: { A: 6, B: 6, C: 4 },
        whitelist: "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ- "
    },
    passport_number: {
        psmByPass: { A: 7, B: 8, C: 7 },
        whitelist: "0123456789№- "
    },
    issued_by: {
        psmByPass: { A: 6, B: 6, C: 4 },
        whitelist: 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ0123456789 .,"()-'
    },
    dept_code: {
        psmByPass: { A: 7, B: 8, C: 7 },
        whitelist: "0123456789№- "
    },
    registration: {
        psmByPass: { A: 6, B: 6, C: 6 },
        whitelist: 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ0123456789 .,"()-'
    }
};
function psmForFieldAndPass(field, passId) {
    return FIELD_OCR_CONFIG[field].psmByPass[passId];
}
function normalizeText(raw) {
    return raw
        .replace(/\r/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(" ")
        .trim();
}
function parseTsv(tsv) {
    const rows = tsv
        .replace(/\r/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (rows.length <= 1) {
        return { rawText: "", normalizedText: "", confidence: null };
    }
    const textParts = [];
    const confParts = [];
    for (let index = 1; index < rows.length; index += 1) {
        const columns = rows[index]?.split("\t");
        if (columns === undefined || columns.length < 12) {
            continue;
        }
        const confValue = Number(columns[10]);
        const text = columns.slice(11).join("\t").trim();
        if (text.length === 0) {
            continue;
        }
        textParts.push(text);
        if (Number.isFinite(confValue) && confValue >= 0) {
            confParts.push(confValue);
        }
    }
    const rawText = textParts.join(" ").trim();
    const normalizedText = normalizeText(rawText);
    if (normalizedText === "" || confParts.length === 0) {
        return { rawText, normalizedText, confidence: null };
    }
    const avg = confParts.reduce((sum, value) => sum + value, 0) / confParts.length;
    return { rawText, normalizedText, confidence: avg };
}
function normalizeByField(field, value) {
    if (value.trim() === "") {
        return "";
    }
    if (field === "passport_number") {
        return normalizePassportNumber(value);
    }
    if (field === "dept_code") {
        return normalizeDeptCode(value);
    }
    return normalizeRussianText(value);
}
function normalizeConfidence(value) {
    if (value === null || !Number.isFinite(value)) {
        return 0.2;
    }
    const normalized = value / 100;
    if (normalized <= 0) {
        return 0.01;
    }
    return Math.min(1, normalized);
}
function trimToLength(value, maxChars) {
    const trimmed = (value ?? "").trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return `${trimmed.slice(0, maxChars)}...`;
}
async function withTimeout(promise, timeoutMs) {
    let timeout = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error(`Tesseract OCR timeout after ${timeoutMs}ms`));
                }, timeoutMs);
            })
        ]);
    }
    finally {
        if (timeout !== null) {
            clearTimeout(timeout);
        }
    }
}
async function cleanupPreprocessedPath(path) {
    const marker = `${join(tmpdir(), "keiscore-pre-ocr-")}`;
    if (!path.startsWith(marker)) {
        return;
    }
    await rm(dirname(path), { recursive: true, force: true });
}
//# sourceMappingURL=tesseractEngine.js.map