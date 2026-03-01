import type { AuditLogger, FieldRoi, NormalizedInput, OcrCandidate } from "../types.js";
export interface TesseractAvailability {
    available: boolean;
    version?: string;
}
export interface MrzOcrAttempt {
    psm: 6 | 11 | 13;
    rawText: string;
    normalizedText: string;
    confidence: number;
}
export declare class TesseractEngine {
    static detectAvailability(): Promise<TesseractAvailability>;
    static runOcrOnRoi(roi: FieldRoi, _input: NormalizedInput, lang: string, passId: "A" | "B" | "C", timeoutMs: number, debugUnsafeIncludeRawText?: boolean, logger?: AuditLogger, retryPaddingRatio?: number): Promise<OcrCandidate | null>;
    static runMrzOcrOnImage(imagePath: string, timeoutMs: number, logger?: AuditLogger): Promise<MrzOcrAttempt[]>;
}
