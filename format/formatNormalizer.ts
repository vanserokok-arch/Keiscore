import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import sharp from "sharp";
import type {
  AuditLogger,
  CoreError,
  ExtractOptions,
  InputFile,
  MockDocumentLayout,
  NormalizedInput,
  RoiRect,
  SupportedInputMime
} from "../types.js";

const MIME_BY_EXTENSION: Record<string, SupportedInputMime> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".pdf": "application/pdf"
};

const DEFAULT_MAX_INPUT_BYTES = 30 * 1024 * 1024;
const DEFAULT_PDF_RENDER_TIMEOUT_MS = 120_000;
const MOCK_PREFIX = "KEISCORE_MOCK_LAYOUT:";
const PASSPORT_ORIENTATION_ROTATIONS: Array<0 | 90 | 180 | 270> = [0, 180, 90, 270];

function normalizePathExtension(name: string): string {
  return extname(name).toLowerCase();
}

function throwStructuredError(error: CoreError): never {
  const structured = new Error(error.message) as Error & { coreError: CoreError };
  structured.coreError = error;
  throw structured;
}

function resolveMimeFromName(name: string): SupportedInputMime | null {
  const extension = normalizePathExtension(name);
  return MIME_BY_EXTENSION[extension] ?? null;
}

export class FormatNormalizer {
  static async normalize(
    input: InputFile,
    opts?: ExtractOptions,
    logger?: AuditLogger
  ): Promise<NormalizedInput> {
    const maxInputBytes = opts?.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    const allowedBasePath = opts?.allowedBasePath === undefined ? null : resolve(opts.allowedBasePath);

    if (input.kind === "path") {
      const mime = resolveMimeFromName(input.path);
      if (mime === null) {
        throwStructuredError({
          code: "UNSUPPORTED_FORMAT",
          message: `Unsupported input format for path: ${input.path}`,
          details: { kind: "path" }
        });
      }

      const absolutePath = resolve(input.path);
      if (allowedBasePath !== null && !absolutePath.startsWith(allowedBasePath)) {
        throwStructuredError({
          code: "SECURITY_VIOLATION",
          message: `Input path is outside allowed base path: ${input.path}`,
          details: { allowedBasePath }
        });
      }

      try {
        await access(input.path);
      } catch {
        throwStructuredError({
          code: "INTERNAL_ERROR",
          message: `Input path is not accessible: ${input.path}`,
          details: { kind: "path" }
        });
      }

      const fileStat = await stat(input.path);
      if (fileStat.size > maxInputBytes) {
        throwStructuredError({
          code: "SECURITY_VIOLATION",
          message: `Input file exceeds size limit (${maxInputBytes} bytes).`,
          details: { size: fileStat.size, maxInputBytes }
        });
      }

      const fileName = basename(input.path);
      const fileBuffer = await readFile(input.path);
      const normalizedPdf =
        mime === "application/pdf"
          ? await this.normalizePdfPath(input.path, opts, logger)
          : null;
      const normalizedImage =
        normalizedPdf?.normalizedImage ??
        (await this.normalizeImageBuffer(fileBuffer, parseMockLayout(fileBuffer), logger));
      const normalizedBuffer = normalizedImage.buffer;
      const mockLayout = parseMockLayout(fileBuffer);
      const quality_metrics = computeQualityMetrics(normalizedBuffer ?? fileBuffer, mockLayout);
      const inferred = inferGeometry(mockLayout);
      const imageGeometry =
        mime === "application/pdf"
          ? {
              width: normalizedPdf?.pages[0]?.width ?? inferred.width,
              height: normalizedPdf?.pages[0]?.height ?? inferred.height
            }
          : await inferImageGeometry(normalizedBuffer, inferred.width, inferred.height);
      const skewAngleDeg = normalizedImage.preprocessing?.deskewAngleDeg ?? inferred.skewAngleDeg;
      const warnings =
        quality_metrics.blur_score < 0.15
          ? [
              {
                code: "QUALITY_WARNING" as const,
                message: "Blur score is below threshold.",
                details: { blur_score: quality_metrics.blur_score }
              }
            ]
          : [];

      if (mime === "application/pdf") {
        const fallbackWidth = inferred.width;
        const fallbackHeight = inferred.height;
        const pages =
          normalizedPdf?.pages.map((page) => ({
            ...page,
            width: Math.max(1, page.width || fallbackWidth),
            height: Math.max(1, page.height || fallbackHeight)
          })) ?? [];
        const firstPage = pages[0];
        return {
          original: input,
          mime,
          kind: "pdf",
          pages,
          sourcePath: input.path,
          fileName,
          buffer: fileBuffer,
          normalizedBuffer,
          width: firstPage?.width ?? imageGeometry.width,
          height: firstPage?.height ?? imageGeometry.height,
          quality_metrics,
          warnings,
          skewAngleDeg,
          ...(normalizedImage.preprocessing === undefined
            ? {}
            : { preprocessing: normalizedImage.preprocessing }),
          ...(mockLayout === undefined ? {} : { mockLayout })
        };
      }

      return {
        original: input,
        mime,
        kind: "image",
        pages: [
          {
            pageNumber: 1,
            imagePath: null,
            width: imageGeometry.width,
            height: imageGeometry.height
          }
        ],
        sourcePath: input.path,
        fileName,
        buffer: fileBuffer,
        normalizedBuffer,
        width: imageGeometry.width,
        height: imageGeometry.height,
        quality_metrics,
        warnings,
        skewAngleDeg,
        ...(normalizedImage.preprocessing === undefined
          ? {}
          : { preprocessing: normalizedImage.preprocessing }),
        ...(mockLayout === undefined ? {} : { mockLayout })
      };
    }

    const mime = resolveMimeFromName(input.filename);
    if (mime === null) {
      throwStructuredError({
        code: "UNSUPPORTED_FORMAT",
        message: `Unsupported input format for filename: ${input.filename}`,
        details: { kind: "buffer" }
      });
    }

    if (input.data.byteLength > maxInputBytes) {
      throwStructuredError({
        code: "SECURITY_VIOLATION",
        message: `Input buffer exceeds size limit (${maxInputBytes} bytes).`,
        details: { size: input.data.byteLength, maxInputBytes }
      });
    }

    const mockLayout = parseMockLayout(input.data);
    const normalizedPdf =
      mime === "application/pdf"
        ? await this.normalizePdfBuffer(input.data, input.filename, opts, logger)
        : null;
    const normalizedImage =
      normalizedPdf?.normalizedImage ?? (await this.normalizeImageBuffer(input.data, mockLayout, logger));
    const normalizedBuffer = normalizedImage.buffer;
    const quality_metrics = computeQualityMetrics(normalizedBuffer, mockLayout);
    const inferred = inferGeometry(mockLayout);
    const imageGeometry =
      mime === "application/pdf"
        ? {
            width: normalizedPdf?.pages[0]?.width ?? inferred.width,
            height: normalizedPdf?.pages[0]?.height ?? inferred.height
          }
        : await inferImageGeometry(normalizedBuffer, inferred.width, inferred.height);
    const skewAngleDeg = normalizedImage.preprocessing?.deskewAngleDeg ?? inferred.skewAngleDeg;
    const warnings =
      quality_metrics.blur_score < 0.15
        ? [
            {
              code: "QUALITY_WARNING" as const,
              message: "Blur score is below threshold.",
              details: { blur_score: quality_metrics.blur_score }
            }
          ]
        : [];

    if (mime === "application/pdf") {
      const fallbackWidth = inferred.width;
      const fallbackHeight = inferred.height;
      const pages =
        normalizedPdf?.pages.map((page) => ({
          ...page,
          width: Math.max(1, page.width || fallbackWidth),
          height: Math.max(1, page.height || fallbackHeight)
        })) ?? [];
      const firstPage = pages[0];
      return {
        original: input,
        mime,
        kind: "pdf",
        pages,
        sourcePath: null,
        fileName: input.filename,
        buffer: input.data,
        normalizedBuffer,
        width: firstPage?.width ?? imageGeometry.width,
        height: firstPage?.height ?? imageGeometry.height,
        quality_metrics,
        warnings,
        skewAngleDeg,
        ...(normalizedImage.preprocessing === undefined
          ? {}
          : { preprocessing: normalizedImage.preprocessing }),
        ...(mockLayout === undefined ? {} : { mockLayout })
      };
    }

    return {
      original: input,
      mime,
      kind: "image",
      pages: [
        {
          pageNumber: 1,
          imagePath: null,
          width: imageGeometry.width,
          height: imageGeometry.height
        }
      ],
      sourcePath: null,
      fileName: input.filename,
      buffer: input.data,
      normalizedBuffer,
      width: imageGeometry.width,
      height: imageGeometry.height,
      quality_metrics,
      warnings,
      skewAngleDeg,
      ...(normalizedImage.preprocessing === undefined
        ? {}
        : { preprocessing: normalizedImage.preprocessing }),
      ...(mockLayout === undefined ? {} : { mockLayout })
    };
  }

