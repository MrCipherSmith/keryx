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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** sha256 hex of a project-relative file's current on-disk content, or `undefined` when it does not exist. */
export async function sha256OfFile(root: string, relativePath: string): Promise<string | undefined> {
  const file = path.join(root, ...relativePath.split("/"));
  if (!(await pathExists(file))) return undefined;
  const content = await readFile(file);
  return createHash("sha256").update(content).digest("hex");
}

/** Reads `<runtimeId>.json`, or `undefined` when absent/unreadable/not valid JSON. */
export async function readInstallState(root: string, runtimeId: string): Promise<InstallState | undefined> {
  const file = installStatePath(root, runtimeId);
  if (!(await pathExists(file))) return undefined;
  try {
    return JSON.parse(await readFile(file, "utf8")) as InstallState;
  } catch {
    return undefined;
  }
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
  },
): Promise<void> {
  if (!(await pathExists(metaprojectDir(root)))) return;

  const sha256: Record<string, string> = {};
  for (const relativePath of entry.writtenPaths) {
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
