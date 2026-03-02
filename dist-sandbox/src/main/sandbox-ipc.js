import { lstat, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { dialog, ipcMain, shell } from "electron";
import { extractRfInternalPassport } from "../../index.js";
import { SandboxOpenPathRequestSchema, SandboxOpenPathResultSchema, SandboxPickPdfResultSchema, SandboxPickPdfResponseSchema, SandboxRunOcrResultSchema, SandboxRunOcrRequestSchema, SandboxRunOcrResponseSchema } from "../shared/ipc/sandbox.js";
const ALLOWED_EXTENSIONS = new Set([".pdf"]);
const ALLOWED_ERROR_CODES = new Set([
    "UNSUPPORTED_FORMAT",
    "DOCUMENT_NOT_DETECTED",
    "PAGE_CLASSIFICATION_FAILED",
    "ENGINE_UNAVAILABLE",
    "FIELD_NOT_CONFIRMED",
    "QUALITY_WARNING",
    "REQUIRE_MANUAL_REVIEW",
    "SECURITY_VIOLATION",
    "INTERNAL_ERROR"
]);
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const OCR_TIMEOUT_MS = 30_000;
const FIELD_ORDER = ["fio", "passport_number", "issued_by", "dept_code", "registration"];
function toCoreError(error) {
    if (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        "message" in error &&
        typeof error.code === "string" &&
        typeof error.message === "string") {
        const candidate = error;
        if (ALLOWED_ERROR_CODES.has(candidate.code)) {
            return candidate;
        }
    }
    if (typeof error === "object" &&
        error !== null &&
        "coreError" in error &&
        typeof error.coreError === "object" &&
        error.coreError !== null) {
        return error.coreError;
    }
    if (error instanceof Error) {
        return { code: "INTERNAL_ERROR", message: error.message };
    }
    return { code: "INTERNAL_ERROR", message: "Unknown sandbox IPC error." };
}
function buildSecurityError(message, details) {
    const wrapped = new Error(message);
    wrapped.coreError = { code: "SECURITY_VIOLATION", message, ...(details === undefined ? {} : { details }) };
    return wrapped;
}
async function validateInputPath(filePath) {
    const normalized = resolve(filePath);
    if (!isAbsolute(normalized)) {
        throw buildSecurityError("Path must be absolute.", { path: filePath });
    }
    const ext = extname(normalized).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw buildSecurityError("Unsupported file extension.", { path: normalized, ext });
    }
    const fileLinkStats = await lstat(normalized).catch(() => null);
    if (fileLinkStats === null) {
        throw buildSecurityError("File does not exist.", { path: normalized });
    }
    if (fileLinkStats.isSymbolicLink()) {
        throw buildSecurityError("Symbolic links are not allowed.", { path: normalized });
    }
    const fileStats = await stat(normalized).catch(() => null);
    if (fileStats === null || !fileStats.isFile()) {
        throw buildSecurityError("File does not exist.", { path: normalized });
    }
    if (fileStats.size > MAX_INPUT_BYTES) {
        throw buildSecurityError("File exceeds 50MB limit.", { path: normalized, size: fileStats.size });
    }
    return normalized;
}
async function resolveDebugRootDir(requested) {
    const direct = requested === undefined ? null : requested;
    const envValue = direct === null ? process.env.KEISCORE_DEBUG_ROI_DIR ?? null : direct;
    const trimmed = envValue === null ? "" : String(envValue).trim();
    if (trimmed === "") {
        return mkdtemp(join(tmpdir(), "keiscore-sandbox-"));
    }
    const resolvedPath = resolve(trimmed);
    await mkdir(resolvedPath, { recursive: true });
    return resolvedPath;
}
function toStructuredFailure(error) {
    return { ok: false, error: toCoreError(error) };
}
function compactReport(report) {
    const matchedAttempt = (report.attempts ?? []).find((attempt) => attempt.pass_id === report.pass_id);
    const preview = String(report.best_candidate_preview ?? "").replace(/\s+/gu, " ").trim();
    return {
        field: report.field,
        pass: report.pass,
        confidence: report.confidence,
        psm: matchedAttempt?.psm ?? null,
        source: report.best_candidate_source ?? matchedAttempt?.source ?? null,
        roi: `x:${report.roi.x} y:${report.roi.y} w:${report.roi.width} h:${report.roi.height} p:${report.roi.page}`,
        best_candidate_preview: preview.slice(0, 90)
    };
}
async function readAnchorAudit(debugDir) {
    if (debugDir === null) {
        return { anchorsFoundCount: null, anchorKeys: [], fallbackUsed: null };
    }
    const auditPath = join(debugDir, "extractor_anchor_audit.json");
    const raw = await readFile(auditPath, "utf8").catch(() => null);
    if (raw === null) {
        return { anchorsFoundCount: null, anchorKeys: [], fallbackUsed: null };
    }
    try {
        const parsed = JSON.parse(raw);
        return {
            anchorsFoundCount: typeof parsed.anchorsFoundCount === "number" && Number.isFinite(parsed.anchorsFoundCount)
                ? parsed.anchorsFoundCount
                : null,
            anchorKeys: Array.isArray(parsed.anchorKeys) ? parsed.anchorKeys.filter((v) => typeof v === "string") : [],
            fallbackUsed: typeof parsed.fallbackUsed === "boolean" ? parsed.fallbackUsed : null
        };
    }
    catch {
        return { anchorsFoundCount: null, anchorKeys: [], fallbackUsed: null };
    }
}
function getNormalizationSummary(result) {
    const norm = result.diagnostics?.normalization;
    return {
        selectedThreshold: typeof norm?.selectedThreshold === "number" ? norm.selectedThreshold : null,
        finalBlackPixelRatio: typeof norm?.finalBlackPixelRatio === "number" ? norm.finalBlackPixelRatio : null,
        usedInvert: typeof norm?.usedInvert === "boolean" ? norm.usedInvert : null,
        retryCount: typeof norm?.retryCount === "number" ? norm.retryCount : null
    };
}
async function runOcrForSource(path, debugDir, ocrVariant, pdfPageRange) {
    const previousDebugDir = process.env.KEISCORE_DEBUG_ROI_DIR;
    try {
        if (debugDir === null) {
            delete process.env.KEISCORE_DEBUG_ROI_DIR;
        }
        else {
            process.env.KEISCORE_DEBUG_ROI_DIR = debugDir;
        }
        const result = await extractRfInternalPassport({ kind: "path", path }, {
            ocrVariant,
            tesseractLang: "rus",
            ocrTimeoutMs: OCR_TIMEOUT_MS,
            ...(pdfPageRange === undefined ? {} : { pdfPageRange })
        });
        return { result, debugDir };
    }
    finally {
        if (previousDebugDir === undefined) {
            delete process.env.KEISCORE_DEBUG_ROI_DIR;
        }
        else {
            process.env.KEISCORE_DEBUG_ROI_DIR = previousDebugDir;
        }
    }
}
function emptyResultWithError(error) {
    return {
        fio: null,
        passport_number: null,
        issued_by: null,
        dept_code: null,
        registration: null,
        confidence_score: 0,
        quality_metrics: {
            blur_score: 0,
            contrast_score: 0,
            geometric_score: 0
        },
        field_reports: [],
        errors: [error]
    };
}
async function runSubOcr(source, path, debugDir, ocrVariant, pdfPageRange) {
    try {
        const run = await runOcrForSource(path, debugDir, ocrVariant, pdfPageRange);
        return { ok: true, result: run.result, debugDir: run.debugDir ?? debugDir };
    }
    catch (error) {
        const structured = toCoreError(error);
        console.error("[sandbox:runOcr] subrun failed", { source, error: structured });
        return { ok: false, result: emptyResultWithError(structured), error: structured, debugDir };
    }
}
export function registerSandboxIpcHandlers() {
    ipcMain.handle("sandbox:pickPassportPdf", async () => {
        try {
            const pickResult = await dialog.showOpenDialog({
                title: "Выберите паспорт (2–3 стр.)",
                properties: ["openFile"],
                filters: [{ name: "PDF", extensions: ["pdf"] }]
            });
            if (pickResult.canceled || pickResult.filePaths.length === 0) {
                return SandboxPickPdfResultSchema.parse({ ok: true, data: null });
            }
            const validated = await validateInputPath(pickResult.filePaths[0] ?? "");
            return SandboxPickPdfResultSchema.parse({ ok: true, data: SandboxPickPdfResponseSchema.parse({ path: validated }) });
        }
        catch (error) {
            return SandboxPickPdfResultSchema.parse(toStructuredFailure(error));
        }
    });
    ipcMain.handle("sandbox:pickRegistrationPdf", async () => {
        try {
            const pickResult = await dialog.showOpenDialog({
                title: "Выберите регистрацию",
                properties: ["openFile"],
                filters: [{ name: "PDF", extensions: ["pdf"] }]
            });
            if (pickResult.canceled || pickResult.filePaths.length === 0) {
                return SandboxPickPdfResultSchema.parse({ ok: true, data: null });
            }
            const validated = await validateInputPath(pickResult.filePaths[0] ?? "");
            return SandboxPickPdfResultSchema.parse({ ok: true, data: SandboxPickPdfResponseSchema.parse({ path: validated }) });
        }
        catch (error) {
            return SandboxPickPdfResultSchema.parse(toStructuredFailure(error));
        }
    });
    ipcMain.handle("sandbox:runOcr", async (_event, payload) => {
        try {
            const request = SandboxRunOcrRequestSchema.parse(payload);
            const ocrVariant = request.ocrVariant ?? "v1";
            const passportPath = await validateInputPath(request.passportPath);
            const registrationPath = await validateInputPath(request.registrationPath);
            const debugRootDir = await resolveDebugRootDir(request.debugDir);
            const passportDebugDir = join(debugRootDir, "passport");
            const registrationDebugDir = join(debugRootDir, "registration");
            await mkdir(passportDebugDir, { recursive: true });
            await mkdir(registrationDebugDir, { recursive: true });
            console.info("[sandbox:runOcr] start", {
                passportPath,
                registrationPath,
                debugDir: debugRootDir
            });
            const passportSubRun = await runSubOcr("passport", passportPath, passportDebugDir, ocrVariant, request.pdfPageRangePassport);
            const registrationSubRun = await runSubOcr("registration", registrationPath, registrationDebugDir, ocrVariant, request.pdfPageRangeRegistration);
            const passportRun = { result: passportSubRun.result, debugDir: passportSubRun.debugDir };
            const registrationRun = { result: registrationSubRun.result, debugDir: registrationSubRun.debugDir };
            const mergedReports = FIELD_ORDER.flatMap((field) => {
                if (field === "registration") {
                    return registrationRun.result.field_reports.filter((report) => report.field === "registration");
                }
                return passportRun.result.field_reports.filter((report) => report.field === field);
            });
            const mergedErrors = [
                ...passportRun.result.errors.map((err) => ({ ...err, details: { source: "passport", ...(err.details ?? {}) } })),
                ...registrationRun.result.errors.map((err) => ({
                    ...err,
                    details: { source: "registration", ...(err.details ?? {}) }
                }))
            ];
            const hasPassport = passportRun.result.field_reports.length > 0 || passportRun.result.errors.length === 0;
            const hasRegistration = registrationRun.result.field_reports.length > 0 || registrationRun.result.errors.length === 0;
            const confidenceScore = hasPassport && hasRegistration
                ? Math.min(passportRun.result.confidence_score, registrationRun.result.confidence_score)
                : hasPassport
                    ? passportRun.result.confidence_score
                    : registrationRun.result.confidence_score;
            const passportAnchorSummary = await readAnchorAudit(passportRun.debugDir);
            const registrationAnchorSummary = await readAnchorAudit(registrationRun.debugDir);
            const response = {
                fields: {
                    fio: passportRun.result.fio,
                    passport_number: passportRun.result.passport_number,
                    issued_by: passportRun.result.issued_by,
                    dept_code: passportRun.result.dept_code,
                    registration: registrationRun.result.registration,
                    phone: null
                },
                debugDir: debugRootDir,
                confidence_score: Number.isFinite(confidenceScore) ? confidenceScore : 0,
                diagnostics: {
                    passport: {
                        sourcePath: passportPath,
                        confidence_score: passportRun.result.confidence_score,
                        summary: passportAnchorSummary,
                        normalization: getNormalizationSummary(passportRun.result),
                        fields: passportRun.result.field_reports.map(compactReport),
                        debugDir: passportRun.debugDir
                    },
                    registration: {
                        sourcePath: registrationPath,
                        confidence_score: registrationRun.result.confidence_score,
                        summary: registrationAnchorSummary,
                        normalization: getNormalizationSummary(registrationRun.result),
                        fields: registrationRun.result.field_reports.map(compactReport),
                        debugDir: registrationRun.debugDir
                    },
                    merged: {
                        strategy: "min",
                        debugRootDir
                    }
                },
                field_reports: mergedReports,
                ...(mergedErrors.length > 0 ? { errors: mergedErrors } : {})
            };
            const parsed = SandboxRunOcrResponseSchema.parse(response);
            const finalStatus = passportSubRun.ok && registrationSubRun.ok ? "ok" : "partial";
            console.info("[sandbox:runOcr] end", {
                status: finalStatus,
                debugDir: debugRootDir,
                passportOk: passportSubRun.ok,
                registrationOk: registrationSubRun.ok,
                errors: parsed.errors?.length ?? 0
            });
            return SandboxRunOcrResultSchema.parse({ ok: true, data: parsed });
        }
        catch (error) {
            const failure = toStructuredFailure(error);
            console.error("[sandbox:runOcr] failed", failure.error);
            return SandboxRunOcrResultSchema.parse(failure);
        }
    });
    ipcMain.handle("sandbox:openPath", async (_event, payload) => {
        try {
            const request = SandboxOpenPathRequestSchema.parse(payload);
            const fullPath = resolve(request.path);
            if (!isAbsolute(fullPath)) {
                throw buildSecurityError("Path must be absolute.");
            }
            const linkStats = await lstat(fullPath).catch(() => null);
            if (linkStats === null) {
                throw buildSecurityError("Path does not exist.", { path: fullPath });
            }
            if (linkStats.isSymbolicLink()) {
                throw buildSecurityError("Symbolic links are not allowed.", { path: fullPath });
            }
            const stats = await stat(fullPath).catch(() => null);
            if (stats === null || (!stats.isDirectory() && !stats.isFile())) {
                throw buildSecurityError("Path is not a regular file or directory.", { path: fullPath });
            }
            const shellResult = await shell.openPath(fullPath);
            if (shellResult === "") {
                return SandboxOpenPathResultSchema.parse({ ok: true, data: { opened: true } });
            }
            return SandboxOpenPathResultSchema.parse({
                ok: false,
                error: { code: "INTERNAL_ERROR", message: shellResult, details: { path: fullPath } }
            });
        }
        catch (error) {
            return SandboxOpenPathResultSchema.parse(toStructuredFailure(error));
        }
    });
}
//# sourceMappingURL=sandbox-ipc.js.map