  private static async normalizeImageBuffer(
    sourceBuffer: Buffer,
    mockLayout: MockDocumentLayout | undefined,
    logger?: AuditLogger
  ): Promise<{ buffer: Buffer; preprocessing?: NormalizedInput["preprocessing"] }> {
    try {
      const sourceMeta = await sharp(sourceBuffer).metadata();
      const sourceWidth = sourceMeta.width ?? 0;
      const pipeline =
        sourceWidth > 0 && sourceWidth < 2500
          ? sharp(sourceBuffer).grayscale().resize({ width: 2500, withoutEnlargement: false }).png()
          : sharp(sourceBuffer).grayscale().png();
      const raster = await pipeline.toBuffer();
      try {
        const processed = await preprocessRasterPage(raster, logger);
        return processed;
      } catch {
        return { buffer: raster };
      }
    } catch (error) {
      if (mockLayout === undefined) {
        throw error;
      }
      const width = Math.max(2500, Math.round(mockLayout.width || 2500));
      const height = Math.max(1, Math.round(mockLayout.height || Math.round(width * 0.7)));
      const fallback = await sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      })
        .png()
        .toBuffer();
      return { buffer: fallback };
    }
  }

  private static async normalizePdfPath(
    sourcePath: string,
    opts?: ExtractOptions,
    logger?: AuditLogger
  ): Promise<{
    normalizedImage: { buffer: Buffer; preprocessing?: NormalizedInput["preprocessing"] };
    pages: Array<{ pageNumber: number; imagePath: string; width: number; height: number }>;
  }> {
    const tmpBase = await mkdtemp(join(tmpdir(), "keiscore-pdf-"));
    const outputPrefix = join(tmpBase, "page");
    const renderTimeoutMs = opts?.pdfRenderTimeoutMs ?? DEFAULT_PDF_RENDER_TIMEOUT_MS;
    const requestedFrom = opts?.pdfPageRange?.from;
    const requestedTo = opts?.pdfPageRange?.to;
    const hasExplicitPageRange = requestedFrom !== undefined || requestedTo !== undefined;
    const from = Math.max(1, Math.floor(requestedFrom ?? 1));
    const to = Math.max(from, Math.floor(requestedTo ?? from));
    const pdftoppmArgs = [
      ...(hasExplicitPageRange ? ["-f", String(from), "-l", String(to)] : []),
      "-gray",
      "-r",
      "500",
      "-png",
      sourcePath,
      outputPrefix
    ];
    let keepArtifacts = false;
    try {
      await execa("pdftoppm", pdftoppmArgs, { timeout: renderTimeoutMs });
      const entries = await readdir(tmpBase);
      const renderedPngNames = entries
        .filter((name) => name.startsWith("page-") && name.endsWith(".png"))
        .sort();
      if (renderedPngNames.length === 0) {
        throw new Error("pdftoppm did not produce PNG outputs.");
      }
      const pages = await Promise.all(
        renderedPngNames.map(async (fileName, index) => {
          const imagePath = join(tmpBase, fileName);
          const pageBuffer = await readFile(imagePath);
          const normalizedImage = await this.normalizeImageBuffer(pageBuffer, undefined, logger);
          await writeFile(imagePath, normalizedImage.buffer);
          const metadata = await sharp(normalizedImage.buffer).metadata();
          const filePageNumber = Number.parseInt(fileName.slice("page-".length, -".png".length), 10);
          const fallbackPage = hasExplicitPageRange ? from + index : index + 1;
          return {
            pageNumber:
              Number.isFinite(filePageNumber) && filePageNumber > 0 ? filePageNumber : fallbackPage,
            imagePath,
            width: Math.max(1, metadata.width ?? 1),
            height: Math.max(1, metadata.height ?? 1),
            preprocessing: normalizedImage.preprocessing
          };
        })
      );
      const firstPage = pages[0];
      if (firstPage === undefined) {
        throw new Error("No rendered pages after normalization.");
      }
      keepArtifacts = true;
      return {
        normalizedImage: {
          buffer: await readFile(firstPage.imagePath),
          ...(firstPage.preprocessing === undefined ? {} : { preprocessing: firstPage.preprocessing })
        },
        pages: pages.map((page) => ({
          pageNumber: page.pageNumber,
          imagePath: page.imagePath,
          width: page.width,
          height: page.height
        }))
      };
    } catch (error) {
      if (isBinaryMissing(error)) {
        throwStructuredError({
          code: "ENGINE_UNAVAILABLE",
          message: "pdftoppm is not available on this host.",
          details: { binary: "pdftoppm", sourcePath }
        });
      }
      logger?.log({
        ts: Date.now(),
        stage: "format-normalizer",
        level: "error",
        message: "pdftoppm failed to render PDF input.",
        data: { sourcePath, reason: error instanceof Error ? error.message : "unknown_error" }
      });
      throwStructuredError({
        code: "INTERNAL_ERROR",
        message: "Failed to render PDF with pdftoppm.",
        details: { sourcePath, reason: error instanceof Error ? error.message : "unknown_error" }
      });
    } finally {
      if (!keepArtifacts) {
        await rm(tmpBase, { recursive: true, force: true });
      }
    }
    throw new Error("Unreachable normalizePdfPath state.");
  }

  private static async normalizePdfBuffer(
    sourceBuffer: Buffer,
    sourceName: string,
    opts?: ExtractOptions,
    logger?: AuditLogger
  ): Promise<{
    normalizedImage: { buffer: Buffer; preprocessing?: NormalizedInput["preprocessing"] };
    pages: Array<{ pageNumber: number; imagePath: string; width: number; height: number }>;
  }> {
    const tmpBase = await mkdtemp(join(tmpdir(), "keiscore-pdf-buffer-"));
    const pdfPath = join(tmpBase, "input.pdf");
    try {
      await writeFile(pdfPath, sourceBuffer);
      return await this.normalizePdfPath(pdfPath, opts, logger);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "coreError" in error &&
        typeof (error as { coreError?: unknown }).coreError === "object"
      ) {
        throw error;
      }
      throwStructuredError({
        code: "INTERNAL_ERROR",
        message: "Failed to normalize PDF buffer.",
        details: { sourceName, reason: error instanceof Error ? error.message : "unknown_error" }
      });
    } finally {
      await rm(tmpBase, { recursive: true, force: true });
    }
  }

  static async cleanupPdfPageArtifacts(normalized: NormalizedInput): Promise<void> {
    if (normalized.kind !== "pdf" || normalized.pages.length === 0) {
      return;
    }
    const firstImagePath = normalized.pages[0]?.imagePath;
    if (firstImagePath === null || firstImagePath === undefined) {
      return;
    }
    const marker = `${join(tmpdir(), "keiscore-pdf-")}`;
    if (!firstImagePath.startsWith(marker)) {
      return;
    }
    await rm(dirname(firstImagePath), { recursive: true, force: true });
  }
}

