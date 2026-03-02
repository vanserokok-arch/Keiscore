import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFixturePath } from "../src/main/sandbox-fixtures.js";
import type { SandboxRunOcrResult } from "../src/shared/ipc/sandbox.js";
import { mapRunResultToUi } from "../src/renderer/pages/ocrSandboxRunResult.js";

describe("sandbox ui run-result mapper", () => {
  it("handles ok:false payload and exposes structured errors", () => {
    const failed: SandboxRunOcrResult = {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "OCR subrun failed",
        details: { source: "passport", reason: "timeout" }
      }
    };

    const mapped = mapRunResultToUi(failed, null);

    expect(() => mapRunResultToUi(failed, null)).not.toThrow();
    expect(mapped.errors).toHaveLength(1);
    expect(mapped.errors[0]).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "OCR subrun failed",
      details: { source: "passport", reason: "timeout" }
    });
    expect(mapped.rawJson).toContain("OCR subrun failed");
  });
});

describe("sandbox fixture path resolver", () => {
  it("blocks traversal caseId with SECURITY_VIOLATION", async () => {
    await expect(resolveFixturePath("../..", "pdf", "passport")).rejects.toMatchObject({
      code: "SECURITY_VIOLATION"
    });
  });

  it("resolves case1/pdf to canonical filename, then falls back to legacy 1.pdf", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "keiscore-fixtures-test-"));
    try {
      await mkdir(join(fixtureRoot, "case1/pdf"), { recursive: true });
      await writeFile(join(fixtureRoot, "case1/pdf/passport.pdf"), Buffer.from("primary"));
      await writeFile(join(fixtureRoot, "case1/pdf/1.pdf"), Buffer.from("fallback"));

      const canonical = await resolveFixturePath("case1", "pdf", "passport", fixtureRoot);
      expect(canonical.relativePath).toBe("fixtures/case1/pdf/passport.pdf");

      await rm(join(fixtureRoot, "case1/pdf/passport.pdf"));
      const fallback = await resolveFixturePath("case1", "pdf", "passport", fixtureRoot);
      expect(fallback.relativePath).toBe("fixtures/case1/pdf/1.pdf");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
