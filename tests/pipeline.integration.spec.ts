import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { DynamicROIMapper } from "../anchors/dynamicRoiMapper.js";
import { TesseractEngine } from "../engines/tesseractEngine.js";
import { FormatNormalizer } from "../format/formatNormalizer.js";
import { extractRfInternalPassport } from "../index.js";
import { InMemoryAuditLogger } from "../types.js";

async function commandExists(command: string): Promise<boolean> {
  try {
    await execa(command, ["--version"], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

function buildPdfWithText(text: string): Buffer {
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
  const offsets: number[] = [0];
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

function buildThreePagePdfWithText(texts: [string, string, string]): Buffer {
  const pageObjects: string[] = [];
  const contentObjects: string[] = [];
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
    pageObjects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 9 0 R >> >> /Contents ${
        6 + index
      } 0 R >>`
    );
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
  const offsets: number[] = [0];
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
      const normalized = await FormatNormalizer.normalize(
        { kind: "path", path: pdfPath },
        {},
        new InMemoryAuditLogger()
      );
      expect(normalized.kind).toBe("pdf");
      expect(normalized.normalizedBuffer).not.toBeNull();

      const rois = await DynamicROIMapper.attachRoiImagePaths(
        normalized,
        [{ field: "dept_code", roi: { x: 0, y: 0, width: 500, height: 250, page: 0 } }],
        new InMemoryAuditLogger()
      );
      const roi = rois[0];
      expect(roi).toBeDefined();
      const candidate = await TesseractEngine.runOcrOnRoi(roi!, normalized, "eng", "A", 8_000);

      expect(candidate === null || typeof candidate.text === "string").toBe(true);
      await DynamicROIMapper.cleanupRoiImagePaths(rois);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!shouldRun)("renders PDF using 0-based page range 1..2 with extended timeout", async () => {
    const hasPdftoppm = await commandExists("pdftoppm");
    if (!hasPdftoppm) {
      return;
    }
    const tempDir = await mkdtemp(join(tmpdir(), "keiscore-integration-"));
    const pdfPath = join(tempDir, "sample-3-pages.pdf");
    try {
      await writeFile(pdfPath, buildThreePagePdfWithText(["PAGE-1", "PAGE-2", "PAGE-3"]));
      const normalized = await FormatNormalizer.normalize(
        { kind: "path", path: pdfPath },
        { pdfPageRange: { from: 1, to: 2 }, pdfRenderTimeoutMs: 120_000 },
        new InMemoryAuditLogger()
      );
      expect(normalized.kind).toBe("pdf");
      expect(normalized.pages.length).toBe(2);
      expect(normalized.pages[0]?.pageNumber).toBe(1);
      expect(normalized.pages[1]?.pageNumber).toBe(2);
      expect(normalized.pages.every((page) => page.width > 0 && page.height > 0)).toBe(true);
      await FormatNormalizer.cleanupPdfPageArtifacts(normalized);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!shouldRun)("extractor audit logs normalized pages for pdfPageRange", async () => {
    const hasPdftoppm = await commandExists("pdftoppm");
    if (!hasPdftoppm) {
      return;
    }
    const tempDir = await mkdtemp(join(tmpdir(), "keiscore-integration-"));
    const pdfPath = join(tempDir, "sample-3-pages-audit.pdf");
    const logger = new InMemoryAuditLogger();
    try {
      await writeFile(pdfPath, buildThreePagePdfWithText(["PAGE-1", "PAGE-2", "PAGE-3"]));
      await extractRfInternalPassport(
        { kind: "path", path: pdfPath },
        { preferOnline: false, pdfPageRange: { from: 1, to: 2 }, logger }
      );

      const normalizedPagesEvent = logger
        .getEvents()
        .find((event) => event.stage === "extractor" && event.message === "Normalized pages prepared.");
      expect(normalizedPagesEvent).toBeDefined();
      expect(normalizedPagesEvent?.data).toMatchObject({
        pdfPageRange: { from: 1, to: 2 },
        normalized_pages: [{ pageNumber: 1 }, { pageNumber: 2 }]
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!shouldRun)("dynamic ROI mapper carries normalized PDF page index into roi.page", async () => {
    const hasPdftoppm = await commandExists("pdftoppm");
    if (!hasPdftoppm) {
      return;
    }
    const tempDir = await mkdtemp(join(tmpdir(), "keiscore-integration-"));
    const pdfPath = join(tempDir, "sample-3-pages-roi.pdf");
    try {
      await writeFile(pdfPath, buildThreePagePdfWithText(["PAGE-1", "PAGE-2", "PAGE-3"]));
      const normalized = await FormatNormalizer.normalize(
        { kind: "path", path: pdfPath },
        { pdfPageRange: { from: 1, to: 2 }, pdfRenderTimeoutMs: 120_000 },
        new InMemoryAuditLogger()
      );
      const rois = await DynamicROIMapper.map(
        normalized,
        { detected: true, docType: "RF_INTERNAL_PASSPORT", confidence: 0.99 },
        { geometricScore: 1, transform: "identity", alignedWidth: normalized.width, alignedHeight: normalized.height, stabilityNotes: [] },
        {
          anchors: {},
          baselineY: null,
          lineHeight: 40,
          scale: 1,
          usedFallbackGrid: true,
          pageType: "spread_page"
        },
        new InMemoryAuditLogger(),
        normalized.pages[0]?.pageNumber
      );
      expect(rois.length).toBeGreaterThan(0);
      expect(rois.every((item) => item.roi.page === 1)).toBe(true);
      await FormatNormalizer.cleanupPdfPageArtifacts(normalized);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!shouldRun)("extracts registration from second page of multi-page passport fixture", async () => {
    const hasPdftoppm = await commandExists("pdftoppm");
    const hasTesseract = await commandExists("tesseract");
    if (!hasPdftoppm || !hasTesseract) {
      return;
    }

    const pdfPath = join(process.cwd(), "fixtures/case3/pdf/passport_with_registration.pdf");
    const auditEvents: Array<{ message: string; data?: any }> = [];
    const logger = { log: (event: any) => auditEvents.push(event) };

    const auditDir = await mkdtemp(join(tmpdir(), "keiscore-audit-"));
    const prevDebugDir = process.env.KEISCORE_DEBUG_ROI_DIR;
    process.env.KEISCORE_DEBUG_ROI_DIR = auditDir;

    try {
      const result = await extractRfInternalPassport(
        { kind: "path", path: pdfPath },
        { ocrVariant: "v2", preferOnline: false, logger, debugUnsafeIncludeRawText: true, pdfRenderTimeoutMs: 120_000 }
      );

      expect(result.registration).not.toBeNull();
      expect(result.registration).toMatch(/УЛ\\./u);
      const regReport = result.field_reports.find((report) => report.field === "registration");
      expect(regReport).toBeDefined();
      expect((regReport?.roi.page ?? 0) >= 1).toBe(true);

      const pageRangeEvent = auditEvents.find((event) => event.message === "PDF page range resolved.");
      expect(pageRangeEvent?.data?.pageCount).toBeGreaterThanOrEqual(2);
      expect(pageRangeEvent?.data?.resolvedRange0based?.to).toBeGreaterThanOrEqual(1);

      const auditJson = JSON.parse(await readFile(join(auditDir, "audit.json"), "utf8"));
      expect(auditJson?.registration?.multiPageSearch?.totalPages).toBeGreaterThanOrEqual(2);
      expect(auditJson?.registration?.multiPageSearch?.selected?.includes(regReport?.roi.page ?? 1)).toBe(true);
    } finally {
      process.env.KEISCORE_DEBUG_ROI_DIR = prevDebugDir;
      await rm(auditDir, { recursive: true, force: true });
    }
  });
});
