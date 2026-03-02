export declare const FIXTURE_CASE_IDS: readonly ["case1", "case2"];
export declare const FIXTURE_KINDS: readonly ["pdf", "png"];
export type FixtureCaseId = (typeof FIXTURE_CASE_IDS)[number];
export type FixtureKind = (typeof FIXTURE_KINDS)[number];
export declare const FIXTURE_RELATIVE_FILES: Record<FixtureCaseId, Record<FixtureKind, {
    passport: string;
    registration: string;
}>>;
export declare const MAX_INPUT_BYTES: number;
export declare const SANDBOX_ALLOWED_EXTENSIONS: Set<string>;
export declare function resolveRepoRoot(importMetaUrl: string): string;
export declare function resolvePathInsideRoot(rootDir: string, relativePath: string): string;
export declare function validateSafeInputFile(filePath: string, allowedExtensions?: Set<string>): Promise<string>;
export declare function resolveFixturePairPaths(repoRoot: string, caseId: FixtureCaseId, kind: FixtureKind): Promise<{
    passportPath: string;
    registrationPath: string;
    passportRelativePath: string;
    registrationRelativePath: string;
}>;
