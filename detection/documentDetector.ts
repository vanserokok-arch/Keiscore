// detection/documentDetector.ts
import sharp from "sharp";
import { execa } from "execa";
import type { AuditLogger, DocumentDetection, NormalizedInput, RoiBBox } from "../types.js";

type BBox = { x: number; y: number; width: number; height: number };

type ContourHeuristicResult = {
  detected: boolean;
  bbox?: BBox;
  aspectRatio?: number;
  areaRatio?: number;
};

function toRoiBBox(box: BBox): RoiBBox {
  return {
    x1: box.x,
    y1: box.y,
    x2: box.x + box.width,
    y2: box.y + box.height
  };
}

function clampBBox(box: BBox, imgW: number, imgH: number): BBox {
  const x = Math.max(0, Math.min(box.x, Math.max(0, imgW - 1)));
  const y = Math.max(0, Math.min(box.y, Math.max(0, imgH - 1)));
  const width = Math.max(1, Math.min(box.width, imgW - x));
  const height = Math.max(1, Math.min(box.height, imgH - y));
  return { x, y, width, height };
}

/**
 * Robust fallback: find content bbox by non-white pixels.
 * Works for "passport on white A4" scans.
 */
async function computeNonWhiteBBox(imagePath: string): Promise<{ bbox: BBox | null; threshold: number; darkRatio: number }> {
  const targetW = 1400;

  const img = sharp(imagePath);
  const meta = await img.metadata();
  if (!meta.width || !meta.height) {
    return { bbox: null, threshold: 245, darkRatio: 0 };
  }

  const scale = Math.min(1, targetW / meta.width);
  const w = Math.max(1, Math.round(meta.width * scale));
  const h = Math.max(1, Math.round(meta.height * scale));

  const { data, info } = await img
    .resize({ width: w })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width;
  const H = info.height;

  const pixels = W * H;
  let below235 = 0;
  let below245 = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i] ?? 255;
    if (v < 245) below245 += 1;
    if (v < 235) below235 += 1;
  }
  const darkRatio = below235 / Math.max(1, pixels);
  const thr = darkRatio > 0.035 || below245 / Math.max(1, pixels) > 0.11 ? 245 : 235;

  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;

  // NOTE: Buffer index access is typed as number | undefined in TS.
  // Guard with `?? 255` to satisfy `exactOptionalPropertyTypes` + strictness.
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const v = data[row + x] ?? 255;
      if (v < thr) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) {
    return { bbox: null, threshold: thr, darkRatio };
  }

  // padding in downscaled space
  const padX = Math.round(W * 0.03);
  const padY = Math.round(H * 0.03);

  minX = Math.max(0, minX - padX);
  minY = Math.max(0, minY - padY);
  maxX = Math.min(W - 1, maxX + padX);
  maxY = Math.min(H - 1, maxY + padY);

  // upscale bbox to original coords
  const inv = 1 / scale;

  const ox = Math.round(minX * inv);
  const oy = Math.round(minY * inv);
  const ow = Math.round((maxX - minX + 1) * inv);
  const oh = Math.round((maxY - minY + 1) * inv);

  const clamped = clampBBox({ x: ox, y: oy, width: ow, height: oh }, meta.width, meta.height);

  // guard against "almost full page" (noise)
  const areaRatio = (clamped.width * clamped.height) / (meta.width * meta.height);
  if (areaRatio > 0.985) {
    return { bbox: null, threshold: thr, darkRatio };
  }

  return { bbox: clamped, threshold: thr, darkRatio };
}

/**
 * Placeholder contour heuristic detector.
 * Keep log contract, but prefer the robust non-white bbox fallback.
 */
async function detectByContourHeuristics(imagePath: string): Promise<ContourHeuristicResult> {
  const meta = await sharp(imagePath).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const aspectRatio = w && h ? w / h : undefined;

  // If/when you add a real contour detector, return detected=true + bbox.
  return {
    detected: false,
    ...(aspectRatio === undefined ? {} : { aspectRatio })
  };
}

type OcrFallbackMetrics = {
  hasRussia: boolean;
  hasFederation: boolean;
  hasMrz: boolean;
  hasSpreadHints: boolean;
  score: number;
  preview: string;
};

