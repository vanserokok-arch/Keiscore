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
      const normalizedGeometry = await inferImageGeometry(
        normalizedBuffer,
        imageGeometry.width,
        imageGeometry.height
      );
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
        const syncedFirstPage =
          firstPage === undefined
            ? { pageNumber: 0, imagePath: null, width: normalizedGeometry.width, height: normalizedGeometry.height }
            : { ...firstPage, width: normalizedGeometry.width, height: normalizedGeometry.height };
        return {
          original: input,
          mime,
          kind: "pdf",
          pages: firstPage === undefined ? [syncedFirstPage] : [syncedFirstPage, ...pages.slice(1)],
          sourcePath: input.path,
          fileName,
          buffer: fileBuffer,
          normalizedBuffer,
          width: syncedFirstPage.width,
          height: syncedFirstPage.height,
          quality_metrics,
          warnings,
          skewAngleDeg,
          ...(normalizedImage.preprocessing === undefined
            ? {}
            : {
                preprocessing: {
                  ...normalizedImage.preprocessing,
                  final_size: {
                    width: syncedFirstPage.width,
                    height: syncedFirstPage.height
                  }
                }
              }),
          ...(mockLayout === undefined ? {} : { mockLayout })
        };
      }

      return {
        original: input,
        mime,
        kind: "image",
        pages: [
          {
            pageNumber: 0,
            imagePath: null,
            width: normalizedGeometry.width,
            height: normalizedGeometry.height
          }
        ],
        sourcePath: input.path,
        fileName,
        buffer: fileBuffer,
        normalizedBuffer,
        width: normalizedGeometry.width,
        height: normalizedGeometry.height,
        quality_metrics,
        warnings,
        skewAngleDeg,
        ...(normalizedImage.preprocessing === undefined
          ? {}
          : {
              preprocessing: {
                ...normalizedImage.preprocessing,
                final_size: {
                  width: normalizedGeometry.width,
                  height: normalizedGeometry.height
                }
              }
            }),
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
    const normalizedGeometry = await inferImageGeometry(
      normalizedBuffer,
      imageGeometry.width,
      imageGeometry.height
    );
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
      const syncedFirstPage =
        firstPage === undefined
          ? { pageNumber: 0, imagePath: null, width: normalizedGeometry.width, height: normalizedGeometry.height }
          : { ...firstPage, width: normalizedGeometry.width, height: normalizedGeometry.height };
      return {
        original: input,
        mime,
        kind: "pdf",
        pages: firstPage === undefined ? [syncedFirstPage] : [syncedFirstPage, ...pages.slice(1)],
        sourcePath: null,
        fileName: input.filename,
        buffer: input.data,
        normalizedBuffer,
        width: syncedFirstPage.width,
        height: syncedFirstPage.height,
        quality_metrics,
        warnings,
        skewAngleDeg,
        ...(normalizedImage.preprocessing === undefined
          ? {}
          : {
              preprocessing: {
                ...normalizedImage.preprocessing,
                final_size: {
                  width: syncedFirstPage.width,
                  height: syncedFirstPage.height
                }
              }
            }),
        ...(mockLayout === undefined ? {} : { mockLayout })
      };
    }

    return {
      original: input,
      mime,
      kind: "image",
      pages: [
        {
          pageNumber: 0,
          imagePath: null,
          width: normalizedGeometry.width,
          height: normalizedGeometry.height
        }
      ],
      sourcePath: null,
      fileName: input.filename,
      buffer: input.data,
      normalizedBuffer,
      width: normalizedGeometry.width,
      height: normalizedGeometry.height,
      quality_metrics,
      warnings,
      skewAngleDeg,
      ...(normalizedImage.preprocessing === undefined
        ? {}
        : {
            preprocessing: {
              ...normalizedImage.preprocessing,
              final_size: {
                width: normalizedGeometry.width,
                height: normalizedGeometry.height
              }
            }
          }),
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
    const requestedRange =
      opts?.pdfPageRange === undefined
        ? null
        : { from: Math.floor(opts.pdfPageRange.from), to: Math.floor(opts.pdfPageRange.to) };
    const pageCount = await this.getPdfPageCount(sourcePath);
    const { from: resolvedFrom, to: resolvedTo, rangeClamped } = resolvePdfPageRange0Based(
      sourcePath,
      pageCount,
      requestedRange
    );
    const resolvedRange0based = { from: resolvedFrom, to: resolvedTo };
    const pdftoppmFrom = resolvedRange0based.from + 1;
    const pdftoppmTo = resolvedRange0based.to + 1;
    logger?.log({
      ts: Date.now(),
      stage: "normalizer",
      level: "info",
      message: "PDF page range resolved.",
      data: {
        pageCount,
        requestedRange,
        resolvedRange0based,
        rangeClamped,
        pdftoppmRange1based: { f: pdftoppmFrom, l: pdftoppmTo }
      }
    });
    const pdftoppmArgs = [
      "-f",
      String(pdftoppmFrom),
      "-l",
      String(pdftoppmTo),
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
          const fallbackPage = resolvedRange0based.from + index;
          return {
            pageNumber:
              Number.isFinite(filePageNumber) && filePageNumber > 0 ? filePageNumber - 1 : fallbackPage,
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
      if (isStructuredCoreError(error)) {
        throw error;
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

  private static async getPdfPageCount(sourcePath: string): Promise<number> {
    const pdfinfoPageCount = await this.tryGetPdfPageCountWithPdfinfo(sourcePath);
    if (pdfinfoPageCount !== null) {
      return pdfinfoPageCount;
    }
    const pdfJsPageCount = await this.tryGetPdfPageCountWithPdfJs(sourcePath);
    if (pdfJsPageCount !== null) {
      return pdfJsPageCount;
    }
    throwStructuredError({
      code: "INTERNAL_ERROR",
      message: "Failed to determine PDF page count.",
      details: {
        sourcePath,
        reason: "Unable to determine page count with pdfinfo or pdfjs-dist."
      }
    });
  }

  private static async tryGetPdfPageCountWithPdfinfo(sourcePath: string): Promise<number | null> {
    try {
      const info = await execa("pdfinfo", [sourcePath], { timeout: 10_000 });
      const pagesMatch = info.stdout.match(/^\s*Pages:\s*(\d+)\s*$/m);
      const parsed = pagesMatch === null ? NaN : Number.parseInt(pagesMatch[1] ?? "", 10);
      if (Number.isInteger(parsed) && parsed >= 1) {
        return parsed;
      }
      throwStructuredError({
        code: "INTERNAL_ERROR",
        message: "Failed to determine PDF page count.",
        details: {
          sourcePath,
          reason: "pdfinfo output does not contain a valid Pages value."
        }
      });
    } catch (error) {
      if (isBinaryMissing(error)) {
        return null;
      }
      if (isStructuredCoreError(error)) {
        throw error;
      }
      throwStructuredError({
        code: "INTERNAL_ERROR",
        message: "Failed to determine PDF page count.",
        details: {
          sourcePath,
          reason: error instanceof Error ? error.message : "pdfinfo_failed"
        }
      });
    }
  }

  private static async tryGetPdfPageCountWithPdfJs(sourcePath: string): Promise<number | null> {
    const importAtRuntime = (new Function(
      "specifier",
      "return import(specifier);"
    ) as (specifier: string) => Promise<Record<string, unknown>>);
    let pdfjsModule: Record<string, unknown> | null = null;
    try {
      pdfjsModule = await importAtRuntime("pdfjs-dist/legacy/build/pdf.mjs");
    } catch {
      try {
        pdfjsModule = await importAtRuntime("pdfjs-dist");
      } catch {
        return null;
      }
    }
    try {
      const getDocumentCandidate = pdfjsModule.getDocument;
      if (typeof getDocumentCandidate !== "function") {
        throwStructuredError({
          code: "INTERNAL_ERROR",
          message: "Failed to determine PDF page count.",
          details: {
            sourcePath,
            reason: "pdfjs-dist getDocument API is unavailable."
          }
        });
      }
      const data = await readFile(sourcePath);
      const loadingTask = (
        getDocumentCandidate as (input: { data: Uint8Array; disableWorker: boolean }) => {
          promise: Promise<{ numPages: number }>;
        }
      )({
        data: new Uint8Array(data),
        disableWorker: true
      });
      const pdf = await loadingTask.promise;
      const pageCount = Math.floor(pdf.numPages);
      if (!Number.isInteger(pageCount) || pageCount < 1) {
        throwStructuredError({
          code: "INTERNAL_ERROR",
          message: "Failed to determine PDF page count.",
          details: {
            sourcePath,
            reason: "pdfjs-dist returned an invalid page count."
          }
        });
      }
      return pageCount;
    } catch (error) {
      if (isStructuredCoreError(error)) {
        throw error;
      }
      throwStructuredError({
        code: "INTERNAL_ERROR",
        message: "Failed to determine PDF page count.",
        details: {
          sourcePath,
          reason: error instanceof Error ? error.message : "pdfjs_failed"
        }
      });
    }
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

function isStructuredCoreError(error: unknown): error is { coreError: CoreError } {
  return typeof error === "object" && error !== null && "coreError" in error;
}

function resolvePdfPageRange0Based(
  sourcePath: string,
  pageCount: number,
  requestedRange: { from: number; to: number } | null
): { from: number; to: number; rangeClamped: boolean } {
  const suggestedRange0based = { from: 0, to: Math.max(0, pageCount - 1) };
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throwStructuredError({
      code: "INTERNAL_ERROR",
      message: "Failed to determine PDF page count.",
      details: {
        sourcePath,
        reason: "Resolved PDF page count is invalid."
      }
    });
  }
  if (requestedRange === null) {
    return { ...suggestedRange0based, rangeClamped: false };
  }
  const { from, to } = requestedRange;
  const maxPage = pageCount - 1;
  const clampedFrom = Math.max(0, Math.min(maxPage, from));
  const clampedTo = Math.max(clampedFrom, Math.max(0, Math.min(maxPage, to)));
  const rangeClamped = clampedFrom !== from || clampedTo !== to;
  return { from: clampedFrom, to: clampedTo, rangeClamped };
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
  const adaptive = await computeAdaptiveContentCrop(deskewed);
  const crop = adaptive.crop;
  const contentCropped =
    crop.bbox === null
      ? adaptive.processed
      : await sharp(adaptive.processed)
          .extract({
            left: crop.bbox.x,
            top: crop.bbox.y,
            width: crop.bbox.width,
            height: crop.bbox.height
          })
          .png()
          .toBuffer();
  const passportCrop = await computePassportForegroundCrop(contentCropped, crop.threshold);
  const passportTrimmed =
    passportCrop.bbox === null
      ? null
      : await trimPassportTailByDensity(contentCropped, passportCrop.bbox, passportCrop.threshold);
  const passportBbox = passportTrimmed ?? passportCrop.bbox;
  const cropped =
    passportBbox === null
      ? contentCropped
      : await sharp(contentCropped)
          .extract({
            left: passportBbox.x,
            top: passportBbox.y,
            width: passportBbox.width,
            height: passportBbox.height
          })
          .png()
          .toBuffer();
  const croppedMeta = await sharp(cropped).metadata();
  const finalWidth = Math.max(1, croppedMeta.width ?? 1);
  const finalHeight = Math.max(1, croppedMeta.height ?? 1);
  const preprocessing: NormalizedInput["preprocessing"] = {
    applied:
      orientation.rotationDeg !== 0 ||
      Math.abs(deskew) >= 0.05 ||
      crop.bbox !== null ||
      passportCrop.bbox !== null ||
      passportBbox !== null,
    selectedThreshold: crop.threshold,
    rotationDeg: orientation.rotationDeg,
    orientationScore: orientation.score,
    deskewAngleDeg: Number(deskew.toFixed(2)),
    blackPixelRatio: Number(crop.blackPixelRatio.toFixed(4)),
    thresholdStrategy: crop.thresholdStrategy,
    safeMode: crop.safeMode,
    retryCount: crop.retryCount,
    usedInvert: crop.usedInvert,
    finalThreshold: crop.threshold,
    finalBlackPixelRatio: Number(crop.blackPixelRatio.toFixed(4)),
    ...(crop.bbox === null
      ? {}
      : {
          cropBbox: {
            ...crop.bbox,
            page: 0
          }
        }),
    ...(crop.bbox === null
      ? {}
      : {
          content_bbox: {
            ...crop.bbox,
            page: 0
          }
        }),
    ...(passportBbox === null
      ? {}
      : {
          passport_bbox: {
            x: 0,
            y: 0,
            width: finalWidth,
            height: finalHeight,
            page: 0
          }
        }),
    ...(passportCrop.bbox === null
      ? {}
      : {
          passport_bbox_before_trim: {
            ...passportCrop.bbox,
            page: 0
          }
        }),
    ...(passportTrimmed === null
      ? {}
      : {
          passport_bbox_after_trim: {
            ...passportTrimmed,
            page: 0
          }
        }),
    applied_padding: passportCrop.padding,
    final_size: {
      width: finalWidth,
      height: finalHeight
    }
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

async function computePassportForegroundCrop(
  source: Buffer,
  thresholdHint: number
): Promise<{ bbox: Omit<RoiRect, "page"> | null; threshold: number; padding: number }> {
  const resized = await sharp(source)
    .resize({ width: 1600, withoutEnlargement: true })
    .grayscale()
    .median(1)
    .raw()
    .toBuffer({
      resolveWithObject: true
    });
  const { data, info } = resized;
  const all = Math.max(1, info.width * info.height);
  const dark240 = countBelowThreshold(data, 240);
  const threshold = thresholdHint >= 245 || dark240 / all > 0.09 ? 245 : 240;
  const largest = findLargestComponentBbox(data, info.width, info.height, threshold);
  if (largest === null) {
    return { bbox: null, threshold, padding: 0 };
  }
  const trimmed = trimBboxByDensity(data, info.width, info.height, threshold, largest);
  const projected = computeProjectionBbox(data, info.width, info.height, threshold);
  const target = chooseTighterPassportBox(largest, trimmed, projected);
  const componentAreaRatio = target.area / all;
  if (componentAreaRatio < 0.03) {
    return { bbox: null, threshold, padding: 0 };
  }
  const sourceMeta = await sharp(source).metadata();
  const fullW = Math.max(1, sourceMeta.width ?? info.width);
  const fullH = Math.max(1, sourceMeta.height ?? info.height);
  const scaleX = fullW / info.width;
  const scaleY = fullH / info.height;
  const rawLeft = Math.floor(target.x * scaleX);
  const rawTop = Math.floor(target.y * scaleY);
  const rawRight = Math.ceil((target.x + target.width) * scaleX);
  const rawBottom = Math.ceil((target.y + target.height) * scaleY);
  const padding = clampInt(Math.round(Math.min(fullW, fullH) * 0.012), 8, 44);
  const left = clampInt(rawLeft - padding, 0, fullW - 1);
  const top = clampInt(rawTop - padding, 0, fullH - 1);
  const right = clampInt(rawRight + padding, left + 1, fullW);
  const bottom = clampInt(rawBottom + padding, top + 1, fullH);
  const bbox = { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  const areaRatio = (bbox.width * bbox.height) / (fullW * fullH);
  if (areaRatio < 0.2 || areaRatio > 0.99) {
    return { bbox: null, threshold, padding };
  }
  return { bbox, threshold, padding };
}

async function trimPassportTailByDensity(
  source: Buffer,
  bbox: Omit<RoiRect, "page">,
  threshold: number
): Promise<Omit<RoiRect, "page">> {
  const raw = await sharp(source).grayscale().raw().toBuffer({ resolveWithObject: true });
  const imageW = Math.max(1, raw.info.width);
  const imageH = Math.max(1, raw.info.height);
  const left = clampInt(bbox.x, 0, imageW - 1);
  const top = clampInt(bbox.y, 0, imageH - 1);
  const right = clampInt(bbox.x + bbox.width - 1, left, imageW - 1);
  const bottom = clampInt(bbox.y + bbox.height - 1, top, imageH - 1);
  const localWidth = right - left + 1;
  const localHeight = bottom - top + 1;
  if (localWidth < 20 || localHeight < 20) {
    return bbox;
  }
  const densityEps = 0.002;
  const minColRun = clampInt(Math.round(imageW * 0.045), 100, 200);
  const minRowRun = clampInt(Math.round(imageH * 0.045), 100, 200);

  const trimRightCols = detectTrailingLowDensityRun({
    start: right,
    end: left,
    minRun: Math.min(minColRun, Math.floor(localWidth * 0.45)),
    sampleSize: localHeight,
    densityEps,
    measureDensity: (x) =>
      countDarkInColumn(raw.data, imageW, imageH, x, top, bottom, threshold) / Math.max(1, localHeight)
  });
  const trimBottomRows = detectTrailingLowDensityRun({
    start: bottom,
    end: top,
    minRun: Math.min(minRowRun, Math.floor(localHeight * 0.45)),
    sampleSize: localWidth,
    densityEps,
    measureDensity: (y) => countDarkInRow(raw.data, imageW, left, right, y, threshold) / Math.max(1, localWidth)
  });

  const trimmedRight = Math.max(left, right - trimRightCols);
  const trimmedBottom = Math.max(top, bottom - trimBottomRows);
  const trimmed = {
    x: left,
    y: top,
    width: Math.max(1, trimmedRight - left + 1),
    height: Math.max(1, trimmedBottom - top + 1)
  };
  if (trimmed.width < Math.round(localWidth * 0.55) || trimmed.height < Math.round(localHeight * 0.55)) {
    return bbox;
  }
  return trimmed;
}

function detectTrailingLowDensityRun(params: {
  start: number;
  end: number;
  minRun: number;
  sampleSize: number;
  densityEps: number;
  measureDensity: (index: number) => number;
}): number {
  const { start, end, minRun, densityEps, measureDensity } = params;
  if (minRun <= 0 || start <= end) {
    return 0;
  }
  let trailingRun = 0;
  for (let i = start; i >= end; i -= 1) {
    const density = measureDensity(i);
    if (density < densityEps) {
      trailingRun += 1;
      continue;
    }
    if (trailingRun >= minRun) {
      return trailingRun;
    }
    trailingRun = 0;
  }
  return trailingRun >= minRun ? trailingRun : 0;
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

async function computeAdaptiveContentCrop(source: Buffer): Promise<{
  processed: Buffer;
  crop: {
    bbox: Omit<RoiRect, "page"> | null;
    threshold: number;
    blackPixelRatio: number;
    thresholdStrategy: string;
    retryCount: number;
    usedInvert: boolean;
    safeMode: boolean;
  };
}> {
  const enhancedBase = await applyMildUnsharp(await applyClaheLikeStretch(source, 1));
  let processed = enhancedBase;
  let retryCount = 0;
  let usedInvert = false;

  let best = await evaluateAdaptiveCrop(processed, "otsu");
  let safeMode = best.blackPixelRatio > 0.35;

  // Retry path for under-inked scans.
  if (adaptiveThresholdRetryDecision(best.blackPixelRatio).mode === "contrast_boost") {
    processed = await applyMildUnsharp(await applyClaheLikeStretch(source, 1.35));
    best = await evaluateAdaptiveCrop(processed, "otsu_retry_contrast_boost");
    retryCount += 1;
  }

  // Retry path for over-inked scans: progressively lower threshold.
  if (adaptiveThresholdRetryDecision(best.blackPixelRatio).mode === "lower_threshold") {
    best = await lowerThresholdUntilTarget(processed, best, 6, safeMode ? "safe_mode_lower_threshold" : "lower_threshold");
    retryCount += best.thresholdStrategy.includes("iter_") ? extractRetryCount(best.thresholdStrategy) : 0;
  }

  // Safety branch for inverse/dark scans: evaluate negate, keep it only when ratio is closer to target.
  if (best.blackPixelRatio > 0.6) {
    const inverted = await sharp(processed).grayscale().negate().png().toBuffer();
    let invertedBest = await evaluateAdaptiveCrop(inverted, "otsu_invert");
    retryCount += 1;
    if (adaptiveThresholdRetryDecision(invertedBest.blackPixelRatio).mode === "lower_threshold") {
      invertedBest = await lowerThresholdUntilTarget(inverted, invertedBest, 6, "invert");
      retryCount += invertedBest.thresholdStrategy.includes("iter_")
        ? extractRetryCount(invertedBest.thresholdStrategy)
        : 0;
    }
    if (distanceToTargetRatio(invertedBest.blackPixelRatio) < distanceToTargetRatio(best.blackPixelRatio)) {
      best = invertedBest;
      usedInvert = true;
    }
  }

  safeMode = safeMode || best.blackPixelRatio > 0.35;
  return { processed, crop: { ...best, retryCount, usedInvert, safeMode } };
}

export function adaptiveThresholdRetryDecision(blackPixelRatio: number): {
  mode: "none" | "lower_threshold" | "contrast_boost";
} {
  if (blackPixelRatio > 0.35) {
    return { mode: "lower_threshold" };
  }
  if (blackPixelRatio < 0.01) {
    return { mode: "contrast_boost" };
  }
  return { mode: "none" };
}

function isTargetBlackPixelRatio(blackPixelRatio: number): boolean {
  return blackPixelRatio >= 0.03 && blackPixelRatio <= 0.25;
}

function distanceToTargetRatio(blackPixelRatio: number): number {
  if (isTargetBlackPixelRatio(blackPixelRatio)) return 0;
  if (blackPixelRatio < 0.03) return 0.03 - blackPixelRatio;
  return blackPixelRatio - 0.25;
}

function extractRetryCount(strategy: string): number {
  const match = strategy.match(/iter_(\d+)/u);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1] ?? "0", 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

async function lowerThresholdUntilTarget(
  source: Buffer,
  seed: {
    bbox: Omit<RoiRect, "page"> | null;
    threshold: number;
    blackPixelRatio: number;
    thresholdStrategy: string;
  },
  maxIterations: number,
  label = "lower_threshold"
): Promise<{
  bbox: Omit<RoiRect, "page"> | null;
  threshold: number;
  blackPixelRatio: number;
  thresholdStrategy: string;
}> {
  let best = seed;
  let threshold = seed.threshold;
  let iteration = 0;
  const step = label.includes("safe_mode") ? 25 : 15;
  while (iteration < maxIterations && threshold > 120 && !isTargetBlackPixelRatio(best.blackPixelRatio)) {
    if (best.blackPixelRatio <= 0.25) break;
    threshold = clampInt(threshold - step, 90, 245);
    const pass = await evaluateAdaptiveCrop(
      source,
      `${label}_iter_${iteration + 1}_t${threshold}`,
      threshold
    );
    best = pass;
    iteration += 1;
  }
  return best;
}

async function evaluateAdaptiveCrop(
  source: Buffer,
  thresholdStrategy: string,
  thresholdOverride?: number
): Promise<{
  bbox: Omit<RoiRect, "page"> | null;
  threshold: number;
  blackPixelRatio: number;
  thresholdStrategy: string;
}> {
  const resized = await sharp(source).resize({ width: 1800, withoutEnlargement: true }).grayscale().raw().toBuffer({
    resolveWithObject: true
  });
  const { data, info } = resized;
  const all = Math.max(1, info.width * info.height);
  const otsu = computeOtsuThreshold(data);
  const threshold = thresholdOverride === undefined ? otsu : clampInt(thresholdOverride, 90, 245);
  const blackPixelRatio = countBelowThreshold(data, threshold) / all;
  const bboxSmall = computeNonWhiteBboxFromRaw(data, info.width, info.height, threshold);
  if (bboxSmall === null) {
    return { bbox: null, threshold, blackPixelRatio, thresholdStrategy };
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
    return { bbox: null, threshold, blackPixelRatio, thresholdStrategy };
  }
  return { bbox: { x: left, y: top, width, height }, threshold, blackPixelRatio, thresholdStrategy };
}

async function applyClaheLikeStretch(source: Buffer, boost: number): Promise<Buffer> {
  const probe = await sharp(source).grayscale().raw().toBuffer({ resolveWithObject: true });
  const low = percentileByte(probe.data, 0.03);
  const high = percentileByte(probe.data, 0.97);
  const span = Math.max(12, high - low);
  const gain = clampNumber((255 / span) * boost, 0.9, 3.2);
  const bias = -low * gain;
  return sharp(source).grayscale().linear(gain, bias).png().toBuffer();
}

async function applyMildUnsharp(source: Buffer): Promise<Buffer> {
  return sharp(source).grayscale().sharpen(1, 0.8, 1.1).png().toBuffer();
}

function computeOtsuThreshold(data: Buffer): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i] ?? 0;
    hist[v] = (hist[v] ?? 0) + 1;
  }
  const total = data.length;
  if (total === 0) return 180;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * (hist[i] ?? 0);
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 180;
  for (let i = 0; i < 256; i += 1) {
    wB += hist[i] ?? 0;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * (hist[i] ?? 0);
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = i;
    }
  }
  return clampInt(threshold, 90, 245);
}

function percentileByte(data: Buffer, p: number): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i] ?? 0;
    hist[v] = (hist[v] ?? 0) + 1;
  }
  const target = Math.round(clampNumber(p, 0, 1) * Math.max(0, data.length - 1));
  let cumulative = 0;
  for (let i = 0; i < 256; i += 1) {
    cumulative += hist[i] ?? 0;
    if (cumulative > target) return i;
  }
  return 255;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

function findLargestComponentBbox(
  raw: Buffer,
  width: number,
  height: number,
  threshold: number
): (Omit<RoiRect, "page"> & { area: number }) | null {
  const total = width * height;
  if (total <= 0) {
    return null;
  }
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let best: (Omit<RoiRect, "page"> & { area: number }) | null = null;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (visited[idx] === 1) {
        continue;
      }
      visited[idx] = 1;
      if ((raw[idx] ?? 255) >= threshold) {
        continue;
      }
      let head = 0;
      let tail = 0;
      queue[tail] = idx;
      tail += 1;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      let area = 0;
      while (head < tail) {
        const current = queue[head] ?? 0;
        head += 1;
        const cx = current % width;
        const cy = Math.floor(current / width);
        area += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) {
              continue;
            }
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
              continue;
            }
            const nIdx = ny * width + nx;
            if (visited[nIdx] === 1) {
              continue;
            }
            visited[nIdx] = 1;
            if ((raw[nIdx] ?? 255) >= threshold) {
              continue;
            }
            queue[tail] = nIdx;
            tail += 1;
          }
        }
      }
      const component = {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        area
      };
      if (best === null || component.area > best.area) {
        best = component;
      }
    }
  }
  return best;
}

