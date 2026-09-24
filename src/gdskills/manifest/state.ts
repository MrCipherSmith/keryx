// Flow 309 (W1), T6: per-target install-state for `keryx skills install`'s
// new manifest-driven path. Conforms to install-manifest.schema.json's
// `$defs/installState`/`$defs/installedModuleRecord` — the same shape
// `src/integrations/install-state.ts` (W5-b) writes for `keryx integrations`,
// reused here rather than redefined, but at a different path:
// `.metaproject/data/skills/install-state/<target>.json` (this module's own
// surface), not `.metaproject/data/integrations/install-state/<runtimeId>.json`
// (W5-b's).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../lib/fs";
import { sha256OfFile, type InstallState, type InstalledModuleRecord } from "../../integrations/install-state";

export const SKILLS_INSTALL_STATE_SCHEMA_VERSION = "1.0.0";

export { sha256OfFile };
export type { InstallState, InstalledModuleRecord };

export function skillsInstallStatePath(repoRoot: string, target: string): string {
  return path.join(repoRoot, ".metaproject", "data", "skills", "install-state", `${target}.json`);
}

function normalizeRecord(value: unknown): InstalledModuleRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.moduleId !== "string") return undefined;
  if (!Array.isArray(record.writtenPaths) || !record.writtenPaths.every((p) => typeof p === "string")) return undefined;
  const sha256Raw = record.sha256;
  if (sha256Raw !== undefined && (typeof sha256Raw !== "object" || sha256Raw === null || Array.isArray(sha256Raw))) {
    return undefined;
  }
  return {
    moduleId: record.moduleId,
    writtenPaths: [...(record.writtenPaths as string[])],
    sha256: { ...((sha256Raw as Record<string, string> | undefined) ?? {}) },
    managedSentinel: record.managedSentinel === true,
    ...(typeof record.keryxVersion === "string" ? { keryxVersion: record.keryxVersion } : {}),
    ...(typeof record.installedAt === "string" ? { installedAt: record.installedAt } : {}),
  };
}

function normalizeState(value: unknown): InstallState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SKILLS_INSTALL_STATE_SCHEMA_VERSION) return undefined;
  if (!Array.isArray(record.installedModules)) return undefined;
  const installedModules: InstalledModuleRecord[] = [];
  for (const entry of record.installedModules) {
    const normalized = normalizeRecord(entry);
    if (!normalized) return undefined;
    installedModules.push(normalized);
  }
  return {
    schemaVersion: SKILLS_INSTALL_STATE_SCHEMA_VERSION,
    target: typeof record.target === "string" ? record.target : "",
    ...(typeof record.profile === "string" ? { profile: record.profile } : {}),
    installedModules,
    recordedAt: typeof record.recordedAt === "string" ? record.recordedAt : "",
  };
}

/** Reads `<target>.json`, or `undefined` when absent/unreadable/not valid install-state JSON. */
export async function readSkillsInstallState(repoRoot: string, target: string): Promise<InstallState | undefined> {
  const file = skillsInstallStatePath(repoRoot, target);
  if (!(await pathExists(file))) return undefined;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return normalizeState(parsed);
  } catch {
    return undefined;
  }
}

function sortedRecords(records: readonly InstalledModuleRecord[]): InstalledModuleRecord[] {
  return [...records].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
}

/**
 * Upsert a batch of module records (keyed by `moduleId`) into `<target>.json`.
 * A record with an empty `writtenPaths` removes any existing record for that
 * module id instead of writing an empty one.
 */
export async function writeSkillsInstallState(
  repoRoot: string,
  target: string,
  moduleRecords: readonly InstalledModuleRecord[],
  profile: string | undefined,
): Promise<void> {
  const existing = await readSkillsInstallState(repoRoot, target);
  const byId = new Map(
    (existing?.installedModules ?? []).map((record) => [record.moduleId, record] as const),
  );
  for (const record of moduleRecords) {
    if (record.writtenPaths.length === 0) {
      byId.delete(record.moduleId);
    } else {
      byId.set(record.moduleId, record);
    }
  }
  const installedModules = sortedRecords([...byId.values()]);
  const file = skillsInstallStatePath(repoRoot, target);

  if (installedModules.length === 0) {
    await rm(file, { force: true });
    return;
  }

  await mkdir(path.dirname(file), { recursive: true });
  const state: InstallState = {
    schemaVersion: SKILLS_INSTALL_STATE_SCHEMA_VERSION,
    target,
    ...(profile !== undefined ? { profile } : existing?.profile !== undefined ? { profile: existing.profile } : {}),
    installedModules,
    recordedAt: new Date().toISOString(),
  };
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
