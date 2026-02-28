import { type ExtractOptions, type ExtractionResult, type InputFile } from "../types.js";
export declare class RfInternalPassportExtractor {
    static extract(input: InputFile, opts?: ExtractOptions): Promise<ExtractionResult>;
}
