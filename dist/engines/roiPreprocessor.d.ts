import type { AuditLogger, PassportField } from "../types.js";
interface PreprocessConfig {
    field?: PassportField;
    extraPaddingRatio?: number;
    logger?: AuditLogger;
}
export declare function preprocessRoiForOcr(inputPath: string): Promise<string>;
export declare function preprocessRoiForOcrWithConfig(inputPath: string, config: PreprocessConfig): Promise<string>;
export declare const RETRY_ROI_PADDING_RATIO = 0.15;
export {};
