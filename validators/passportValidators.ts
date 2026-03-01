import {
  normalizeDeptCode,
  normalizeFioCandidate,
  normalizePassportNumber,
  normalizeRussianText
} from "../format/textNormalizer.js";

export const PASSPORT_NUMBER_REGEX = /^\d{4}\s№\d{6}$/u;
export const DEPT_CODE_REGEX = /^\d{3}-\d{3}$/u;
export const FIO_REGEX = /^[А-ЯЁ-]+(?:\s+[А-ЯЁ-]+){2}$/u;
export const ISSUED_BY_REGEX = /^[А-ЯЁ0-9\s"().,\-]{12,}$/u;
export const REGISTRATION_REGEX = /^[А-ЯЁ0-9\s"().,\-]{20,}$/u;

const MRZ_MARKER_REGEX = /P<N?RUS[A-Z<]?|PNRUS[A-Z<]?|NRUS[A-Z<]?/u;
const CYRILLIC_SURNAME_REGEX = /^[А-ЯЁ-]+$/u;

export function validatePassportNumber(value: string): string | null {
  if (value.trim().length === 0) {
    return null;
  }
  const compact = normalizePassportNumber(value);
  if (compact.length !== 10 || !/^\d{10}$/u.test(compact)) {
    return null;
  }
  const formatted = `${compact.slice(0, 4)} №${compact.slice(4)}`;
  if (!PASSPORT_NUMBER_REGEX.test(formatted)) {
    return null;
  }
  return formatted;
}

export function validateDeptCode(value: string): string | null {
  if (value.trim().length === 0) {
    return null;
  }
  const normalized = normalizeDeptCode(value);
  if (!DEPT_CODE_REGEX.test(normalized)) {
    return null;
  }
  return normalized;
}

export function validateFio(value: string): string | null {
  if (value.trim().length === 0 || hasHighFioNoiseRatio(value)) {
    return null;
  }
  const normalized = normalizeFioCandidate(value);
  if (normalized === null) {
    return null;
  }
  if (!FIO_REGEX.test(normalized)) {
    return null;
  }
  const parts = normalized.split(" ");
  if (parts.length !== 3) {
    return null;
  }
  const [surname, name, patronymic] = parts;
  if (surname === undefined || name === undefined || patronymic === undefined) {
    return null;
  }
  if (!parts.every((part) => /^[А-ЯЁ-]+$/u.test(part))) {
    return null;
  }
  if (!passesFioSurnameQualityGuard(surname)) {
    return null;
  }
  if (
    name.length < 2 ||
    patronymic.length < 2 ||
    parts.some((part) => part.length < 2 || isNoiseToken(part) || isSuspiciousFioWord(part))
  ) {
    return null;
  }
  if (
    surname === name ||
    surname === patronymic ||
    /^(Г|РФ|ПАСПОРТ|РОССИЯ)$/u.test(surname) ||
    /^(Г|РФ|ПАСПОРТ|РОССИЯ)$/u.test(name) ||
    /^(Г|РФ|ПАСПОРТ|РОССИЯ)$/u.test(patronymic)
  ) {
    return null;
  }
  if (!/(ВНА|ВИЧ|ИЧ|ЬЕВНА)$/u.test(patronymic)) {
    return null;
  }
  return normalized;
}

export interface MrzLatinFioTokens {
  surname: string;
  name: string;
  patronymic: string;
  marker: string;
  line: string;
}

export interface SurnameQualityResult {
  ok: boolean;
  reason: "OK" | "LOW_QUALITY_SURNAME";
}

export function parseMrzLatinFio(value: string): MrzLatinFioTokens | null {
  const lines = value
    .toUpperCase()
    .replace(/\r/gu, "\n")
    .split("\n")
    .map((line) => normalizeMrzLine(line))
    .filter((line) => line.length > 8 && (line.includes("RUS") || line.includes("<<")));
  for (const line of lines) {
    const candidate = parseSingleMrzLine(line);
    if (candidate !== null) {
      return candidate;
    }
  }
  return null;
}

export function transliterateMrzLatinToCyrillic(input: string): string {
  const normalized = input.replace(/[^A-Z]/gu, "");
  const map: Record<string, string> = {
    SCH: "Щ",
    ZH: "Ж",
    KH: "Х",
    TS: "Ц",
    CH: "Ч",
    SH: "Ш",
    YA: "Я",
    YU: "Ю",
    YE: "Е",
    YO: "Ё",
    A: "А",
    B: "Б",
    V: "В",
    G: "Г",
    D: "Д",
    E: "Е",
    Z: "З",
    I: "И",
    J: "Й",
    K: "К",
    L: "Л",
    M: "М",
    N: "Н",
    O: "О",
    P: "П",
    R: "Р",
    S: "С",
    T: "Т",
    U: "У",
    F: "Ф",
    H: "Х",
    Y: "Ы",
    C: "К",
    Q: "К",
    W: "В",
    X: "КС"
  };
  const ordered = Object.keys(map).sort((left, right) => right.length - left.length);
  let output = "";
  let index = 0;
  while (index < normalized.length) {
    let consumed = false;
    for (const token of ordered) {
      if (!normalized.startsWith(token, index)) {
        continue;
      }
      output += map[token] ?? "";
      index += token.length;
      consumed = true;
      break;
    }
    if (!consumed) {
      index += 1;
    }
  }
  return output;
}

export function assessFioSurnameQuality(surname: string): SurnameQualityResult {
  const clean = normalizeRussianText(surname).replace(/\s+/gu, "");
  if (clean.length < 5) {
    return { ok: false, reason: "LOW_QUALITY_SURNAME" };
  }
  if (!CYRILLIC_SURNAME_REGEX.test(clean)) {
    return { ok: false, reason: "LOW_QUALITY_SURNAME" };
  }
  if (/(.)\1{2,}/u.test(clean)) {
    return { ok: false, reason: "LOW_QUALITY_SURNAME" };
  }
  const rareChars = (clean.match(/[ЪЫЬЭЩФ]/gu) ?? []).length;
  const rareRatio = rareChars / Math.max(1, clean.length);
  if (rareRatio > 0.45) {
    return { ok: false, reason: "LOW_QUALITY_SURNAME" };
  }
  return { ok: true, reason: "OK" };
}

export function validateIssuedBy(value: string): string | null {
  if (value.trim().length === 0) {
    return null;
  }
  if (/[<‹«]/u.test(value) || value.includes("<<<")) {
    return null;
  }
  const normalized = normalizeRussianText(value)
    .split(" ")
    .filter((part) => !isNoiseToken(part))
    .join(" ");
  if (!ISSUED_BY_REGEX.test(normalized) || normalized.length < 12) {
    return null;
  }
  const normalizedForDigitChecks = normalized.replace(/O/gu, "0");
  const digits = (normalizedForDigitChecks.match(/\d/gu) ?? []).length;
  const nonSpaceChars = normalizedForDigitChecks.replace(/\s+/gu, "").length;
  const digitRatio = nonSpaceChars === 0 ? 0 : digits / nonSpaceChars;
  if (digitRatio > 0.1) {
    return null;
  }
  if (/\d{6,}/u.test(normalizedForDigitChecks) || /(?:\s|^)\d{4,}(?:\s|$)/u.test(normalizedForDigitChecks)) {
    return null;
  }
  const words = normalized.split(" ").filter((part) => /[А-ЯЁ]/u.test(part));
  if (words.length < 2) {
    return null;
  }
  const markersFound = /(ГУ|МВД|УФМС|РОССИИ)/u.test(normalized);
  if (!markersFound) {
    return null;
  }
  const singleLetterOrDots = normalized.match(/\b[А-ЯЁ]\b|[.]{2,}/gu)?.length ?? 0;
  if (singleLetterOrDots >= 10) {
    return null;
  }
  const nonAllowedChars = normalized.replace(/[А-ЯЁ0-9\s.,()"'-]/gu, "").length;
  const totalChars = normalized.replace(/\s+/gu, "").length;
  if (totalChars > 0 && nonAllowedChars / totalChars > 0.15) {
    return null;
  }
  return normalized;
}

export function validateRegistration(value: string): string | null {
  if (value.trim().length === 0) {
    return null;
  }
  const normalized = normalizeRussianText(value)
    .split(" ")
    .filter((part) => !isNoiseToken(part))
    .join(" ");
  if (!REGISTRATION_REGEX.test(normalized)) {
    return null;
  }
  if (!/\d/u.test(normalized)) {
    return null;
  }
  if (!/(УЛ\.|Д\.|КВ\.|Г\.)/u.test(normalized)) {
    return null;
  }
  return normalized;
}

function isNoiseToken(value: string): boolean {
  const clean = value.trim();
  if (clean.length <= 1) {
    return true;
  }
  if (/^[№-]+$/u.test(clean)) {
    return true;
  }
  return /^[ГК]$/u.test(clean);
}

function isSuspiciousFioWord(value: string): boolean {
  if (value.length < 3) {
    return true;
  }
  if (/^(.)\1{2,}$/u.test(value)) {
    return true;
  }
  if (/(ЧИИ|ИИИ|ННН|ШШШ)$/u.test(value)) {
    return true;
  }
  const uniqueChars = new Set(value).size;
  if (value.length >= 5 && uniqueChars <= 2) {
    return true;
  }
  return false;
}

function hasHighFioNoiseRatio(value: string): boolean {
  const compact = value.replace(/\s+/gu, "");
  if (compact.length === 0) {
    return true;
  }
  const noisyChars = (compact.match(/[0-9.,:;!?()[\]{}"'@#$%^&*_+=\\/|<>№]/gu) ?? []).length;
  return noisyChars / compact.length > 0.2;
}

function passesFioSurnameQualityGuard(surname: string): boolean {
  if (surname.length < 5) {
    return false;
  }
  if (!CYRILLIC_SURNAME_REGEX.test(surname)) {
    return false;
  }
  const nonLetterChars = surname.replace(/[А-ЯЁ]/gu, "").length;
  if (nonLetterChars > 0) {
    return false;
  }
  if (/(ЯО|ЙО|ЬО|ЪО)/u.test(surname)) {
    return false;
  }
  if (/[АЕЁИОУЫЭЮЯ]{3,}/u.test(surname)) {
    return false;
  }
  if (/[ЬЪЙ]{3,}/u.test(surname)) {
    return false;
  }
  return true;
}

function normalizeMrzLine(input: string): string {
  return input
    .replace(/[А]/gu, "A")
    .replace(/[В]/gu, "B")
    .replace(/[ЕЁ]/gu, "E")
    .replace(/[К]/gu, "K")
    .replace(/[М]/gu, "M")
    .replace(/[Н]/gu, "H")
    .replace(/[О]/gu, "O")
    .replace(/[Р]/gu, "P")
    .replace(/[С]/gu, "C")
    .replace(/[Т]/gu, "T")
    .replace(/[У]/gu, "Y")
    .replace(/[Х]/gu, "X")
    .replace(/[«»‹›]/gu, "<")
    .replace(/[15]/gu, "I")
    .replace(/0/gu, "O")
    .replace(/8/gu, "B")
    .replace(/[^A-Z0-9<]/gu, "");
}

function parseSingleMrzLine(line: string): MrzLatinFioTokens | null {
  const markerMatch = line.match(MRZ_MARKER_REGEX);
  if (markerMatch === null || markerMatch.index === undefined) {
    return null;
  }
  const marker = markerMatch[0];
  const tail = line.slice(markerMatch.index + marker.length).replace(/^[<]+/u, "");
  if (!tail.includes("<<")) {
    return null;
  }
  const chunks = tail
    .split(/<+/u)
    .map((chunk) => chunk.replace(/[^A-Z]/gu, ""))
    .filter((chunk) => chunk.length > 0);
  if (chunks.length < 2) {
    return null;
  }
  const surname = chunks[0] ?? "";
  const name = chunks[1] ?? "";
  const patronymic = chunks[2] ?? "";
  if (surname.length < 2 || name.length < 2) {
    return null;
  }
  return {
    surname,
    name,
    patronymic,
    marker,
    line
  };
}
