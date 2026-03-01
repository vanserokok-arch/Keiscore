export class PerspectiveCalibrator {
    static async calibrate(input, detection, logger) {
        const skewPenalty = Math.min(1, Math.abs(input.skewAngleDeg) / 20);
        const areaBonus = detection.areaRatio ?? 0.6;
        const geometricScore = detection.detected
            ? clamp01(0.9 - skewPenalty * 0.4 + areaBonus * 0.1)
            : clamp01(0.35 - skewPenalty * 0.2);
        const stabilityNotes = [];
        if (!detection.detected) {
            stabilityNotes.push("document_not_detected");
        }
        if (Math.abs(input.skewAngleDeg) > 8) {
            stabilityNotes.push("high_skew_detected");
        }
        if (geometricScore < 0.6) {
            stabilityNotes.push("low_geometric_stability");
        }
        logger.log({
            ts: Date.now(),
            stage: "perspective-calibrator",
            level: "info",
            message: "Perspective calibration executed.",
            data: {
                detected: detection.detected,
                source: input.sourcePath ?? input.fileName,
                geometricScore,
                skewAngleDeg: input.skewAngleDeg,
                stabilityNotes
            }
        });
        return {
            geometricScore,
            transform: "identity",
            alignedWidth: input.width,
            alignedHeight: input.height,
            stabilityNotes
        };
    }
}
function clamp01(value) {
    if (value < 0) {
        return 0;
    }
    if (value > 1) {
        return 1;
    }
    return value;
}
//# sourceMappingURL=perspectiveCalibrator.js.map