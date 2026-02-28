import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { DynamicROIMapper } from "../anchors/dynamicRoiMapper.js";
import { TesseractEngine } from "../engines/tesseractEngine.js";
import { FormatNormalizer } from "../format/formatNormalizer.js";
import { InMemoryAuditLogger } from "../types.js";
async function commandExists(command) {
    try {
        await execa(command, ["--version"], { timeout: 3_000 });
        return true;
    }
    catch {
        return false;
    }
}
function buildPdfWithText(text) {
    const stream = `BT
/F1 24 Tf
36 140 Td
(${text}) Tj
ET`;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    ];
    let out = "%PDF-1.4\n";
    const offsets = [0];
    for (let i = 0; i < objects.length; i += 1) {
        offsets.push(Buffer.byteLength(out, "utf8"));
        out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const startXref = Buffer.byteLength(out, "utf8");
    out += `xref
0 ${objects.length + 1}
0000000000 65535 f 
`;
    for (let i = 1; i < offsets.length; i += 1) {
        out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    out += `trailer
<< /Size ${objects.length + 1} /Root 1 0 R >>
startxref
${startXref}
%%EOF`;
    return Buffer.from(out, "utf8");
}
function buildThreePagePdfWithText(texts) {
    const pageObjects = [];
    const contentObjects = [];
    for (const text of texts) {
        const stream = `BT
/F1 24 Tf
36 140 Td
(${text}) Tj
ET`;
        contentObjects.push(`<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`);
    }
    // Object numbering: 1 catalog, 2 pages, pages 3..5, contents 6..8, font 9
    for (let index = 0; index < texts.length; index += 1) {
        pageObjects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 9 0 R >> >> /Contents ${6 + index} 0 R >>`);
    }
    const kids = "[3 0 R 4 0 R 5 0 R]";
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        `<< /Type /Pages /Kids ${kids} /Count 3 >>`,
        ...pageObjects,
        ...contentObjects,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    ];
    let out = "%PDF-1.4\n";
    const offsets = [0];
    for (let i = 0; i < objects.length; i += 1) {
        offsets.push(Buffer.byteLength(out, "utf8"));
        out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const startXref = Buffer.byteLength(out, "utf8");
    out += `xref
0 ${objects.length + 1}
0000000000 65535 f 
`;
    for (let i = 1; i < offsets.length; i += 1) {
        out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    out += `trailer
<< /Size ${objects.length + 1} /Root 1 0 R >>
startxref
${startXref}
%%EOF`;
    return Buffer.from(out, "utf8");
}
describe("optional real binary integration", () => {
    const shouldRun = process.env.RUN_OPTIONAL_INTEGRATION === "1";
    it.skipIf(!shouldRun)("renders PDF and OCRs ROI with local binaries", async () => {
        const hasTesseract = await commandExists("tesseract");
        const hasPdftoppm = await commandExists("pdftoppm");
        if (!hasTesseract || !hasPdftoppm) {
            return;
        }
        const tempDir = await mkdtemp(join(tmpdir(), "keiscore-integration-"));
        const pdfPath = join(tempDir, "sample.pdf");
        try {
            await writeFile(pdfPath, buildPdfWithText("HELLO 770-001"));
            const normalized = await FormatNormalizer.normalize({ kind: "path", path: pdfPath }, {}, new InMemoryAuditLogger());
            expect(normalized.kind).toBe("pdf");
            expect(normalized.normalizedBuffer).not.toBeNull();
            const rois = await DynamicROIMapper.attachRoiImagePaths(normalized, [{ field: "dept_code", roi: { x: 0, y: 0, width: 500, height: 250, page: 0 } }], new InMemoryAuditLogger());
            const roi = rois[0];
            expect(roi).toBeDefined();
            const candidate = await TesseractEngine.runOcrOnRoi(roi, normalized, "eng", "A", 8_000);
            expect(candidate === null || typeof candidate.text === "string").toBe(true);
            await DynamicROIMapper.cleanupRoiImagePaths(rois);
        }
        finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });
    it.skipIf(!shouldRun)("renders PDF using page range 2..3 with extended timeout", async () => {
        const hasPdftoppm = await commandExists("pdftoppm");
        if (!hasPdftoppm) {
            return;
        }
        const tempDir = await mkdtemp(join(tmpdir(), "keiscore-integration-"));
        const pdfPath = join(tempDir, "sample-3-pages.pdf");
        try {
            await writeFile(pdfPath, buildThreePagePdfWithText(["PAGE-1", "PAGE-2", "PAGE-3"]));
            const normalized = await FormatNormalizer.normalize({ kind: "path", path: pdfPath }, { pdfPageRange: { from: 2, to: 3 }, pdfRenderTimeoutMs: 120_000 }, new InMemoryAuditLogger());
            expect(normalized.kind).toBe("pdf");
            expect(normalized.pages.length).toBe(2);
            expect(normalized.pages[0]?.pageNumber).toBe(2);
            expect(normalized.pages[1]?.pageNumber).toBe(3);
            expect(normalized.pages.every((page) => page.width > 0 && page.height > 0)).toBe(true);
            await FormatNormalizer.cleanupPdfPageArtifacts(normalized);
        }
        finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=pipeline.integration.spec.js.map