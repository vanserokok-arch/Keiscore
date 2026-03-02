function normalizeThrownError(error) {
    if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
        const code = String(error.code);
        const message = String(error.message);
        const details = "details" in error ? error.details : undefined;
        return {
            code: code,
            message,
            ...(details === undefined ? {} : { details })
        };
    }
    if (error instanceof Error) {
        return {
            code: "INTERNAL_ERROR",
            message: error.message,
            details: { stack: error.stack }
        };
    }
    return {
        code: "INTERNAL_ERROR",
        message: "Unknown renderer error.",
        details: { value: error }
    };
}
export function mapRunResultToUi(lastResult, thrownError) {
    if (thrownError !== null) {
        const error = normalizeThrownError(thrownError);
        return {
            rawJson: JSON.stringify({ thrown: error }, null, 2),
            errors: [error],
            fieldRows: [],
            normalizationRows: [],
            sourceRows: [],
            debugDir: null,
            artifactPaths: []
        };
    }
    if (lastResult === null) {
        return {
            rawJson: JSON.stringify({ info: "run not started" }, null, 2),
            errors: [],
            fieldRows: [],
            normalizationRows: [],
            sourceRows: [],
            debugDir: null,
            artifactPaths: []
        };
    }
    if (!lastResult.ok) {
        return {
            rawJson: JSON.stringify(lastResult, null, 2),
            errors: [lastResult.error],
            fieldRows: [],
            normalizationRows: [],
            sourceRows: [],
            debugDir: null,
            artifactPaths: []
        };
    }
    const data = lastResult.data;
    const fieldRows = [
        ...(data.diagnostics.passport?.fields ?? []),
        ...(data.diagnostics.registration?.fields ?? [])
    ].map((row) => ({
        field: row.field,
        pass: row.pass ? "pass" : "fail",
        confidence: row.confidence.toFixed(2),
        psm: row.psm === null ? "-" : String(row.psm),
        source: row.source ?? "-",
        bestPreview: row.best_candidate_preview || "-"
    }));
    const normalizationRows = [];
    if (data.diagnostics.passport) {
        normalizationRows.push({
            source: "passport",
            selectedThreshold: data.diagnostics.passport.normalization.selectedThreshold === null
                ? "-"
                : String(data.diagnostics.passport.normalization.selectedThreshold),
            finalBlackPixelRatio: data.diagnostics.passport.normalization.finalBlackPixelRatio === null
                ? "-"
                : String(data.diagnostics.passport.normalization.finalBlackPixelRatio),
            usedInvert: data.diagnostics.passport.normalization.usedInvert === null
                ? "-"
                : data.diagnostics.passport.normalization.usedInvert
                    ? "yes"
                    : "no",
            retryCount: data.diagnostics.passport.normalization.retryCount === null
                ? "-"
                : String(data.diagnostics.passport.normalization.retryCount)
        });
    }
    if (data.diagnostics.registration) {
        normalizationRows.push({
            source: "registration",
            selectedThreshold: data.diagnostics.registration.normalization.selectedThreshold === null
                ? "-"
                : String(data.diagnostics.registration.normalization.selectedThreshold),
            finalBlackPixelRatio: data.diagnostics.registration.normalization.finalBlackPixelRatio === null
                ? "-"
                : String(data.diagnostics.registration.normalization.finalBlackPixelRatio),
            usedInvert: data.diagnostics.registration.normalization.usedInvert === null
                ? "-"
                : data.diagnostics.registration.normalization.usedInvert
                    ? "yes"
                    : "no",
            retryCount: data.diagnostics.registration.normalization.retryCount === null
                ? "-"
                : String(data.diagnostics.registration.normalization.retryCount)
        });
    }
    const sourceRows = [];
    if (data.diagnostics.passport) {
        sourceRows.push({
            source: "passport",
            originalPath: data.diagnostics.passport.originalPath,
            sourceKind: data.diagnostics.passport.sourceKind ?? "pdf",
            convertedPdfPath: data.diagnostics.passport.convertedPdfPath ?? null
        });
    }
    if (data.diagnostics.registration) {
        sourceRows.push({
            source: "registration",
            originalPath: data.diagnostics.registration.originalPath,
            sourceKind: data.diagnostics.registration.sourceKind ?? "pdf",
            convertedPdfPath: data.diagnostics.registration.convertedPdfPath ?? null
        });
    }
    const artifactPaths = [];
    if (data.debugDir) {
        const root = data.debugDir.endsWith("/") ? data.debugDir.slice(0, -1) : data.debugDir;
        const sourceDirs = [`${root}/passport`, `${root}/registration`];
        for (const dir of sourceDirs) {
            artifactPaths.push(`${dir}/page_for_search.png`);
            artifactPaths.push(`${dir}/overlay_anchors.png`);
            artifactPaths.push(`${dir}/overlay_candidates.png`);
            artifactPaths.push(`${dir}/extractor_anchor_audit.json`);
            artifactPaths.push(`${dir}/extractor_audit.json`);
        }
    }
    return {
        rawJson: JSON.stringify(lastResult, null, 2),
        errors: data.errors ?? [],
        fieldRows,
        normalizationRows,
        sourceRows,
        debugDir: data.debugDir,
        artifactPaths
    };
}
//# sourceMappingURL=ocrSandboxRunResult.js.map