async function analyzeOcrHints(imagePath: string): Promise<OcrFallbackMetrics> {
  try {
    const meta = await sharp(imagePath).metadata();
    const width = Math.max(1, meta.width ?? 1);
    const height = Math.max(1, meta.height ?? 1);
    const center = await sharp(imagePath)
      .extract({
        left: Math.floor(width * 0.18),
        top: Math.floor(height * 0.18),
        width: Math.max(1, Math.floor(width * 0.64)),
        height: Math.max(1, Math.floor(height * 0.64))
      })
      .resize({ width: 1000, withoutEnlargement: false })
      .grayscale()
      .png()
      .toBuffer();
    const { stdout } = await execa("tesseract", ["stdin", "stdout", "-l", "rus", "--psm", "6"], {
      input: center,
      timeout: 8_000
    });
    const text = (stdout ?? "").toUpperCase().replace(/\s+/g, " ").trim();
    const hasRussia = /(РОСС|ОССИ|РОСС|РССИЯ|ОССИЯ)/u.test(text);
    const hasFederation = /(ФЕДЕРАЦ|ФЕЛЕРАЦ|ЕЛЕРАЦ|ЮЕЛЕРАЦ|ФЕАЕРАЦ)/u.test(text);
    const hasMrz = text.includes("<<<") || /[A-Z0-9<]{12,}/u.test(text);
    const hasSpreadHints = /(ФАМИЛ|ИМЯ|ОТЧЕСТВ|ПОДРАЗДЕЛ|ВЫДАН|ДАТА|КОД)/u.test(text);
    const score =
      (hasRussia ? 1.4 : 0) +
      (hasFederation ? 1.4 : 0) +
      (hasMrz ? 0.8 : 0) +
      (hasSpreadHints ? 1.1 : 0) +
      Math.min(0.5, text.length / 2000);
    return { hasRussia, hasFederation, hasMrz, hasSpreadHints, score, preview: text.slice(0, 220) };
  } catch {
    return {
      hasRussia: false,
      hasFederation: false,
      hasMrz: false,
      hasSpreadHints: false,
      score: 0,
      preview: ""
    };
  }
}

function buildDocumentDetectionFailed(
  aspectRatio?: number,
  areaRatio?: number,
  contour?: RoiBBox
): DocumentDetection {
  const out: DocumentDetection = {
    detected: false,
    docType: "UNKNOWN",
    confidence: 0
  };
  if (aspectRatio !== undefined) out.aspectRatio = aspectRatio;
  if (areaRatio !== undefined) out.areaRatio = areaRatio;
  if (contour !== undefined) out.contour = contour;
  return out;
}

function buildDocumentDetectionSuccess(
  contour: RoiBBox,
  aspectRatio?: number,
  areaRatio?: number,
  confidence = 0.75
): DocumentDetection {
  const out: DocumentDetection = {
    detected: true,
    docType: "RF_INTERNAL_PASSPORT",
    confidence,
    contour
  };
  if (aspectRatio !== undefined) out.aspectRatio = aspectRatio;
  if (areaRatio !== undefined) out.areaRatio = areaRatio;
  return out;
}

