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
    debugDir: string | null;
};
export declare function mapRunResultToUi(lastResult: SandboxRunOcrResult | null, thrownError: unknown | null): UiRunResult;
