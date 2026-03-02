import { existsSync } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const FIXTURE_CASE_IDS = ["case1", "case2"];
export const FIXTURE_KINDS = ["pdf", "png"];
export const FIXTURE_RELATIVE_FILES = {
    case1: {
        pdf: {
            passport: "case1/pdf/passport.pdf",
            registration: "case1/pdf/registration.pdf"
        },
        png: {
            passport: "case1/png/passport.png",
            registration: "case1/png/registration.png"
        }
    },
    case2: {
        pdf: {
            passport: "case2/pdf/passport.pdf",
            registration: "case2/pdf/registration.pdf"
        },
        png: {
            passport: "case2/png/passport.png",
            registration: "case2/png/registration.png"
        }
    }
};
export const MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const SANDBOX_ALLOWED_EXTENSIONS = new Set([".pdf", ".png"]);
export function resolveRepoRoot(importMetaUrl) {
    let cursor = dirname(fileURLToPath(importMetaUrl));
    while (true) {
        if (existsSync(join(cursor, "package.json"))) {
            return cursor;
        }
        const parent = dirname(cursor);
        if (parent === cursor) {
            throw new Error("Failed to resolve repository root from import.meta.url");
        }
        cursor = parent;
    }
}
export function resolvePathInsideRoot(rootDir, relativePath) {
    const fullPath = resolve(rootDir, relativePath);
    const relFromRoot = relative(rootDir, fullPath);
    if (relFromRoot === "" || relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) {
        throw new Error("Path escapes allowed root.");
    }
    return fullPath;
}
export async function validateSafeInputFile(filePath, allowedExtensions = SANDBOX_ALLOWED_EXTENSIONS) {
    const normalized = resolve(filePath);
    if (!isAbsolute(normalized)) {
        throw new Error("Path must be absolute.");
    }
    const ext = extname(normalized).toLowerCase();
    if (!allowedExtensions.has(ext)) {
        throw new Error("Unsupported file extension.");
    }
    const fileLinkStats = await lstat(normalized).catch(() => null);
    if (fileLinkStats === null || fileLinkStats.isSymbolicLink()) {
        throw new Error("File is missing or symbolic link.");
    }
    const fileStats = await stat(normalized).catch(() => null);
    if (fileStats === null || !fileStats.isFile()) {
        throw new Error("File does not exist.");
    }
    if (fileStats.size > MAX_INPUT_BYTES) {
        throw new Error("File exceeds 50MB limit.");
    }
    return normalized;
}
export async function resolveFixturePairPaths(repoRoot, caseId, kind) {
    const mapping = FIXTURE_RELATIVE_FILES[caseId][kind];
    const fixturesRoot = join(repoRoot, "fixtures");
    const passportPath = resolvePathInsideRoot(fixturesRoot, mapping.passport);
    const registrationPath = resolvePathInsideRoot(fixturesRoot, mapping.registration);
    await validateSafeInputFile(passportPath);
    await validateSafeInputFile(registrationPath);
    return {
        passportPath,
        registrationPath,
        passportRelativePath: join("fixtures", mapping.passport),
        registrationRelativePath: join("fixtures", mapping.registration)
    };
}
//# sourceMappingURL=sandbox-fixtures.js.map