// Flow 313 (W4 portability), T10 — importing an external Agent-Skills-standard
// catalog (W4-AC9). Read-only vetting (`vetExternalCatalog`) plus a
// reference-only recorder (`applyExternalImports`): an accepted candidate is
// never copied anywhere (not into `.metaproject/skills/`, not into
// `~/.keryx/skills/<name>/`, not into any bundle) — only its source directory
// and a per-file sha256 map are recorded in
// `~/.keryx/skills/external-imports.json`, so a later `keryx skills scout
// --include-imports` and `verifyExternalImports` can find and re-check it
// without Keryx ever owning a copy of someone else's skill content.

import { mkdir, lstat, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

import { pathExists } from "../lib/fs";
import { userStorePaths } from "../lib/keryx-home";
import { loadSkillCatalog } from "../gdskills/governance/catalog-index";
import {
  auditSkillSnapshot,
  collectSkillDirectorySnapshot,
  scoutSkill,
  type ScoutDecision,
  type SnapshotCollectFailureReason,
} from "../gdskills/governance/scout";
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
  /**
   * R2-F2 follow-up (flow 313 review round 2 fix): a monotonically
   * increasing counter, included in the MAC input below alongside
   * `schemaVersion`. Without it, an attacker who once captured a valid
   * (registry bytes, integrity) pair could replay those exact bytes later
   * to roll the registry back to a prior state and still pass integrity
   * verification — the MAC alone doesn't prove FRESHNESS, only that the
   * signer produced these exact bytes at some point.
   */
  readonly version: number;
  readonly imports: Readonly<Record<string, ExternalImportRecord>>;
  /**
   * R1-F2 follow-up (flow 313 review round 1 fix): `sha256:<hex>` — an
   * HMAC-SHA256 (keyed with the per-user secret at
   * `~/.keryx/state/external-imports.key`, R2-F2: moved out of the
   * bundle-writable `skills/` tree) over the canonical (sorted-key) JSON of
   * `{schemaVersion, version, imports}`. Only `applyExternalImports` ever
   * computes and writes this; `readExternalImports` recomputes it on every
   * read and refuses the registry (`corrupt-external-imports-registry`) if
   * it doesn't match — a bundle that plants `external-imports.json` directly
   * (bypassing the vetting gate entirely) cannot produce a value that
   * verifies, since it never had the secret. Compared with
   * `crypto.timingSafeEqual`, not `!==` (R2-F2).
   */
  readonly integrity: string;
}

export type ReadExternalImportsResult =
  | { ok: true; registry: ExternalImportsRegistry }
  | {
      ok: false;
      reason: "corrupt-external-imports-registry" | "external-imports-key-missing" | "external-imports-key-invalid";
      message: string;
    };

function emptyRegistry(): ExternalImportsRegistry {
  // Never persisted verbatim: `applyExternalImports` always recomputes a
  // fresh `integrity` (and bumps `version`) before writing. This
  // placeholder only satisfies the in-memory shape for "no registry file
  // exists yet" — `version: 0` is a sentinel a real, persisted registry
  // (see `isValidRegistry`, which requires `version >= 1`) can never have.
  return { schemaVersion: 1, version: 0, imports: {}, integrity: "" };
}

function isValidRegistry(value: unknown): value is ExternalImportsRegistry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) return false;
  if (typeof v.integrity !== "string" || v.integrity.length === 0) return false;
  if (typeof v.version !== "number" || !Number.isInteger(v.version) || v.version < 1) return false;
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

/** R2-F2 follow-up: the MAC input now names `schemaVersion` and `version` explicitly (not just `imports`), so neither an older schema nor a replayed earlier version can be silently reinterpreted as a different, still-"valid" document. */
function computeImportsIntegrity(
  key: Buffer,
  schemaVersion: 1,
  version: number,
  imports: Readonly<Record<string, ExternalImportRecord>>,
): string {
  const canonical = JSON.stringify({ schemaVersion, version, imports: sortImports(imports) });
  return `sha256:${createHmac("sha256", key).update(canonical).digest("hex")}`;
}