function isBinaryMissing(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const execaError = error as Error & { code?: string; stderr?: string; shortMessage?: string };
  if (execaError.code === "ENOENT") {
    return true;
  }
  const joined = `${execaError.message} ${execaError.stderr ?? ""} ${execaError.shortMessage ?? ""}`;
  return joined.toLowerCase().includes("command not found");
}

function parseMockLayout(buffer: Buffer): MockDocumentLayout | undefined {
  const asText = buffer.toString("utf8");
  if (!asText.startsWith(MOCK_PREFIX)) {
    return undefined;
  }

  const raw = asText.slice(MOCK_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(raw) as MockDocumentLayout;
    return parsed;
  } catch {
    return undefined;
  }
}

function inferGeometry(layout: MockDocumentLayout | undefined): {
  width: number;
  height: number;
  skewAngleDeg: number;
} {
  return {
    width: Math.max(1, layout?.width ?? 2200),
    height: Math.max(1, layout?.height ?? 1550),
    skewAngleDeg: layout?.skewDeg ?? 0
  };
}

async function inferImageGeometry(
  normalizedBuffer: Buffer,
  fallbackWidth: number,
  fallbackHeight: number
): Promise<{ width: number; height: number }> {
  try {
    const metadata = await sharp(normalizedBuffer).metadata();
    return {
      width: Math.max(1, metadata.width ?? fallbackWidth),
      height: Math.max(1, metadata.height ?? fallbackHeight)
    };
  } catch {
    return {
      width: Math.max(1, fallbackWidth),
      height: Math.max(1, fallbackHeight)
    };
  }
}

