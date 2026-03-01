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
const FIELD_ORDER = ["fio", "passport_number", "issued_by", "dept_code", "registration"];
function buildDiagnostics(centralWindowTextPreview, normalization, fieldDebug) {
    const diagnostics = {};
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
function safeNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.max(0, Math.min(1, value));
}
function normalizeOcrRuText(input) {
    const raw = String(input ?? "").replace(/[\u0000-\u001f\u007f]+/gu, " ");
    const map = {
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
function computeMockQuality(layout) {
    const blur = clamp01(safeNumber(layout.quality?.blur, 0));
    const contrast = clamp01(safeNumber(layout.quality?.contrast, 0));
    const noise = clamp01(safeNumber(layout.quality?.noise, 0));
    return { blur, contrast, noise };
}
function computeMockDetected(layout) {
    const w = Math.max(1, safeNumber(layout.width, 0));
    const h = Math.max(1, safeNumber(layout.height, 0));
    const c = layout.contour;
    if (!c || w <= 1 || h <= 1)
        return { detected: false, confidence: 0 };
    const cw = Math.max(0, c.x2 - c.x1);
    const ch = Math.max(0, c.y2 - c.y1);
    const areaRatio = (cw * ch) / (w * h);
    if (!Number.isFinite(areaRatio) || areaRatio < 0.55) {
        return { detected: false, confidence: clamp01(areaRatio) };
    }
    return { detected: true, confidence: clamp01(0.6 + areaRatio * 0.4) };
}
function pickMockCandidate(layout, field) {
    const attempts = [];
    const add = (passId, attempt) => {
        if (!attempt)
            return;
        const text = String(attempt.text ?? "").trim();
        if (!text)
            return;
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
    if (attempts.length === 0)
        return [];
    const order = { A: 0, B: 1, C: 2 };
    attempts.sort((a, b) => (b.confidence - a.confidence) || (order[b.passId] - order[a.passId]));
    return attempts;
}
function buildMockResult(layout, logger) {
    const { blur, contrast, noise } = computeMockQuality(layout);
    const detected = computeMockDetected(layout);
    const isRegistrationPage = String(layout.pageTypeHint ?? "").toLowerCase().includes("registration");
    const field_reports = [];
    const errors = [];
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
        let bestValidated = null;
        let bestRaw = null;
        for (const attempt of picked) {
            const normalized = field === "passport_number" ? normalizePassportNumber(attempt.text) : normalizeOcrRuText(attempt.text);
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
            out[field] = bestValidated.validated;
            totalConfidence += bestValidated.confidence;
            counted += 1;
            logger?.log({ ts: Date.now(), stage: "mock", level: "info", message: `Mock field confirmed: ${field}` });
        }
        else if (bestRaw !== null) {
            report.pass_id = bestRaw.passId;
            report.confidence = bestRaw.confidence;
            report.best_candidate_preview = bestRaw.text;
            report.best_candidate_source = "roi";
            report.best_candidate_normalized = bestRaw.normalized;
            report.pass = false;
            report.validator_passed = false;
            report.rejection_reason = "FIELD_NOT_CONFIRMED";
            logger?.log({ ts: Date.now(), stage: "mock", level: "warn", message: `Mock field rejected: ${field}` });
        }
        else {
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
    if (importantMissing ||
        errors.some((e) => e.code === "QUALITY_WARNING" || e.code === "DOCUMENT_NOT_DETECTED")) {
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
        return { code: "INTERNAL_ERROR", message: error.message };
    }
    return { code: "INTERNAL_ERROR", message: "Unknown extraction failure" };
}
function validateByField(field, value) {
    if (field === "fio")
        return validateFio(value);
    if (field === "passport_number")
        return validatePassportNumber(value);
    if (field === "issued_by")
        return validateIssuedBy(value);
    if (field === "dept_code")
        return validateDeptCode(value);
    return validateRegistration(value);
}
function emptyFieldReport(field, roi, engine) {
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
function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}
function roiFromRatios(field, w, h, page) {
    // Stable fallback grid on normalized passport spread.
    const map = {
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
function expandRoi(roi, pageWidth, pageHeight, expand) {
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
function buildDeptCodeRoiFromAnchorBox(anchorBox, pageWidth, pageHeight, page) {
    const x = clamp(Math.round(anchorBox.x), 0, Math.max(0, pageWidth - 1));
    const y = clamp(Math.round(anchorBox.y + anchorBox.height + 10), 0, Math.max(0, pageHeight - 1));
    const width = Math.max(1, Math.round(anchorBox.width * 1.6));
    const height = Math.max(1, Math.round(anchorBox.height * 1.2));
    const x2 = clamp(x + width, x + 1, Math.max(1, pageWidth));
    const y2 = clamp(y + height, y + 1, Math.max(1, pageHeight));
    return { x, y, width: Math.max(1, x2 - x), height: Math.max(1, y2 - y), page };
}
function shiftRoiVertical(roi, offsetY, pageHeight) {
    const y = clamp(roi.y + offsetY, 0, Math.max(0, pageHeight - 1));
    const y2 = clamp(y + roi.height, y + 1, Math.max(1, pageHeight));
    return { ...roi, y, height: Math.max(1, y2 - y) };
}
function normalizeDeptCodeStrict(raw) {
    const normalized = normalizeRussianText(raw).replace(/[^0-9\-]/gu, "");
    if (normalized.length !== 7)
        return "";
    if (!normalized.includes("-"))
        return "";
    if (!/^\d{3}-\d{3}$/u.test(normalized))
        return "";
    return normalized;
}
function clampIntValue(value, min, max) {
    return Math.max(min, Math.min(max, Math.round(value)));
}
function makeRoi(pageWidth, pageHeight, page, x, y, width, height) {
    const left = clampIntValue(x, 0, Math.max(0, pageWidth - 1));
    const top = clampIntValue(y, 0, Math.max(0, pageHeight - 1));
    const right = clampIntValue(left + width, left + 1, Math.max(1, pageWidth));
    const bottom = clampIntValue(top + height, top + 1, Math.max(1, pageHeight));
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top), page };
}
function buildDeptCodeRoiCandidates(anchorBbox, pageWidth, pageHeight, page) {
    const candidates = [];
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
    const dedup = new Map();
    for (const candidate of candidates) {
        const key = `${candidate.x}:${candidate.y}:${candidate.width}:${candidate.height}`;
        if (!dedup.has(key))
            dedup.set(key, candidate);
    }
    return [...dedup.values()];
}
function computeOtsuThresholdRaw(data) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < data.length; i += 1) {
        hist[data[i] ?? 0] = (hist[data[i] ?? 0] ?? 0) + 1;
    }
    const total = data.length;
    if (total === 0)
        return 200;
    let sum = 0;
    for (let i = 0; i < 256; i += 1)
        sum += i * (hist[i] ?? 0);
    let sumB = 0;
    let wB = 0;
    let maxVar = -1;
    let threshold = 200;
    for (let i = 0; i < 256; i += 1) {
        wB += hist[i] ?? 0;
        if (wB === 0)
            continue;
        const wF = total - wB;
        if (wF === 0)
            break;
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
async function computeInkScore(pagePath, roi) {
    const { data } = await sharp(pagePath)
        .extract({ left: roi.x, top: roi.y, width: roi.width, height: roi.height })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
    if (data.length === 0)
        return 0;
    const otsu = computeOtsuThresholdRaw(data);
    const threshold = Math.max(otsu, 200);
    let black = 0;
    for (let i = 0; i < data.length; i += 1) {
        if ((data[i] ?? 255) < threshold)
            black += 1;
    }
    return black / data.length;
}
function regexForField(field) {
    if (field === "passport_number")
        return /\d{4}\s?\d{6}/u;
    if (field === "dept_code")
        return /\d{3}-\d{3}/u;
    return null;
}
function computeRussianCharRatio(text) {
    const compact = String(text ?? "").replace(/\s+/gu, "");
    if (!compact)
        return 0;
    const matches = compact.match(/[А-ЯЁ]/gu) ?? [];
    return matches.length / compact.length;
}
function computeLengthScore(field, text) {
    const len = String(text ?? "").trim().length;
    if (len === 0)
        return 0;
    if (field === "fio")
        return len >= 8 && len <= 90 ? 1 : 0;
    if (field === "issued_by")
        return len > 15 ? 1 : 0;
    if (field === "registration")
        return len > 10 ? 1 : 0;
    if (field === "passport_number")
        return len >= 10 && len <= 13 ? 1 : 0;
    if (field === "dept_code")
        return len >= 7 && len <= 8 ? 1 : 0;
    return 0;
}
export function rankCandidates(candidates) {
    return [...candidates]
        .map((candidate) => ({
        ...candidate,
        rankingScore: candidate.field === "dept_code"
            ? clamp01(candidate.confidence) * 0.5 +
                clamp01(candidate.regexMatch) * 0.4 +
                clamp01(candidate.lengthScore) * 0.1
            : clamp01(candidate.confidence) * 0.4 +
                clamp01(candidate.regexMatch) * 0.3 +
                clamp01(candidate.lengthScore) * 0.1 +
                clamp01(candidate.russianCharRatio) * 0.1 +
                clamp01(candidate.anchorAlignmentScore) * 0.1
    }))
        .sort((a, b) => b.rankingScore - a.rankingScore ||
        Number(b.validated !== null) - Number(a.validated !== null) ||
        b.confidence - a.confidence);
}
function anchorScoreForField(field, anchorKeys) {
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
async function cropToFile(srcPath, roi, outPath) {
    await sharp(srcPath)
        .extract({ left: roi.x, top: roi.y, width: roi.width, height: roi.height })
        .png({ compressionLevel: 9 })
        .toFile(outPath);
}
async function preprocessForOcr(inPath, outPath, mode) {
    const img = sharp(inPath).grayscale();
    const thr = mode === "digits" ? 205 : 220;
    await img.normalize().median(1).threshold(thr).png({ compressionLevel: 9 }).toFile(outPath);
}
async function saveRoiPassDebugArtifacts(params) {
    const debugDirRaw = process.env.KEISCORE_DEBUG_ROI_DIR;
    const debugDir = debugDirRaw === undefined ? "" : String(debugDirRaw).trim();
    if (debugDir === "")
        return;
    await mkdir(debugDir, { recursive: true });
    const ts = Date.now();
    const stem = `${ts}_field-${params.field}_pass-${params.passId}_stage-${params.stage}_mode-${params.mode}_x${params.roi.x}_y${params.roi.y}_w${params.roi.width}_h${params.roi.height}`;
    const beforePath = join(debugDir, `${stem}_before.png`);
    const afterPath = join(debugDir, `${stem}_after.png`);
    const overlayPath = join(debugDir, `${stem}_overlay.png`);
    const metaPath = join(debugDir, `${stem}.json`);
    await sharp(params.cropPath).png().toFile(beforePath);
    await sharp(params.prePath).png().toFile(afterPath);
    const roiOverlay = Buffer.from(`<svg width="${params.roi.width}" height="${params.roi.height}"><rect x="1" y="1" width="${Math.max(1, params.roi.width - 2)}" height="${Math.max(1, params.roi.height - 2)}" fill="none" stroke="#22c55e" stroke-width="2"/></svg>`);
    await sharp(params.pagePath)
        .extract({ left: params.roi.x, top: params.roi.y, width: params.roi.width, height: params.roi.height })
        .composite([{ input: roiOverlay, top: 0, left: 0 }])
        .png()
        .toFile(overlayPath);
    await writeFile(metaPath, JSON.stringify({
        field: params.field,
        passId: params.passId,
        stage: params.stage,
        mode: params.mode,
        roi: params.roi,
        psmList: params.psmList,
        before: beforePath,
        after: afterPath,
        overlay: overlayPath
    }, null, 2), "utf8");
}
async function runTesseractTsv(imagePath, lang, timeoutMs, psm, whitelist) {
    const base = imagePath.replace(/\.png$/i, "");
    const args = [
        imagePath,
        base,
        "-l",
        lang,
        "--psm",
        String(psm),
        ...(whitelist === undefined || whitelist === "" ? [] : ["-c", `tessedit_char_whitelist=${whitelist}`]),
        "tsv"
    ];
    await execa("tesseract", args, { timeout: timeoutMs, reject: false });
    try {
        return await readFile(`${base}.tsv`, "utf8");
    }
    catch {
        return "";
    }
}
function parseTsvWords(tsv) {
    const lines = String(tsv ?? "").split(/\r?\n/u);
    const out = [];
    for (const line of lines) {
        if (!line || line.startsWith("level\t"))
            continue;
        const cols = line.split("\t");
        if (cols.length < 12)
            continue;
        const text = (cols[11] ?? "").trim();
        if (!text)
            continue;
        const conf = Number(cols[10] ?? "-1");
        if (!Number.isFinite(conf) || conf < 0)
            continue;
        const left = Number(cols[6] ?? "0");
        const top = Number(cols[7] ?? "0");
        const width = Number(cols[8] ?? "0");
        const height = Number(cols[9] ?? "0");
        if (![left, top, width, height].every((v) => Number.isFinite(v)))
            continue;
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
function getLineKey(word) {
    const hasStructuredLine = Number.isFinite(Number(word.lineNum)) && Number(word.lineNum) > 0;
    if (hasStructuredLine) {
        const b = Number(word.blockNum ?? 0);
        const p = Number(word.parNum ?? 0);
        const l = Number(word.lineNum ?? 0);
        return `${b}:${p}:${l}`;
    }
    if (typeof word.lineKey === "string" && word.lineKey)
        return word.lineKey;
    const b = Number(word.blockNum ?? 0);
    const p = Number(word.parNum ?? 0);
    const l = Number(word.lineNum ?? 0);
    return `${b}:${p}:${l}`;
}
function getCenterY(word) {
    const y0 = Number(word.y0 ?? word.bbox?.y1 ?? 0);
    const y1 = Number(word.y1 ?? word.bbox?.y2 ?? 0);
    return (y0 + y1) / 2;
}
function getLeftX(word) {
    return Number(word.x0 ?? word.bbox?.x1 ?? 0);
}
function groupWordsIntoLines(words) {
    const byLine = new Map();
    for (const w of words) {
        const key = getLineKey(w);
        const arr = byLine.get(key) ?? [];
        arr.push(w);
        byLine.set(key, arr);
    }
    const lines = [];
    for (const [key, arr] of byLine.entries()) {
        arr.sort((a, b) => getLeftX(a) - getLeftX(b));
        const text = arr.map((w) => w.text).join(" ").replace(/\s+/gu, " ").trim();
        const avgConf = arr.reduce((s, w) => s + Number(w.confidence ?? 0), 0) / Math.max(1, arr.length);
        const y = arr.reduce((s, w) => s + getCenterY(w), 0) / Math.max(1, arr.length);
        if (text)
            lines.push({ key, y, text, avgConf });
    }
    lines.sort((a, b) => a.y - b.y);
    return lines;
}
function cleanCyrillicLine(input) {
    return normalizeOcrRuText(String(input ?? ""))
        .replace(/[^А-ЯЁ\s\-\.]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}
function digitRatio(text) {
    const t = String(text ?? "");
    const nonSpace = t.replace(/\s+/gu, "");
    if (!nonSpace)
        return 0;
    const digits = (nonSpace.match(/\d/gu) ?? []).length;
    return digits / nonSpace.length;
}
/**
 * TEST HELPER: Choose best FIO from multiple OCR lines.
 */
export function selectBestFioFromCyrillicLines(lines, surnamesHints = []) {
    const hintSet = new Set(surnamesHints
        .map((s) => normalizeOcrRuText(s).split(" ")[0] ?? "")
        .filter((s) => /^[А-ЯЁ-]+$/u.test(s)));
    const scored = [];
    const garbageTokens = /(ЛЕНИНГРАДСКАЯ|ОБЛАСТЬ|ГУ|МВД|РОССИИ|ТОСНО|РАЙОН)/u;
    for (const raw of lines) {
        const normalized = normalizeOcrRuText(raw);
        if (normalized.length < 8)
            continue;
        if (/\d/u.test(normalized))
            continue;
        if (!/^[А-ЯЁ\s-]+$/u.test(normalized))
            continue;
        const words = normalized.split(" ").filter(Boolean);
        if (words.length !== 3)
            continue;
        if (!words.every((word) => /^[А-ЯЁ-]+$/u.test(word)))
            continue;
        const validated = validateFio(normalized);
        if (validated === null)
            continue;
        const surname = words[0] ?? "";
        let score = 0;
        score += 20;
        score += Math.min(12, validated.length / 3);
        if (hintSet.size > 0 && hintSet.has(surname))
            score += 40;
        if (garbageTokens.test(validated))
            score -= 40;
        scored.push({ v: validated, score });
    }
    scored.sort((a, b) => b.score - a.score || b.v.length - a.v.length || a.v.localeCompare(b.v, "ru"));
    return scored[0]?.v ?? null;
}
/**
 * TEST HELPER: Build "issued_by" candidates from TSV words.
 */
export function buildIssuedByCandidatesFromTsvWords(words) {
    const normalizedWords = words.map((w) => ({ ...w, text: normalizeOcrRuText(w.text) }));
    const lines = groupWordsIntoLines(normalizedWords)
        .map((l) => ({
        text: normalizeOcrRuText(l.text).replace(/[^А-ЯЁ0-9\s"().,\-]/gu, " ").replace(/\s+/gu, " ").trim(),
        conf: l.avgConf
    }))
        .filter((l) => l.text.length >= 4)
        .filter((l) => digitRatio(l.text) <= 0.12);
    const looksLikeContinuation = (lineText) => {
        if (!lineText)
            return false;
        return /^И(?:\s|$)/u.test(lineText) || /ЛЕНИНГРАДСКОЙ/u.test(lineText);
    };
    const candidates = [];
    const pushCandidate = (value, confidence) => {
        const text = normalizeOcrRuText(value);
        if (text.length < 10)
            return;
        if (/\d{6,}/u.test(text))
            return;
        const markerHits = ISSUED_BY_MARKERS.reduce((acc, m) => (text.includes(m) ? acc + 1 : acc), 0);
        candidates.push({ text, confidence, markerScore: markerHits });
    };
    for (let i = 0; i < lines.length; i += 1) {
        const line1 = lines[i];
        if (!line1)
            continue;
        pushCandidate(line1.text, line1.conf);
        const line2 = lines[i + 1];
        if (!line2)
            continue;
        pushCandidate(`${line1.text} ${line2.text}`, (line1.conf + line2.conf) / 2);
        if (looksLikeContinuation(line2.text)) {
            pushCandidate(`${line1.text} ${line2.text}`, (line1.conf + line2.conf) / 2 + 0.01);
        }
    }
    candidates.sort((a, b) => b.markerScore - a.markerScore || b.confidence - a.confidence || b.text.length - a.text.length);
    const unique = new Map();
    for (const c of candidates) {
        if (!c.text.includes("МВД") && c.markerScore === 0)
            continue;
        if (validateIssuedBy(c.text) === null)
            continue;
        if (!unique.has(c.text))
            unique.set(c.text, { text: c.text, confidence: c.confidence });
    }
    return [...unique.values()];
}
function pickFioCandidate(lines) {
    const selected = selectBestFioFromCyrillicLines(lines.map((l) => l.text));
    if (!selected)
        return null;
    const bestLine = lines
        .map((l) => ({ clean: cleanCyrillicLine(l.text), conf: l.avgConf }))
        .filter((l) => normalizeRussianText(l.clean) === selected)
        .sort((a, b) => b.conf - a.conf)[0] ?? null;
    return { value: selected, conf: bestLine?.conf ?? 0.3 };
}
function pickIssuedByCandidate(lines) {
    const words = [];
    for (let i = 0; i < lines.length; i += 1) {
        words.push({ text: lines[i]?.text ?? "", confidence: lines[i]?.avgConf ?? 0, lineKey: `0:0:${i}` });
    }
    const candidates = buildIssuedByCandidatesFromTsvWords(words);
    const best = candidates[0];
    if (!best)
        return null;
    return { value: best.text, conf: best.confidence };
}
function pickRegistrationCandidate(lines) {
    const cleaned = lines
        .map((l) => ({ text: normalizeRussianText(String(l.text ?? "")), conf: l.avgConf }))
        .map((l) => ({ text: l.text.replace(/[<>]/gu, " ").replace(/\s+/gu, " ").trim(), conf: l.conf }))
        .filter((l) => l.text.length >= 12)
        .filter((l) => digitRatio(l.text) <= 0.25);
    const candidates = [];
    for (let i = 0; i < cleaned.length; i += 1) {
        for (let len = 1; len <= 5; len += 1) {
            const slice = cleaned.slice(i, i + len);
            if (slice.length === 0)
                continue;
            const value = slice.map((s) => s.text).join(" ").replace(/\s+/gu, " ").trim();
            if (value.length < 20)
                continue;
            if (/\d{10,}/u.test(value))
                continue;
            const conf = slice.reduce((s, it) => s + it.conf, 0) / Math.max(1, slice.length);
            candidates.push({ value, conf });
        }
    }
    candidates.sort((a, b) => b.conf - a.conf || b.value.length - a.value.length);
    for (const c of candidates) {
        const normalized = normalizeRussianText(c.value);
        if (validateRegistration(normalized) === null)
            return { value: normalized, conf: c.conf };
    }
    return null;
}
async function ocrTsvLinesForRoi(pagePath, roi, tmp, lang, timeoutMs, mode, psmList, whitelist, debugContext) {
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
    const emptyZones = [];
    let bestLines = [];
    let bestPreview = [];
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
async function ocrPlainText(pagePath, roi, tmp, lang, timeoutMs, psm, debugContext) {
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
    }
    catch {
        return "";
    }
}
async function ocrDeptCodeStrictLinesForRoi(pagePath, roi, tmp, lang, timeoutMs, debugContext) {
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
function bestCandidateReport(field, roi, attempts, best, rankedTop) {
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
            source: (attempt.source ?? "roi"),
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
                .concat([...attempts]
                .map((a) => ({
                validated: validateByField(field, a.normalized_preview ?? ""),
                raw_preview: String(a.raw_text_preview ?? "").slice(0, 120),
                normalized_preview: String(a.normalized_preview ?? "").slice(0, 120),
                confidence: Number(a.confidence ?? 0),
                psm: a.psm ?? null,
                source: (a.source ?? "roi"),
                validator_passed: false,
                rejection_reason: "FIELD_NOT_CONFIRMED"
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
                .slice(0, 3))
                .slice(0, 3)
        }
    };
}
function splitRoiIntoHorizontalZones(roi, zones) {
    const out = [];
    const zoneHeight = Math.max(1, Math.floor(roi.height / Math.max(1, zones)));
    for (let idx = 0; idx < zones; idx += 1) {
        const y = roi.y + zoneHeight * idx;
        const isLast = idx === zones - 1;
        const height = isLast ? Math.max(1, roi.y + roi.height - y) : zoneHeight;
        out.push({ x: roi.x, y, width: roi.width, height, page: roi.page });
    }
    return out;
}
function cleanCyrillicWords(text) {
    return normalizeRussianText(text)
        .replace(/[^А-ЯЁ\s-]/gu, " ")
        .replace(/\d/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}
export function selectFioFromThreeZones(zoneLines) {
    if (zoneLines.length !== 3)
        return null;
    const cleaned = zoneLines
        .map((line) => cleanCyrillicWords(line))
        .filter((line) => line.length >= 3 && line.length <= 30 && !/\d/u.test(line));
    if (cleaned.length !== 3)
        return null;
    const candidate = cleaned.join(" ").replace(/\s+/gu, " ").trim();
    return validateFio(candidate) ?? null;
}
async function resolveRoisWithAnchorFirst(normalized, logger, width, height, pageIndex) {
    const fallback = {
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
        const fromAnchors = {};
        for (const item of mapped) {
            fromAnchors[item.field] = item.roi;
        }
        const fallbackUsed = anchors.usedFallbackGrid ||
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
                anchorKeys: new Set(),
                anchorsFoundCount,
                anchorKeysTop,
                fallbackUsed: true,
                ...(deptCodeAnchorBox === undefined ? {} : { deptCodeAnchorBox })
            };
        }
        const rois = {
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
            ...(deptCodeAnchorBox === undefined ? {} : { deptCodeAnchorBox })
        };
    }
    catch (error) {
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
            anchorKeys: new Set(),
            anchorsFoundCount: 0,
            anchorKeysTop: [],
            fallbackUsed: true
        };
    }
}
function makeRankedCandidate(params) {
    const validated = validateByField(params.field, params.normalized);
    return {
        field: params.field,
        pass_id: params.pass_id,
        source: params.source,
        psm: params.psm,
        raw_text_preview: params.raw.slice(0, 120),
        normalized_preview: params.normalized.slice(0, 120),
        confidence: clamp01(params.confidence),
        regexMatch: params.regex === null || params.regex === undefined
            ? validated !== null
                ? 1
                : 0
            : params.regex.test(params.normalized)
                ? 1
                : 0,
        lengthScore: computeLengthScore(params.field, params.normalized),
        russianCharRatio: computeRussianCharRatio(params.normalized),
        anchorAlignmentScore: clamp01(params.anchorAlignmentScore),
        rankingScore: 0,
        validated
    };
}
export class RfInternalPassportExtractor {
    static async extract(input, opts) {
        const options = normalizeOptions(opts);
        const logger = options.logger;
        const errors = [];
        let tmp = null;
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
                return buildMockResult(normalized.mockLayout, logger);
            }
            const page0 = normalized.pages && normalized.pages[0];
            const pagePath = page0?.imagePath ?? null;
            if (!pagePath) {
                errors.push({ code: "INTERNAL_ERROR", message: "Normalized page image is missing." });
                const out = {
                    ...BASE_RESULT,
                    confidence_score: 0,
                    field_reports: FIELD_ORDER.map((f) => emptyFieldReport(f, { x: 0, y: 0, width: 0, height: 0, page: 0 }, "none")),
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
            const { rois, anchorKeys, anchorsFoundCount, anchorKeysTop, fallbackUsed, deptCodeAnchorBox } = await resolveRoisWithAnchorFirst(normalized, logger, width, height, pageIndex);
            const thresholdStrategyUsed = normalized.preprocessing?.thresholdStrategy ?? "legacy";
            const debugDir = process.env.KEISCORE_DEBUG_ROI_DIR ? String(process.env.KEISCORE_DEBUG_ROI_DIR) : "";
            if (debugDir) {
                try {
                    await mkdir(debugDir, { recursive: true });
                    const overlay = await sharp(pagePath)
                        .composite(Object.values(rois).map((r) => ({
                        input: Buffer.from(`<svg width="${width}" height="${height}"><rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="none" stroke="#00FF88" stroke-width="6"/></svg>`),
                        top: 0,
                        left: 0
                    })))
                        .png()
                        .toBuffer();
                    await writeFile(join(debugDir, "overlay_zones.png"), overlay);
                    await sharp(pagePath).png().toFile(join(debugDir, "normalized_page.png"));
                    for (const [field, roi] of Object.entries(rois)) {
                        await cropToFile(pagePath, roi, join(debugDir, `${field}.png`));
                    }
                    await writeFile(join(debugDir, "roi_bbox_overlay.json"), JSON.stringify({
                        width,
                        height,
                        rois
                    }, null, 2), "utf8");
                    await writeFile(join(debugDir, "extractor_anchor_audit.json"), JSON.stringify({
                        anchorsFoundCount,
                        anchorKeys: anchorKeysTop,
                        fallbackUsed,
                        deptCodeAnchorBox: deptCodeAnchorBox ?? null
                    }, null, 2), "utf8");
                }
                catch {
                    // ignore
                }
            }
            const fieldReports = [];
            const fieldDebug = {};
            // passport_number
            {
                const field = "passport_number";
                const roi = rois[field];
                const attempts = [];
                const ranked = [];
                const anchorAlignmentScore = anchorScoreForField(field, anchorKeys);
                const variants = [
                    { passId: "A", roi, psmList: [6], confidence: 0.82 },
                    {
                        passId: "B",
                        roi: expandRoi(roi, width, height, { left: 0.2, right: 0.2, top: 1.1, bottom: 0.8 }),
                        psmList: [7, 6],
                        confidence: 0.7
                    },
                    {
                        passId: "C",
                        roi: expandRoi(roi, width, height, { left: 0.35, right: 0.35, top: 1.4, bottom: 1.2 }),
                        psmList: [11, 7],
                        confidence: 0.6
                    }
                ];
                const allDebugPreviews = [];
                const allDebugEmptyZones = [];
                for (const variant of variants) {
                    const linesRes = await ocrTsvLinesForRoi(pagePath, variant.roi, tmp, options.tesseractLang ?? "rus", options.ocrTimeoutMs ?? 30_000, "digits", variant.psmList, "0123456789№ ", { field, passId: variant.passId });
                    allDebugPreviews.push(...linesRes.debug.previews);
                    allDebugEmptyZones.push(...linesRes.debug.emptyZones);
                    const joined = linesRes.lines.map((l) => l.text).join(" ");
                    const digits = normalizePassportNumber(joined);
                    const normalizedText = digits.length >= 10 ? `${digits.slice(0, 4)} ${digits.slice(4, 10)}` : digits;
                    attempts.push({
                        pass_id: variant.passId,
                        raw_text_preview: joined.slice(0, 120),
                        normalized_preview: normalizedText.slice(0, 120),
                        source: "zonal_tsv",
                        confidence: variant.confidence,
                        psm: variant.psmList[0] ?? 6
                    });
                    ranked.push(makeRankedCandidate({
                        field,
                        pass_id: variant.passId,
                        source: "zonal_tsv",
                        psm: variant.psmList[0] ?? 6,
                        raw: joined,
                        normalized: normalizedText,
                        confidence: variant.confidence,
                        anchorAlignmentScore,
                        regex: regexForField(field)
                    }));
                }
                const rankedTop = rankCandidates(ranked);
                const best = rankedTop[0];
                fieldReports.push(bestCandidateReport(field, roi, attempts, {
                    preview: best?.normalized_preview ?? attempts[0]?.normalized_preview ?? "",
                    normalized: best?.validated ?? "",
                    confidence: best?.confidence ?? 0,
                    source: (best?.source ?? "zonal_tsv"),
                    pass_id: best?.pass_id ?? "A",
                    selectedPass: best?.pass_id ?? "A",
                    rankingScore: best?.rankingScore ?? 0,
                    anchorAlignmentScore: best?.anchorAlignmentScore ?? anchorAlignmentScore,
                    thresholdStrategyUsed,
                    validator_passed: (best?.validated ?? null) !== null,
                    rejection_reason: (best?.validated ?? null) === null ? "FIELD_NOT_CONFIRMED" : null
                }, rankedTop.slice(0, 3)));
                fieldDebug[field] = {
                    zonal_tsv_lines_preview: allDebugPreviews,
                    zonal_tsv_empty_zones: allDebugEmptyZones,
                    thresholdStrategyUsed
                };
            }
            // dept_code
            {
                const field = "dept_code";
                if (tmp === null) {
                    throw new Error("Temporary OCR directory is not initialized");
                }
                const tmpDir = tmp;
                const roi = deptCodeAnchorBox === undefined
                    ? rois[field]
                    : buildDeptCodeRoiFromAnchorBox(deptCodeAnchorBox, width, height, rois[field].page);
                const attempts = [];
                const ranked = [];
                const anchorAlignmentScore = anchorScoreForField(field, anchorKeys);
                const locatorCandidates = deptCodeAnchorBox === undefined
                    ? [roi, shiftRoiVertical(roi, -12, height), shiftRoiVertical(roi, 12, height)]
                    : buildDeptCodeRoiCandidates(deptCodeAnchorBox, width, height, roi.page);
                const scored = await Promise.all(locatorCandidates.map(async (candidateRoi) => ({
                    roi: candidateRoi,
                    inkScore: await computeInkScore(pagePath, candidateRoi)
                })));
                const topCandidates = scored
                    .filter((item) => item.inkScore >= 0.01)
                    .sort((a, b) => b.inkScore - a.inkScore)
                    .slice(0, 6);
                const debugDir = (process.env.KEISCORE_DEBUG_ROI_DIR ?? "").trim();
                if (debugDir !== "") {
                    await writeFile(join(debugDir, "dept_code_locator_candidates.json"), JSON.stringify({
                        total: scored.length,
                        selectedTop: topCandidates.length,
                        candidates: scored.map((item) => ({
                            roi: item.roi,
                            inkScore: Number(item.inkScore.toFixed(6))
                        }))
                    }, null, 2), "utf8").catch(() => undefined);
                }
                for (let i = 0; i < topCandidates.length; i += 1) {
                    const item = topCandidates[i];
                    if (item === undefined)
                        continue;
                    const passId = i === 0 ? "A" : i === 1 ? "B" : "C";
                    const lines = await ocrDeptCodeStrictLinesForRoi(pagePath, item.roi, tmpDir, options.tesseractLang ?? "rus", options.ocrTimeoutMs ?? 30_000, { field, passId: `loc${i + 1}` });
                    const joined = lines.map((l) => l.text).join(" ");
                    const normalizedText = normalizeDeptCodeStrict(joined);
                    const confidence = lines.reduce((best, line) => Math.max(best, line.avgConf), 0);
                    attempts.push({
                        pass_id: passId,
                        raw_text_preview: joined.slice(0, 120),
                        normalized_preview: normalizedText.slice(0, 120),
                        source: "zonal_tsv",
                        confidence,
                        psm: 7
                    });
                    ranked.push(makeRankedCandidate({
                        field,
                        pass_id: passId,
                        source: "zonal_tsv",
                        psm: 7,
                        raw: joined,
                        normalized: normalizedText,
                        confidence,
                        anchorAlignmentScore,
                        regex: regexForField(field)
                    }));
                    if (/^\d{3}-\d{3}$/u.test(normalizedText)) {
                        break;
                    }
                }
                const rankedTop = rankCandidates(ranked);
                const best = rankedTop[0];
                fieldReports.push(bestCandidateReport(field, roi, attempts, {
                    preview: best?.normalized_preview ?? attempts[0]?.normalized_preview ?? "",
                    normalized: best?.validated ?? "",
                    confidence: best?.confidence ?? 0,
                    source: (best?.source ?? "zonal_tsv"),
                    pass_id: best?.pass_id ?? "A",
                    selectedPass: best?.pass_id ?? "A",
                    rankingScore: best?.rankingScore ?? 0,
                    anchorAlignmentScore: best?.anchorAlignmentScore ?? anchorAlignmentScore,
                    thresholdStrategyUsed,
                    validator_passed: (best?.validated ?? null) !== null,
                    rejection_reason: (best?.validated ?? null) === null ? "FIELD_NOT_CONFIRMED" : null
                }, rankedTop.slice(0, 3)));
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
                const field = "fio";
                const roi = rois[field];
                const attempts = [];
                const ranked = [];
                const anchorAlignmentScore = anchorScoreForField(field, anchorKeys);
                const passConfigs = [
                    { passId: "A", psm: 6 },
                    { passId: "B", psm: 11 }
                ];
                for (const config of passConfigs) {
                    const zoneRois = splitRoiIntoHorizontalZones(roi, 3);
                    const zoneTexts = [];
                    let zoneConfidence = 0;
                    for (const zoneRoi of zoneRois) {
                        const linesRes = await ocrTsvLinesForRoi(pagePath, zoneRoi, tmp, options.tesseractLang ?? "rus", options.ocrTimeoutMs ?? 30_000, "text", [config.psm], "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ- ", { field, passId: config.passId });
                        const bestLine = linesRes.lines.sort((a, b) => b.avgConf - a.avgConf)[0];
                        const clean = cleanCyrillicWords(bestLine?.text ?? "");
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
                        ranked.push(makeRankedCandidate({
                            field,
                            pass_id: config.passId,
                            source: "zonal_tsv",
                            psm: config.psm,
                            raw: assembledFio,
                            normalized,
                            confidence: zoneConfidence / 3,
                            anchorAlignmentScore
                        }));
                    }
                }
                if (ranked.length === 0) {
                    const raw = await ocrPlainText(pagePath, roi, tmp, options.tesseractLang ?? "rus", options.ocrTimeoutMs ?? 30_000, 6, { field, passId: "C" });
                    const clean = cleanCyrillicWords(raw);
                    attempts.push({
                        pass_id: "C",
                        raw_text_preview: raw.slice(0, 120),
                        normalized_preview: clean.slice(0, 120),
                        source: "roi",
                        confidence: 0.15,
                        psm: 6
                    });
                    ranked.push(makeRankedCandidate({
                        field,
                        pass_id: "C",
                        source: "roi",
                        psm: 6,
                        raw,
                        normalized: clean,
                        confidence: 0.15,
                        anchorAlignmentScore
                    }));
                }
                const rankedTop = rankCandidates(ranked);
                const best = rankedTop[0];
                fieldReports.push(bestCandidateReport(field, roi, attempts, {
                    preview: best?.normalized_preview ?? "",
                    normalized: best?.validated ?? "",
                    confidence: best?.confidence ?? 0,
                    source: (best?.source ?? "roi"),
                    pass_id: best?.pass_id ?? "C",
                    selectedPass: best?.pass_id ?? "C",
                    rankingScore: best?.rankingScore ?? 0,
                    anchorAlignmentScore: best?.anchorAlignmentScore ?? anchorAlignmentScore,
                    thresholdStrategyUsed,
                    validator_passed: (best?.validated ?? null) !== null,
                    rejection_reason: (best?.validated ?? null) === null ? "FIELD_NOT_CONFIRMED" : null
                }, rankedTop.slice(0, 3)));
            }
            // issued_by
            {
                const field = "issued_by";
                const roi = rois[field];
                const attempts = [];
                const ranked = [];
                const anchorAlignmentScore = anchorScoreForField(field, anchorKeys);
                const passConfigs = [
                    { passId: "A", psm: 4 },
                    { passId: "B", psm: 6 }
                ];
                for (const config of passConfigs) {
                    const linesRes = await ocrTsvLinesForRoi(pagePath, roi, tmp, options.tesseractLang ?? "rus", options.ocrTimeoutMs ?? 30_000, "text", [config.psm], undefined, { field, passId: config.passId });
                    const candidate = pickIssuedByCandidate(linesRes.lines);
                    const normalized = normalizeRussianText(candidate?.value ?? linesRes.lines.map((l) => l.text).join(" "));
                    if (normalized.length <= 15)
                        continue;
                    attempts.push({
                        pass_id: config.passId,
                        raw_text_preview: normalized.slice(0, 120),
                        normalized_preview: normalized.slice(0, 120),
                        source: "zonal_tsv",
                        confidence: candidate?.conf ?? 0.2,
                        psm: config.psm
                    });
                    const markerHits = ISSUED_BY_MARKERS.reduce((acc, marker) => (normalized.includes(marker) ? acc + 1 : acc), 0);
                    ranked.push(makeRankedCandidate({
                        field,
                        pass_id: config.passId,
                        source: "zonal_tsv",
                        psm: config.psm,
                        raw: normalized,
                        normalized,
                        confidence: clamp01((candidate?.conf ?? 0.2) + Math.min(0.2, markerHits * 0.05)),
                        anchorAlignmentScore
                    }));
                }
                const rankedTop = rankCandidates(ranked);
                const best = rankedTop[0];
                fieldReports.push(bestCandidateReport(field, roi, attempts, {
                    preview: best?.normalized_preview ?? "",
                    normalized: best?.validated ?? "",
                    confidence: best?.confidence ?? 0,
                    source: (best?.source ?? "roi"),
                    pass_id: best?.pass_id ?? "C",
                    selectedPass: best?.pass_id ?? "C",
                    rankingScore: best?.rankingScore ?? 0,
                    anchorAlignmentScore: best?.anchorAlignmentScore ?? anchorAlignmentScore,
                    thresholdStrategyUsed,
                    validator_passed: (best?.validated ?? null) !== null,
                    rejection_reason: (best?.validated ?? null) === null ? "FIELD_NOT_CONFIRMED" : null
                }, rankedTop.slice(0, 3)));
            }
            // registration
            {
                const field = "registration";
                const roi = rois[field];
                const attempts = [];
                const ranked = [];
                const anchorAlignmentScore = anchorScoreForField(field, anchorKeys);
                const passConfigs = [
                    { passId: "A", psm: 6 },
                    { passId: "B", psm: 11 }
                ];
                for (const config of passConfigs) {
                    const linesRes = await ocrTsvLinesForRoi(pagePath, roi, tmp, options.tesseractLang ?? "rus", options.ocrTimeoutMs ?? 30_000, "text", [config.psm], undefined, { field, passId: config.passId });
                    const regCandidate = pickRegistrationCandidate(linesRes.lines);
                    const normalized = normalizeRussianText(regCandidate?.value ?? linesRes.lines.map((l) => l.text).join(" "));
                    if (normalized.length <= 10)
                        continue;
                    attempts.push({
                        pass_id: config.passId,
                        raw_text_preview: normalized.slice(0, 120),
                        normalized_preview: normalized.slice(0, 120),
                        source: "zonal_tsv",
                        confidence: regCandidate?.conf ?? 0.1,
                        psm: config.psm
                    });
                    ranked.push(makeRankedCandidate({
                        field,
                        pass_id: config.passId,
                        source: "zonal_tsv",
                        psm: config.psm,
                        raw: normalized,
                        normalized,
                        confidence: regCandidate?.conf ?? 0.1,
                        anchorAlignmentScore
                    }));
                }
                const rankedTop = rankCandidates(ranked);
                const best = rankedTop[0];
                fieldReports.push(bestCandidateReport(field, roi, attempts, {
                    preview: best?.normalized_preview ?? "",
                    normalized: best?.validated ?? "",
                    confidence: best?.confidence ?? 0,
                    source: (best?.source ?? "roi"),
                    pass_id: best?.pass_id ?? "C",
                    selectedPass: best?.pass_id ?? "C",
                    rankingScore: best?.rankingScore ?? 0,
                    anchorAlignmentScore: best?.anchorAlignmentScore ?? anchorAlignmentScore,
                    thresholdStrategyUsed,
                    validator_passed: (best?.validated ?? null) !== null,
                    rejection_reason: (best?.validated ?? null) === null ? "FIELD_NOT_CONFIRMED" : null
                }, rankedTop.slice(0, 3)));
            }
            const diagnostics = buildDiagnostics(undefined, normalized.preprocessing, fieldDebug);
            const get = (f) => fieldReports.find((r) => r.field === f) ?? null;
            const result = {
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
            for (const f of FIELD_ORDER) {
                const value = result[f];
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
        }
        catch (e) {
            const core = toCoreError(e);
            const fallback = {
                ...BASE_RESULT,
                confidence_score: 0,
                field_reports: FIELD_ORDER.map((f) => emptyFieldReport(f, { x: 0, y: 0, width: 0, height: 0, page: 0 }, "none")),
                errors: [core]
            };
            return ExtractionResultSchema.parse(fallback);
        }
        finally {
            if (tmp) {
                await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
            }
        }
    }
}
//# sourceMappingURL=rfInternalPassportExtractor.js.map