import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { execa } from "execa";
const ANCHOR_WORDS = [
    "ФАМИЛИЯ",
    "ИМЯ",
    "ОТЧЕСТВО",
    "КОД ПОДРАЗДЕЛЕНИЯ",
    "ВЫДАН",
    "МЕСТО ЖИТЕЛЬСТВА",
    "РОСС",
    "ФЕДЕРАЦ",
    "ПОЛ",
    "ЖЕН",
    "<<<"
];
const DEFAULT_TESSERACT_TIMEOUT_MS = 30_000;
export class AnchorModel {
    static async findAnchors(input, detection, calibration, logger, debugUnsafeIncludeRawText = false) {
        const anchors = {};
        // 0) mock anchors
        const mockAnchors = input.mockLayout?.anchors ?? {};
        for (const key of Object.keys(mockAnchors)) {
            const point = mockAnchors[key];
            if (point !== undefined) {
                anchors[key.toUpperCase()] = point;
            }
        }
        // 1) OCR tokens: mockLayout OR tesseract TSV from first page image
        const tokens = await getOcrTokens(input, logger);
        // 2) Anchor scan from tokens
        // - single-word anchors: direct match
        // - multi-word anchors: phrase match across consecutive tokens on the same line
        const normalizedTokens = tokens
            .map((t) => ({
            token: t,
            text: t.text.toUpperCase().replace(/[^А-Я0-9\- ]+/g, " ").trim()
        }))
            .filter((t) => t.text.length > 0);
        // helper: consider tokens on the same text line if y1 is close
        const sameLine = (a, b) => {
            const ay = a.bbox.y1;
            const by = b.bbox.y1;
            return Math.abs(ay - by) <= Math.max(12, Math.min(40, Math.abs((a.bbox.y2 - a.bbox.y1) * 0.6)));
        };
        // 2.1) single-token anchors
        for (const entry of normalizedTokens) {
            const normalizedToken = entry.text;
            for (const anchorWord of ANCHOR_WORDS) {
                if (anchors[anchorWord] !== undefined) {
                    continue;
                }
                const exactOrContainsMatch = normalizedToken.includes(anchorWord);
                if (exactOrContainsMatch) {
                    anchors[anchorWord] = { x: entry.token.bbox.x1, y: entry.token.bbox.y1 };
                    continue;
                }
                const prefixes = getAnchorPrefixes(anchorWord);
                const prefixMatch = prefixes.some((prefix) => normalizedToken.startsWith(prefix));
                if (prefixMatch) {
                    anchors[anchorWord] = { x: entry.token.bbox.x1, y: entry.token.bbox.y1 };
                }
            }
        }
        // 2.2) phrase anchors (multi-word)
        const sortedByLine = [...normalizedTokens].sort((a, b) => {
            if (a.token.bbox.y1 !== b.token.bbox.y1)
                return a.token.bbox.y1 - b.token.bbox.y1;
            return a.token.bbox.x1 - b.token.bbox.x1;
        });
        for (const anchorWord of ANCHOR_WORDS) {
            if (!anchorWord.includes(" "))
                continue;
            if (anchors[anchorWord] !== undefined)
                continue;
            const parts = anchorWord.split(/\s+/).filter(Boolean);
            if (parts.length < 2)
                continue;
            for (let i = 0; i < sortedByLine.length; i++) {
                const start = sortedByLine[i];
                if (start === undefined)
                    continue;
                // Safer: avoid string | undefined
                const first = parts[0] ?? "";
                if (first.length === 0)
                    continue;
                // first part must match exactly (or be a prefix, to survive OCR noise)
                if (!(start.text === first || start.text.startsWith(first)))
                    continue;
                let ok = true;
                let last = start;
                for (let p = 1; p < parts.length; p++) {
                    const expected = parts[p] ?? "";
                    const next = sortedByLine[i + p];
                    if (!next) {
                        ok = false;
                        break;
                    }
                    if (!sameLine(last.token, next.token)) {
                        ok = false;
                        break;
                    }
                    if (expected.length === 0) {
                        ok = false;
                        break;
                    }
                    if (!(next.text === expected || next.text.startsWith(expected))) {
                        ok = false;
                        break;
                    }
                    last = next;
                }
                if (ok) {
                    anchors[anchorWord] = { x: start.token.bbox.x1, y: start.token.bbox.y1 };
                    break;
                }
            }
        }
        const textLineYs = computeTextLines(tokens);
        let anchorCount = Object.keys(anchors).length;
        const fallbackTriggered = anchorCount <= 2;
        if (fallbackTriggered) {
            const fallback = buildFallbackGridAnchors(input, anchors, textLineYs, tokens);
            for (const [key, point] of Object.entries(fallback)) {
                if (anchors[key] === undefined) {
                    anchors[key] = point;
                }
            }
            anchorCount = Object.keys(anchors).length;
        }
        const baselineY = computeBaselineY(tokens, anchors);
        const lineHeight = Math.max(20, computeLineHeight(tokens));
        const scale = lineHeight / 40;
        // 3) Page type classification uses full-page OCR tokens
        const pageText = tokens.map((token) => token.text).join(" ");
        const pageType = classifyByText(pageText);
        const usedFallbackGrid = fallbackTriggered;
        const centralWindowTextPreview = debugUnsafeIncludeRawText
            ? toPreview(await getCenterText(input, logger), 200)
            : "";
        logger.log({
            ts: Date.now(),
            stage: "anchor-model",
            level: "info",
            message: "Anchor scan completed.",
            data: {
                detected: detection.detected,
                transform: calibration.transform,
                source: input.fileName,
                anchorCount,
                tokenCount: tokens.length,
                pageTextPreview: toPreview(pageText, 200),
                baselineY,
                lineHeight,
                pageType,
                usedFallbackGrid,
                textLineCount: textLineYs.length,
                ...(debugUnsafeIncludeRawText ? { central_window_text_preview: centralWindowTextPreview } : {})
            }
        });
        return {
            anchors,
            baselineY,
            lineHeight,
            scale,
            usedFallbackGrid,
            pageType,
            ...(textLineYs.length === 0 ? {} : { textLineYs }),
            ...(debugUnsafeIncludeRawText
                ? { central_window_text_preview: centralWindowTextPreview }
                : {})
        };
    }
}
function computeBaselineY(tokens, anchors) {
    const ys = tokens.map((token) => token.bbox.y1);
    for (const point of Object.values(anchors)) {
        ys.push(point.y);
    }
    if (ys.length === 0) {
        return null;
    }
    ys.sort((left, right) => left - right);
    return ys[Math.floor(ys.length / 2)] ?? null;
}
function computeLineHeight(tokens) {
    if (tokens.length === 0) {
        return 40;
    }
    const heights = tokens.map((token) => Math.max(1, token.bbox.y2 - token.bbox.y1));
    return heights.reduce((sum, value) => sum + value, 0) / heights.length;
}
function computeTextLines(tokens) {
    const ys = tokens.map((token) => token.bbox.y1).sort((a, b) => a - b);
    if (ys.length === 0) {
        return [];
    }
    const lines = [ys[0] ?? 0];
    for (let i = 1; i < ys.length; i += 1) {
        const value = ys[i];
        const last = lines[lines.length - 1] ?? value ?? 0;
        if (value === undefined) {
            continue;
        }
        if (Math.abs(value - last) > 14) {
            lines.push(value);
        }
        else {
            lines[lines.length - 1] = Math.round((last + value) / 2);
        }
    }
    return lines;
}
async function getOcrTokens(input, logger) {
    const mockTokens = input.mockLayout?.ocrTokens;
    if (mockTokens !== undefined)
        return mockTokens;
    const imagePath = input.pages?.[0]?.imagePath;
    if (!imagePath)
        return [];
    try {
        const { stdout } = await execa("tesseract", [imagePath, "stdout", "-l", "rus", "--psm", "6", "tsv"], { timeout: DEFAULT_TESSERACT_TIMEOUT_MS });
        const lines = (stdout ?? "").split("\n");
        if (lines.length <= 1)
            return [];
        const out = [];
        // TSV: header line then rows
        for (let i = 1; i < lines.length; i++) {
            const row = lines[i] ?? "";
            const parts = row.split("\t");
            if (parts.length < 12)
                continue;
            const level = Number(parts[0]);
            if (level !== 5)
                continue; // word-level rows only
            const left = Number(parts[6]);
            const top = Number(parts[7]);
            const width = Number(parts[8]);
            const height = Number(parts[9]);
            const text = (parts[11] ?? "").trim();
            if (!text)
                continue;
            if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) {
                continue;
            }
            if (width <= 0 || height <= 0)
                continue;
            out.push({
                text,
                bbox: { x1: left, y1: top, x2: left + width, y2: top + height }
            });
        }
        return out;
    }
    catch (err) {
        logger.log({
            ts: Date.now(),
            stage: "anchor-model",
            level: "warn",
            message: "Failed to build OCR tokens via tesseract TSV.",
            data: {
                reason: err instanceof Error ? err.message : String(err),
                PATH: process.env.PATH
            }
        });
        return [];
    }
}
async function getCenterText(input, logger) {
    // тестовый путь (оставляем как был)
    const mock = input.mockLayout?.centralWindowText ??
        input.mockLayout?.ocrTokens?.map((token) => token.text).join(" ");
    if (mock !== undefined) {
        return mock;
    }
    const page0 = input.pages?.[0];
    const imagePath = page0?.imagePath;
    if (!imagePath) {
        return "";
    }
    // размеры берём из metadata, иначе из поля страницы/инпута
    let width = page0?.width ?? input.width ?? 0;
    let height = page0?.height ?? input.height ?? 0;
    try {
        const meta = await sharp(imagePath).metadata();
        width = meta.width ?? width;
        height = meta.height ?? height;
    }
    catch {
        // ignore, fallback to known dims
    }
    if (!width || !height) {
        return "";
    }
    // Central crop: x 30..70%, y 35..60%
    const x1 = Math.max(0, Math.floor(width * 0.30));
    const x2 = Math.min(width, Math.floor(width * 0.70));
    const y1 = Math.max(0, Math.floor(height * 0.35));
    const y2 = Math.min(height, Math.floor(height * 0.60));
    const cropW = Math.max(1, x2 - x1);
    const cropH = Math.max(1, y2 - y1);
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "keiscore-center-"));
    const cropPath = path.join(tmpRoot, "center.png");
    try {
        await sharp(imagePath)
            .extract({ left: x1, top: y1, width: cropW, height: cropH })
            .png()
            .toFile(cropPath);
        const { stdout } = await execa("tesseract", [cropPath, "stdout", "-l", "rus", "--psm", "6"], {
            timeout: DEFAULT_TESSERACT_TIMEOUT_MS
        });
        return (stdout ?? "").trim();
    }
    catch (err) {
        logger.log({
            ts: Date.now(),
            stage: "anchor-model",
            level: "warn",
            message: "Failed to OCR central window crop.",
            data: { reason: err instanceof Error ? err.message : String(err) }
        });
        return "";
    }
    finally {
        try {
            await fs.rm(tmpRoot, { recursive: true, force: true });
        }
        catch {
            // ignore
        }
    }
}
function classifyByText(text) {
    const normalizedText = text.toUpperCase();
    const hasPassport = normalizedText.includes("ПАСПОРТ") || normalizedText.includes("АСНОРТ");
    const hasRussia = normalizedText.includes("РОССИЙСКАЯ") ||
        normalizedText.includes("РОСС") ||
        normalizedText.includes("ВОСС") ||
        normalizedText.includes("РОС");
    const hasFederation = normalizedText.includes("ФЕДЕРАЦИЯ") ||
        normalizedText.includes("ФЕДЕРАЦ") ||
        normalizedText.includes("ФЕД") ||
        normalizedText.includes("ФЕАЛ") ||
        normalizedText.includes("ФЕАЕРАЦ") ||
        normalizedText.includes("ФЕЛЕРАЦ");
    const hasSpreadLayoutHint = normalizedText.includes("КОД ПОДРАЗДЕЛЕНИЯ") ||
        normalizedText.includes("ПОДРАЗДЕЛЕНИЯ") ||
        normalizedText.includes("ДАТА ВЫДАЧИ");
    if ((hasPassport || hasSpreadLayoutHint) && hasRussia && hasFederation) {
        return "spread_page";
    }
    if (normalizedText.includes("МЕСТО ЖИТЕЛЬСТВА") ||
        (normalizedText.includes("МЕСТО") && normalizedText.includes("ЖИТЕЛЬСТВА"))) {
        return "registration_page";
    }
    return "unknown";
}
function buildFallbackGridAnchors(input, anchors, textLineYs, tokens) {
    const width = Math.max(1, input.width);
    const height = Math.max(1, input.height);
    const lineHeight = Math.max(22, computeLineHeight(tokens));
    const baseLine = anchors["ФАМИЛИЯ"]?.y ??
        anchors["КОД ПОДРАЗДЕЛЕНИЯ"]?.y ??
        textLineYs[Math.max(0, Math.floor(textLineYs.length * 0.42))] ??
        Math.round(height * 0.42);
    const leftX = Math.round(width * 0.08);
    const rightX = Math.round(width * 0.62);
    return {
        ФАМИЛИЯ: { x: leftX, y: Math.max(0, Math.round(baseLine - lineHeight * 1.2)) },
        "КОД ПОДРАЗДЕЛЕНИЯ": { x: rightX, y: Math.max(0, Math.round(baseLine + lineHeight * 0.8)) },
        ВЫДАН: { x: rightX, y: Math.max(0, Math.round(baseLine + lineHeight * 2.6)) }
    };
}
function getAnchorPrefixes(anchorWord) {
    const parts = anchorWord
        .toUpperCase()
        .split(/\s+/)
        .map((part) => part.replace(/[^А-Я0-9\-]+/g, ""))
        .filter(Boolean);
    const prefixes = new Set();
    for (const part of parts) {
        if (part.length < 4) {
            continue;
        }
        const maxLen = Math.min(6, part.length);
        for (let len = 4; len <= maxLen; len++) {
            prefixes.add(part.slice(0, len));
        }
    }
    return [...prefixes];
}
function toPreview(value, maxChars) {
    const trimmed = value.trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return `${trimmed.slice(0, maxChars)}...`;
}
//# sourceMappingURL=anchorModel.js.map