function trimBboxByDensity(
  raw: Buffer,
  width: number,
  height: number,
  threshold: number,
  bbox: Omit<RoiRect, "page"> & { area: number }
): (Omit<RoiRect, "page"> & { area: number }) | null {
  const minDarkPerCol = Math.max(2, Math.round(bbox.height * 0.01));
  const minDarkPerRow = Math.max(2, Math.round(bbox.width * 0.005));
  let left = bbox.x;
  let right = bbox.x + bbox.width - 1;
  let top = bbox.y;
  let bottom = bbox.y + bbox.height - 1;
  while (left < right && countDarkInColumn(raw, width, height, left, top, bottom, threshold) < minDarkPerCol) {
    left += 1;
  }
  while (right > left && countDarkInColumn(raw, width, height, right, top, bottom, threshold) < minDarkPerCol) {
    right -= 1;
  }
  while (top < bottom && countDarkInRow(raw, width, left, right, top, threshold) < minDarkPerRow) {
    top += 1;
  }
  while (bottom > top && countDarkInRow(raw, width, left, right, bottom, threshold) < minDarkPerRow) {
    bottom -= 1;
  }
  if (right <= left || bottom <= top) {
    return null;
  }
  return {
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1,
    area: (right - left + 1) * (bottom - top + 1)
  };
}

