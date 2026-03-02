import type { SandboxError, SandboxRunOcrResult } from "../../shared/ipc/sandbox.js";

export type FieldDiagRow = {
  field: string;
  pass: string;
  confidence: string;
  psm: string;
  source: string;
  bestPreview: string;
};

export type NormRow = {
  source: "passport" | "registration";
  selectedThreshold: string;
  finalBlackPixelRatio: string;
  usedInvert: string;
  retryCount: string;
};

export type UiRunResult = {
  rawJson: string;
  errors: SandboxError[];
  fieldRows: FieldDiagRow[];
  normalizationRows: NormRow[];
  sourceRows: Array<{
    source: "passport" | "registration";
    originalPath: string;
    sourceKind: "pdf" | "png";
    convertedPdfPath: string | null;
  }>;
  debugDir: string | null;
};

function normalizeThrownError(error: unknown): SandboxError {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    const code = String((error as { code?: unknown }).code);
    const message = String((error as { message?: unknown }).message);
    const details = "details" in error ? (error as { details?: unknown }).details : undefined;
    return {
      code: code as SandboxError["code"],
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

export function mapRunResultToUi(lastResult: SandboxRunOcrResult | null, thrownError: unknown | null): UiRunResult {
  if (thrownError !== null) {
    const error = normalizeThrownError(thrownError);
    return {
      rawJson: JSON.stringify({ thrown: error }, null, 2),
      errors: [error],
      fieldRows: [],
      normalizationRows: [],
      sourceRows: [],
      debugDir: null
    };
  }

  if (lastResult === null) {
    return {
      rawJson: JSON.stringify({ info: "run not started" }, null, 2),
      errors: [],
      fieldRows: [],
      normalizationRows: [],
      sourceRows: [],
      debugDir: null
    };
  }

  if (!lastResult.ok) {
    return {
      rawJson: JSON.stringify(lastResult, null, 2),
      errors: [lastResult.error],
      fieldRows: [],
      normalizationRows: [],
      sourceRows: [],
      debugDir: null
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

  const normalizationRows: NormRow[] = [];
  if (data.diagnostics.passport) {
    normalizationRows.push({
      source: "passport",
      selectedThreshold:
        data.diagnostics.passport.normalization.selectedThreshold === null
          ? "-"
          : String(data.diagnostics.passport.normalization.selectedThreshold),
      finalBlackPixelRatio:
        data.diagnostics.passport.normalization.finalBlackPixelRatio === null
          ? "-"
          : String(data.diagnostics.passport.normalization.finalBlackPixelRatio),
      usedInvert:
        data.diagnostics.passport.normalization.usedInvert === null
          ? "-"
          : data.diagnostics.passport.normalization.usedInvert
            ? "yes"
            : "no",
      retryCount:
        data.diagnostics.passport.normalization.retryCount === null
          ? "-"
          : String(data.diagnostics.passport.normalization.retryCount)
    });
  }
  if (data.diagnostics.registration) {
    normalizationRows.push({
      source: "registration",
      selectedThreshold:
        data.diagnostics.registration.normalization.selectedThreshold === null
          ? "-"
          : String(data.diagnostics.registration.normalization.selectedThreshold),
      finalBlackPixelRatio:
        data.diagnostics.registration.normalization.finalBlackPixelRatio === null
          ? "-"
          : String(data.diagnostics.registration.normalization.finalBlackPixelRatio),
      usedInvert:
        data.diagnostics.registration.normalization.usedInvert === null
          ? "-"
          : data.diagnostics.registration.normalization.usedInvert
            ? "yes"
            : "no",
      retryCount:
        data.diagnostics.registration.normalization.retryCount === null
          ? "-"
          : String(data.diagnostics.registration.normalization.retryCount)
    });
  }

  const sourceRows: UiRunResult["sourceRows"] = [];
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

  return {
    rawJson: JSON.stringify(lastResult, null, 2),
    errors: data.errors ?? [],
    fieldRows,
    normalizationRows,
    sourceRows,
    debugDir: data.debugDir
  };
}
