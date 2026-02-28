import type { AuditLogger, ExtractOptions, InputFile, NormalizedInput } from "../types.js";
export declare class FormatNormalizer {
    static normalize(input: InputFile, opts?: ExtractOptions, logger?: AuditLogger): Promise<NormalizedInput>;
    private static normalizeImageBuffer;
    private static normalizePdfPath;
    private static normalizePdfBuffer;
    static cleanupPdfPageArtifacts(normalized: NormalizedInput): Promise<void>;
}