function computeProjectionBbox(
  raw: Buffer,
  width: number,
  height: number,
  threshold: number
): (Omit<RoiRect, "page"> & { area: number }) | null {
  const minDarkPerCol = Math.max(3, Math.round(height * 0.015));
  const minDarkPerRow = Math.max(3, Math.round(width * 0.007));
  let left = 0;
  let right = width - 1;
  let top = 0;
  let bottom = height - 1;
  while (left < right && countDarkInColumn(raw, width, height, left, 0, height - 1, threshold) < minDarkPerCol) {
    left += 1;
  }
  while (right > left && countDarkInColumn(raw, width, height, right, 0, height - 1, threshold) < minDarkPerCol) {
    right -= 1;
  }
  while (top < bottom && countDarkInRow(raw, width, left, right, top, threshold) < minDarkPerRow) {
    top += 1;
  }
  while (bottom > top && countDarkInRow(raw, width, left, right, bottom, threshold) < minDarkPerRow) {
    bottom -= 1;
  }
  if (right <= left || bottom <= top) {
    return null;
  }
  return {
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1,
    area: (right - left + 1) * (bottom - top + 1)
  };
}

function chooseTighterPassportBox(
  largest: Omit<RoiRect, "page"> & { area: number },
  trimmed: (Omit<RoiRect, "page"> & { area: number }) | null,
  projected: (Omit<RoiRect, "page"> & { area: number }) | null
): Omit<RoiRect, "page"> & { area: number } {
  const candidates = [largest, trimmed, projected].filter((item): item is Omit<RoiRect, "page"> & { area: number } =>
    item !== null
  );
  return candidates.sort((a, b) => a.area - b.area)[0] ?? largest;
}

function countDarkInColumn(
  raw: Buffer,
  width: number,
  height: number,
  x: number,
  top: number,
  bottom: number,
  threshold: number
): number {
  if (x < 0 || x >= width) {
    return 0;
  }
  let count = 0;
  const y1 = Math.max(0, top);
  const y2 = Math.min(height - 1, bottom);
  for (let y = y1; y <= y2; y += 1) {
    if ((raw[y * width + x] ?? 255) < threshold) {
      count += 1;
    }
  }
  return count;
}

function countDarkInRow(raw: Buffer, width: number, left: number, right: number, y: number, threshold: number): number {
  if (y < 0) {
    return 0;
  }
  let count = 0;
  const x1 = Math.max(0, left);
  const x2 = Math.max(x1, right);
  const row = y * width;
  for (let x = x1; x <= x2; x += 1) {
    if ((raw[row + x] ?? 255) < threshold) {
      count += 1;
    }
  }
  return count;
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
