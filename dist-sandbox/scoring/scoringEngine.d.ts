import type { FieldReport, ExtractionResult } from "../types.js";
export interface ScoringSummary {
    confidence_score: number;
    quality_metrics: ExtractionResult["quality_metrics"];
    requireManualReview: boolean;
    field_scores: Record<string, number>;
}
export declare class ScoringEngine {
    static score(fieldReports: FieldReport[], qualityMetrics?: ExtractionResult["quality_metrics"]): ScoringSummary;
}
