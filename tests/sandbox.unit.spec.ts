import { describe, expect, it } from "vitest";
import { resolvePathInsideRoot } from "../src/main/sandbox-fixtures.js";
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
  it("resolves fixture path only inside fixtures root and blocks traversal", () => {
    const root = "/tmp/keiscore/fixtures";
    const allowed = resolvePathInsideRoot(root, "case1/pdf/passport.pdf");
    expect(allowed).toBe("/tmp/keiscore/fixtures/case1/pdf/passport.pdf");
    expect(() => resolvePathInsideRoot(root, "../outside.pdf")).toThrow("Path escapes allowed root.");
  });
});
