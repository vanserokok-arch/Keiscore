import type { ExtractOptions, ExtractionResult, InputFile } from "../types.js";
export type ExtractorFn = (input: InputFile, opts?: ExtractOptions) => Promise<ExtractionResult>;
export declare class ExtractorRegistry {
    private readonly registry;
    register(name: string, extractor: ExtractorFn): void;
    get(name: string): ExtractorFn | undefined;
}
