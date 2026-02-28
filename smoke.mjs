import { extractRfInternalPassport } from "./dist/index.js";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node smoke.mjs /path/to/passport.pdf");
  process.exit(1);
}

const res = await extractRfInternalPassport(
  { kind: "path", path: filePath },
  { preferOnline: false, pdfRenderTimeoutMs: 120000, debugUnsafeIncludeRawText: true }
);

const normalization = res.diagnostics?.normalization;
if (normalization) {
  console.log("=== normalization ===");
  console.log(
    JSON.stringify(
      {
        crop_bbox: normalization.cropBbox ?? null,
        rotation_deg: normalization.rotationDeg,
        deskew_angle_deg: normalization.deskewAngleDeg,
        threshold: normalization.selectedThreshold,
        orientation_score: normalization.orientationScore,
        black_pixel_ratio: normalization.blackPixelRatio
      },
      null,
      2
    )
  );
}

console.log("=== fields ===");
for (const report of res.field_reports) {
  const bestAttempt = [...(report.attempts ?? [])].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  console.log(
    JSON.stringify(
      {
        field: report.field,
        roi: report.roi,
        roiImagePath: report.roiImagePath ?? null,
        postprocessed_roi_image_path: report.postprocessed_roi_image_path ?? null,
        psm: bestAttempt?.psm ?? null,
        confidence: report.confidence,
        pass: report.pass,
        validator_reason: report.rejection_reason
      },
      null,
      2
    )
  );
}

console.log("=== result ===");
console.log(JSON.stringify(res, null, 2));