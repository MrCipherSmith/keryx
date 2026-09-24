// Flow 313 (W4 portability), T10 — importing an external Agent-Skills-standard
// catalog (W4-AC9). Read-only vetting (`vetExternalCatalog`) plus a
// reference-only recorder (`applyExternalImports`): an accepted candidate is
// never copied anywhere (not into `.metaproject/skills/`, not into
// `~/.keryx/skills/<name>/`, not into any bundle) — only its source directory
// and a per-file sha256 map are recorded in
// `~/.keryx/skills/external-imports.json`, so a later `keryx skills scout
// --include-imports` and `verifyExternalImports` can find and re-check it
// without Keryx ever owning a copy of someone else's skill content.

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";

import { pathExists } from "../lib/fs";
import { userStorePaths } from "../lib/keryx-home";
import { loadSkillCatalog } from "../gdskills/governance/catalog-index";
import { auditSkillSnapshot, collectSkillDirectorySnapshot, scoutSkill, type ScoutDecision } from "../gdskills/governance/scout";
import { parseSkillFrontmatter } from "../gdskills/skill-frontmatter";
import { sha256Hex } from "./checksum";

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LEN = 64;
const MAX_DESCRIPTION_LEN = 1024;

export type ExternalAuditGate = "pass" | "fail" | "not-applicable";

export interface ExternalCandidate {
  readonly name: string;
  readonly dir: string;
  readonly decision: "accepted" | "rejected";
  readonly reasons: string[];
  readonly scout: { readonly decision: ScoutDecision; readonly topMatch: string | null };
  readonly audit: { readonly gate: ExternalAuditGate; readonly findings: number };
  /** Not part of the public candidate shape a caller prints, but carried through to `applyExternalImports`. */
  readonly description: string;
  /** Relative path -> sha256, every regular file under `dir` (only populated once frontmatter/symlink checks pass). */
  readonly files: Readonly<Record<string, string>>;
}

export interface VetExternalCatalogOptions {
  catalogPath: string;
  projectRoot: string;
  env?: NodeJS.ProcessEnv | undefined;
  homeDir?: string | undefined;
}

export interface VetExternalCatalogResult {
  candidates: ExternalCandidate[];
}

export interface ExternalImportRecord {
  readonly sourceRef: string;
  readonly description: string;
  readonly files: Readonly<Record<string, string>>;
  readonly scoutDecision: ScoutDecision;
  readonly auditGate: ExternalAuditGate;
  readonly vettedAt: string;
}

export interface ExternalImportsRegistry {
  readonly schemaVersion: 1;
  readonly imports: Readonly<Record<string, ExternalImportRecord>>;
  /**
   * R1-F2 follow-up (flow 313 review round 1 fix): `sha256:<hex>` — an
   * HMAC-SHA256 (keyed with the per-user secret at
   * `~/.keryx/skills/.external-imports.key`) over the canonical (sorted-key)
   * JSON of `imports`. Only `applyExternalImports` ever computes and writes
   * this; `readExternalImports` recomputes it on every read and refuses the
   * registry (`corrupt-external-imports-registry`) if it doesn't match — a
   * bundle that plants `external-imports.json` directly (bypassing the
   * vetting gate entirely) cannot produce a value that verifies, since it
   * never had the secret.
   */
  readonly integrity: string;
}

export type ReadExternalImportsResult =
  | { ok: true; registry: ExternalImportsRegistry }
  | { ok: false; reason: "corrupt-external-imports-registry"; message: string };

function emptyRegistry(): ExternalImportsRegistry {
  // Never persisted verbatim: `applyExternalImports` always recomputes a
  // fresh `integrity` before writing. This placeholder only satisfies the
  // in-memory shape for "no registry file exists yet".
  return { schemaVersion: 1, imports: {}, integrity: "" };
}

function isValidRegistry(value: unknown): value is ExternalImportsRegistry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) return false;
  if (typeof v.integrity !== "string" || v.integrity.length === 0) return false;
  return typeof v.imports === "object" && v.imports !== null && !Array.isArray(v.imports);
}

