import { access, mkdir, readFile, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { dialog, ipcMain, shell } from "electron";
import { extractRfInternalPassport } from "../../index.js";
import { SandboxOpenDebugDirRequestSchema, SandboxOpenDebugDirResponseSchema, SandboxPickFileRequestSchema, SandboxPickFileResponseSchema, SandboxRunOcrRequestSchema, SandboxRunOcrResponseSchema } from "../shared/ipc/sandbox.js";
const ALLOWED_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg"]);
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
        return error;
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
    if (envValue === null) {
        return null;
    }
    const trimmed = String(envValue).trim();
    if (trimmed === "") {
        return null;
    }
    const resolvedPath = resolve(trimmed);
    await mkdir(resolvedPath, { recursive: true });
    return resolvedPath;
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
async function runOcrForSource(path, debugDir) {
    const previousDebugDir = process.env.KEISCORE_DEBUG_ROI_DIR;
    try {
        if (debugDir === null) {
            delete process.env.KEISCORE_DEBUG_ROI_DIR;
        }
        else {
            process.env.KEISCORE_DEBUG_ROI_DIR = debugDir;
        }
        const result = await extractRfInternalPassport({ kind: "path", path }, {
            tesseractLang: "rus",
            ocrTimeoutMs: OCR_TIMEOUT_MS
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
export function registerSandboxIpcHandlers() {
    ipcMain.handle("sandbox:pickFile", async (_event, payload) => {
        const request = SandboxPickFileRequestSchema.parse(payload);
        const filters = request.kind === "passport"
            ? [{ name: "Passport files", extensions: ["pdf", "png", "jpg", "jpeg"] }]
            : [{ name: "Registration files", extensions: ["pdf", "png", "jpg", "jpeg"] }];
        const pickResult = await dialog.showOpenDialog({
            title: request.kind === "passport" ? "Выберите паспорт (2–3 стр.)" : "Выберите страницу регистрации",
            properties: ["openFile"],
            filters
        });
        if (pickResult.canceled || pickResult.filePaths.length === 0) {
            return SandboxPickFileResponseSchema.parse({ canceled: true });
        }
        const validated = await validateInputPath(pickResult.filePaths[0] ?? "");
        return SandboxPickFileResponseSchema.parse({ canceled: false, path: validated });
    });
    ipcMain.handle("sandbox:runOcr", async (_event, payload) => {
        try {
            const request = SandboxRunOcrRequestSchema.parse(payload);
            const passportPath = await validateInputPath(request.passportPath);
            const registrationPath = await validateInputPath(request.registrationPath);
            const debugRootDir = await resolveDebugRootDir(request.debugDir);
            const passportDebugDir = debugRootDir === null ? null : join(debugRootDir, "passport");
            const registrationDebugDir = debugRootDir === null ? null : join(debugRootDir, "registration");
            if (passportDebugDir !== null) {
                await mkdir(passportDebugDir, { recursive: true });
            }
            if (registrationDebugDir !== null) {
                await mkdir(registrationDebugDir, { recursive: true });
            }
            let passportRun;
            let registrationRun;
            try {
                passportRun = await runOcrForSource(passportPath, passportDebugDir);
            }
            catch (error) {
                const core = toCoreError(error);
                passportRun = { result: emptyResultWithError(core), debugDir: passportDebugDir };
            }
            try {
                registrationRun = await runOcrForSource(registrationPath, registrationDebugDir);
            }
            catch (error) {
                const core = toCoreError(error);
                registrationRun = { result: emptyResultWithError(core), debugDir: registrationDebugDir };
            }
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
            return SandboxRunOcrResponseSchema.parse(response);
        }
        catch (error) {
            const passthrough = toCoreError(error);
            const fallback = {
                fields: {
                    fio: null,
                    passport_number: null,
                    issued_by: null,
                    dept_code: null,
                    registration: null,
                    phone: null
                },
                confidence_score: 0,
                diagnostics: {
                    merged: {
                        strategy: "min",
                        debugRootDir: null
                    }
                },
                field_reports: [],
                errors: [passthrough]
            };
            return SandboxRunOcrResponseSchema.parse(fallback);
        }
    });
    ipcMain.handle("sandbox:openDebugDir", async (_event, payload) => {
        try {
            const request = SandboxOpenDebugDirRequestSchema.parse(payload);
            const fullPath = resolve(request.dirPath);
            if (!isAbsolute(fullPath)) {
                throw buildSecurityError("Debug directory path must be absolute.");
            }
            const stats = await stat(fullPath).catch(() => null);
            if (stats === null || !stats.isDirectory()) {
                throw buildSecurityError("Debug directory does not exist.", { path: fullPath });
            }
            await access(fullPath, fsConstants.R_OK);
            const shellResult = await shell.openPath(fullPath);
            const response = { ok: shellResult === "", message: shellResult === "" ? null : shellResult };
            return SandboxOpenDebugDirResponseSchema.parse(response);
        }
        catch (error) {
            const core = toCoreError(error);
            return SandboxOpenDebugDirResponseSchema.parse({ ok: false, message: `${core.code}: ${core.message}` });
        }
    });
}
//# sourceMappingURL=sandbox-ipc.js.map