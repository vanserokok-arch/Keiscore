const CYRILLIC_UPPER_REGEX = /^[А-ЯЁ]+$/u;
function normalizeWhitespace(value) {
    return value.replace(/\s+/gu, " ").trim();
}
function stripControlAndJunk(value) {
    return value
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .replace(/[^\p{L}\p{N}\s\-./,"()]/gu, " ");
}
function collapseRepeatedChars(value) {
    return value.replace(/(.)\1{2,}/gu, "$1$1");
}
function toRussianVisualGlyphs(value) {
    return value
        .replaceAll("B", "В")
        .replaceAll("M", "М")
        .replaceAll("H", "Н")
        .replaceAll("P", "Р")
        .replaceAll("C", "С")
        .replaceAll("T", "Т")
        .replaceAll("Y", "У")
        .replaceAll("X", "Х")
        .replaceAll("A", "А")
        .replaceAll("E", "Е")
        .replaceAll("K", "К")
        .replaceAll("O", "О");
}
export function normalizeRussianText(input) {
    const upper = input.toUpperCase();
    const text = stripControlAndJunk(upper);
    const visual = toRussianVisualGlyphs(text);
    const withDigits = visual
        .replaceAll("|", "1")
        .replaceAll("I", "1")
        .replaceAll("L", "1")
        .replaceAll("0", "О");
    return normalizeWhitespace(collapseRepeatedChars(withDigits));
}
export function normalizePassportNumber(input) {
    const upper = input.toUpperCase();
    const withDigits = upper
        .replaceAll("O", "0")
        .replaceAll("О", "0")
        .replaceAll("I", "1")
        .replaceAll("|", "1")
        .replaceAll("L", "1")
        .replaceAll("B", "8")
        .replaceAll("S", "5");
    const digits = withDigits.replace(/[^\d]/gu, "");
    const collapsed = collapseRepeatedChars(digits);
    if (collapsed.length <= 10) {
        return collapsed;
    }
    return collapsed.slice(0, 10);
}
export function normalizeDeptCode(input) {
    const upper = input.toUpperCase();
    const withDigits = upper
        .replaceAll("O", "0")
        .replaceAll("О", "0")
        .replaceAll("I", "1")
        .replaceAll("|", "1")
        .replaceAll("L", "1");
    const compact = withDigits.replace(/[^\d-]/gu, "").replace(/-{2,}/gu, "-");
    const digits = compact.replace(/[^\d]/gu, "");
    if (!compact.includes("-")) {
        if (digits.length >= 6) {
            const prepared = digits.slice(0, 6);
            return `${prepared.slice(0, 3)}-${prepared.slice(3)}`;
        }
        return digits;
    }
    const [leftRaw, rightRaw] = compact.split("-", 2);
    const leftDigits = (leftRaw ?? "").replace(/[^\d]/gu, "");
    const rightDigits = (rightRaw ?? "").replace(/[^\d]/gu, "");
    return `${leftDigits}-${rightDigits}`;
}
export function normalizeFioCandidate(input) {
    const normalized = normalizeRussianText(input)
        .replace(/[^\p{sc=Cyrillic}\s-]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
    const stopFragments = [
        "ФАМИ",
        "ИМЯ",
        "ОТЧЕ",
        "ОТСТВ",
        "ПОЛ",
        "ЖЕН",
        "МУЖ",
        "РОЖД",
        "МЕСТО",
        "ВЫДА"
    ];
    const words = normalized
        .split(" ")
        .map((word) => word.trim())
        .filter((word) => word.length >= 3 &&
        CYRILLIC_UPPER_REGEX.test(word) &&
        !stopFragments.some((fragment) => word.includes(fragment)));
    if (words.length < 2) {
        return null;
    }
    if (words.length > 3) {
        for (let i = 0; i <= words.length - 3; i += 1) {
            const triple = words.slice(i, i + 3);
            if (triple.every((word) => word.length >= 3)) {
                return triple.join(" ");
            }
        }
        return words.slice(0, 3).join(" ");
    }
    return words.join(" ");
}
//# sourceMappingURL=textNormalizer.js.map