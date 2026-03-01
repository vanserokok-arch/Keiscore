import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import sharp from "sharp";
import { FormatNormalizer } from "../format/formatNormalizer.js";
import { normalizePassportNumber, normalizeRussianText } from "../format/textNormalizer.js";
import {
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
  type CoreError,
  type ExtractOptions,
  type ExtractionResult,
  type FieldReport,
  type InputFile,
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

async function cropToFile(srcPath: string, roi: RoiRect, outPath: string): Promise<void> {
  await sharp(srcPath)
    .extract({ left: roi.x, top: roi.y, width: roi.width, height: roi.height })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

async function preprocessForOcr(inPath: string, outPath: string, mode: "text" | "digits"): Promise<void> {
  const img = sharp(inPath).grayscale();
  const thr = mode === "digits" ? 205 : 220;
  await img.normalize().median(1).threshold(thr).png({ compressionLevel: 9 }).toFile(outPath);
}

async function runTesseractTsv(imagePath: string, lang: string, timeoutMs: number, psm: number): Promise<string> {
  const base = imagePath.replace(/\.png$/i, "");
  const args = [imagePath, base, "-l", lang, "--psm", String(psm), "tsv"];
  await execa("tesseract", args, { timeout: timeoutMs, reject: false });
  try {
    return await readFile(`${base}.tsv`, "utf8");
  } catch {
    return "";
  }
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
    if (validateRegistration(normalized) === null) return { value: normalized, conf: c.conf };
  }

  return null;
}

async function ocrTsvLinesForRoi(
  pagePath: string,
  roi: RoiRect,
  tmp: string,
  lang: string,
  timeoutMs: number,
  mode: "text" | "digits",
  psmList: number[]
): Promise<{
  lines: Array<{ text: string; avgConf: number }>;
  debug: { previews: string[]; emptyZones: Array<{ reason: string; crop_path: string | null }> };
}> {
  const cropPath = join(tmp, `${roi.x}-${roi.y}-${roi.width}-${roi.height}.png`);
  const prePath = join(tmp, `${roi.x}-${roi.y}-${roi.width}-${roi.height}.pre.png`);

  await cropToFile(pagePath, roi, cropPath);
  await preprocessForOcr(cropPath, prePath, mode);

  const emptyZones: Array<{ reason: string; crop_path: string | null }> = [];
  let bestLines: Array<{ text: string; avgConf: number }> = [];
  let bestPreview: string[] = [];

  for (const psm of psmList) {
    const psmBase = join(tmp, `${roi.x}-${roi.y}-${roi.width}-${roi.height}.psm${psm}`);
    const psmImg = `${psmBase}.png`;
    await sharp(prePath).toFile(psmImg);

    const tsv = await runTesseractTsv(psmImg, lang, timeoutMs, psm);
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

async function ocrPlainText(pagePath: string, roi: RoiRect, tmp: string, lang: string, timeoutMs: number, psm: number) {
  const cropPath = join(tmp, `plain-${roi.x}-${roi.y}-${roi.width}-${roi.height}.png`);
  const prePath = join(tmp, `plain-${roi.x}-${roi.y}-${roi.width}-${roi.height}.pre.png`);
  await cropToFile(pagePath, roi, cropPath);
  await preprocessForOcr(cropPath, prePath, "text");

  const outBase = join(tmp, `plain-${roi.x}-${roi.y}-${roi.width}-${roi.height}-out`);
  await execa("tesseract", [prePath, outBase, "-l", lang, "--psm", String(psm)], { timeout: timeoutMs, reject: false });

  try {
    return await readFile(`${outBase}.txt`, "utf8");
  } catch {
    return "";
  }
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
    validator_passed: boolean;
    rejection_reason: string | null;
  }
): FieldReport {
  return {
    field,
    roi,
    engine_used: "tesseract",
    pass: best.validator_passed,
    pass_id: best.pass_id,
    confidence: best.validator_passed ? best.confidence : 0,
    validator_passed: best.validator_passed,
    rejection_reason: best.rejection_reason,
    anchor_alignment_score: 0.45,
    attempts,
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
      top_candidates: [...attempts]
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
    }
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

      const rois: Record<PassportField, RoiRect> = {
        fio: roiFromRatios("fio", width, height, pageIndex),
        passport_number: roiFromRatios("passport_number", width, height, pageIndex),
        issued_by: roiFromRatios("issued_by", width, height, pageIndex),
        dept_code: roiFromRatios("dept_code", width, height, pageIndex),
        registration: roiFromRatios("registration", width, height, pageIndex)
      };

      const debugDir = process.env.KEISCORE_DEBUG_ROI_DIR ? String(process.env.KEISCORE_DEBUG_ROI_DIR) : "";
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
        } catch {
          // ignore
        }
      }

      const fieldReports: FieldReport[] = [];
      const fieldDebug: Record<string, any> = {};

      // passport_number
      {
        const field: PassportField = "passport_number";
        const roi = rois[field];
        const attempts: NonNullable<FieldReport["attempts"]> = [];

        const linesRes = await ocrTsvLinesForRoi(
          pagePath,
          roi,
          tmp,
          options.tesseractLang ?? "rus",
          options.ocrTimeoutMs ?? 30_000,
          "digits",
          [7, 6, 8, 11]
        );
        const joined = linesRes.lines.map((l) => l.text).join(" ");
        const normalizedText = normalizePassportNumber(joined);
        const validated = validatePassportNumber(normalizedText);

        attempts.push({
          pass_id: "C",
          raw_text_preview: joined.slice(0, 120),
          normalized_preview: normalizedText.slice(0, 120),
          source: "zonal_tsv",
          confidence: 0.9,
          psm: 6
        });

        fieldReports.push(
          bestCandidateReport(field, roi, attempts, {
            preview: normalizedText,
            normalized: normalizedText,
            confidence: validated !== null ? 0.9 : 0,
            source: "zonal_tsv",
            pass_id: "C",
            validator_passed: validated !== null,
            rejection_reason: validated === null ? "FIELD_NOT_CONFIRMED" : null
          })
        );

        fieldDebug[field] = {
          zonal_tsv_lines_preview: linesRes.debug.previews,
          zonal_tsv_empty_zones: linesRes.debug.emptyZones
        };
      }

      // dept_code
      {
        const field: PassportField = "dept_code";
        const roi = rois[field];
        const attempts: NonNullable<FieldReport["attempts"]> = [];

        const linesRes = await ocrTsvLinesForRoi(
          pagePath,
          roi,
          tmp,
          options.tesseractLang ?? "rus",
          options.ocrTimeoutMs ?? 30_000,
          "digits",
          [7, 6, 8, 11]
        );
        const joined = linesRes.lines.map((l) => l.text).join(" ");
        const normalizedText = normalizeRussianText(joined)
          .replace(/[^0-9\-]/gu, "")
          .replace(/(\d{3})(\d{3})/u, "$1-$2");
        const validated = validateDeptCode(normalizedText);

        attempts.push({
          pass_id: "C",
          raw_text_preview: joined.slice(0, 120),
          normalized_preview: normalizedText.slice(0, 120),
          source: "zonal_tsv",
          confidence: 0.55,
          psm: 6
        });

        fieldReports.push(
          bestCandidateReport(field, roi, attempts, {
            preview: normalizedText,
            normalized: normalizedText,
            confidence: validated !== null ? 0.55 : 0,
            source: "zonal_tsv",
            pass_id: "C",
            validator_passed: validated !== null,
            rejection_reason: validated === null ? "FIELD_NOT_CONFIRMED" : null
          })
        );
      }

      // fio
      {
        const field: PassportField = "fio";
        const roi = rois[field];
        const attempts: NonNullable<FieldReport["attempts"]> = [];

        const linesRes = await ocrTsvLinesForRoi(
          pagePath,
          roi,
          tmp,
          options.tesseractLang ?? "rus",
          options.ocrTimeoutMs ?? 30_000,
          "text",
          [6, 4, 11, 7]
        );
        const fioCandidate = pickFioCandidate(linesRes.lines);

        if (fioCandidate) {
          attempts.push({
            pass_id: "C",
            raw_text_preview: fioCandidate.value.slice(0, 120),
            normalized_preview: fioCandidate.value.slice(0, 120),
            source: "zonal_tsv",
            confidence: fioCandidate.conf,
            psm: 6
          });
        } else {
          const raw = await ocrPlainText(pagePath, roi, tmp, options.tesseractLang ?? "rus", options.ocrTimeoutMs ?? 30_000, 6);
          const clean = cleanCyrillicLine(raw);
          attempts.push({
            pass_id: "C",
            raw_text_preview: raw.slice(0, 120),
            normalized_preview: clean.slice(0, 120),
            source: "roi",
            confidence: 0.15,
            psm: 6
          });
        }

        const bestAttempt = attempts.find((a) => (a.normalized_preview ?? "").trim().length > 0) ?? attempts[0];
        const normalizedText = normalizeRussianText(bestAttempt?.normalized_preview ?? "");
        const validated = validateFio(normalizedText);

        fieldReports.push(
          bestCandidateReport(field, roi, attempts, {
            preview: normalizedText,
            normalized: normalizedText,
            confidence: validated !== null ? Number(bestAttempt?.confidence ?? 0) : 0,
            source: (bestAttempt?.source ?? "roi") as BestCandidateSource,
            pass_id: "C",
            validator_passed: validated !== null,
            rejection_reason: validated === null ? "FIELD_NOT_CONFIRMED" : null
          })
        );
      }

      // issued_by
      {
        const field: PassportField = "issued_by";
        const roi = rois[field];
        const attempts: NonNullable<FieldReport["attempts"]> = [];

        const linesRes = await ocrTsvLinesForRoi(
          pagePath,
          roi,
          tmp,
          options.tesseractLang ?? "rus",
          options.ocrTimeoutMs ?? 30_000,
          "text",
          [4, 6, 11, 7]
        );
        const issuedCandidate = pickIssuedByCandidate(linesRes.lines);

        if (issuedCandidate) {
          attempts.push({
            pass_id: "C",
            raw_text_preview: issuedCandidate.value.slice(0, 120),
            normalized_preview: issuedCandidate.value.slice(0, 120),
            source: "zonal_tsv",
            confidence: issuedCandidate.conf,
            psm: 4
          });
        } else {
          const raw = await ocrPlainText(pagePath, roi, tmp, options.tesseractLang ?? "rus", options.ocrTimeoutMs ?? 30_000, 4);
          const clean = cleanCyrillicLine(raw);
          attempts.push({
            pass_id: "C",
            raw_text_preview: raw.slice(0, 120),
            normalized_preview: clean.slice(0, 120),
            source: "roi",
            confidence: 0.12,
            psm: 4
          });
        }

        const bestAttempt = attempts.find((a) => (a.normalized_preview ?? "").trim().length > 0) ?? attempts[0];
        const normalizedText = normalizeRussianText(bestAttempt?.normalized_preview ?? "");
        const validated = validateIssuedBy(normalizedText);

        fieldReports.push(
          bestCandidateReport(field, roi, attempts, {
            preview: normalizedText,
            normalized: normalizedText,
            confidence: validated !== null ? Number(bestAttempt?.confidence ?? 0) : 0,
            source: (bestAttempt?.source ?? "roi") as BestCandidateSource,
            pass_id: "C",
            validator_passed: validated !== null,
            rejection_reason: validated === null ? "FIELD_NOT_CONFIRMED" : null
          })
        );
      }

      // registration
      {
        const field: PassportField = "registration";
        const roi = rois[field];
        const attempts: NonNullable<FieldReport["attempts"]> = [];

        const linesRes = await ocrTsvLinesForRoi(
          pagePath,
          roi,
          tmp,
          options.tesseractLang ?? "rus",
          options.ocrTimeoutMs ?? 30_000,
          "text",
          [6, 4, 11, 7]
        );
        const regCandidate = pickRegistrationCandidate(linesRes.lines);

        if (regCandidate) {
          attempts.push({
            pass_id: "C",
            raw_text_preview: regCandidate.value.slice(0, 120),
            normalized_preview: regCandidate.value.slice(0, 120),
            source: "zonal_tsv",
            confidence: regCandidate.conf,
            psm: 6
          });
        } else {
          const raw = await ocrPlainText(pagePath, roi, tmp, options.tesseractLang ?? "rus", options.ocrTimeoutMs ?? 30_000, 6);
          const clean = normalizeRussianText(raw).replace(/\s+/gu, " ").trim();
          attempts.push({
            pass_id: "C",
            raw_text_preview: raw.slice(0, 120),
            normalized_preview: clean.slice(0, 120),
            source: "roi",
            confidence: 0.08,
            psm: 6
          });
        }

        const bestAttempt = attempts.find((a) => (a.normalized_preview ?? "").trim().length > 0) ?? attempts[0];
        const normalizedText = normalizeRussianText(bestAttempt?.normalized_preview ?? "");
        const validated = validateRegistration(normalizedText);

        fieldReports.push(
          bestCandidateReport(field, roi, attempts, {
            preview: normalizedText,
            normalized: normalizedText,
            confidence: validated !== null ? Number(bestAttempt?.confidence ?? 0) : 0,
            source: (bestAttempt?.source ?? "roi") as BestCandidateSource,
            pass_id: "C",
            validator_passed: validated !== null,
            rejection_reason: validated === null ? "FIELD_NOT_CONFIRMED" : null
          })
        );
      }

      const diagnostics = buildDiagnostics(undefined, normalized.preprocessing, fieldDebug);
      const get = (f: PassportField) => fieldReports.find((r) => r.field === f) ?? null;

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
