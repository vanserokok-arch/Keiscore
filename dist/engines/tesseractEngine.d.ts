import type { AuditLogger, FieldRoi, NormalizedInput, OcrCandidate } from "../types.js";
export interface TesseractAvailability {
    available: boolean;
    version?: string;
}
export declare class TesseractEngine {
    static detectAvailability(): Promise<TesseractAvailability>;
    static runOcrOnRoi(roi: FieldRoi, _input: NormalizedInput, lang: string, passId: "A" | "B" | "C", timeoutMs: number, debugUnsafeIncludeRawText?: boolean, logger?: AuditLogger, retryPaddingRatio?: number): Promise<OcrCandidate | null>;
}