async function preprocessRasterPage(
  source: Buffer,
  logger?: AuditLogger
): Promise<{ buffer: Buffer; preprocessing?: NormalizedInput["preprocessing"] }> {
  const orientation = await chooseOrientation(source);
  const oriented = orientation.rotationDeg === 0 ? source : await rotateWithWhiteBg(source, orientation.rotationDeg);
  const deskew = await estimateDeskewAngle(oriented);
  const deskewed = Math.abs(deskew) < 0.05 ? oriented : await rotateFloatWithWhiteBg(oriented, -deskew);
  const crop = await computeAdaptiveContentCrop(deskewed);
  const cropped =
    crop.bbox === null
      ? deskewed
      : await sharp(deskewed)
          .extract({
            left: crop.bbox.x,
            top: crop.bbox.y,
            width: crop.bbox.width,
            height: crop.bbox.height
          })
          .png()
          .toBuffer();
  const preprocessing: NormalizedInput["preprocessing"] = {
    applied: orientation.rotationDeg !== 0 || Math.abs(deskew) >= 0.05 || crop.bbox !== null,
    selectedThreshold: crop.threshold,
    rotationDeg: orientation.rotationDeg,
    orientationScore: orientation.score,
    deskewAngleDeg: Number(deskew.toFixed(2)),
    blackPixelRatio: Number(crop.blackPixelRatio.toFixed(4)),
    ...(crop.bbox === null
      ? {}
      : {
          cropBbox: {
            ...crop.bbox,
            page: 0
          }
        })
  };
  logger?.log({
    ts: Date.now(),
    stage: "format-normalizer",
    level: "info",
    message: "Page normalization preprocessing applied.",
    data: preprocessing
  });
  return { buffer: cropped, preprocessing };
}

