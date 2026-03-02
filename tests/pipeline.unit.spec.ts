import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuditLogger } from "../types.js";

type SharpState = {
  metadata: { width: number; height: number };
  normalizedBuffer: Buffer;
  extractCalls: Array<{ left: number; top: number; width: number; height: number }>;
  toFileCalls: string[];
  resizeCalls: unknown[];
};

function setupMocks() {
  const execaMock = vi.fn();
  const sharpState: SharpState = {
    metadata: { width: 1200, height: 800 },
    normalizedBuffer: Buffer.from("normalized-png"),
    extractCalls: [],
    toFileCalls: [],
    resizeCalls: []
  };
  const sharpMock = vi.fn(() => {
    const chain = {
      metadata: vi.fn(async () => sharpState.metadata),
      grayscale: vi.fn(() => chain),
      resize: vi.fn((opts: unknown) => {
        sharpState.resizeCalls.push(opts);
        return chain;
      }),
      png: vi.fn(() => chain),
      toBuffer: vi.fn(async () => sharpState.normalizedBuffer),
      extract: vi.fn((opts: { left: number; top: number; width: number; height: number }) => {
        sharpState.extractCalls.push(opts);
        return chain;
      }),
      toFile: vi.fn(async (path: string) => {
        sharpState.toFileCalls.push(path);
      })
    };
    return chain;
  });
  vi.resetModules();
  vi.doMock("execa", () => ({ execa: execaMock }));
  vi.doMock("sharp", () => ({ default: sharpMock }));
  return { execaMock, sharpState };
}

