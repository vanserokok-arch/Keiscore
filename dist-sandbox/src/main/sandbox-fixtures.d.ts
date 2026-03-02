export declare const FIXTURE_CASE_IDS: readonly ["case1", "case2"];
export declare const FIXTURE_KINDS: readonly ["pdf", "png"];
export declare const FIXTURE_DOCS: readonly ["passport", "registration"];
export type FixtureCaseId = (typeof FIXTURE_CASE_IDS)[number];
export type FixtureKind = (typeof FIXTURE_KINDS)[number];
export type FixtureDoc = (typeof FIXTURE_DOCS)[number];
export declare const MAX_INPUT_BYTES: number;
export declare function resolveRepoRoot(importMetaUrl: string): string;
export declare function validateSafeInputFile(filePath: string, allowedExtensions?: Set<string>): Promise<string>;
export declare const REPO_ROOT: string;
export declare const FIXTURES_ROOT: string;
export declare function resolveFixturePath(caseId: string, kind: string, doc: string, fixturesRoot?: string): Promise<{
    absolutePath: string;
    relativePath: string;
}>;
export declare function resolveFixturePairPaths(caseId: string, kind: string): Promise<{
    passport: {
        absolutePath: string;
        relativePath: string;
    };
    registration: {
        absolutePath: string;
        relativePath: string;
    };
}>;
