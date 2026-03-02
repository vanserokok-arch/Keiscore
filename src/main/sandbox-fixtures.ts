import { existsSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_CASE_IDS = ["case1", "case2"] as const;
export const FIXTURE_KINDS = ["pdf", "png"] as const;
export const FIXTURE_DOCS = ["passport", "registration"] as const;
export type FixtureCaseId = (typeof FIXTURE_CASE_IDS)[number];
export type FixtureKind = (typeof FIXTURE_KINDS)[number];
export type FixtureDoc = (typeof FIXTURE_DOCS)[number];

export const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const CASE_ID_ALLOWLIST = new Set<string>(FIXTURE_CASE_IDS);
const KIND_ALLOWLIST = new Set<string>(FIXTURE_KINDS);
const DOC_ALLOWLIST = new Set<string>(FIXTURE_DOCS);
const KIND_TO_EXTENSION: Record<FixtureKind, ".pdf" | ".png"> = {
  pdf: ".pdf",
  png: ".png"
};

export function resolveRepoRoot(importMetaUrl: string): string {
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

function buildSecurityViolation(message: string, details?: Record<string, unknown>): Error & { code: "SECURITY_VIOLATION" } {
  const wrapped = new Error(message) as Error & { code: "SECURITY_VIOLATION"; details?: Record<string, unknown> };
  wrapped.code = "SECURITY_VIOLATION";
  if (details !== undefined) {
    wrapped.details = details;
  }
  return wrapped;
}

export async function validateSafeInputFile(filePath: string, allowedExtensions = new Set([".pdf", ".png"])): Promise<string> {
  const normalized = resolve(filePath);
  if (!isAbsolute(normalized)) {
    throw buildSecurityViolation("Path must be absolute.", { path: filePath });
  }

  const ext = extname(normalized).toLowerCase();
  if (!allowedExtensions.has(ext)) {
    throw buildSecurityViolation("Unsupported file extension.", { path: normalized, ext });
  }

  const fileLinkStats = await lstat(normalized).catch(() => null);
  if (fileLinkStats === null || fileLinkStats.isSymbolicLink()) {
    throw buildSecurityViolation("File is missing or symbolic link.", { path: normalized });
  }

  const fileStats = await stat(normalized).catch(() => null);
  if (fileStats === null || !fileStats.isFile()) {
    throw buildSecurityViolation("File does not exist.", { path: normalized });
  }
  if (fileStats.size > MAX_INPUT_BYTES) {
    throw buildSecurityViolation("File exceeds 50MB limit.", { path: normalized, size: fileStats.size });
  }
  return normalized;
}

async function assertPathHasNoSymlink(rootDir: string, absolutePath: string): Promise<void> {
  const rel = relative(rootDir, absolutePath);
  const segments = rel.split(/[\\/]/u).filter((segment) => segment.length > 0);
  let cursor = rootDir;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    const linkStats = await lstat(cursor).catch(() => null);
    if (linkStats !== null && linkStats.isSymbolicLink()) {
      throw buildSecurityViolation("Symbolic links are not allowed for fixtures.", { path: cursor });
    }
  }
}

function assertFromAllowlist(value: string, allowed: Set<string>, label: string): void {
  if (!allowed.has(value)) {
    throw buildSecurityViolation(`Invalid ${label}.`, { [label]: value });
  }
}

function buildFixtureCandidates(caseId: FixtureCaseId, kind: FixtureKind, doc: FixtureDoc): string[] {
  if (kind === "png") {
    return [`${caseId}/png/${doc}.png`];
  }
  const primary = `${caseId}/pdf/${doc}.pdf`;
  if (caseId === "case1") {
    const fallback = doc === "passport" ? "1.pdf" : "2.pdf";
    return [primary, `${caseId}/pdf/${fallback}`];
  }
  return [primary];
}

async function validateFixtureCandidate(fixturesRootAbs: string, candidateRelativePath: string, kind: FixtureKind): Promise<string | null> {
  const candidateAbsolute = resolve(fixturesRootAbs, candidateRelativePath);
  const relFromRoot = relative(fixturesRootAbs, candidateAbsolute);
  if (relFromRoot === "" || relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) {
    throw buildSecurityViolation("Fixture path escapes fixtures root.", { candidateRelativePath });
  }

  const fixtureRootReal = await realpath(fixturesRootAbs).catch(() => null);
  if (fixtureRootReal === null) {
    throw buildSecurityViolation("Fixtures root does not exist.", { fixturesRoot: fixturesRootAbs });
  }

  const exists = await stat(candidateAbsolute).catch(() => null);
  if (exists === null) {
    return null;
  }

  await assertPathHasNoSymlink(fixturesRootAbs, candidateAbsolute);
  const candidateReal = await realpath(candidateAbsolute).catch(() => null);
  if (candidateReal === null) {
    throw buildSecurityViolation("Fixture path cannot be resolved.", { candidatePath: candidateAbsolute });
  }

  const relReal = relative(fixtureRootReal, candidateReal);
  if (relReal === "" || relReal.startsWith("..") || isAbsolute(relReal) || relReal.startsWith(`..${sep}`)) {
    throw buildSecurityViolation("Fixture real path escapes fixtures root.", { candidatePath: candidateAbsolute });
  }

  const expectedExt = KIND_TO_EXTENSION[kind];
  const ext = extname(candidateReal).toLowerCase();
  if (ext !== expectedExt) {
    throw buildSecurityViolation("Fixture has unsupported extension.", { candidatePath: candidateAbsolute, ext, kind });
  }

  await validateSafeInputFile(candidateReal, new Set([expectedExt]));
  return candidateReal;
}

export const REPO_ROOT = resolveRepoRoot(import.meta.url);
export const FIXTURES_ROOT = join(REPO_ROOT, "fixtures");

export async function resolveFixturePath(
  caseId: string,
  kind: string,
  doc: string,
  fixturesRoot = FIXTURES_ROOT
): Promise<{ absolutePath: string; relativePath: string }> {
  assertFromAllowlist(caseId, CASE_ID_ALLOWLIST, "caseId");
  assertFromAllowlist(kind, KIND_ALLOWLIST, "kind");
  assertFromAllowlist(doc, DOC_ALLOWLIST, "doc");

  const narrowedCase = caseId as FixtureCaseId;
  const narrowedKind = kind as FixtureKind;
  const narrowedDoc = doc as FixtureDoc;

  const candidates = buildFixtureCandidates(narrowedCase, narrowedKind, narrowedDoc);
  for (const candidateRelativePath of candidates) {
    const candidate = await validateFixtureCandidate(fixturesRoot, candidateRelativePath, narrowedKind);
    if (candidate !== null) {
      return {
        absolutePath: candidate,
        relativePath: join("fixtures", candidateRelativePath)
      };
    }
  }

  throw buildSecurityViolation("Fixture file not found.", { caseId, kind, doc, tried: candidates });
}

export async function resolveFixturePairPaths(caseId: string, kind: string): Promise<{
  passport: { absolutePath: string; relativePath: string };
  registration: { absolutePath: string; relativePath: string };
}> {
  const passport = await resolveFixturePath(caseId, kind, "passport");
  const registration = await resolveFixturePath(caseId, kind, "registration");
  return {
    passport,
    registration
  };
}
