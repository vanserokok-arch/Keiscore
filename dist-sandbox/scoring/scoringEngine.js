function clamp01(value) {
    if (value < 0) {
        return 0;
    }
    if (value > 1) {
        return 1;
    }
    return value;
}
export class ScoringEngine {
    static score(fieldReports, qualityMetrics) {
        const fieldScores = {};
        let total = 0;
        let validatedCount = 0;
        for (const report of fieldReports) {
            const numericBoost = (report.field === "passport_number" || report.field === "dept_code") && report.validator_passed ? 0.18 : 0;
            const validatorSignal = report.validator_passed ? 1 : 0;
            if (report.validator_passed) {
                validatedCount += 1;
            }
            const score = clamp01(0.36 * clamp01(report.confidence) +
                0.26 * validatorSignal +
                0.3 * clamp01(report.anchor_alignment_score ?? 0.5) +
                numericBoost);
            fieldScores[report.field] = score;
            total += score;
        }
        let confidence_score = fieldReports.length === 0 ? 0 : clamp01(total / Math.max(1, fieldReports.length));
        if (validatedCount >= 2 && confidence_score < 0.6) {
            confidence_score = 0.6;
        }
        const requireManualReview = confidence_score < 0.75;
        return {
            confidence_score,
            quality_metrics: qualityMetrics ?? {
                blur_score: 0,
                contrast_score: 0,
                geometric_score: 0
            },
            requireManualReview,
            field_scores: fieldScores
        };
    }
}
//# sourceMappingURL=scoringEngine.js.map