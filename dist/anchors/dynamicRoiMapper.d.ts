import type { AnchorResult, AuditLogger, DocumentDetection, FieldRoi, NormalizedInput, PerspectiveCalibration } from "../types.js";
export declare class DynamicROIMapper {
    static map(input: NormalizedInput, detection: DocumentDetection, calibration: PerspectiveCalibration, anchors: AnchorResult, logger: AuditLogger): Promise<FieldRoi[]>;
    static attachRoiImagePaths(input: NormalizedInput, rois: FieldRoi[], logger: AuditLogger): Promise<FieldRoi[]>;
    static cleanupRoiImagePaths(rois: FieldRoi[]): Promise<void>;
}
