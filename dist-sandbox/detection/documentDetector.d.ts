import type { AuditLogger, DocumentDetection, NormalizedInput } from "../types.js";
export declare class DocumentDetector {
    static detect(input: NormalizedInput, logger: AuditLogger): Promise<DocumentDetection>;
}
