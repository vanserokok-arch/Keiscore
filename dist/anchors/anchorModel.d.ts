import type { AnchorResult, AuditLogger, DocumentDetection, NormalizedInput, PerspectiveCalibration } from "../types.js";
export declare class AnchorModel {
    static findAnchors(input: NormalizedInput, detection: DocumentDetection, calibration: PerspectiveCalibration, logger: AuditLogger, debugUnsafeIncludeRawText?: boolean): Promise<AnchorResult>;
}
