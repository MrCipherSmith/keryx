// Flow 307 (W5-b), T6: per-target install-state for the integrations
// installer core. Conforms to install-manifest.schema.json's
// `$defs/installState`/`$defs/installedModuleRecord`, plus two additive
// optional fields on the record — `keryxVersion`/`installedAt` — that this
// module stamps so `doctor` can report WHEN and by WHICH Keryx build a drifted
// surface was installed (see the schema's own description on those two
// properties).
//
// State lives at `<root>/.metaproject/data/integrations/install-state/<runtimeId>.json`
// and is written ONLY when `<root>/.metaproject` already exists — this module
// never creates a `.metaproject/` directory in a project that has none. A
// surface that installs no file (e.g. zed's `acp-permission`, satisfied
// entirely by keryx's own runtime behaviour) is never recorded here — see
// `installer.ts`, which only calls into this module for a surface that
// actually wrote something.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { currentWriterVersion } from "../lib/install-plan";
import type { SurfaceFlag } from "./types";

export const INSTALL_STATE_SCHEMA_VERSION = "1.0.0";

export interface InstalledModuleRecord {
  readonly moduleId: string;
  readonly surface?: SurfaceFlag;
  readonly writtenPaths: readonly string[];
  readonly sha256: Readonly<Record<string, string>>;
  readonly managedSentinel: boolean;
  /** Additive (W5-b): the running Keryx version at install time. */
  readonly keryxVersion?: string;
  /** Additive (W5-b): ISO date-time this record was last written. */
  readonly installedAt?: string;
}

export interface InstallState {
  readonly schemaVersion: "1.0.0";
  readonly target: string;
  readonly profile?: string;
  readonly installedModules: readonly InstalledModuleRecord[];
  readonly recordedAt: string;
}

function metaprojectDir(root: string): string {
  return path.join(root, ".metaproject");
}

export function installStatePath(root: string, runtimeId: string): string {
  return path.join(metaprojectDir(root), "data", "integrations", "install-state", `${runtimeId}.json`);
}

/**
 * sha256 hex of a project-relative FILE's current on-disk content, or
 * `undefined` when it does not exist. R1-F2: a directory-valued
 * `writtenPaths`/`hashPaths` entry (the `agents` surface's `relativePath` is
 * a whole directory, e.g. `.claude/agents`, unlike every other surface's
 * single settings file) previously reached `readFile` here and crashed with
 * EISDIR — after every agent file was already written, escaping
 * `installIntegration`'s try/catch and reporting the whole install failed.
 * `stat` + `isFile()` makes a directory (or anything else that is not a
 * plain file) a quiet `undefined` instead: nothing to hash, not an error —
 * `doctor`'s drift check (`shaDriftedSinceInstall`, which calls this per
 * recorded path) degrades the same way, simply reporting no drift signal for
 * a path it cannot hash rather than throwing.
 */
export async function sha256OfFile(root: string, relativePath: string): Promise<string | undefined> {
  const file = path.join(root, ...relativePath.split("/"));
  let stats;
  try {
    stats = await stat(file);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) return undefined;
  const content = await readFile(file);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * F7: a single record's shape check — `moduleId` must be a string,
 * `writtenPaths` an array of strings, and `sha256` (when present at all) a
 * plain, non-array object; it defaults to `{}` when absent, since older/odd
 * writers may omit it. Anything else — `null`, a string, an array element
 * with a non-string `moduleId`, ... — is not a usable record.
 */
function normalizeInstalledModuleRecord(value: unknown): InstalledModuleRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.moduleId !== "string") return undefined;
  if (!Array.isArray(record.writtenPaths) || !record.writtenPaths.every((p) => typeof p === "string")) return undefined;
  const sha256Raw = record.sha256;
  if (sha256Raw !== undefined && (typeof sha256Raw !== "object" || sha256Raw === null || Array.isArray(sha256Raw))) return undefined;
  return {
    moduleId: record.moduleId,
    ...(typeof record.surface === "string" ? { surface: record.surface as SurfaceFlag } : {}),
    writtenPaths: [...(record.writtenPaths as string[])],
    sha256: { ...((sha256Raw as Record<string, string> | undefined) ?? {}) },
    managedSentinel: record.managedSentinel === true,
    ...(typeof record.keryxVersion === "string" ? { keryxVersion: record.keryxVersion } : {}),
    ...(typeof record.installedAt === "string" ? { installedAt: record.installedAt } : {}),
  };
}

/**
 * F7 (review round 2 — carried over from round 1): a parsed value only
 * counts as usable install-state when it carries THIS module's
 * `schemaVersion`, an array `installedModules`, AND every element of that
 * array is itself a valid record (see `normalizeInstalledModuleRecord`).
 *
 * Decision (documented here, since the task this fixes left it open): ONE
 * malformed record makes the WHOLE state file "unreadable" — this module
 * does not attempt to keep the other, well-formed records and drop only the
 * bad one. A state file is a single artifact keryx alone writes; there is no
 * expected way for exactly one record in it to be corrupt while the rest are
 * fine, so treating the whole file as unreadable (same as bad JSON, or a
 * record shaped for a future/older schema version) keeps the failure mode
 * simple and matches "install should overwrite/repair it safely" — the next
 * `recordSurfaceInstalled` call reads `undefined` back (nothing recorded)
 * and writes a fresh, valid file from scratch, which discards the corrupt
 * records rather than trying to merge around them. `doctor` surfaces the
 * unreadable file as a top-level problem (`installStateIsUnreadable`)
 * instead of crashing or silently reporting "nothing installed".
 */
