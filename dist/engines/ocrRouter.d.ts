import type { AuditLogger, ExtractOptions, FieldRoi, NormalizedInput, OcrRouterResult } from "../types.js";
type RouterRuntimeOptions = ExtractOptions & {
    _numericOnly?: boolean;
    _retryPaddingRatio?: number;
    _passLabel?: string;
};
export declare class OcrEngineRouter {
    static run(rois: FieldRoi[], input: NormalizedInput, opts: RouterRuntimeOptions, logger: AuditLogger): Promise<OcrRouterResult>;
}
export {};
