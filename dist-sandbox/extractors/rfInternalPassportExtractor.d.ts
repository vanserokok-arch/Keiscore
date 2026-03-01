import { type ExtractOptions, type ExtractionResult, type InputFile, type PassportField } from "../types.js";
type BestCandidateSource = "roi" | "page" | "zonal_tsv" | "mrz";
/**
 * TSV word model used by unit tests (and optionally by extractor helpers).
 * Supports both:
 * - coords from raw tesseract TSV parsing (x0,y0,x1,y1,lineKey)
 * - structured coords in tests (blockNum/parNum/lineNum/bbox)
 */
export type TsvWord = {
    text: string;
    confidence: number;
    x0?: number;
    y0?: number;
    x1?: number;
    y1?: number;
    lineKey?: string;
    blockNum?: number;
    parNum?: number;
    lineNum?: number;
    bbox?: {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
    };
};
type RankedCandidate = {
    field?: PassportField;
    pass_id: "A" | "B" | "C";
    source: BestCandidateSource;
    psm: number | null;
    raw_text_preview: string;
    normalized_preview: string;
    confidence: number;
    regexMatch: number;
    lengthScore: number;
    russianCharRatio: number;
    anchorAlignmentScore: number;
    rankingScore: number;
    validated: string | null;
};
export declare function rankCandidates(candidates: RankedCandidate[]): RankedCandidate[];
/**
 * TEST HELPER: Choose best FIO from multiple OCR lines.
 */
export declare function selectBestFioFromCyrillicLines(lines: string[], surnamesHints?: string[]): string | null;
/**
 * TEST HELPER: Build "issued_by" candidates from TSV words.
 */
export declare function buildIssuedByCandidatesFromTsvWords(words: TsvWord[]): Array<{
    text: string;
    confidence: number;
}>;
export declare function selectFioFromThreeZones(zoneLines: string[]): string | null;
export declare class RfInternalPassportExtractor {
    static extract(input: InputFile, opts?: ExtractOptions): Promise<ExtractionResult>;
}
export {};