function skillsRootFor(env: NodeJS.ProcessEnv, homeDir?: string): string {
  return userStorePaths(env, homeDir).skills;
}

/**
 * R2-F2 (flow 313 review round 2, L2 "trust in attacker-writable state"
 * class): the integrity key. Formerly `~/.keryx/skills/.external-imports.key`
 * — inside the very tree a user-scope bundle writes to, so a bundle landing
 * first on a fresh home (before any external import ever ran) could plant
 * the key itself and thereafter sign any registry it wants. Now under
 * `~/.keryx/state/`, a reserved tree `src/bundle/paths.ts` refuses every
 * bundle apply target against (L1's "path identity" class). An old key
 * sitting at the former `skills/.external-imports.key` path — whether left
 * over or planted — is never read from here again: this function only ever
 * builds the new `state/` path, and that old path is itself now reserved so
 * nothing can write there through a bundle either.
 */
function integrityKeyPathFor(env: NodeJS.ProcessEnv, homeDir?: string): string {
  return userStorePaths(env, homeDir).externalImportsKey;
}

type IntegrityKeyLoadResult =
  | { readonly ok: true; readonly key: Buffer }
  | { readonly ok: false; readonly reason: "missing" }
  | { readonly ok: false; readonly reason: "invalid"; readonly message: string };

/**
 * Read-only: the per-user integrity key, validated against every property
 * that makes it trustworthy as a secret (R2-F2) — `missing` when the file
 * simply doesn't exist yet (the normal "never imported anything" state),
 * `invalid` with a named reason for anything else that makes the file
 * untrustworthy: a symlink (could point anywhere, including somewhere an
 * attacker controls), not a regular file, wrong mode, owned by someone
 * else, or not exactly 32 bytes (including empty — a zero-length "key"
 * would make the HMAC trivially reproducible). Never creates or repairs the
 * key — only `loadOrCreateIntegrityKey` (the write path) does, and even it
 * refuses rather than silently overwriting an `invalid` key.
 */
