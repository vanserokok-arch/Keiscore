import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { extractRfInternalPassport } from "./dist/index.js";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node smoke.mjs /path/to/passport.pdf");
  process.exit(1);
}

const auditEvents = [];
const logger = {
  log(event) {
    auditEvents.push(event);
  }
};
const res = await extractRfInternalPassport(
  { kind: "path", path: filePath },
  { preferOnline: false, pdfRenderTimeoutMs: 120000, debugUnsafeIncludeRawText: true, logger }
);

const overlayArtifacts = await writeDebugZoneOverlay(res);
if (overlayArtifacts !== null) {
  console.log("=== debug_overlay ===");
  console.log(JSON.stringify(overlayArtifacts, null, 2));
}

const normalization = res.diagnostics?.normalization;
if (normalization) {
  console.log("=== normalization ===");
  console.log(
    JSON.stringify(
      {
        crop_bbox: normalization.cropBbox ?? null,
        content_bbox: normalization.content_bbox ?? null,
        passport_bbox: normalization.passport_bbox ?? null,
        applied_padding: normalization.applied_padding ?? null,
        final_size: normalization.final_size ?? null,
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
const roiAuditByField = new Map();
for (const event of auditEvents) {
  if (event?.stage !== "roi-mapper" || event?.message !== "Field ROI mapped." || event?.data === undefined) {
    continue;
  }
  const field = event.data.field;
  if (typeof field !== "string") {
    continue;
  }
  roiAuditByField.set(field, {
    outOfBoundsBeforeClamp: event.data.outOfBoundsBeforeClamp ?? null,
    clampApplied: event.data.clampApplied ?? null,
    roiArea: event.data.roiArea ?? null
  });
}
for (const report of res.field_reports) {
  const bestAttempt = [...(report.attempts ?? [])].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  const roiAudit = roiAuditByField.get(report.field) ?? {};
  console.log(
    JSON.stringify(
      {
        field: report.field,
        roi: report.roi,
        outOfBoundsBeforeClamp: roiAudit.outOfBoundsBeforeClamp ?? null,
        clampApplied: roiAudit.clampApplied ?? null,
        roi_area: roiAudit.roiArea ?? report.roi.width * report.roi.height,
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

function toSource(attempt) {
  if (attempt?.source) {
    return attempt.source;
  }
  return attempt?.pass_id === "C" ? "page" : "roi";
}

function levenshtein(a, b) {
  if (a === b) {
    return 0;
  }
  const left = String(a ?? "");
  const right = String(b ?? "");
  const dp = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cur = dp[j] ?? 0;
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prev + cost);
      prev = cur;
    }
  }
  return dp[right.length] ?? 0;
}

console.log("=== best_candidates ===");
const fioReport = res.field_reports.find((item) => item.field === "fio");
if (fioReport) {
  const mrzAuditAttempts = auditEvents
    .filter((event) => event?.stage === "extractor" && event?.message === "MRZ FIO attempt collected.")
    .map((event) => ({
      windowId: event?.data?.windowId ?? null,
      psm: event?.data?.psm ?? null,
      confidence: event?.data?.confidence ?? null,
      raw_preview: String(event?.data?.rawPreview ?? "").slice(0, 120)
    }));
  console.log("=== fio_mrz_attempts ===");
  console.log(JSON.stringify(mrzAuditAttempts, null, 2));

  const attempts = [...(fioReport.attempts ?? [])].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const mrzCandidate = attempts.find((attempt) => toSource(attempt) === "mrz");
  const roiCandidate = attempts.find((attempt) => toSource(attempt) !== "mrz");
  const mrzSurname = (mrzCandidate?.normalized_preview ?? "").split(" ")[0] ?? "";
  const roiSurname = (roiCandidate?.normalized_preview ?? "").split(" ")[0] ?? "";
  console.log(
    JSON.stringify(
      {
        field: "fio",
        roiCandidate: (roiCandidate?.normalized_preview ?? roiCandidate?.raw_text_preview ?? "").slice(0, 120),
        mrzCandidate: (mrzCandidate?.normalized_preview ?? mrzCandidate?.raw_text_preview ?? "").slice(0, 120),
        similarityScore:
          mrzSurname !== "" && roiSurname !== "" ? Math.max(0, 1 - levenshtein(mrzSurname, roiSurname) / Math.max(mrzSurname.length, roiSurname.length)) : null,
        chosen: {
          source: fioReport.best_candidate_source ?? "unknown",
          confidence: attempts.find((attempt) => (attempt.normalized_preview ?? "").trim() === (fioReport.best_candidate_normalized ?? "").trim())?.confidence ?? null,
          normalizedText: (fioReport.best_candidate_normalized ?? fioReport.best_candidate_preview ?? "").slice(0, 120),
          validatorPassed: fioReport.validator_passed,
          finalFio: res.fio
        },
        ...(res.fio === null ? { nullReason: fioReport.rejection_reason ?? "FIO_VALIDATION_FAILED" } : {})
      },
      null,
      2
    )
  );
}

const issuedByReport = res.field_reports.find((item) => item.field === "issued_by");
if (issuedByReport) {
  const candidate = (issuedByReport.best_candidate_normalized ?? issuedByReport.best_candidate_preview ?? "").trim();
  const nonSpaceChars = candidate.replace(/\s+/gu, "").length;
  const digitRatio = nonSpaceChars === 0 ? 0 : ((candidate.match(/\d/gu) ?? []).length / nonSpaceChars);
  const markersFound = Array.from(candidate.matchAll(/(ГУ|МВД|РОССИИ|УФМС|ОТДЕЛ|УПРАВЛ|ПАСПОРТ)/gu)).map(
    (m) => m[1]
  );
  console.log(
    JSON.stringify(
      {
        field: "issued_by",
        candidate: candidate.slice(0, 120),
        digitRatio: Number(digitRatio.toFixed(4)),
        markersFound,
        chosen: {
          source: issuedByReport.best_candidate_source ?? "unknown",
          validatorPassed: issuedByReport.validator_passed
        }
      },
      null,
      2
    )
  );
}

const compactDebug = {
  fio: res.field_reports.find((item) => item.field === "fio")?.debug_candidates ?? res.diagnostics?.field_debug?.fio ?? null,
  issued_by:
    res.field_reports.find((item) => item.field === "issued_by")?.debug_candidates ??
    res.diagnostics?.field_debug?.issued_by ??
    null
};
if (compactDebug.fio || compactDebug.issued_by) {
  console.log("=== field_debug_compact ===");
  console.log(
    JSON.stringify(
      {
        fio:
          compactDebug.fio === null
            ? null
            : {
                source_counts: compactDebug.fio.source_counts,
                top3: compactDebug.fio.top_candidates.slice(0, 3)
              },
        issued_by:
          compactDebug.issued_by === null
            ? null
            : {
                source_counts: compactDebug.issued_by.source_counts,
                top3: compactDebug.issued_by.top_candidates.slice(0, 3)
              }
      },
      null,
      2
    )
  );
}

const worstRoiMarginEvent = [...auditEvents]
  .reverse()
  .find((event) => event?.stage === "dynamic-roi-mapper" && event?.data?.worstRoiMargin !== undefined);
if (worstRoiMarginEvent?.data?.worstRoiMargin !== undefined) {
  console.log("=== roi_bounds_audit ===");
  console.log(JSON.stringify(worstRoiMarginEvent.data.worstRoiMargin, null, 2));
}

console.log("=== result ===");
console.log(JSON.stringify(res, null, 2));

console.log("=== final_fields ===");
console.log(
  JSON.stringify(
    {
      fio: res.fio,
      passport_number: res.passport_number,
      issued_by: res.issued_by,
      dept_code: res.dept_code,
      registration: res.registration,
      confidence_score: res.confidence_score
    },
    null,
    2
  )
);

async function writeDebugZoneOverlay(result) {
  const debugDir = (process.env.KEISCORE_DEBUG_ROI_DIR ?? "").trim() || join(tmpdir(), "keiscore_debug_roi");
  await mkdir(debugDir, { recursive: true });
  const normalizedPagePath = await detectNormalizedPagePath(debugDir);
  if (normalizedPagePath === null) {
    return null;
  }

  const normalizedCopyPath = join(debugDir, "normalized_page.png");
  await copyFile(normalizedPagePath, normalizedCopyPath);
  const image = sharp(normalizedCopyPath);
  const metadata = await image.metadata();
  const width = metadata.width ?? result.diagnostics?.normalization?.final_size?.width ?? 0;
  const height = metadata.height ?? result.diagnostics?.normalization?.final_size?.height ?? 0;
  if (width <= 0 || height <= 0) {
    return null;
  }

  const zonesPercent = [
    { name: "fio_zone_1", leftR: 0.08, topR: 0.39, rightR: 0.8, bottomR: 0.44, color: "#34d399" },
    { name: "fio_zone_2", leftR: 0.08, topR: 0.42, rightR: 0.8, bottomR: 0.47, color: "#10b981" },
    { name: "fio_zone_3", leftR: 0.08, topR: 0.45, rightR: 0.8, bottomR: 0.5, color: "#059669" },
    { name: "issued_zone_1", leftR: 0.4, topR: 0.32, rightR: 0.98, bottomR: 0.4, color: "#60a5fa" },
    { name: "issued_zone_2", leftR: 0.4, topR: 0.35, rightR: 0.98, bottomR: 0.43, color: "#3b82f6" },
    { name: "issued_zone_3", leftR: 0.4, topR: 0.38, rightR: 0.98, bottomR: 0.46, color: "#2563eb" }
  ];
  const zonesPx = zonesPercent.map((zone) => {
    const left = Math.max(0, Math.round(width * zone.leftR));
    const top = Math.max(0, Math.round(height * zone.topR));
    const right = Math.min(width, Math.round(width * zone.rightR));
    const bottom = Math.min(height, Math.round(height * zone.bottomR));
    return {
      ...zone,
      left,
      top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top)
    };
  });

  const overlaySvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
${zonesPx
  .map(
    (zone) => `<rect x="${zone.left}" y="${zone.top}" width="${zone.width}" height="${zone.height}" fill="none" stroke="${zone.color}" stroke-width="4"/>
<text x="${zone.left + 8}" y="${Math.max(16, zone.top + 18)}" fill="${zone.color}" font-size="18" font-family="Arial">${zone.name}</text>`
  )
  .join("\n")}
</svg>`;
  const overlayPath = join(debugDir, "overlay_zones.png");
  await sharp(normalizedCopyPath)
    .composite([{ input: Buffer.from(overlaySvg) }])
    .png()
    .toFile(overlayPath);

  const cropPaths = [];
  for (const zone of zonesPx) {
    const cropPath = join(debugDir, `${zone.name}.png`);
    await sharp(normalizedCopyPath)
      .extract({ left: zone.left, top: zone.top, width: zone.width, height: zone.height })
      .png()
      .toFile(cropPath);
    cropPaths.push(cropPath);
  }
  const zonesByPercent = Object.fromEntries(
    zonesPercent.map((zone) => [
      zone.name,
      {
        leftR: zone.leftR,
        topR: zone.topR,
        rightR: zone.rightR,
        bottomR: zone.bottomR
      }
    ])
  );
  const zonesByPixels = Object.fromEntries(
    zonesPx.map((zone) => [
      zone.name,
      {
        left: zone.left,
        top: zone.top,
        width: zone.width,
        height: zone.height
      }
    ])
  );
  await writeFile(join(debugDir, "overlay_zones.json"), JSON.stringify({ zonesByPercent, zonesByPixels }, null, 2), "utf8");

  return {
    debugDir,
    normalized_page: normalizedCopyPath,
    overlay_zones: overlayPath,
    crops: cropPaths
  };
}

async function detectNormalizedPagePath(debugDir) {
  const entries = await readdir(debugDir);
  const pageCandidates = entries
    .filter((name) => name.endsWith("_0_page.png") || name.endsWith("_page.png"))
    .map((name) => join(debugDir, name));
  if (pageCandidates.length === 0) {
    return null;
  }
  const withMtime = await Promise.all(
    pageCandidates.map(async (path) => ({
      path,
      mtimeMs: (await stat(path)).mtimeMs
    }))
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMtime[0]?.path ?? null;
}