export class DocumentDetector {
  static async detect(input: NormalizedInput, logger: AuditLogger): Promise<DocumentDetection> {
    const page0 = input.pages[0];
    const imagePath = page0?.imagePath ?? null;

    // 0) Mock layout override (tests)
    if (input.mockLayout?.contour) {
      const metaW = input.mockLayout.width;
      const metaH = input.mockLayout.height;
      const contour = input.mockLayout.contour;
      const areaRatio =
        metaW && metaH
          ? ((contour.x2 - contour.x1) * (contour.y2 - contour.y1)) / (metaW * metaH)
          : undefined;
      const aspectRatio = metaW && metaH ? metaW / metaH : undefined;

      logger.log({
        ts: Date.now(),
        stage: "document-detector",
        level: "info",
        message: "Document detected by contour heuristics.",
        data: {
          kind: input.kind,
          mime: input.mime,
          aspectRatio,
          areaRatio,
          contour
        }
      });

      return buildDocumentDetectionSuccess(contour, aspectRatio, areaRatio, 0.9);
    }

    if (imagePath === null) {
      logger.log({
        ts: Date.now(),
        stage: "document-detector",
        level: "warn",
        message: "Document detection failed.",
        data: { kind: input.kind, mime: input.mime, reason: "NO_PAGE_IMAGE" }
      });
      return buildDocumentDetectionFailed();
    }

    // 1) Try contour heuristics (currently placeholder)
    const contourRes = await detectByContourHeuristics(imagePath);

    logger.log({
      ts: Date.now(),
      stage: "document-detector",
      level: contourRes.detected ? "info" : "warn",
      message: contourRes.detected
        ? "Document detected by contour heuristics."
        : "Document detection failed.",
      data: {
        kind: input.kind,
        mime: input.mime,
        ...(contourRes.aspectRatio === undefined ? {} : { aspectRatio: contourRes.aspectRatio }),
        ...(contourRes.areaRatio === undefined ? {} : { areaRatio: contourRes.areaRatio }),
        ...(contourRes.bbox === undefined ? {} : { contour: toRoiBBox(contourRes.bbox) })
      }
    });

    if (contourRes.detected && contourRes.bbox) {
      const contour = toRoiBBox(contourRes.bbox);
      return buildDocumentDetectionSuccess(contour, contourRes.aspectRatio, contourRes.areaRatio, 0.8);
    }

    // 2) Fallback: non-white bbox
    logger.log({
      ts: Date.now(),
      stage: "document-detector",
      level: "info",
      message: "OCR fallback detection attempt.",
      data: { imagePath }
    });

    const nonWhite = await computeNonWhiteBBox(imagePath);
    const bbox = nonWhite.bbox;
    const fallbackOcr = await analyzeOcrHints(imagePath);

    const meta = await sharp(imagePath).metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;
    const aspectRatio = imgW && imgH ? imgW / imgH : undefined;
    const areaRatio =
      bbox && imgW && imgH ? (bbox.width * bbox.height) / (imgW * imgH) : undefined;

    // This stage is named "OCR fallback" for log stability (even if we didn't OCR here).
    // Anchors/ocr pipeline will do the real text work.
    logger.log({
      ts: Date.now(),
      stage: "document-detector",
      level: "info",
      message: "OCR fallback detection analyzed.",
      data: {
        preview: fallbackOcr.preview || input.fileName,
        hasPassport: false,
        hasRussia: fallbackOcr.hasRussia,
        hasFederation: fallbackOcr.hasFederation,
        hasMrz: fallbackOcr.hasMrz,
        hasSpreadHints: fallbackOcr.hasSpreadHints,
        matchedStrict: false,
        matchedSpread:
          fallbackOcr.hasRussia &&
          fallbackOcr.hasFederation &&
          fallbackOcr.hasMrz &&
          fallbackOcr.hasSpreadHints,
        ocrSpreadScore: fallbackOcr.score,
        nonWhiteThreshold: nonWhite.threshold,
        nonWhiteDarkRatio: nonWhite.darkRatio,
        ...(bbox === null ? {} : { bbox })
      }
    });

    const ocrSpreadDetected =
      fallbackOcr.hasRussia &&
      fallbackOcr.hasFederation &&
      fallbackOcr.hasMrz &&
      fallbackOcr.hasSpreadHints;

    if (bbox && ocrSpreadDetected) {
      const confidence = Math.min(0.92, 0.7 + fallbackOcr.score * 0.06);
      logger.log({
        ts: Date.now(),
        stage: "document-detector",
        level: "info",
        message: "OCR fallback spread detection used.",
        data: {
          imagePath,
          branch: "ocr-fallback-spread",
          ocrSpreadScore: fallbackOcr.score,
          nonWhiteThreshold: nonWhite.threshold,
          nonWhiteDarkRatio: nonWhite.darkRatio,
          bbox
        }
      });
      return buildDocumentDetectionSuccess(toRoiBBox(bbox), aspectRatio, areaRatio, confidence);
    }

    if (!bbox && ocrSpreadDetected && imgW > 0 && imgH > 0) {
      const fullPageContour = { x: 0, y: 0, width: imgW, height: imgH };
      return buildDocumentDetectionSuccess(toRoiBBox(fullPageContour), aspectRatio, 0.99, 0.66);
    }

    if (bbox) {
      logger.log({
        ts: Date.now(),
        stage: "document-detector",
        level: "info",
        message: "OCR fallback detection used.",
        data: {
          imagePath,
          branch: "nonwhite-bbox",
          nonWhiteThreshold: nonWhite.threshold,
          nonWhiteDarkRatio: nonWhite.darkRatio,
          ocrSpreadScore: fallbackOcr.score,
          bbox
        }
      });

      return buildDocumentDetectionSuccess(toRoiBBox(bbox), aspectRatio, areaRatio, 0.75);
    }

    return buildDocumentDetectionFailed(contourRes.aspectRatio, contourRes.areaRatio);
  }
}