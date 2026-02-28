import { RfInternalPassportExtractor } from "./extractors/rfInternalPassportExtractor.js";
import { ExtractorRegistry, type ExtractorFn } from "./extractors/extractorRegistry.js";
import type { ExtractOptions, ExtractionResult, InputFile } from "./types.js";

const extractorRegistry = new ExtractorRegistry();
extractorRegistry.register("rf_internal_passport", RfInternalPassportExtractor.extract);
extractorRegistry.register("rf_internal_passport_v1", RfInternalPassportExtractor.extract);

export function registerExtractor(name: string, extractor: ExtractorFn): void {
  extractorRegistry.register(name, extractor);
}

export async function extractRfInternalPassport(
  input: InputFile,
  opts?: ExtractOptions
): Promise<ExtractionResult> {
  const extractor =
    extractorRegistry.get("rf_internal_passport_v1") ?? extractorRegistry.get("rf_internal_passport");
  if (extractor === undefined) {
    throw new Error("NOT_IMPLEMENTED: RF internal passport extractor is not registered.");
  }
  return extractor(input, opts);
}

export * from "./types.js";
export * from "./validators/passportValidators.js";
