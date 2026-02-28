import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuditLogger } from "../types.js";
function setupMocks() {
    const execaMock = vi.fn();
    const sharpState = {
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
            resize: vi.fn((opts) => {
                sharpState.resizeCalls.push(opts);
                return chain;
            }),
            png: vi.fn(() => chain),
            toBuffer: vi.fn(async () => sharpState.normalizedBuffer),
            extract: vi.fn((opts) => {
                sharpState.extractCalls.push(opts);
                return chain;
            }),
            toFile: vi.fn(async (path) => {
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
            kind: "buffer",
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
        execaMock.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOENT" }));
        const run = FormatNormalizer.normalize({
            kind: "buffer",
            filename: "doc.pdf",
            data: Buffer.from("%PDF-1.4")
        }, {}, new InMemoryAuditLogger());
        await expect(run).rejects.toMatchObject({
            coreError: { code: "ENGINE_UNAVAILABLE" }
        });
    });
    it("crops ROI png and runs tesseract with psm by pass", async () => {
        const { execaMock, sharpState } = setupMocks();
        const { DynamicROIMapper } = await import("../anchors/dynamicRoiMapper.js");
        const { TesseractEngine } = await import("../engines/tesseractEngine.js");
        execaMock.mockResolvedValueOnce({
            stdout: "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n" +
                "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t95\t770-001"
        });
        const rois = await DynamicROIMapper.attachRoiImagePaths({
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
        }, [{ field: "dept_code", roi: { x: 100, y: 100, width: 320, height: 80, page: 0 } }], new InMemoryAuditLogger());
        const roi = rois[0];
        expect(roi).toBeDefined();
        const candidate = await TesseractEngine.runOcrOnRoi(roi, {
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
        }, "rus", "B", 1000);
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
});
//# sourceMappingURL=pipeline.unit.spec.js.map