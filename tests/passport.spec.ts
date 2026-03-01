import { afterEach, describe, expect, it } from "vitest";
import * as coreModule from "../index.js";
import {
  buildIssuedByCandidatesFromTsvWords,
  rankCandidates,
  selectFioFromThreeZones,
  selectBestFioFromCyrillicLines,
  type TsvWord
} from "../extractors/rfInternalPassportExtractor.js";
import { adaptiveThresholdRetryDecision } from "../format/formatNormalizer.js";
import {
  ExtractionResultSchema,
  InMemoryAuditLogger,
  extractRfInternalPassport,
  validateDeptCode,
  validateFio,
  validateIssuedBy,
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
    expect(validatePassportNumber("4120 №093363")).toBe("4120 №093363");
    expect(validateDeptCode("123-456")).toBe("123-456");
    expect(validateIssuedBy("ГУ МВД РОССИИ ПО Г. МОСКВЕ 1234567890")).toBeNull();
    expect(validatePassportNumber("bad")).toBeNull();
    expect(validatePassportNumber("0")).toBeNull();
    expect(validateDeptCode("12-1234")).toBeNull();
    expect(validateDeptCode("")).toBeNull();
    expect(validateIssuedBy("")).toBeNull();
  });

  it('validateFio rejects OCR-broken surname like "ВОЯОКОВЕ"', () => {
    expect(validateFio("ВОЯОКОВЕ АННА НИКОЛАЕВНА")).toBeNull();
  });

  it("validateFio rejects noisy punctuation-heavy OCR", () => {
    expect(validateFio("..,,.. ВОЯ.ОКОВЕ !!! АННА ??? НИКОЛАЕВНА 12345")).toBeNull();
  });

  it("validateIssuedBy rejects long numeric tail candidate", () => {
    expect(validateIssuedBy("НИИ ОБЛ. ЛЕНИНГРАДСКАЯ 38 0200728470021")).toBeNull();
  });

  it("fio scorer picks high-quality cyrillic 3-word candidate", () => {
    const selected = selectBestFioFromCyrillicLines(
      [
        "ИЯ АННА НИКОЛАЕВНА ЧИИ",
        "ГОР ТОСНО",
        "ВОЛОХОВИЧ АННА НИКОЛАЕВНА",
        "ВОЛОХОВИЧ АННА НИКОЛАЕВНА 111111"
      ],
      ["ВОЛОХОВИЧ"]
    );
    expect(selected).toBe("ВОЛОХОВИЧ АННА НИКОЛАЕВНА");
  });

  it("fio selector rejects low-quality and non-fio lines", () => {
    const selected = selectBestFioFromCyrillicLines(
      ["ГОР ТОСНО", "ВОЯОКОВЕ АННА НИКОЛАЕВНА", "ВОЛОХОВИЧ АННА НИКОЛАЕВНА"],
      ["ВОЛОХОВИЧ"]
    );
    expect(selected).toBe("ВОЛОХОВИЧ АННА НИКОЛАЕВНА");
  });

  it("fio selector rejects noisy and digit-heavy candidates", () => {
    const selected = selectBestFioFromCyrillicLines([
      "ВОЯОКОВЕ АННА НИКОЛАЕВНА",
      "ВОЛОХОВИЧ АННА НИКОЛАЕВНА 123456",
      "ВОЛОХОВИЧ АННА НИКОЛАЕВНА"
    ]);
    expect(selected).toBe("ВОЛОХОВИЧ АННА НИКОЛАЕВНА");
  });

  it("fio selector chooses TSV line with VOLОХОВИЧ over garbage", () => {
    const selected = selectBestFioFromCyrillicLines(
      [
        "ВОЯОКОВЕ АННА НИКОЛАЕВНА",
        "ЛЕНИНГРАДСКАЯ ОБЛАСТЬ",
        "ВОЛОХОвИЧ АННА НИКОЛАЕВНА",
        "ГУ МВД РОССИИ"
      ],
      ["ВОЛОХОВИЧ"]
    );
    expect(selected).toBe("ВОЛОХОВИЧ АННА НИКОЛАЕВНА");
  });

  it("issued_by line-merge builds stable candidate from TSV words", () => {
    const words: TsvWord[] = [
      {
        text: "ГУ",
        confidence: 96,
        blockNum: 1,
        parNum: 1,
        lineNum: 1,
        bbox: { x1: 100, y1: 200, x2: 140, y2: 225 }
      },
      {
        text: "МВД",
        confidence: 95,
        blockNum: 1,
        parNum: 1,
        lineNum: 1,
        bbox: { x1: 150, y1: 200, x2: 220, y2: 225 }
      },
      {
        text: "РОССИИ",
        confidence: 94,
        blockNum: 1,
        parNum: 1,
        lineNum: 1,
        bbox: { x1: 230, y1: 200, x2: 340, y2: 225 }
      },
      {
        text: "ПО",
        confidence: 93,
        blockNum: 1,
        parNum: 1,
        lineNum: 1,
        bbox: { x1: 350, y1: 200, x2: 390, y2: 225 }
      },
      {
        text: "Г.",
        confidence: 93,
        blockNum: 1,
        parNum: 1,
        lineNum: 1,
        bbox: { x1: 400, y1: 200, x2: 430, y2: 225 }
      },
      {
        text: "САНКТ-ПЕТЕРБУРГУ",
        confidence: 92,
        blockNum: 1,
        parNum: 1,
        lineNum: 1,
        bbox: { x1: 440, y1: 200, x2: 690, y2: 225 }
      },
      {
        text: "И",
        confidence: 94,
        blockNum: 1,
        parNum: 1,
        lineNum: 2,
        bbox: { x1: 100, y1: 236, x2: 120, y2: 260 }
      },
      {
        text: "ЛЕНИНГРАДСКОЙ",
        confidence: 95,
        blockNum: 1,
        parNum: 1,
        lineNum: 2,
        bbox: { x1: 130, y1: 236, x2: 320, y2: 260 }
      },
      {
        text: "ОБЛАСТИ",
        confidence: 95,
        blockNum: 1,
        parNum: 1,
        lineNum: 2,
        bbox: { x1: 330, y1: 236, x2: 450, y2: 260 }
      }
    ];
    const best = buildIssuedByCandidatesFromTsvWords(words)[0]?.text ?? null;
    expect(best).not.toBeNull();
    expect(best).toContain("ГУ МВД РОССИИ");
    expect(best).toContain("САНКТ-ПЕТЕРБУРГУ");
    expect(best).toContain("ЛЕНИНГРАДСКОЙ");
    expect(best).toContain("ОБЛАСТИ");
  });

  it("validateIssuedBy accepts stable authority line", () => {
    const validated = validateIssuedBy("ГУ МВД РОССИИ ПО Г. САНКТ-ПЕТЕРБУРГУ И ЛЕНИНГРАДСКОЙ ОБЛАСТИ");
    expect(validated).not.toBeNull();
    expect(validated).toContain("ГУ МВД РОССИИ");
    expect(validated).toContain("САНКТ-ПЕТЕРБУРГУ");
    expect(validated).toContain("ЛЕНИНГРАДСКОЙ");
  });

  it("issued_by line-merge rejects 6+ digit numeric tail chunks", () => {
    const words: TsvWord[] = [
      {
        text: "ГУ",
        confidence: 94,
        blockNum: 1,
        parNum: 1,
        lineNum: 1,
        bbox: { x1: 110, y1: 200, x2: 150, y2: 224 }
      },
      {
        text: "МВД",
        confidence: 94,
        blockNum: 1,
        parNum: 1,
        lineNum: 1,
        bbox: { x1: 158, y1: 200, x2: 230, y2: 224 }
      },
      {
        text: "РОССИИ",
        confidence: 93,
        blockNum: 1,
        parNum: 1,
        lineNum: 1,
        bbox: { x1: 238, y1: 200, x2: 350, y2: 224 }
      },
      {
        text: "123456",
        confidence: 95,
        blockNum: 1,
        parNum: 1,
        lineNum: 2,
        bbox: { x1: 110, y1: 236, x2: 350, y2: 260 }
      }
    ];
    const candidates = buildIssuedByCandidatesFromTsvWords(words).map((item: { text: string }) => item.text);
    expect(candidates.some((item: string) => /\d{6,}/u.test(item))).toBe(false);
  });

  it("rankCandidates prefers regex-valid candidate even at lower confidence", () => {
    const ranked = rankCandidates([
      {
        pass_id: "A",
        source: "zonal_tsv",
        psm: 6,
        raw_text_preview: "412O 09336X",
        normalized_preview: "412O 09336X",
        confidence: 0.93,
        regexMatch: 0,
        lengthScore: 1,
        russianCharRatio: 0,
        anchorAlignmentScore: 1,
        rankingScore: 0,
        validated: null
      },
      {
        pass_id: "B",
        source: "zonal_tsv",
        psm: 6,
        raw_text_preview: "4120 093363",
        normalized_preview: "4120 093363",
        confidence: 0.61,
        regexMatch: 1,
        lengthScore: 1,
        russianCharRatio: 0,
        anchorAlignmentScore: 1,
        rankingScore: 0,
        validated: "4120 №093363"
      }
    ]);
    expect(ranked[0]?.pass_id).toBe("B");
  });

  it("multi-pass FIO chooses valid 3-line candidate from horizontal zones", () => {
    const candidate = selectFioFromThreeZones(["ВОЛОХОВИЧ", "АННА", "НИКОЛАЕВНА"]);
    expect(candidate).toBe("ВОЛОХОВИЧ АННА НИКОЛАЕВНА");
  });

  it("adaptive threshold retry logic selects correct strategy by black pixel ratio", () => {
    expect(adaptiveThresholdRetryDecision(0.7).mode).toBe("lower_threshold");
    expect(adaptiveThresholdRetryDecision(0.009).mode).toBe("contrast_boost");
    expect(adaptiveThresholdRetryDecision(0.2).mode).toBe("none");
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

  it("stabilizes volokhovich case fields with strict validators", async () => {
    process.env.ONLINE_OCR_ENDPOINT = "https://ocr.example/api";
    const result = await extractRfInternalPassport(
      buildInput({
        width: 2800,
        height: 2000,
        pageTypeHint: "spread_page",
        centralWindowText: "ПАСПОРТ РОССИЙСКАЯ ФЕДЕРАЦИЯ",
        anchors: {
          ФАМИЛИЯ: { x: 420, y: 760 },
          ВЫДАН: { x: 410, y: 1170 },
          "КОД ПОДРАЗДЕЛЕНИЯ": { x: 420, y: 1080 }
        },
        multiPass: {
          fio: {
            A: { text: "АННА НИКОЛАЕВНА ЧИИ", confidence: 0.97 },
            C: { text: "ВОЛОХОВИЧ АННА НИКОЛАЕВНА", confidence: 0.66 }
          }
        },
        fields: {
          fio: "ВОЛОХОВИЧ АННА НИКОЛАЕВНА",
          passport_number: "4120 093363",
          issued_by: "ГУ МВД РОССИИ ПО Г. САНКТ-ПЕТЕРБУРГУ И ЛЕНИНГРАДСКОЙ ОБЛАСТИ",
          dept_code: "470-021"
        }
      }),
      { preferOnline: true, debugUnsafeIncludeRawText: true }
    );

    expect(result.fio).toBe("ВОЛОХОВИЧ АННА НИКОЛАЕВНА");
    expect(result.passport_number).toBe("4120 №093363");
    expect(result.dept_code).toBe("470-021");
    expect(result.issued_by).toContain("ГУ МВД РОССИИ");
    expect(result.issued_by).toContain("САНКТ-ПЕТЕРБУРГУ");
    expect(result.issued_by).toContain("ЛЕНИНГРАДСКОЙ");

    const fioReport = result.field_reports.find((report) => report.field === "fio");
    const issuedByReport = result.field_reports.find((report) => report.field === "issued_by");

    expect(fioReport?.best_candidate_preview).toBeDefined();
    expect(issuedByReport?.best_candidate_preview).toBeDefined();
    expect(fioReport?.best_candidate_preview).not.toBe("mrz_roi_fio");
    expect(issuedByReport?.best_candidate_preview).not.toBe("zonal_tsv_issued_by");
    expect(fioReport?.best_candidate_preview).toContain("АННА");
    expect(issuedByReport?.best_candidate_preview).toMatch(/МВД|ГУ МВД/u);
    const fioPreviews = fioReport?.attempts?.map((attempt) => attempt.normalized_preview) ?? [];
    const issuedByPreviews = issuedByReport?.attempts?.map((attempt) => attempt.normalized_preview) ?? [];
    expect(fioPreviews).not.toContain("mrz_roi_fio");
    expect(issuedByPreviews).not.toContain("zonal_tsv_issued_by");
  });
});
