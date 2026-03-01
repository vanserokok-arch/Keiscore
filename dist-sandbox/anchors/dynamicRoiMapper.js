import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
const PASSPORT_FIELDS = [
    "fio",
    "passport_number",
    "issued_by",
    "dept_code",
    "registration"
];
export class DynamicROIMapper {
    static async map(input, detection, calibration, anchors, logger, pageNumber) {
        const metadata = input.normalizedBuffer === null ? null : await sharp(input.normalizedBuffer).metadata();
        const width = Math.max(1, input.preprocessing?.final_size?.width ?? metadata?.width ?? input.width ?? calibration.alignedWidth);
        const height = Math.max(1, input.preprocessing?.final_size?.height ?? metadata?.height ?? input.height ?? calibration.alignedHeight);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            const coreError = {
                code: "DOCUMENT_NOT_DETECTED",
                message: "Cannot map ROI because normalized page dimensions are invalid.",
                details: {
                    width,
                    height,
                    source: input.fileName
                }
            };
            const structured = new Error(coreError.message);
            structured.coreError = coreError;
            throw structured;
        }
        const resolvedPageNumber = Number.isFinite(pageNumber)
            ? Math.max(0, Math.floor(pageNumber ?? 0))
            : Math.max(0, Math.floor((input.pages[0]?.pageNumber ?? 0)));
        const page = resolvedPageNumber;
        const anchorsMap = anchors.anchors;
        const lineHeight = Math.max(24, anchors.lineHeight || 40);
        const snapY = (y) => snapToTextLine(y, anchors.textLineYs, lineHeight);
        const makePercent = (x1, y1, x2, y2) => ({
            x: Math.round(width * x1),
            y: Math.round(height * y1),
            width: Math.round(width * (x2 - x1)),
            height: Math.round(height * (y2 - y1)),
            page
        });
        const anchor = (name) => anchorsMap[name.toUpperCase()];
        const fallbackReasons = [];
        const fioAnchor = anchor("ФАМИЛИЯ");
        const deptAnchor = anchor("КОД ПОДРАЗДЕЛЕНИЯ");
        const issuedAnchor = anchor("ВЫДАН");
        const registrationAnchor = anchor("МЕСТО ЖИТЕЛЬСТВА");
        const isSpreadPage = anchors.pageType === "spread_page";
        const fioRoi = isSpreadPage
            ? fioAnchor === undefined
                ? makePercent(0.2, 0.37, 0.74, 0.61)
                : {
                    x: Math.round(Math.max(width * 0.2, fioAnchor.x + lineHeight * 1.6)),
                    y: Math.round(Math.max(height * 0.35, fioAnchor.y - lineHeight * 0.1)),
                    width: Math.round(Math.min(width * 0.54, lineHeight * 22)),
                    height: Math.round(Math.max(lineHeight * 6.2, height * 0.17)),
                    page
                }
            : fioAnchor === undefined
                ? makePercent(0.18, 0.36, 0.88, 0.56)
                : {
                    x: fioAnchor.x,
                    y: fioAnchor.y,
                    width: Math.round(width * 0.7),
                    height: Math.round(lineHeight * 3),
                    page
                };
        if (fioAnchor === undefined)
            fallbackReasons.push("fio_anchor_missing");
        const passportNumberRoi = isSpreadPage
            ? deptAnchor === undefined
                ? makePercent(0.61, 0.2, 0.95, 0.35)
                : {
                    x: Math.round(Math.max(width * 0.58, deptAnchor.x + lineHeight * 1.9)),
                    y: snapY(Math.round(Math.max(height * 0.1, Math.min(height * 0.3, deptAnchor.y - lineHeight * 5.1)))),
                    width: Math.round(Math.max(width * 0.32, lineHeight * 9.8)),
                    height: Math.round(lineHeight * 2.6),
                    page
                }
            : deptAnchor === undefined
                ? makePercent(0.55, 0.04, 0.92, 0.18)
                : {
                    x: Math.round(deptAnchor.x + lineHeight * 2.2),
                    y: Math.max(0, Math.round(deptAnchor.y - lineHeight * 2.1)),
                    width: Math.round(width * 0.3),
                    height: Math.round(lineHeight * 1.7),
                    page
                };
        if (deptAnchor === undefined)
            fallbackReasons.push("dept_anchor_missing_for_passport_number");
        const deptCodeRoi = isSpreadPage
            ? deptAnchor === undefined
                ? makePercent(0.63, 0.36, 0.9, 0.47)
                : {
                    x: Math.round(Math.max(width * 0.6, deptAnchor.x + lineHeight * 6.4)),
                    y: snapY(Math.round(Math.max(height * 0.34, deptAnchor.y + lineHeight * 0.6))),
                    width: Math.round(lineHeight * 8.8),
                    height: Math.round(lineHeight * 1.8),
                    page
                }
            : deptAnchor === undefined
                ? makePercent(0.42, 0.52, 0.7, 0.62)
                : {
                    x: Math.round(deptAnchor.x + lineHeight * 4.2),
                    y: deptAnchor.y,
                    width: Math.round(lineHeight * 5.2),
                    height: Math.round(lineHeight * 1.2),
                    page
                };
        const issuedByRoi = makePercent(0.45, 0.34, 0.97, 0.58);
        if (issuedAnchor === undefined)
            fallbackReasons.push("issued_anchor_missing");
        const registrationRoi = anchors.pageType === "registration_page"
            ? registrationAnchor === undefined
                ? makePercent(0.08, 0.32, 0.92, 0.92)
                : {
                    x: Math.round(width * 0.08),
                    y: Math.round(registrationAnchor.y + lineHeight * 1.1),
                    width: Math.round(width * 0.84),
                    height: Math.round(height - (registrationAnchor.y + lineHeight * 1.3)),
                    page
                }
            : makePercent(0.08, 0.78, 0.92, 0.94);
        if (anchors.pageType === "registration_page" && registrationAnchor === undefined) {
            fallbackReasons.push("registration_anchor_missing");
        }
        const anchorKeys = Object.keys(anchors.anchors);
        const roiMapperContext = {
            pageType: anchors.pageType,
            usedFallbackGrid: anchors.usedFallbackGrid,
            anchorKeys,
            ...(anchors.textLineYs === undefined ? {} : { textLineYs: anchors.textLineYs })
        };
        const rawRois = [
            { field: "fio", roi: fioRoi, _roiMapperContext: roiMapperContext },
            { field: "passport_number", roi: passportNumberRoi, _roiMapperContext: roiMapperContext },
            { field: "issued_by", roi: issuedByRoi, _roiMapperContext: roiMapperContext },
            { field: "dept_code", roi: deptCodeRoi, _roiMapperContext: roiMapperContext },
            { field: "registration", roi: registrationRoi, _roiMapperContext: roiMapperContext }
        ];
        const rois = rawRois.map((fieldRoi) => ({
            ...fieldRoi,
            roi: clampRoiWithAudit(fieldRoi.roi, width, height).roi
        }));
        const roiAudits = rawRois.map((fieldRoi) => ({
            field: fieldRoi.field,
            ...clampRoiWithAudit(fieldRoi.roi, width, height).audit
        }));
        const worstRoiMargin = roiAudits.reduce((acc, item) => ({
            minX: Math.min(acc.minX, item.marginsBeforeClamp.minX),
            minY: Math.min(acc.minY, item.marginsBeforeClamp.minY),
            maxX: Math.max(acc.maxX, item.marginsBeforeClamp.maxX),
            maxY: Math.max(acc.maxY, item.marginsBeforeClamp.maxY)
        }), {
            minX: Number.POSITIVE_INFINITY,
            minY: Number.POSITIVE_INFINITY,
            maxX: Number.NEGATIVE_INFINITY,
            maxY: Number.NEGATIVE_INFINITY
        });
        for (const fieldRoi of rawRois) {
            const clamped = clampRoiWithAudit(fieldRoi.roi, width, height);
            logger.log({
                ts: Date.now(),
                stage: "roi-mapper",
                level: "info",
                message: "Field ROI mapped.",
                data: {
                    field: fieldRoi.field,
                    roi: clamped.roi,
                    roiRaw: fieldRoi.roi,
                    outOfBoundsBeforeClamp: clamped.audit.outOfBoundsBeforeClamp,
                    clampApplied: clamped.audit.clampApplied,
                    roiArea: clamped.audit.areaAfterClamp,
                    pageType: anchors.pageType,
                    usedFallbackGrid: anchors.usedFallbackGrid,
                    anchorKeys
                }
            });
        }
        logger.log({
            ts: Date.now(),
            stage: "dynamic-roi-mapper",
            level: "info",
            message: "ROI mapping completed.",
            data: {
                detected: detection.detected,
                transform: calibration.transform,
                anchorCount: Object.keys(anchors.anchors).length,
                source: input.fileName,
                pageType: anchors.pageType,
                layout: { width, height },
                finalCanvas: { x: 0, y: 0, width, height },
                fallbackReasons,
                worstRoiMargin,
                roiAudits,
                rois
            }
        });
        return rois.filter((roi) => PASSPORT_FIELDS.includes(roi.field));
    }
    static async attachRoiImagePaths(input, rois, logger) {
        if (input.normalizedBuffer === null) {
            return rois;
        }
        const normalizedBuffer = input.normalizedBuffer;
        const tmpBase = await mkdtemp(join(tmpdir(), "keiscore-roi-"));
        const debugRoiDir = process.env.KEISCORE_DEBUG_ROI_DIR;
        try {
            if (debugRoiDir) {
                await mkdir(debugRoiDir, { recursive: true });
            }
            const mapped = await Promise.all(rois.map(async (fieldRoi) => {
                const fieldRoiWithContext = fieldRoi;
                const roiFilePath = join(tmpBase, `${fieldRoi.field}-${fieldRoi.roi.x}-${fieldRoi.roi.y}-${fieldRoi.roi.width}-${fieldRoi.roi.height}.png`);
                await sharp(normalizedBuffer)
                    .extract({
                    left: fieldRoi.roi.x,
                    top: fieldRoi.roi.y,
                    width: Math.max(1, fieldRoi.roi.width),
                    height: Math.max(1, fieldRoi.roi.height)
                })
                    .png()
                    .toFile(roiFilePath);
                const mappedFieldRoi = {
                    ...fieldRoiWithContext,
                    roiImagePath: roiFilePath
                };
                if (debugRoiDir) {
                    const debugPath = join(debugRoiDir, `${Date.now()}_${mappedFieldRoi.roi.page}_${mappedFieldRoi.field}.png`);
                    try {
                        await copyFile(roiFilePath, debugPath);
                    }
                    catch {
                        // debug copy is best-effort, skip on mocked/non-materialized files
                    }
                    logger.log({
                        ts: Date.now(),
                        stage: "roi-mapper",
                        level: "info",
                        message: "ROI debug copy written.",
                        data: {
                            field: mappedFieldRoi.field,
                            page: mappedFieldRoi.roi.page,
                            debugPath
                        }
                    });
                }
                const context = fieldRoiWithContext._roiMapperContext;
                logger.log({
                    ts: Date.now(),
                    stage: "roi-mapper",
                    level: "info",
                    message: "ROI crop created.",
                    data: {
                        field: mappedFieldRoi.field,
                        pageType: context?.pageType,
                        usedFallbackGrid: context?.usedFallbackGrid,
                        roi: mappedFieldRoi.roi,
                        roiImagePath: mappedFieldRoi.roiImagePath,
                        anchorKeys: context?.anchorKeys
                    }
                });
                return mappedFieldRoi;
            }));
            logger.log({
                ts: Date.now(),
                stage: "dynamic-roi-mapper",
                level: "debug",
                message: "ROI image crops prepared.",
                data: { cropCount: mapped.length }
            });
            if (debugRoiDir) {
                const pageRoisMap = new Map();
                for (const mappedRoi of mapped) {
                    const pageRois = pageRoisMap.get(mappedRoi.roi.page) ?? [];
                    pageRois.push(mappedRoi);
                    pageRoisMap.set(mappedRoi.roi.page, pageRois);
                }
                const pageMetadata = await sharp(normalizedBuffer).metadata();
                const pageWidth = Math.max(1, pageMetadata.width ?? 1);
                const pageHeight = Math.max(1, pageMetadata.height ?? 1);
                await Promise.all(Array.from(pageRoisMap.entries()).map(async ([page, pageRois]) => {
                    const ts = Date.now();
                    const pagePath = join(debugRoiDir, `${ts}_${page}_page.png`);
                    const overlayPath = join(debugRoiDir, `${ts}_${page}_overlay.png`);
                    try {
                        await sharp(normalizedBuffer).png().toFile(pagePath);
                        const overlaySvg = buildRoiOverlaySvg(pageWidth, pageHeight, pageRois);
                        await sharp(normalizedBuffer)
                            .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
                            .png()
                            .toFile(overlayPath);
                    }
                    catch {
                        // Best-effort debug rendering; skip in mocked/shimmed sharp environments.
                        return;
                    }
                    logger.log({
                        ts: Date.now(),
                        stage: "roi-mapper",
                        level: "info",
                        message: "ROI overlay written.",
                        data: {
                            page,
                            overlayPath,
                            pagePath,
                            rois: pageRois.map((roi) => ({
                                field: roi.field,
                                x: roi.roi.x,
                                y: roi.roi.y,
                                width: roi.roi.width,
                                height: roi.roi.height
                            }))
                        }
                    });
                }));
            }
            return mapped;
        }
        catch (error) {
            await rm(tmpBase, { recursive: true, force: true });
            throw error;
        }
    }
    static async cleanupRoiImagePaths(rois) {
        const rootPath = rois.find((roi) => roi.roiImagePath !== undefined)?.roiImagePath;
        if (rootPath === undefined) {
            return;
        }
        const marker = `${join(tmpdir(), "keiscore-roi-")}`;
        if (!rootPath.startsWith(marker)) {
            return;
        }
        const roiDir = dirname(rootPath);
        await rm(roiDir, { recursive: true, force: true });
    }
}
function clampRoi(roi, maxWidth, maxHeight) {
    const minX = 0;
    const minY = 0;
    const maxX = maxWidth - 1;
    const maxY = maxHeight - 1;
    const x = clamp(Math.round(roi.x), minX, maxX);
    const y = clamp(Math.round(roi.y), minY, maxY);
    const maxRoiWidth = Math.max(1, maxX - x + 1);
    const maxRoiHeight = Math.max(1, maxY - y + 1);
    return {
        x,
        y,
        width: clamp(Math.round(roi.width), 1, maxRoiWidth),
        height: clamp(Math.round(roi.height), 1, maxRoiHeight),
        page: roi.page
    };
}
function clampRoiWithAudit(roi, maxWidth, maxHeight) {
    const minX = Math.round(roi.x);
    const minY = Math.round(roi.y);
    const maxX = minX + Math.max(1, Math.round(roi.width));
    const maxY = minY + Math.max(1, Math.round(roi.height));
    const outOfBoundsBeforeClamp = minX < 0 || minY < 0 || maxX > maxWidth || maxY > maxHeight;
    const clamped = clampRoi(roi, maxWidth, maxHeight);
    const clampApplied = clamped.x !== Math.round(roi.x) ||
        clamped.y !== Math.round(roi.y) ||
        clamped.width !== Math.max(1, Math.round(roi.width)) ||
        clamped.height !== Math.max(1, Math.round(roi.height));
    return {
        roi: clamped,
        audit: {
            outOfBoundsBeforeClamp,
            clampApplied,
            areaBeforeClamp: Math.max(1, Math.round(roi.width)) * Math.max(1, Math.round(roi.height)),
            areaAfterClamp: clamped.width * clamped.height,
            marginsBeforeClamp: { minX, minY, maxX, maxY }
        }
    };
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
function buildRoiOverlaySvg(width, height, rois) {
    const colors = ["#ff1744", "#00b0ff", "#00c853", "#ff9100", "#aa00ff", "#d500f9", "#00e5ff"];
    const canvasRect = `<rect x="0" y="0" width="${Math.max(1, width - 1)}" height="${Math.max(1, height - 1)}" fill="transparent" stroke="#fdd835" stroke-width="3" />`;
    const roiElements = rois
        .map((fieldRoi, index) => {
        const color = colors[index % colors.length];
        const roiWidth = Math.max(1, fieldRoi.roi.width);
        const roiHeight = Math.max(1, fieldRoi.roi.height);
        const labelX = fieldRoi.roi.x + 4;
        const labelY = Math.max(14, fieldRoi.roi.y - 4);
        const label = escapeSvgText(fieldRoi.field);
        return [
            `<rect x="${fieldRoi.roi.x}" y="${fieldRoi.roi.y}" width="${roiWidth}" height="${roiHeight}" fill="transparent" stroke="${color}" stroke-width="2" />`,
            `<text x="${labelX}" y="${labelY}" fill="${color}" font-family="Arial, sans-serif" font-size="14" font-weight="700">${label}</text>`
        ].join("");
    })
        .join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${canvasRect}${roiElements}</svg>`;
}
function escapeSvgText(input) {
    return input
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}
function snapToTextLine(y, textLineYs, lineHeight) {
    if (textLineYs === undefined || textLineYs.length === 0) {
        return y;
    }
    let best = textLineYs[0] ?? y;
    let bestDelta = Math.abs(best - y);
    for (const lineY of textLineYs) {
        const delta = Math.abs(lineY - y);
        if (delta < bestDelta) {
            best = lineY;
            bestDelta = delta;
        }
    }
    if (bestDelta > lineHeight * 1.25) {
        return y;
    }
    return best;
}
//# sourceMappingURL=dynamicRoiMapper.js.map