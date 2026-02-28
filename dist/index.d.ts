import { type ExtractorFn } from "./extractors/extractorRegistry.js";
import type { ExtractOptions, ExtractionResult, InputFile } from "./types.js";
export declare function registerExtractor(name: string, extractor: ExtractorFn): void;
export declare function extractRfInternalPassport(input: InputFile, opts?: ExtractOptions): Promise<ExtractionResult>;
export * from "./types.js";
export * from "./validators/passportValidators.js";