async function loadIntegrityKey(env: NodeJS.ProcessEnv, homeDir?: string): Promise<IntegrityKeyLoadResult> {
  const keyPath = integrityKeyPathFor(env, homeDir);
  let st;
  try {
    st = await lstat(keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "invalid", message: `cannot stat ${keyPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, reason: "invalid", message: `${keyPath} is a symlink; refusing to trust it as the integrity key` };
  }
  if (!st.isFile()) {
    return { ok: false, reason: "invalid", message: `${keyPath} is not a regular file` };
  }
  if ((st.mode & 0o777) !== 0o600) {
    return { ok: false, reason: "invalid", message: `${keyPath} has mode ${(st.mode & 0o777).toString(8)}, expected 0600` };
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    return { ok: false, reason: "invalid", message: `${keyPath} is not owned by the current user` };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(keyPath);
  } catch (err) {
    return { ok: false, reason: "invalid", message: `cannot read ${keyPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (bytes.length !== 32) {
    return { ok: false, reason: "invalid", message: `${keyPath} is ${bytes.length} byte(s), expected exactly 32` };
  }
  return { ok: true, key: bytes };
}

type IntegrityKeyResult =
  | { readonly ok: true; readonly key: Buffer }
  | { readonly ok: false; readonly reason: "external-imports-key-invalid"; readonly message: string };

/**
 * Write path only (`applyExternalImports`): 32 random bytes, created with
 * mode 0600 via an exclusive (`wx`) create on first use. A concurrent
 * writer that wins the create race is read back rather than treated as an
 * error. R2-F2: an EXISTING key that fails `loadIntegrityKey`'s validation
 * is never silently regenerated or overwritten — that would let an attacker
 * force a fresh, attacker-observed key into place just by planting a bad
 * one first. It is a refusal instead.
 */
async function loadOrCreateIntegrityKey(env: NodeJS.ProcessEnv, homeDir?: string): Promise<IntegrityKeyResult> {
  const existing = await loadIntegrityKey(env, homeDir);
  if (existing.ok) return existing;
  if (existing.reason === "invalid") {
    return { ok: false, reason: "external-imports-key-invalid", message: existing.message };
  }

  const keyPath = integrityKeyPathFor(env, homeDir);
  await mkdir(path.dirname(keyPath), { recursive: true });
  const key = randomBytes(32);
  try {
    await writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
    return { ok: true, key };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      const raced = await loadIntegrityKey(env, homeDir);
      if (raced.ok) return raced;
      if (raced.reason === "invalid") {
        return { ok: false, reason: "external-imports-key-invalid", message: raced.message };
      }
      return { ok: false, reason: "external-imports-key-invalid", message: `${keyPath} disappeared immediately after being created` };
    }
    return { ok: false, reason: "external-imports-key-invalid", message: err instanceof Error ? err.message : String(err) };
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

  // R2-F2: the registry exists but the key does not — this must NEVER
  // silently regenerate a fresh key (that would just let the imports go
  // unverifiable forever, one new key at a time) — it is a distinct, named
  // refusal from a merely corrupt registry, so a caller (and a test) can
  // tell "someone deleted/never had the key" apart from "the bytes don't
  // match". An invalid (symlinked/wrong-mode/wrong-owner/wrong-size) key is
  // equally named and distinct from both.
  const keyResult = await loadIntegrityKey(env, homeDir);
  if (!keyResult.ok) {
    if (keyResult.reason === "missing") {
      return {
        ok: false,
        reason: "external-imports-key-missing",
        message: `${filePath} exists but the per-user integrity key at ${integrityKeyPathFor(env, homeDir)} is missing; refusing to regenerate it silently`,
      };
    }
    return { ok: false, reason: "external-imports-key-invalid", message: keyResult.message };
  }

  const expected = computeImportsIntegrity(keyResult.key, parsed.schemaVersion, parsed.version, parsed.imports);
  // R2-F2: compared with `timingSafeEqual`, not `!==` — a plain string
  // comparison leaks how many leading bytes matched through timing, which
  // is exactly the kind of oracle an HMAC scheme is meant not to have.
  // `timingSafeEqual` throws on mismatched lengths, so that case is handled
  // explicitly rather than by catching.
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(parsed.integrity, "utf8");
  const verified = expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
  if (!verified) {
    return { ok: false, reason: "corrupt-external-imports-registry", message: `${filePath} failed integrity verification` };
  }

  return { ok: true, registry: parsed };
}

type WriteRegistryResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "external-imports-key-invalid"; readonly message: string };

async function writeExternalImportsRegistry(
  env: NodeJS.ProcessEnv,
  homeDir: string | undefined,
  imports: Readonly<Record<string, ExternalImportRecord>>,
  version: number,
): Promise<WriteRegistryResult> {
  const filePath = userStorePaths(env, homeDir).externalSkillImports;
  await mkdir(path.dirname(filePath), { recursive: true });
  const keyResult = await loadOrCreateIntegrityKey(env, homeDir);
  if (!keyResult.ok) return keyResult;
  const sortedImports = sortImports(imports);
  const integrity = computeImportsIntegrity(keyResult.key, 1, version, imports);
  const payload = `${JSON.stringify({ schemaVersion: 1, version, imports: sortedImports, integrity }, null, 2)}\n`;
  const tmpPath = path.join(path.dirname(filePath), `.external-imports.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmpPath, payload, "utf8");
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  return { ok: true };
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
  | {
      ok: false;
      reason:
        | "corrupt-external-imports-registry"
        | "external-imports-key-missing"
        | "external-imports-key-invalid"
        | "external-imports-locked";
      message: string;
    };

const EXTERNAL_IMPORTS_LOCK_RETRY_MS = 50;
const EXTERNAL_IMPORTS_LOCK_TIMEOUT_MS = 3000;
const EXTERNAL_IMPORTS_LOCK_STALE_AGE_MS = 10 * 60 * 1000;

/**
 * R3-F23 (flow 313 W4 review round 3): the lock file is only ever removed by
 * its own holder's `finally` block — a crash or `kill -9` of that process
 * leaves it on disk forever, and every later `bundle import --external`
 * refused permanently with no recovery step. A lock is now RECLAIMABLE (and
 * only reclaimable) when either holds:
 *  - the pid recorded in the lock file is no longer alive (`process.kill
 *    (pid, 0)` throws `ESRCH`) — the clearest possible signal the holder is
 *    gone, checked without sending any real signal (signal 0 only probes);
 *  - the lock file is older than `EXTERNAL_IMPORTS_LOCK_STALE_AGE_MS` (10
 *    minutes) — a generous bound no real read-modify-write under this lock
 *    should ever approach, kept as a fallback for pid REUSE (a dead holder's
 *    pid reassigned to an unrelated live process would otherwise defeat the
 *    liveness check above).
 * A reclaim removes the stale file and retries acquisition exactly once;
 * if the unlink or the retry race with another process, that is treated as
 * ordinary lock contention (falls through to the normal poll/timeout path)
 * rather than a second reclaim attempt, so two processes can never loop
 * reclaiming each other's fresh lock.
 */
async function isStaleExternalImportsLock(lockPath: string): Promise<{ stale: boolean; note: string }> {
  let raw: string;
  let mtimeMs: number;
  try {
    const [content, stats] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    raw = content;
    mtimeMs = stats.mtimeMs;
  } catch {
    // Already gone (another process reclaimed or released it) — not our job.
    return { stale: false, note: "" };
  }
  const pid = Number.parseInt(raw.trim(), 10);
  const ageMs = Date.now() - mtimeMs;
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ESRCH") {
        return { stale: true, note: `holder pid ${pid} is no longer running` };
      }
      // EPERM etc.: the pid exists but we can't probe it — fall through to
      // the age check rather than assuming it is dead.
    }
  }
  if (ageMs > EXTERNAL_IMPORTS_LOCK_STALE_AGE_MS) {
    return { stale: true, note: `lock file is ${Math.round(ageMs / 1000)}s old (over the ${EXTERNAL_IMPORTS_LOCK_STALE_AGE_MS / 1000}s stale threshold)` };
  }
  return { stale: false, note: "" };
}

/**
 * R2-F9 (flow 313 review round 2 fix): the registry's read-modify-write
 * (`readExternalImports` -> merge -> `writeExternalImportsRegistry`) used to
 * run with no coordination at all, so two concurrent `bundle import
 * --external` runs on the same home could both read the same starting
 * state and each write back a registry missing the other's import — a lost
 * update. An exclusive (`wx`) lock FILE under the reserved `state/` tree
 * serializes the whole read-modify-write across processes; a contending
 * process polls briefly rather than blocking indefinitely
 * (`EXTERNAL_IMPORTS_LOCK_TIMEOUT_MS`), and times out to a named refusal
 * rather than hanging the CLI.
 */
async function withExternalImportsLock<T>(
  env: NodeJS.ProcessEnv,
  homeDir: string | undefined,
  fn: () => Promise<T>,
): Promise<T | { ok: false; reason: "external-imports-locked"; message: string }> {
  const lockPath = path.join(userStorePaths(env, homeDir).state, "external-imports.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });

  const deadline = Date.now() + EXTERNAL_IMPORTS_LOCK_TIMEOUT_MS;
  let reclaimAttempted = false;
  let reclaimNote: string | undefined;
  for (;;) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      if (!reclaimAttempted) {
        reclaimAttempted = true;
        const { stale, note } = await isStaleExternalImportsLock(lockPath);
        if (stale) {
          reclaimNote = note;
          await unlink(lockPath).catch(() => undefined);
          try {
            await writeFile(lockPath, String(process.pid), { flag: "wx" });
            break;
          } catch (retryErr) {
            if ((retryErr as NodeJS.ErrnoException)?.code !== "EEXIST") throw retryErr;
            // Lost the race to reclaim it (another process reclaimed or
            // re-acquired first) — fall through to the ordinary poll below.
          }
        }
      }
      if (Date.now() >= deadline) {
        const reclaimSuffix = reclaimNote ? ` A stale lock was detected and reclaim was attempted (${reclaimNote}), but it lost the race to another process.` : "";
        return {
          ok: false,
          reason: "external-imports-locked",
          message: `${lockPath} is held by another process; timed out after ${EXTERNAL_IMPORTS_LOCK_TIMEOUT_MS}ms.${reclaimSuffix} If you're sure no "keryx bundle import --external" is running, delete this file and retry.`,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_IMPORTS_LOCK_RETRY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

/**
 * Record every ACCEPTED candidate by reference: no skill file is copied
 * anywhere. A rejected candidate is never written. Idempotent for a candidate
 * whose files already match the recorded entry. The whole read-modify-write
 * runs under `withExternalImportsLock` (R2-F9).
 */
export async function applyExternalImports(
  result: VetExternalCatalogResult,
  opts: { env?: NodeJS.ProcessEnv | undefined; homeDir?: string | undefined; now?: (() => Date) | undefined } = {},
): Promise<ApplyExternalImportsResult> {
  const accepted = result.candidates.filter((c) => c.decision === "accepted");
  if (accepted.length === 0) return { ok: true, written: [] };

  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir;
  const now = opts.now ?? (() => new Date());

  return withExternalImportsLock(env, homeDir, async (): Promise<ApplyExternalImportsResult> => {
    const read = await readExternalImports(env, homeDir);
    if (!read.ok) return read;

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

    const written = await writeExternalImportsRegistry(env, homeDir, imports, read.registry.version + 1);
    if (!written.ok) return written;
    return { ok: true, written: accepted.map((c) => c.name) };
  });
}

// --- verify -------------------------------------------------------------

/**
 * R2-F17 follow-up (flow 313 review round 2 fix, R1-F17 "still open" half):
 * verify used to walk `record.sourceRef` with a bare `readdir`/`isFile()`
 * scan (`collectFiles`, now removed) that silently treated a symlinked file
 * or directory as neither a file nor a directory — exactly like
 * `readdir`'s `Dirent.isDirectory()` does — so a symlink added to an
 * accepted candidate's directory AFTER acceptance was invisible to both the
 * per-file checksum loop (never reached, since it only iterated the
 * RECORDED file list) and the "extra files on disk" scan (silently
 * skipped). Verify now re-snapshots with the exact same
 * `collectSkillDirectorySnapshot` primitive vetting used originally
 * (`lstat`-based, refuses a symlink anywhere, caps depth/count/size), so a
 * symlink planted after acceptance is reported `symlink-refused` — the
 * same reason vetting itself would have given it — never silently ignored.
 */
export type VerifyExternalImportEntryStatus =
  | "ok"
  | "unresolvable"
  | "checksum-mismatch"
  | "unlisted-file"
  | SnapshotCollectFailureReason;

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

/** Per import: `ok`, `unresolvable` (sourceRef or a listed file missing), `checksum-mismatch` (a listed file changed), `unlisted-file` (a file on disk not in the recorded set), or one of `collectSkillDirectorySnapshot`'s own fail-closed reasons (`symlink-refused`, `too-many-files`, `too-large`, `too-deep`, `unreadable-file`, `unreadable-dir`, `special-file-refused`) when the source directory itself can no longer be trusted. */
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

    const snapshot = await collectSkillDirectorySnapshot(record.sourceRef);
    if (!snapshot.ok) {
      entries.push({ name, status: snapshot.reason, message: snapshot.message });
      continue;
    }

    let status: VerifyExternalImportEntryStatus = "ok";
    let message: string | undefined;

    for (const [rel, sha] of Object.entries(record.files)) {
      const bytes = snapshot.files.get(rel);
      if (bytes === undefined) {
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
      const extra = [...snapshot.files.keys()].filter((rel) => !listed.has(rel)).sort();
      if (extra.length > 0) {
        status = "unlisted-file";
        message = `file(s) present but not recorded: ${extra.join(", ")}`;
      }
    }

    entries.push({ name, status, ...(message !== undefined ? { message } : {}) });
  }

  return { ok: entries.every((e) => e.status === "ok"), entries };
}