/** Deterministic, sorted-key form of `imports` — the exact structure both `writeExternalImportsRegistry` persists and `computeImportsIntegrity` hashes, so the two can never drift apart. */
function sortImports(imports: Readonly<Record<string, ExternalImportRecord>>): Record<string, ExternalImportRecord> {
  const sorted: Record<string, ExternalImportRecord> = {};
  for (const key of Object.keys(imports).sort()) {
    const record = imports[key] as ExternalImportRecord;
    const sortedFiles: Record<string, string> = {};
    for (const filePathKey of Object.keys(record.files).sort()) {
      sortedFiles[filePathKey] = record.files[filePathKey] as string;
    }
    sorted[key] = { ...record, files: sortedFiles };
  }
  return sorted;
}

function computeImportsIntegrity(key: Buffer, imports: Readonly<Record<string, ExternalImportRecord>>): string {
  const canonical = JSON.stringify(sortImports(imports));
  return `sha256:${createHmac("sha256", key).update(canonical).digest("hex")}`;
}

function skillsRootFor(env: NodeJS.ProcessEnv, homeDir?: string): string {
  return userStorePaths(env, homeDir).skills;
}

function integrityKeyPathFor(env: NodeJS.ProcessEnv, homeDir?: string): string {
  return path.join(skillsRootFor(env, homeDir), ".external-imports.key");
}

/** Read-only: the per-user integrity key, or `undefined` when it does not exist yet. Never creates it — only `loadOrCreateIntegrityKey` (the write path) does. */
async function loadIntegrityKey(env: NodeJS.ProcessEnv, homeDir?: string): Promise<Buffer | undefined> {
  try {
    return await readFile(integrityKeyPathFor(env, homeDir));
  } catch {
    return undefined;
  }
}

/** Write path only (`applyExternalImports`): 32 random bytes, created with mode 0600 via an exclusive (`wx`) create on first use. A concurrent writer that wins the create race is read back rather than treated as an error. */
async function loadOrCreateIntegrityKey(env: NodeJS.ProcessEnv, homeDir?: string): Promise<Buffer> {
  const existing = await loadIntegrityKey(env, homeDir);
  if (existing !== undefined && existing.length > 0) return existing;

  const keyPath = integrityKeyPathFor(env, homeDir);
  await mkdir(path.dirname(keyPath), { recursive: true });
  const key = randomBytes(32);
  try {
    await writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      const raced = await loadIntegrityKey(env, homeDir);
      if (raced !== undefined && raced.length > 0) return raced;
    }
    throw err;
  }
}

/**
 * R1-F2 follow-up: a file directly under `~/.keryx/skills/` whose case-
 * folded, NFC-normalized name equals `external-imports.json` but is not the
 * canonical path itself. On a case-insensitive filesystem this can never
 * happen (there is only ever one file, whatever its original casing) — this
 * matters on a case-SENSITIVE one (Linux CI), where a bundle (or anything
 * else) could otherwise plant a second, distinct file right next to the real
 * registry that some other, less careful reader might pick up case-
 * insensitively. Exported as a pure matcher over a directory listing so it
 * is testable without depending on the host filesystem's own case
 * sensitivity.
 */
export function findCaseVariantSibling(names: readonly string[], canonicalBase: string): string | undefined {
  const target = canonicalBase.normalize("NFC").toLowerCase();
  for (const name of names) {
    if (name === canonicalBase) continue;
    if (name.normalize("NFC").toLowerCase() === target) return name;
  }
  return undefined;
}

