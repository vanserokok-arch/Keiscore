import type { AuditLogger, DocumentDetection, NormalizedInput, PerspectiveCalibration } from "../types.js";
export declare class PerspectiveCalibrator {
    static calibrate(input: NormalizedInput, detection: DocumentDetection, logger: AuditLogger): Promise<PerspectiveCalibration>;
}