async function chooseOrientation(
  source: Buffer
): Promise<{ rotationDeg: 0 | 90 | 180 | 270; score: number }> {
  let best: { rotationDeg: 0 | 90 | 180 | 270; score: number } = { rotationDeg: 0, score: -1 };
  for (const rotationDeg of PASSPORT_ORIENTATION_ROTATIONS) {
    try {
      const rotated = rotationDeg === 0 ? source : await rotateWithWhiteBg(source, rotationDeg);
      const score = await computePassportHintScore(rotated);
      if (score > best.score) {
        best = { rotationDeg, score };
      }
    } catch {
      // ignore and continue orientation probing
    }
  }
  return best;
}

async function computePassportHintScore(source: Buffer): Promise<number> {
  const metadata = await sharp(source).metadata();
  const width = Math.max(1, metadata.width ?? 1);
  const height = Math.max(1, metadata.height ?? 1);
  const crop = {
    left: Math.floor(width * 0.2),
    top: Math.floor(height * 0.2),
    width: Math.max(1, Math.floor(width * 0.6)),
    height: Math.max(1, Math.floor(height * 0.6))
  };
  const center = await sharp(source).extract(crop).resize({ width: 900, withoutEnlargement: false }).png().toBuffer();
  try {
    const { stdout } = await execa("tesseract", ["stdin", "stdout", "-l", "rus", "--psm", "6"], {
      input: center,
      timeout: 7_000
    });
    const text = (stdout ?? "").toUpperCase();
    const hasRussia = text.includes("РОСС") ? 1 : 0;
    const hasFederation = text.includes("ФЕДЕРАЦ") ? 1 : 0;
    const hasSpreadHints = /(ФАМИЛИ|ОТЧЕСТВ|КОД|ВЫДАН|ПОДРАЗДЕЛ|МЕСТО)/u.test(text) ? 1 : 0;
    const hasMrz = text.includes("<<<") ? 1 : 0;
    const tokenBonus = Math.min(0.4, text.replace(/[^А-ЯЁ0-9]+/gu, " ").trim().split(/\s+/).length / 80);
    return hasRussia * 1.2 + hasFederation * 1.2 + hasSpreadHints * 1 + hasMrz * 0.8 + tokenBonus;
  } catch {
    return 0;
  }
}

