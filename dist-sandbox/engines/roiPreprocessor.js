import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
const DEFAULT_PADDING_RATIO = 0.07;
const RETRY_PADDING_RATIO = 0.15;
const MIN_WIDTH = 1200;
export async function preprocessRoiForOcr(inputPath) {
    return preprocessRoiForOcrWithConfig(inputPath, {});
}
export async function preprocessRoiForOcrWithConfig(inputPath, config) {
    const paddingRatio = clampPaddingRatio(config.extraPaddingRatio ?? DEFAULT_PADDING_RATIO);
    const tmpBase = await mkdtemp(join(tmpdir(), "keiscore-pre-ocr-"));
    const outPath = join(tmpBase, `pre_${basename(inputPath)}`);
    const source = sharp(inputPath);
    const sourceMeta = await source.metadata();
    const sourceWidth = Math.max(1, sourceMeta.width ?? 1);
    const sourceHeight = Math.max(1, sourceMeta.height ?? 1);
    const paddedBounds = withPadding({ left: 0, top: 0, width: sourceWidth, height: sourceHeight }, sourceWidth, sourceHeight, paddingRatio);
    const preThresholdBuffer = await sharp(inputPath)
        .extract(paddedBounds)
        .grayscale()
        .resize({
        width: computeTargetWidth(config.field, paddedBounds.width),
        withoutEnlargement: false,
        fit: "contain",
        background: { r: 255, g: 255, b: 255 }
    })
        .png()
        .toBuffer();
    const processedBuffer = isNarrowTextField(config.field)
        ? await adaptiveThreshold(preThresholdBuffer)
        : await softTextEnhance(preThresholdBuffer);
    const croppedBuffer = await autoCropNonWhite(processedBuffer);
    let pipeline = sharp(croppedBuffer);
    if (isNarrowTextField(config.field)) {
        const narrowed = await centerAndIncreaseHeight(croppedBuffer);
        pipeline = sharp(narrowed);
    }
    const finalBuffer = await pipeline.png().toBuffer();
    await sharp(finalBuffer).png().toFile(outPath);
    const debugRoiDir = process.env.KEISCORE_DEBUG_ROI_DIR;
    if (debugRoiDir !== undefined && debugRoiDir.trim() !== "") {
        await mkdir(debugRoiDir, { recursive: true });
        const suffix = config.field === undefined ? basename(inputPath) : `post_${config.field}.png`;
        const debugPath = join(debugRoiDir, `${Date.now()}_${suffix}`);
        try {
            await copyFile(outPath, debugPath);
        }
        catch {
            // Best-effort debug copy; keep OCR flow unaffected in mocked environments.
        }
    }
    config.logger?.log({
        ts: Date.now(),
        stage: "ocr-preprocess",
        level: "info",
        message: "ROI preprocessing applied.",
        data: {
            inputPath,
            outputPath: outPath,
            paddingRatio,
            minWidth: MIN_WIDTH,
            grayscale: true,
            adaptiveThreshold: isNarrowTextField(config.field),
            sharpen: isNarrowTextField(config.field) ? "strong-local" : "soft-global",
            denoise: isNarrowTextField(config.field) ? "none" : "median-1",
            autoCropNonWhite: true,
            narrowTextBoost: isNarrowTextField(config.field)
        }
    });
    return outPath;
}
export async function preprocessMrz(roi) {
    const meta = await sharp(roi).metadata();
    const width = Math.max(1, meta.width ?? 1);
    const scaleFactor = width >= 1200 ? 2 : 3;
    const resized = await sharp(roi)
        .grayscale()
        .resize({
        width: Math.max(width * scaleFactor, 1800),
        withoutEnlargement: false,
        fit: "contain",
        background: { r: 255, g: 255, b: 255 }
    })
        .median(1)
        .png()
        .toBuffer();
    const thresholded = await adaptiveThresholdWithConfig(resized, 0.02, 7);
    return sharp(thresholded)
        .sharpen({ sigma: 0.9, m1: 0.65, m2: 1.05 })
        .png()
        .toBuffer();
}
function clampPaddingRatio(value) {
    const ratio = Number.isFinite(value) ? value : DEFAULT_PADDING_RATIO;
    if (ratio < 0) {
        return 0;
    }
    if (ratio > 0.4) {
        return 0.4;
    }
    return ratio;
}
function withPadding(bounds, maxWidth, maxHeight, paddingRatio) {
    const padX = Math.round(bounds.width * paddingRatio);
    const padY = Math.round(bounds.height * paddingRatio);
    const left = clamp(bounds.left - padX, 0, maxWidth - 1);
    const top = clamp(bounds.top - padY, 0, maxHeight - 1);
    const right = clamp(bounds.left + bounds.width + padX, left + 1, maxWidth);
    const bottom = clamp(bounds.top + bounds.height + padY, top + 1, maxHeight);
    return {
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top)
    };
}
async function autoCropNonWhite(buffer) {
    let width = 1;
    let height = 1;
    let raw;
    try {
        const image = sharp(buffer).grayscale();
        const meta = await image.metadata();
        width = Math.max(1, meta.width ?? 1);
        height = Math.max(1, meta.height ?? 1);
        raw = await image.raw().toBuffer();
    }
    catch {
        return buffer;
    }
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    const threshold = 244;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const pixel = raw[y * width + x] ?? 255;
            if (pixel < threshold) {
                if (x < minX)
                    minX = x;
                if (y < minY)
                    minY = y;
                if (x > maxX)
                    maxX = x;
                if (y > maxY)
                    maxY = y;
            }
        }
    }
    if (maxX <= minX || maxY <= minY) {
        return buffer;
    }
    const cropLeft = clamp(minX - 8, 0, width - 1);
    const cropTop = clamp(minY - 8, 0, height - 1);
    const cropRight = clamp(maxX + 8, cropLeft + 1, width);
    const cropBottom = clamp(maxY + 8, cropTop + 1, height);
    return sharp(buffer)
        .extract({
        left: cropLeft,
        top: cropTop,
        width: Math.max(1, cropRight - cropLeft),
        height: Math.max(1, cropBottom - cropTop)
    })
        .png()
        .toBuffer();
}
async function centerAndIncreaseHeight(buffer) {
    try {
        const meta = await sharp(buffer).metadata();
        const width = Math.max(1, meta.width ?? MIN_WIDTH);
        const height = Math.max(1, meta.height ?? Math.round(width * 0.2));
        const targetHeight = Math.max(height, Math.round(height * 1.8));
        const background = sharp({
            create: {
                width,
                height: targetHeight,
                channels: 3,
                background: { r: 255, g: 255, b: 255 }
            }
        });
        const top = Math.max(0, Math.floor((targetHeight - height) / 2));
        return background
            .composite([{ input: buffer, top, left: 0 }])
            .grayscale()
            .png()
            .toBuffer();
    }
    catch {
        return buffer;
    }
}
async function adaptiveThreshold(buffer) {
    return adaptiveThresholdWithConfig(buffer, 0.03, 9);
}
async function adaptiveThresholdWithConfig(buffer, radiusRatio, thresholdDelta) {
    let width = 1;
    let height = 1;
    let src;
    try {
        const image = sharp(buffer).grayscale();
        const meta = await image.metadata();
        width = Math.max(1, meta.width ?? 1);
        height = Math.max(1, meta.height ?? 1);
        src = await image.raw().toBuffer();
    }
    catch {
        return sharp(buffer).grayscale().png().toBuffer();
    }
    const sharpened = applySlightSharpen(src, width, height);
    const integral = new Uint32Array((width + 1) * (height + 1));
    for (let y = 1; y <= height; y += 1) {
        let rowSum = 0;
        for (let x = 1; x <= width; x += 1) {
            const pixel = sharpened[(y - 1) * width + (x - 1)] ?? 255;
            rowSum += pixel;
            const idx = y * (width + 1) + x;
            integral[idx] = (integral[idx - (width + 1)] ?? 0) + rowSum;
        }
    }
    const windowRadius = Math.max(8, Math.round(Math.min(width, height) * radiusRatio));
    const out = Buffer.alloc(width * height, 255);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const x1 = clamp(x - windowRadius, 0, width - 1);
            const y1 = clamp(y - windowRadius, 0, height - 1);
            const x2 = clamp(x + windowRadius, 0, width - 1);
            const y2 = clamp(y + windowRadius, 0, height - 1);
            const area = Math.max(1, (x2 - x1 + 1) * (y2 - y1 + 1));
            const sum = (integral[(y2 + 1) * (width + 1) + (x2 + 1)] ?? 0) -
                (integral[y1 * (width + 1) + (x2 + 1)] ?? 0) -
                (integral[(y2 + 1) * (width + 1) + x1] ?? 0) +
                (integral[y1 * (width + 1) + x1] ?? 0);
            const localMean = sum / area;
            const value = sharpened[y * width + x] ?? 255;
            out[y * width + x] = value < localMean - thresholdDelta ? 0 : 255;
        }
    }
    return sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer();
}
async function softTextEnhance(buffer) {
    try {
        return await sharp(buffer).grayscale().median(1).sharpen({ sigma: 0.95, m1: 0.7, m2: 1.05 }).png().toBuffer();
    }
    catch {
        return sharp(buffer).grayscale().png().toBuffer();
    }
}
function applySlightSharpen(src, width, height) {
    const out = Buffer.from(src);
    for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
            const centerIdx = y * width + x;
            const center = src[centerIdx] ?? 255;
            const top = src[(y - 1) * width + x] ?? center;
            const bottom = src[(y + 1) * width + x] ?? center;
            const left = src[y * width + (x - 1)] ?? center;
            const right = src[y * width + (x + 1)] ?? center;
            const sharpened = clamp(Math.round(center * 1.25 - (top + bottom + left + right) * 0.0625), 0, 255);
            out[centerIdx] = sharpened;
        }
    }
    return out;
}
function isNarrowTextField(field) {
    return field === "passport_number" || field === "dept_code";
}
function computeTargetWidth(field, sourceWidth) {
    if (field === "passport_number") {
        return Math.max(1800, sourceWidth * 3);
    }
    if (field === "dept_code") {
        return Math.max(1600, sourceWidth * 2);
    }
    return Math.max(MIN_WIDTH, sourceWidth);
}
function clamp(value, min, max) {
    if (value < min) {
        return min;
    }
    if (value > max) {
        return max;
    }
    return value;
}
export const RETRY_ROI_PADDING_RATIO = RETRY_PADDING_RATIO;
//# sourceMappingURL=roiPreprocessor.js.map