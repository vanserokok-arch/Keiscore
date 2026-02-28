import { afterEach, describe, expect, it } from "vitest";
import * as coreModule from "../index.js";
import {
  ExtractionResultSchema,
  InMemoryAuditLogger,
  extractRfInternalPassport,
  validateDeptCode,
  validatePassportNumber,
  type MockDocumentLayout
} from "../index.js";

const ORIGINAL_ENDPOINT = process.env.ONLINE_OCR_ENDPOINT;

afterEach(() => {
  process.env.ONLINE_OCR_ENDPOINT = ORIGINAL_ENDPOINT;
});

function buildInput(layout: MockDocumentLayout) {
  const payload = Buffer.from(`KEISCORE_MOCK_LAYOUT:${JSON.stringify(layout)}`, "utf8");
  return {
    kind: "buffer" as const,
    filename: "passport.png",
    data: payload
  };
}

describe("KEIScore foundation", () => {
  it("exports public extraction function", () => {
    expect(typeof coreModule.extractRfInternalPassport).toBe("function");
    expect(typeof coreModule.registerExtractor).toBe("function");
  });

  it("validates passport fields", () => {
    expect(validatePassportNumber("4120 093363")).toBe("4120 №093363");
    expect(validateDeptCode("123-456")).toBe("123-456");
    expect(validatePassportNumber("bad")).toBeNull();
    expect(validateDeptCode("12-1234")).toBeNull();
  });

  it("extracts all fields on ideal scan", async () => {
    process.env.ONLINE_OCR_ENDPOINT = "https://ocr.example/api";
    const logger = new InMemoryAuditLogger();
    const result = await extractRfInternalPassport(
      buildInput({
        width: 2800,
        height: 2000,
        contour: { x1: 120, y1: 90, x2: 2680, y2: 1900 },
        pageTypeHint: "spread_page",
        centralWindowText: "ПАСПОРТ РОССИЙСКАЯ ФЕДЕРАЦИЯ",
        quality: { blur: 0.93, contrast: 0.91, noise: 0.08 },
        anchors: {
          ФАМИЛИЯ: { x: 420, y: 760 },
          ВЫДАН: { x: 410, y: 1170 },
          "КОД ПОДРАЗДЕЛЕНИЯ": { x: 420, y: 1080 }
        },
        fields: {
          fio: "ИВАНОВ ИВАН ИВАНОВИЧ",
          passport_number: "4120 093363",
          issued_by: "ГУ МВД РОССИИ ПО Г. МОСКВЕ",
          dept_code: "770-001",
          registration: "Г. МОСКВА УЛ. ТВЕРСКАЯ Д. 10 КВ. 5"
        }
      }),
      { preferOnline: true, logger }
    );

    expect(result.fio).toBe("ИВАНОВ ИВАН ИВАНОВИЧ");
    expect(result.passport_number).toBe("4120 №093363");
    expect(result.issued_by).toContain("МВД");
    expect(result.dept_code).toBe("770-001");
    expect(result.registration).toContain("УЛ.");
    expect(result.confidence_score).toBeGreaterThan(0.75);
    expect(result.errors.some((error) => error.code === "REQUIRE_MANUAL_REVIEW")).toBe(false);
    expect(logger.getEvents().length).toBeGreaterThan(5);
  });

  it("uses pass cascade for 15 degree skew", async () => {
    process.env.ONLINE_OCR_ENDPOINT = "https://ocr.example/api";
    const result = await extractRfInternalPassport(
      buildInput({
        width: 2800,
        height: 2000,
        skewDeg: 15,
        pageTypeHint: "spread_page",
        centralWindowText: "ПАСПОРТ РОССИЙСКАЯ ФЕДЕРАЦИЯ",
        anchors: {
          ФАМИЛИЯ: { x: 420, y: 760 },
          ВЫДАН: { x: 410, y: 1170 },
          "КОД ПОДРАЗДЕЛЕНИЯ": { x: 420, y: 1080 }
        },
        multiPass: {
          passport_number: {
            A: { text: "41Z0 09336X", confidence: 0.51 },
            B: { text: "4120093363", confidence: 0.88 }
          }
        },
        fields: {
          fio: "ПЕТРОВ ПЕТР ПЕТРОВИЧ",
          issued_by: "УФМС РОССИИ ПО Г. САНКТ-ПЕТЕРБУРГУ",
          dept_code: "780-002",
          registration: "Г. САНКТ-ПЕТЕРБУРГ УЛ. САДОВАЯ Д. 1 КВ. 10"
        }
      }),
      { preferOnline: true }
    );

    expect(result.passport_number).toBe("4120 №093363");
    expect(
      result.field_reports.find((report) => report.field === "passport_number")?.pass_id
    ).toBe("B");
  });

  it("returns quality warning for shadowed scan", async () => {
    process.env.ONLINE_OCR_ENDPOINT = "https://ocr.example/api";
    const result = await extractRfInternalPassport(
      buildInput({
        width: 2800,
        height: 2000,
        pageTypeHint: "spread_page",
        centralWindowText: "ПАСПОРТ РОССИЙСКАЯ ФЕДЕРАЦИЯ",
        quality: { blur: 0.12, contrast: 0.4, noise: 0.5 },
        fields: {
          fio: "СИДОРОВ СИДОР СИДОРОВИЧ",
          passport_number: "4501 123456",
          issued_by: "ГУ МВД РОССИИ ПО Г. КАЗАНИ",
          dept_code: "160-004",
          registration: "Г. КАЗАНЬ УЛ. БАУМАНА Д. 9 КВ. 7"
        }
      }),
      { preferOnline: true }
    );

    expect(result.errors.some((error) => error.code === "QUALITY_WARNING")).toBe(true);
  });

  it("handles low-contrast registration page", async () => {
    process.env.ONLINE_OCR_ENDPOINT = "https://ocr.example/api";
    const result = await extractRfInternalPassport(
      buildInput({
        width: 2600,
        height: 1900,
        pageTypeHint: "registration_page",
        centralWindowText: "Место жительства",
        quality: { blur: 0.78, contrast: 0.18, noise: 0.22 },
        anchors: { "МЕСТО ЖИТЕЛЬСТВА": { x: 330, y: 520 } },
        fields: {
          registration: "Г. ПСКОВ УЛ. ЛЕНИНА Д. 15 КВ. 12"
        }
      }),
      { preferOnline: true }
    );

    expect(result.registration).toContain("УЛ.");
    expect(result.fio).toBeNull();
  });

  it("flags partially cropped document as not detected", async () => {
    process.env.ONLINE_OCR_ENDPOINT = "https://ocr.example/api";
    const result = await extractRfInternalPassport(
      buildInput({
        width: 2000,
        height: 2000,
        contour: { x1: 100, y1: 100, x2: 600, y2: 700 },
        pageTypeHint: "unknown",
        centralWindowText: "???"
      }),
      { preferOnline: true }
    );

    expect(result.errors.some((error) => error.code === "DOCUMENT_NOT_DETECTED")).toBe(true);
    expect(result.confidence_score).toBeLessThan(0.75);
  });

  it("keeps deterministic output for noisy mobile photo", async () => {
    process.env.ONLINE_OCR_ENDPOINT = "https://ocr.example/api";
    const result = await extractRfInternalPassport(
      buildInput({
        width: 2500,
        height: 1750,
        skewDeg: 7,
        pageTypeHint: "spread_page",
        centralWindowText: "ПАСПОРТ РОССИЙСКАЯ ФЕДЕРАЦИЯ",
        quality: { blur: 0.28, contrast: 0.45, noise: 0.76 },
        fields: {
          fio: "ИВАНОВ ИВАН ИВАНОВИЧ",
          passport_number: "4120 №093363",
          issued_by: "ГУ МВД РОССИИ ПО Г. МОСКВЕ",
          dept_code: "770-001",
          registration: "Г. МОСКВА УЛ. ТВЕРСКАЯ Д. 10 КВ. 5"
        }
      }),
      { preferOnline: true }
    );

    expect(result.field_reports).toHaveLength(5);
    expect(result.confidence_score).toBeGreaterThan(0);

    const parsed = ExtractionResultSchema.parse(result);
    expect(parsed).toEqual(result);
  });
});