async function estimateDeskewAngle(source: Buffer): Promise<number> {
  const probe = await sharp(source).resize({ width: 1200, withoutEnlargement: true }).grayscale().png().toBuffer();
  let bestAngle = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let angle = -2; angle <= 2.001; angle += 0.5) {
    const rotated = Math.abs(angle) < 0.01 ? probe : await rotateFloatWithWhiteBg(probe, angle);
    const { data, info } = await sharp(rotated).threshold(190).raw().toBuffer({ resolveWithObject: true });
    const rowSums = new Array<number>(info.height).fill(0);
    for (let y = 0; y < info.height; y += 1) {
      const rowStart = y * info.width;
      let count = 0;
      for (let x = 0; x < info.width; x += 1) {
        if ((data[rowStart + x] ?? 255) < 128) {
          count += 1;
        }
      }
      rowSums[y] = count;
    }
    const mean = rowSums.reduce((sum, value) => sum + value, 0) / Math.max(1, rowSums.length);
    const variance =
      rowSums.reduce((sum, value) => {
        const d = value - mean;
        return sum + d * d;
      }, 0) / Math.max(1, rowSums.length);
    if (variance > bestScore) {
      bestScore = variance;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

async function computeAdaptiveContentCrop(
  source: Buffer
): Promise<{ bbox: Omit<RoiRect, "page"> | null; threshold: number; blackPixelRatio: number }> {
  const resized = await sharp(source).resize({ width: 1800, withoutEnlargement: true }).grayscale().raw().toBuffer({
    resolveWithObject: true
  });
  const { data, info } = resized;
  const dark235 = countBelowThreshold(data, 235);
  const dark245 = countBelowThreshold(data, 245);
  const all = Math.max(1, info.width * info.height);
  const blackPixelRatio = dark235 / all;
  const threshold = blackPixelRatio > 0.03 || dark245 / all > 0.09 ? 245 : 235;
  const bboxSmall = computeNonWhiteBboxFromRaw(data, info.width, info.height, threshold);
  if (bboxSmall === null) {
    return { bbox: null, threshold, blackPixelRatio };
  }
  const sourceMeta = await sharp(source).metadata();
  const fullW = Math.max(1, sourceMeta.width ?? info.width);
  const fullH = Math.max(1, sourceMeta.height ?? info.height);
  const scaleX = fullW / info.width;
  const scaleY = fullH / info.height;
  const pad = 12;
  const left = clampInt(Math.floor(bboxSmall.x * scaleX) - pad, 0, fullW - 1);
  const top = clampInt(Math.floor(bboxSmall.y * scaleY) - pad, 0, fullH - 1);
  const right = clampInt(Math.ceil((bboxSmall.x + bboxSmall.width) * scaleX) + pad, left + 1, fullW);
  const bottom = clampInt(Math.ceil((bboxSmall.y + bboxSmall.height) * scaleY) + pad, top + 1, fullH);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const areaRatio = (width * height) / (fullW * fullH);
  if (areaRatio > 0.995 || areaRatio < 0.08) {
    return { bbox: null, threshold, blackPixelRatio };
  }
  return { bbox: { x: left, y: top, width, height }, threshold, blackPixelRatio };
}

function countBelowThreshold(data: Buffer, threshold: number): number {
  let count = 0;
  for (let i = 0; i < data.length; i += 1) {
    if ((data[i] ?? 255) < threshold) {
      count += 1;
    }
  }
  return count;
}

function computeNonWhiteBboxFromRaw(
  raw: Buffer,
  width: number,
  height: number,
  threshold: number
): Omit<RoiRect, "page"> | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if ((raw[row + x] ?? 255) >= threshold) {
        continue;
      }
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX <= minX || maxY <= minY) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function rotateWithWhiteBg(source: Buffer, deg: 0 | 90 | 180 | 270): Promise<Buffer> {
  return sharp(source).rotate(deg, { background: { r: 255, g: 255, b: 255 } }).png().toBuffer();
}

async function rotateFloatWithWhiteBg(source: Buffer, deg: number): Promise<Buffer> {
  return sharp(source).rotate(deg, { background: { r: 255, g: 255, b: 255 } }).png().toBuffer();
}

function clampInt(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function computeQualityMetrics(
  source: Buffer,
  layout: MockDocumentLayout | undefined
): NormalizedInput["quality_metrics"] {
  if (layout?.quality !== undefined) {
    return {
      blur_score: clamp01(layout.quality.blur ?? 0.8),
      contrast_score: clamp01(layout.quality.contrast ?? 0.8),
      noise_score: clamp01(layout.quality.noise ?? 0.2)
    };
  }

  if (source.byteLength === 0) {
    return { blur_score: 0, contrast_score: 0, noise_score: 1 };
  }

  let sum = 0;
  for (const value of source.values()) {
    sum += value;
  }
  const mean = sum / source.byteLength;

  let variance = 0;
  let diffCount = 0;
  let prev: number | null = null;
  for (const value of source.values()) {
    const delta = value - mean;
    variance += delta * delta;
    if (prev !== null && Math.abs(prev - value) > 20) {
      diffCount += 1;
    }
    prev = value;
  }

  const stdDev = Math.sqrt(variance / source.byteLength);
  const contrast = clamp01(stdDev / 64);
  const noise = clamp01(diffCount / Math.max(1, source.byteLength - 1));
  const blur = clamp01(1 - noise * 0.6 + contrast * 0.3);

  return {
    blur_score: blur,
    contrast_score: contrast,
    noise_score: noise
  };
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number.isFinite(value) ? value : 0;
}
