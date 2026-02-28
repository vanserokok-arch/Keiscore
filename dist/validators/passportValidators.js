import { normalizeDeptCode, normalizeFioCandidate, normalizePassportNumber, normalizeRussianText } from "../format/textNormalizer.js";
export const PASSPORT_NUMBER_REGEX = /^\d{10}$/u;
export const DEPT_CODE_REGEX = /^\d{3}-\d{3}$/u;
export const FIO_REGEX = /^[А-ЯЁ-]+(?:\s+[А-ЯЁ-]+){2}$/u;
export const ISSUED_BY_REGEX = /^[А-ЯЁ0-9\s"().,\-]{10,}$/u;
export const REGISTRATION_REGEX = /^[А-ЯЁ0-9\s"().,\-]{20,}$/u;
export function validatePassportNumber(value) {
    const compact = normalizePassportNumber(value);
    if (!PASSPORT_NUMBER_REGEX.test(compact)) {
        return null;
    }
    return `${compact.slice(0, 4)} №${compact.slice(4)}`;
}
export function validateDeptCode(value) {
    const normalized = normalizeDeptCode(value);
    if (!DEPT_CODE_REGEX.test(normalized)) {
        return null;
    }
    return normalized;
}
export function validateFio(value) {
    const normalized = normalizeFioCandidate(value);
    if (normalized === null) {
        return null;
    }
    if (!FIO_REGEX.test(normalized)) {
        return null;
    }
    const parts = normalized.split(" ");
    if (parts.length !== 3 || parts.some((part) => part.length < 3 || isNoiseToken(part))) {
        return null;
    }
    return normalized;
}
export function validateIssuedBy(value) {
    const normalized = normalizeRussianText(value)
        .split(" ")
        .filter((part) => !isNoiseToken(part))
        .join(" ");
    if (!ISSUED_BY_REGEX.test(normalized)) {
        return null;
    }
    if (!/(ГУ|МВД|УФМС|ОТДЕЛ)/u.test(normalized)) {
        return null;
    }
    return normalized;
}
export function validateRegistration(value) {
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
function isNoiseToken(value) {
    const clean = value.trim();
    if (clean.length <= 1) {
        return true;
    }
    if (/^[№-]+$/u.test(clean)) {
        return true;
    }
    return /^[ГК]$/u.test(clean);
}
//# sourceMappingURL=passportValidators.js.map