/** Read `~/.keryx/skills/external-imports.json`; absent -> empty registry; corrupt, tampered, or shadowed by a case-variant sibling -> a named fail-closed reason. */
export async function readExternalImports(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): Promise<ReadExternalImportsResult> {
  const filePath = userStorePaths(env, homeDir).externalSkillImports;
  const skillsDir = skillsRootFor(env, homeDir);

  let siblingNames: string[];
  try {
    siblingNames = await readdir(skillsDir);
  } catch {
    siblingNames = [];
  }
  const caseVariant = findCaseVariantSibling(siblingNames, path.basename(filePath));
  if (caseVariant !== undefined) {
    return {
      ok: false,
      reason: "corrupt-external-imports-registry",
      message: `${path.join(skillsDir, caseVariant)} is a case-variant of external-imports.json; refusing to read either`,
    };
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { ok: true, registry: emptyRegistry() };
    return {
      ok: false,
      reason: "corrupt-external-imports-registry",
      message: `cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "corrupt-external-imports-registry",
      message: `${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isValidRegistry(parsed)) {
    return { ok: false, reason: "corrupt-external-imports-registry", message: `${filePath} has an unrecognized shape` };
  }

  const key = await loadIntegrityKey(env, homeDir);
  if (key === undefined) {
    return {
      ok: false,
      reason: "corrupt-external-imports-registry",
      message: `${filePath} exists but no per-user integrity key was found; the registry cannot be verified`,
    };
  }
  const expected = computeImportsIntegrity(key, parsed.imports);
  if (expected !== parsed.integrity) {
    return { ok: false, reason: "corrupt-external-imports-registry", message: `${filePath} failed integrity verification` };
  }

  return { ok: true, registry: parsed };
}

async function writeExternalImportsRegistry(
  env: NodeJS.ProcessEnv,
  homeDir: string | undefined,
  imports: Readonly<Record<string, ExternalImportRecord>>,
): Promise<void> {
  const filePath = userStorePaths(env, homeDir).externalSkillImports;
  await mkdir(path.dirname(filePath), { recursive: true });
  const key = await loadOrCreateIntegrityKey(env, homeDir);
  const sortedImports = sortImports(imports);
  const integrity = computeImportsIntegrity(key, imports);
  const payload = `${JSON.stringify({ schemaVersion: 1, imports: sortedImports, integrity }, null, 2)}\n`;
  const tmpPath = path.join(path.dirname(filePath), `.external-imports.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmpPath, payload, "utf8");
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

// --- vetting ----------------------------------------------------------------

/** A candidate is the catalog root itself (when it directly holds `SKILL.md`), else every immediate subdirectory that does. `skippedSymlinks` (R1-F28): every immediate entry that is itself a symlink — `readdir`'s `Dirent.isDirectory()` reports a symlinked directory as NOT a directory, so it used to be silently dropped from both lists rather than reported. */
async function candidateDirs(catalogPath: string): Promise<{ dirs: string[]; skippedSymlinks: string[] }> {
  if (await pathExists(path.join(catalogPath, "SKILL.md"))) {
    return { dirs: [catalogPath], skippedSymlinks: [] };
  }
  let entries;
  try {
    entries = await readdir(catalogPath, { withFileTypes: true });
  } catch {
    return { dirs: [], skippedSymlinks: [] };
  }
  const dirs: string[] = [];
  const skippedSymlinks: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(catalogPath, entry.name);
    if (entry.isSymbolicLink()) {
      skippedSymlinks.push(abs);
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (await pathExists(path.join(abs, "SKILL.md"))) dirs.push(abs);
  }
  return { dirs, skippedSymlinks };
}

async function collectFiles(dir: string, relPrefix: string, out: Map<string, Buffer>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = relPrefix.length > 0 ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collectFiles(abs, rel, out);
      continue;
    }
    if (entry.isFile()) out.set(rel, await readFile(abs));
  }
}

function filesMatch(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false;
  }
  return aKeys.every((key) => a[key] === b[key]);
}

interface PreparedCandidate {
  readonly dir: string;
  readonly snapshot: Awaited<ReturnType<typeof collectSkillDirectorySnapshot>>;
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly reasons: string[];
}

/**
 * Read-only: vet every candidate skill directory under `catalogPath` against
 * the project's own skill catalog (scout gate), the already-imported
 * registry, and the W8 harness audit — see the module header for what
 * "accepted" does and does not do.
 *
 * R1-F17 (flow 313 review round 1 fix): every candidate's files are read
 * exactly ONCE, via `collectSkillDirectorySnapshot` — the same in-memory
 * snapshot is hashed (`files` below) AND audited (`auditSkillSnapshot`), so
 * the bytes that get pinned into the registry can never differ from the
 * bytes that were actually scanned. `SKILL.md`'s frontmatter is parsed
 * straight from that same snapshot too, not a separate read.
 *
 * R1-F18: names are collected across the WHOLE batch before any candidate is
 * decided, so two directories that declare the same `name` are BOTH rejected
 * `duplicate-name` — neither one can silently win by import order.
 *
 * R1-F28: a catalog-root entry that is itself a symlink (`candidateDirs`'
 * `skippedSymlinks`) is reported as a rejected candidate (`symlink-refused`),
 * never silently dropped from the result.
 */
export async function vetExternalCatalog(opts: VetExternalCatalogOptions): Promise<VetExternalCatalogResult> {
  const { dirs, skippedSymlinks } = await candidateDirs(opts.catalogPath);
  const skillCatalog = loadSkillCatalog(opts.projectRoot, { scope: "all" });
  const existingImportsRead = await readExternalImports(opts.env ?? process.env, opts.homeDir);
  const existingImports = existingImportsRead.ok ? existingImportsRead.registry.imports : {};

  const prepared: PreparedCandidate[] = [];
  for (const dir of dirs) {
    const reasons: string[] = [];
    const snapshot = await collectSkillDirectorySnapshot(dir);
    let name: string | undefined;
    let description: string | undefined;

    if (!snapshot.ok) {
      reasons.push(snapshot.reason);
    } else {
      const skillMdBytes = snapshot.files.get("SKILL.md");
      const body = skillMdBytes !== undefined ? skillMdBytes.toString("utf8") : "";
      const frontmatter = parseSkillFrontmatter(body);
      name = frontmatter.name;
      description = frontmatter.description;
      const validName = name !== undefined && name.length <= MAX_NAME_LEN && SKILL_NAME_RE.test(name);
      const validDescription = description !== undefined && description.length > 0 && description.length <= MAX_DESCRIPTION_LEN;
      if (!validName || !validDescription) reasons.push("invalid-skill-frontmatter");
    }

    prepared.push({ dir, snapshot, name, description, reasons });
  }

  const nameCounts = new Map<string, number>();
  for (const candidate of prepared) {
    if (candidate.name === undefined) continue;
    nameCounts.set(candidate.name, (nameCounts.get(candidate.name) ?? 0) + 1);
  }

  const candidates: ExternalCandidate[] = [];

  for (const candidate of prepared) {
    const reasons = [...candidate.reasons];
    if (candidate.name !== undefined && (nameCounts.get(candidate.name) ?? 0) > 1) {
      reasons.push("duplicate-name");
    }

    let scoutResult: { decision: ScoutDecision; topMatch: string | null } = { decision: "create", topMatch: null };
    const files: Record<string, string> = {};
    let auditGate: ExternalAuditGate = "not-applicable";
    let findings = 0;

    if (reasons.length === 0 && candidate.snapshot.ok && candidate.name !== undefined && candidate.description !== undefined) {
      for (const [rel, bytes] of candidate.snapshot.files) files[rel] = sha256Hex(bytes);

      const scouted = scoutSkill(`${candidate.name} ${candidate.description}`, skillCatalog);
      scoutResult = { decision: scouted.decision, topMatch: scouted.matches[0]?.skillId ?? null };
      if (scouted.decision === "use") reasons.push("scout-duplicate");
      else if (scouted.decision === "fork") reasons.push("scout-overlap");

      const existingRecord = existingImports[candidate.name];
      if (existingRecord !== undefined && !filesMatch(existingRecord.files, files)) {
        reasons.push("already-imported");
      }

      if (reasons.length === 0) {
        const audited = await auditSkillSnapshot(candidate.snapshot.files);
        if (!audited.ok) {
          auditGate = "not-applicable";
          reasons.push("audit-not-applicable");
        } else {
          findings = audited.findings;
          const failing = (audited.bySeverity.high ?? 0) + (audited.bySeverity.critical ?? 0) > 0;
          auditGate = failing ? "fail" : "pass";
          if (failing) reasons.push("audit-failed");
        }
      }
    }

    candidates.push({
      name: candidate.name ?? path.basename(candidate.dir),
      dir: candidate.dir,
      decision: reasons.length === 0 ? "accepted" : "rejected",
      reasons,
      scout: scoutResult,
      audit: { gate: auditGate, findings },
      description: candidate.description ?? "",
      files,
    });
  }

  for (const skipped of skippedSymlinks) {
    candidates.push({
      name: path.basename(skipped),
      dir: skipped,
      decision: "rejected",
      reasons: ["symlink-refused"],
      scout: { decision: "create", topMatch: null },
      audit: { gate: "not-applicable", findings: 0 },
      description: "",
      files: {},
    });
  }

  return { candidates };
}

export type ApplyExternalImportsResult =
  | { ok: true; written: string[] }
  | { ok: false; reason: "corrupt-external-imports-registry"; message: string };

/**
 * Record every ACCEPTED candidate by reference: no skill file is copied
 * anywhere. A rejected candidate is never written. Idempotent for a candidate
 * whose files already match the recorded entry.
 */
export async function applyExternalImports(
  result: VetExternalCatalogResult,
  opts: { env?: NodeJS.ProcessEnv | undefined; homeDir?: string | undefined; now?: (() => Date) | undefined } = {},
): Promise<ApplyExternalImportsResult> {
  const accepted = result.candidates.filter((c) => c.decision === "accepted");
  if (accepted.length === 0) return { ok: true, written: [] };

  const read = await readExternalImports(opts.env ?? process.env, opts.homeDir);
  if (!read.ok) return read;

  const now = opts.now ?? (() => new Date());
  const imports: Record<string, ExternalImportRecord> = { ...read.registry.imports };
  for (const candidate of accepted) {
    imports[candidate.name] = {
      sourceRef: candidate.dir,
      description: candidate.description,
      files: candidate.files,
      scoutDecision: candidate.scout.decision,
      auditGate: candidate.audit.gate,
      vettedAt: now().toISOString(),
    };
  }

  await writeExternalImportsRegistry(opts.env ?? process.env, opts.homeDir, imports);
  return { ok: true, written: accepted.map((c) => c.name) };
}

// --- verify -------------------------------------------------------------

export type VerifyExternalImportEntryStatus = "ok" | "unresolvable" | "checksum-mismatch" | "unlisted-file";

export interface VerifyExternalImportsEntryResult {
  readonly name: string;
  readonly status: VerifyExternalImportEntryStatus;
  readonly message?: string;
}

export interface VerifyExternalImportsResult {
  readonly ok: boolean;
  readonly entries: VerifyExternalImportsEntryResult[];
  readonly refusal?: { readonly reason: string; readonly message: string };
}

async function listFilesRecursively(dir: string): Promise<string[]> {
  const out: string[] = [];
  const fileBytes = new Map<string, Buffer>();
  await collectFiles(dir, "", fileBytes);
  for (const rel of fileBytes.keys()) out.push(rel);
  return out.sort();
}

/** Per import: `ok`, `unresolvable` (sourceRef or a listed file missing), `checksum-mismatch` (a listed file changed), or `unlisted-file` (a file on disk not in the recorded set). */
export async function verifyExternalImports(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): Promise<VerifyExternalImportsResult> {
  const read = await readExternalImports(env, homeDir);
  if (!read.ok) {
    return { ok: false, entries: [], refusal: { reason: read.reason, message: read.message } };
  }

  const entries: VerifyExternalImportsEntryResult[] = [];
  for (const [name, record] of Object.entries(read.registry.imports)) {
    if (!(await pathExists(record.sourceRef))) {
      entries.push({ name, status: "unresolvable", message: `${record.sourceRef} does not exist` });
      continue;
    }

    let status: VerifyExternalImportEntryStatus = "ok";
    let message: string | undefined;

    for (const [rel, sha] of Object.entries(record.files)) {
      const abs = path.join(record.sourceRef, ...rel.split("/"));
      let bytes: Buffer;
      try {
        bytes = await readFile(abs);
      } catch {
        status = "unresolvable";
        message = `${rel} is missing under ${record.sourceRef}`;
        break;
      }
      if (sha256Hex(bytes) !== sha) {
        status = "checksum-mismatch";
        message = `${rel} sha256 no longer matches the recorded value`;
        break;
      }
    }

    if (status === "ok") {
      const listed = new Set(Object.keys(record.files));
      const actual = await listFilesRecursively(record.sourceRef);
      const extra = actual.filter((rel) => !listed.has(rel));
      if (extra.length > 0) {
        status = "unlisted-file";
        message = `file(s) present but not recorded: ${extra.join(", ")}`;
      }
    }

    entries.push({ name, status, ...(message !== undefined ? { message } : {}) });
  }

  return { ok: entries.every((e) => e.status === "ok"), entries };
}
