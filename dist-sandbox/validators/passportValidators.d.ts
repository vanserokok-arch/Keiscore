export declare const PASSPORT_NUMBER_REGEX: RegExp;
export declare const DEPT_CODE_REGEX: RegExp;
export declare const FIO_REGEX: RegExp;
export declare const ISSUED_BY_REGEX: RegExp;
export declare const REGISTRATION_REGEX: RegExp;
export declare function validatePassportNumber(value: string): string | null;
export declare function validateDeptCode(value: string): string | null;
export declare function validateFio(value: string): string | null;
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
export declare function parseMrzLatinFio(value: string): MrzLatinFioTokens | null;
export declare function transliterateMrzLatinToCyrillic(input: string): string;
export declare function assessFioSurnameQuality(surname: string): SurnameQualityResult;
export declare function validateIssuedBy(value: string): string | null;
export declare function validateRegistration(value: string): string | null;
