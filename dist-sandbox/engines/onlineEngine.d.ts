import type { FieldRoi, NormalizedInput, OcrCandidate } from "../types.js";
export interface OnlineAvailability {
    available: boolean;
    endpoint?: string;
}
export declare class OnlineEngine {
    static pingOnline(): Promise<OnlineAvailability>;
    static runOcrOnRoi(roi: FieldRoi, input: NormalizedInput, passId: "A" | "B" | "C", timeoutMs: number): Promise<OcrCandidate | null>;
}