function normalizeInstallState(value: unknown): InstallState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== INSTALL_STATE_SCHEMA_VERSION) return undefined;
  if (!Array.isArray(record.installedModules)) return undefined;
  const installedModules: InstalledModuleRecord[] = [];
  for (const entry of record.installedModules) {
    const normalized = normalizeInstalledModuleRecord(entry);
    if (!normalized) return undefined;
    installedModules.push(normalized);
  }
  return {
    schemaVersion: INSTALL_STATE_SCHEMA_VERSION,
    target: typeof record.target === "string" ? record.target : "",
    ...(typeof record.profile === "string" ? { profile: record.profile } : {}),
    installedModules,
    recordedAt: typeof record.recordedAt === "string" ? record.recordedAt : "",
  };
}

async function parseInstallStateFile(
  root: string,
  runtimeId: string,
): Promise<{ state: InstallState | undefined; unreadable: boolean }> {
  const file = installStatePath(root, runtimeId);
  if (!(await pathExists(file))) return { state: undefined, unreadable: false };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    const normalized = normalizeInstallState(parsed);
    if (normalized) return { state: normalized, unreadable: false };
    return { state: undefined, unreadable: true };
  } catch {
    return { state: undefined, unreadable: true };
  }
}

/** Reads `<runtimeId>.json`, or `undefined` when absent/unreadable/not valid install-state JSON (F7). */
export async function readInstallState(root: string, runtimeId: string): Promise<InstallState | undefined> {
  return (await parseInstallStateFile(root, runtimeId)).state;
}

/**
 * True when `<runtimeId>.json` EXISTS but is not usable install-state (bad
 * JSON, or valid JSON missing `schemaVersion`/`installedModules`) — the case
 * `doctor` should report as a problem, distinct from "nothing recorded yet"
 * (no file at all), which is normal and silent (F7).
 */
export async function installStateIsUnreadable(root: string, runtimeId: string): Promise<boolean> {
  return (await parseInstallStateFile(root, runtimeId)).unreadable;
}

function sortedRecords(records: readonly InstalledModuleRecord[]): InstalledModuleRecord[] {
  return [...records].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
}

async function writeInstallState(root: string, runtimeId: string, state: InstallState): Promise<void> {
  const file = installStatePath(root, runtimeId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Upsert one surface's install-state record (keyed by `moduleId`, one record
 * per installed surface). `writtenPaths` are project-relative; their sha256
 * is computed by reading back the actual on-disk content this call is
 * recording, so what is hashed is exactly what was written — never a value
 * the caller merely believes it wrote.
 *
 * A no-op when `<root>/.metaproject` does not exist: this never creates a
 * Metaproject directory in a project that has none.
 */
export async function recordSurfaceInstalled(
  root: string,
  runtimeId: string,
  entry: {
    moduleId: string;
    surface?: SurfaceFlag;
    writtenPaths: readonly string[];
    managedSentinel: boolean;
    /**
     * Paths to sha256-hash for doctor's "changed since install" note (F5).
     * Defaults to `writtenPaths`. Pass `[]` for a JSON surface whose settings
     * file is shared with another surface: a whole-file hash there would
     * flag drift the moment a SIBLING surface (not this one) next
     * installs/uninstalls into the same file — that is not a change to THIS
     * surface's own managed entries, so rather than mis-attribute someone
     * else's edit, this record simply carries no sha256 and never raises a
     * drift note from file content changes it does not own.
     */
    hashPaths?: readonly string[];
  },
): Promise<void> {
  if (!(await pathExists(metaprojectDir(root)))) return;

  const sha256: Record<string, string> = {};
  for (const relativePath of entry.hashPaths ?? entry.writtenPaths) {
    const hash = await sha256OfFile(root, relativePath);
    if (hash) sha256[relativePath] = hash;
  }

  const record: InstalledModuleRecord = {
    moduleId: entry.moduleId,
    ...(entry.surface !== undefined ? { surface: entry.surface } : {}),
    writtenPaths: [...entry.writtenPaths],
    sha256,
    managedSentinel: entry.managedSentinel,
    keryxVersion: currentWriterVersion(),
    installedAt: new Date().toISOString(),
  };

  const existing = await readInstallState(root, runtimeId);
  const installedModules = sortedRecords([
    ...(existing?.installedModules.filter((r) => r.moduleId !== entry.moduleId) ?? []),
    record,
  ]);

  await writeInstallState(root, runtimeId, {
    schemaVersion: INSTALL_STATE_SCHEMA_VERSION,
    target: runtimeId,
    ...(existing?.profile !== undefined ? { profile: existing.profile } : {}),
    installedModules,
    recordedAt: new Date().toISOString(),
  });
}

/**
 * Remove one surface's install-state record. Deletes the state file entirely
 * once no records remain. A no-op when there is nothing recorded for
 * `moduleId` (including when there is no state file at all).
 */
export async function recordSurfaceUninstalled(root: string, runtimeId: string, moduleId: string): Promise<void> {
  const existing = await readInstallState(root, runtimeId);
  if (!existing) return;
  const remaining = existing.installedModules.filter((r) => r.moduleId !== moduleId);
  if (remaining.length === existing.installedModules.length) return;

  if (remaining.length === 0) {
    await rm(installStatePath(root, runtimeId), { force: true });
    return;
  }

  await writeInstallState(root, runtimeId, {
    ...existing,
    installedModules: sortedRecords(remaining),
    recordedAt: new Date().toISOString(),
  });
}