describe("real pipeline units (mocked deps)", () => {
  afterEach(() => {
    vi.doUnmock("execa");
    vi.doUnmock("sharp");
    vi.resetModules();
  });

  it("normalizes image buffer using sharp grayscale+resize", async () => {
    const { sharpState } = setupMocks();
    const { FormatNormalizer } = await import("../format/formatNormalizer.js");
    const input = {
      kind: "buffer" as const,
      filename: "doc.png",
      data: Buffer.from("image-data")
    };
    const normalized = await FormatNormalizer.normalize(input, {}, new InMemoryAuditLogger());

    expect(normalized.kind).toBe("image");
    expect(normalized.normalizedBuffer).toEqual(Buffer.from("normalized-png"));
    expect(sharpState.resizeCalls.length).toBeGreaterThan(0);
    expect(normalized.width).toBe(1200);
    expect(normalized.height).toBe(800);
  });

  it("returns ENGINE_UNAVAILABLE if pdftoppm is missing", async () => {
    const { execaMock } = setupMocks();
    const { FormatNormalizer } = await import("../format/formatNormalizer.js");
    vi.spyOn(FormatNormalizer as unknown as { getPdfPageCount: (sourcePath: string) => Promise<number> }, "getPdfPageCount").mockResolvedValueOnce(1);
    execaMock.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOENT" }));

    const run = FormatNormalizer.normalize(
      {
        kind: "buffer",
        filename: "doc.pdf",
        data: Buffer.from("%PDF-1.4")
      },
      {},
      new InMemoryAuditLogger()
    );
    await expect(run).rejects.toMatchObject({
      coreError: { code: "ENGINE_UNAVAILABLE" }
    });
  });

  it("emits normalizer audit for valid page range", async () => {
    const { execaMock } = setupMocks();
    const { FormatNormalizer } = await import("../format/formatNormalizer.js");
    vi.spyOn(FormatNormalizer as unknown as { getPdfPageCount: (sourcePath: string) => Promise<number> }, "getPdfPageCount").mockResolvedValueOnce(1);
    execaMock.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOENT" }));
    const logger = new InMemoryAuditLogger();

    const run = FormatNormalizer.normalize(
      {
        kind: "buffer",
        filename: "doc.pdf",
        data: Buffer.from("%PDF-1.4")
      },
      { pdfPageRange: { from: 0, to: 0 } },
      logger
    );
    await expect(run).rejects.toMatchObject({
      coreError: { code: "ENGINE_UNAVAILABLE" }
    });
    expect(execaMock).toHaveBeenCalled();
    const normalizerAudit = logger.getEvents().find(
      (event) => event.stage === "normalizer" && event.message === "PDF page range resolved."
    );
    expect(normalizerAudit).toBeDefined();
    expect(normalizerAudit?.data).toMatchObject({
      pageCount: 1,
      requestedRange: { from: 0, to: 0 },
      resolvedRange0based: { from: 0, to: 0 },
      rangeClamped: false,
      pdftoppmRange1based: { f: 1, l: 1 }
    });
    const pdftoppmRange = (normalizerAudit?.data as { pdftoppmRange1based?: { f: number; l: number } } | undefined)
      ?.pdftoppmRange1based;
    const resolved = (normalizerAudit?.data as { resolvedRange0based?: { from: number; to: number } } | undefined)
      ?.resolvedRange0based;
    expect(pdftoppmRange?.f).toBe((resolved?.from ?? 0) + 1);
    expect(pdftoppmRange?.l).toBe((resolved?.to ?? 0) + 1);
  });

  it("clamps out-of-range pdfPageRange and continues", async () => {
    const { execaMock } = setupMocks();
    const { FormatNormalizer } = await import("../format/formatNormalizer.js");
    vi.spyOn(FormatNormalizer as unknown as { getPdfPageCount: (sourcePath: string) => Promise<number> }, "getPdfPageCount").mockResolvedValueOnce(1);
    execaMock.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOENT" }));
    const logger = new InMemoryAuditLogger();

    const run = FormatNormalizer.normalize(
      {
        kind: "buffer",
        filename: "doc.pdf",
        data: Buffer.from("%PDF-1.4")
      },
      { pdfPageRange: { from: 0, to: 3 } },
      logger
    );
    await expect(run).rejects.toMatchObject({
      coreError: { code: "ENGINE_UNAVAILABLE" }
    });
    const normalizerAudit = logger.getEvents().find(
      (event) => event.stage === "normalizer" && event.message === "PDF page range resolved."
    );
    expect(normalizerAudit?.data).toMatchObject({
      pageCount: 1,
      requestedRange: { from: 0, to: 3 },
      resolvedRange0based: { from: 0, to: 0 },
      rangeClamped: true,
      pdftoppmRange1based: { f: 1, l: 1 }
    });
    expect(execaMock).toHaveBeenCalled();
  });

  it("preserves structured errors thrown during pdftoppm call", async () => {
    const { execaMock } = setupMocks();
    const { FormatNormalizer } = await import("../format/formatNormalizer.js");
    vi.spyOn(FormatNormalizer as unknown as { getPdfPageCount: (sourcePath: string) => Promise<number> }, "getPdfPageCount").mockResolvedValueOnce(1);
    execaMock.mockRejectedValueOnce(Object.assign(new Error("structured"), { coreError: { code: "INTERNAL_ERROR", message: "preserve_me" } }));

    const run = FormatNormalizer.normalize(
      {
        kind: "buffer",
        filename: "doc.pdf",
        data: Buffer.from("%PDF-1.4")
      },
      {},
      new InMemoryAuditLogger()
    );
    await expect(run).rejects.toMatchObject({
      coreError: { code: "INTERNAL_ERROR", message: "preserve_me" }
    });
  });

  it("crops ROI png and runs tesseract with psm by pass", async () => {
    const { execaMock, sharpState } = setupMocks();
    const { DynamicROIMapper } = await import("../anchors/dynamicRoiMapper.js");
    const { TesseractEngine } = await import("../engines/tesseractEngine.js");
    execaMock.mockResolvedValueOnce({
      stdout:
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n" +
        "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t95\t770-001"
    });

    const rois = await DynamicROIMapper.attachRoiImagePaths(
      {
        original: { kind: "buffer", filename: "doc.png", data: Buffer.from("image-data") },
        mime: "image/png",
        kind: "image",
        pages: [{ pageNumber: 1, imagePath: null, width: 2500, height: 1800 }],
        sourcePath: null,
        fileName: "doc.png",
        buffer: Buffer.from("image-data"),
        normalizedBuffer: Buffer.from("normalized-png"),
        width: 2500,
        height: 1800,
        quality_metrics: { blur_score: 1, contrast_score: 1, noise_score: 0 },
        warnings: [],
        skewAngleDeg: 0
      },
      [{ field: "dept_code", roi: { x: 100, y: 100, width: 320, height: 80, page: 0 } }],
      new InMemoryAuditLogger()
    );
    const roi = rois[0];
    expect(roi).toBeDefined();
    const candidate = await TesseractEngine.runOcrOnRoi(
      roi!,
      {
        original: { kind: "buffer", filename: "doc.png", data: Buffer.from("image-data") },
        mime: "image/png",
        kind: "image",
        pages: [{ pageNumber: 1, imagePath: null, width: 2500, height: 1800 }],
        sourcePath: null,
        fileName: "doc.png",
        buffer: Buffer.from("image-data"),
        normalizedBuffer: Buffer.from("normalized-png"),
        width: 2500,
        height: 1800,
        quality_metrics: { blur_score: 1, contrast_score: 1, noise_score: 0 },
        warnings: [],
        skewAngleDeg: 0
      },
      "rus",
      "B",
      1000
    );

    expect(sharpState.extractCalls.length).toBeGreaterThanOrEqual(1);
    expect(sharpState.toFileCalls.length).toBeGreaterThanOrEqual(1);
    expect(candidate?.text).toBe("770-001");
    const lastCall = execaMock.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    expect(lastCall?.[0]).toBe("tesseract");
    const args = lastCall?.[1];
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("stdout");
    expect(args).toContain("-l");
    expect(args).toContain("rus");
    expect(args).toContain("--oem");
    expect(args).toContain("1");
    expect(args).toContain("--psm");
    expect(args).toContain("8");
    expect(args).toContain("tsv");
    expect(args).toContain("tessedit_char_whitelist=0123456789№- ");
    expect(lastCall?.[2]).toEqual({ timeout: 1000, reject: false });
  });

  it("maps ROI with page index from normalized input pageNumber", async () => {
    setupMocks();
    const { DynamicROIMapper } = await import("../anchors/dynamicRoiMapper.js");
    const rois = await DynamicROIMapper.map(
      {
        original: { kind: "buffer", filename: "doc.png", data: Buffer.from("image-data") },
        mime: "image/png",
        kind: "image",
        pages: [{ pageNumber: 2, imagePath: null, width: 2500, height: 1800 }],
        sourcePath: null,
        fileName: "doc.png",
        buffer: Buffer.from("image-data"),
        normalizedBuffer: Buffer.from("normalized-png"),
        width: 2500,
        height: 1800,
        quality_metrics: { blur_score: 1, contrast_score: 1, noise_score: 0 },
        warnings: [],
        skewAngleDeg: 0
      },
      { detected: true, docType: "RF_INTERNAL_PASSPORT", confidence: 0.99 },
      { geometricScore: 1, transform: "identity", alignedWidth: 2500, alignedHeight: 1800, stabilityNotes: [] },
      {
        anchors: {},
        baselineY: null,
        lineHeight: 40,
        scale: 1,
        usedFallbackGrid: true,
        pageType: "spread_page"
      },
      new InMemoryAuditLogger()
    );

    expect(rois.length).toBeGreaterThan(0);
    expect(rois.every((item) => item.roi.page === 2)).toBe(true);
  });
});
