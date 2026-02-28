import type { ExtractOptions, ExtractionResult, InputFile } from "../types.js";

export type ExtractorFn = (input: InputFile, opts?: ExtractOptions) => Promise<ExtractionResult>;

export class ExtractorRegistry {
  private readonly registry = new Map<string, ExtractorFn>();

  register(name: string, extractor: ExtractorFn): void {
    this.registry.set(name, extractor);
  }

  get(name: string): ExtractorFn | undefined {
    return this.registry.get(name);
  }
}
