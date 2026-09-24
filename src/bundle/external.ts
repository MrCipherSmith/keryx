// Flow 313 (W4 portability), T10 — importing an external Agent-Skills-standard
// catalog (W4-AC9). Read-only vetting (`vetExternalCatalog`) plus a
// reference-only recorder (`applyExternalImports`): an accepted candidate is
// never copied anywhere (not into `.metaproject/skills/`, not into
// `~/.keryx/skills/<name>/`, not into any bundle) — only its source directory
// and a per-file sha256 map are recorded in
// `~/.keryx/skills/external-imports.json`, so a later `keryx skills scout
// --include-imports` and `verifyExternalImports` can find and re-check it
// without Keryx ever owning a copy of someone else's skill content.

import { mkdir, readFile, readdir, rename, unlink, writeFile, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { pathExists } from "../lib/fs";
import { userStorePaths } from "../lib/keryx-home";
import { loadSkillCatalog } from "../gdskills/governance/catalog-index";
import { scoutSkill, scoutVetCandidate, type ScoutDecision } from "../gdskills/governance/scout";
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
}

export type ReadExternalImportsResult =
  | { ok: true; registry: ExternalImportsRegistry }
  | { ok: false; reason: "corrupt-external-imports-registry"; message: string };

function emptyRegistry(): ExternalImportsRegistry {
  return { schemaVersion: 1, imports: {} };
}

function isValidRegistry(value: unknown): value is ExternalImportsRegistry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) return false;
  return typeof v.imports === "object" && v.imports !== null && !Array.isArray(v.imports);
}

/** Read `~/.keryx/skills/external-imports.json`; absent -> empty registry; corrupt -> a named fail-closed reason. */
export async function readExternalImports(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): Promise<ReadExternalImportsResult> {
  const filePath = userStorePaths(env, homeDir).externalSkillImports;
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
  return { ok: true, registry: parsed };
}

async function writeExternalImportsRegistry(filePath: string, registry: ExternalImportsRegistry): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const sortedImports: Record<string, ExternalImportRecord> = {};
  for (const key of Object.keys(registry.imports).sort()) {
    const record = registry.imports[key] as ExternalImportRecord;
    const sortedFiles: Record<string, string> = {};
    for (const filePathKey of Object.keys(record.files).sort()) {
      sortedFiles[filePathKey] = record.files[filePathKey] as string;
    }
    sortedImports[key] = { ...record, files: sortedFiles };
  }
  const payload = `${JSON.stringify({ schemaVersion: 1, imports: sortedImports }, null, 2)}\n`;
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

async function containsSymlink(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const st = await lstat(abs);
    if (st.isSymbolicLink()) return true;
    if (st.isDirectory() && (await containsSymlink(abs))) return true;
  }
  return false;
}

/** A candidate is the catalog root itself (when it directly holds `SKILL.md`), else every immediate subdirectory that does. */
async function candidateDirs(catalogPath: string): Promise<string[]> {
  if (await pathExists(path.join(catalogPath, "SKILL.md"))) {
    return [catalogPath];
  }
  let entries;
  try {
    entries = await readdir(catalogPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(catalogPath, entry.name);
    if (await pathExists(path.join(abs, "SKILL.md"))) dirs.push(abs);
  }
  return dirs;
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

/**
 * Read-only: vet every candidate skill directory under `catalogPath` against
 * the project's own skill catalog (scout gate), the already-imported
 * registry, and the W8 harness audit — see the module header for what
 * "accepted" does and does not do.
 */
export async function vetExternalCatalog(opts: VetExternalCatalogOptions): Promise<VetExternalCatalogResult> {
  const dirs = await candidateDirs(opts.catalogPath);
  const skillCatalog = loadSkillCatalog(opts.projectRoot, { scope: "all" });
  const existingImportsRead = await readExternalImports(opts.env ?? process.env, opts.homeDir);
  const existingImports = existingImportsRead.ok ? existingImportsRead.registry.imports : {};

  const candidates: ExternalCandidate[] = [];

  for (const dir of dirs) {
    const reasons: string[] = [];

    let selfSymlink = false;
    try {
      selfSymlink = (await lstat(dir)).isSymbolicLink();
    } catch {
      // dir vanished between candidateDirs() and here — treat as no symlink.
    }
    const innerSymlink = selfSymlink ? false : await containsSymlink(dir);
    if (selfSymlink || innerSymlink) reasons.push("symlink-refused");

    let body = "";
    if (!selfSymlink) {
      try {
        body = await readFile(path.join(dir, "SKILL.md"), "utf8");
      } catch {
        body = "";
      }
    }
    const frontmatter = parseSkillFrontmatter(body);
    const name = frontmatter.name;
    const description = frontmatter.description;
    const validName = name !== undefined && name.length <= MAX_NAME_LEN && SKILL_NAME_RE.test(name);
    const validDescription = description !== undefined && description.length > 0 && description.length <= MAX_DESCRIPTION_LEN;
    if (!validName || !validDescription) reasons.push("invalid-skill-frontmatter");

    let scoutResult: { decision: ScoutDecision; topMatch: string | null } = { decision: "create", topMatch: null };
    const files: Record<string, string> = {};
    let auditGate: ExternalAuditGate = "not-applicable";
    let findings = 0;

    if (reasons.length === 0 && name !== undefined && description !== undefined) {
      const fileBytes = new Map<string, Buffer>();
      await collectFiles(dir, "", fileBytes);
      for (const [rel, bytes] of fileBytes) files[rel] = sha256Hex(bytes);

      const scouted = scoutSkill(`${name} ${description}`, skillCatalog);
      scoutResult = { decision: scouted.decision, topMatch: scouted.matches[0]?.skillId ?? null };
      if (scouted.decision === "use") reasons.push("scout-duplicate");
      else if (scouted.decision === "fork") reasons.push("scout-overlap");

      const existingRecord = existingImports[name];
      if (existingRecord !== undefined && !filesMatch(existingRecord.files, files)) {
        reasons.push("already-imported");
      }

      if (reasons.length === 0) {
        const vetting = await scoutVetCandidate(dir);
        if (!vetting.available) {
          auditGate = "not-applicable";
          reasons.push("audit-not-applicable");
        } else {
          findings = vetting.summary?.findings ?? 0;
          const bySeverity = vetting.summary?.bySeverity ?? {};
          const failing = (bySeverity.high ?? 0) + (bySeverity.critical ?? 0) > 0;
          auditGate = failing ? "fail" : "pass";
          if (failing) reasons.push("audit-failed");
        }
      }
    }

    candidates.push({
      name: name ?? path.basename(dir),
      dir,
      decision: reasons.length === 0 ? "accepted" : "rejected",
      reasons,
      scout: scoutResult,
      audit: { gate: auditGate, findings },
      description: description ?? "",
      files,
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

  const filePath = userStorePaths(opts.env ?? process.env, opts.homeDir).externalSkillImports;
  await writeExternalImportsRegistry(filePath, { schemaVersion: 1, imports });
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
