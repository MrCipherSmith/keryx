// Per-project permission-mode default (ask/trust/auto), keyed by resolved
// project path — a new small registry alongside `projects.json`, not an
// extension of it: `ProjectEntry` is tied to the register/forget lifecycle of
// `keryx init`, and a permission-mode default must be settable for a project
// the user never explicitly registered.
//
// Deliberately NOT a place a tool or model can reach: nothing in
// `src/harness/tool/` calls into this module. Only explicit user action (a
// CLI flag or the `/mode` command, both resolved before a turn ever starts)
// ever calls `setProjectPermissionMode`.

import path from "node:path";
import { isPermissionMode, type PermissionMode } from "../commands/permission-mode";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFileAtomic } from "./config-dir";
import { withFileLock } from "./file-lock";
import { projectIdentity } from "./project-registry";

export interface PermissionModeRegistry {
  schemaVersion: 1;
  /** Keyed by {@link projectIdentity}, not the raw path — see that function's docstring. */
  projects: Record<string, PermissionMode>;
}

const EMPTY: PermissionModeRegistry = { schemaVersion: 1, projects: {} };

/** Absolute path to `permission-mode.json`, in the shared user-global config directory. */
export function permissionModeConfigPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), "permission-mode.json");
}

function withRegistryLock<T>(dir: string | undefined, fn: () => T): T | null {
  return withFileLock(`${permissionModeConfigPath(dir)}.lock`, fn, {
    waitingMessage: "waiting for the permission-mode config lock…",
  });
}

/**
 * Load the registry, dropping any entry whose value is not one of the three
 * closed mode names (a hand-edited or future-version file) rather than
 * refusing the whole file. Never throws.
 */
export function loadPermissionModeRegistry(dir?: string): PermissionModeRegistry {
  const read = readConfigFile(permissionModeConfigPath(dir));
  if (!read.ok) {
    return { ...EMPTY, projects: {} };
  }
  try {
    const parsed = JSON.parse(read.text) as unknown;
    const raw = (parsed as { projects?: unknown }).projects;
    if (typeof raw !== "object" || raw === null) {
      return { ...EMPTY, projects: {} };
    }
    const projects: Record<string, PermissionMode> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && isPermissionMode(value)) {
        projects[key] = value;
      }
    }
    return { schemaVersion: 1, projects };
  } catch {
    return { ...EMPTY, projects: {} };
  }
}

function saveRegistry(registry: PermissionModeRegistry, dir?: string): boolean {
  try {
    ensureKeryxConfigDir(dir);
    const sorted: PermissionModeRegistry = {
      schemaVersion: 1,
      projects: Object.fromEntries(
        Object.entries(registry.projects).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    };
    writeOwnerOnlyFileAtomic(permissionModeConfigPath(dir), `${JSON.stringify(sorted, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The stored default for `projectPath`, or `undefined` when nothing is set. */
export function getProjectPermissionMode(projectPath: string, dir?: string): PermissionMode | undefined {
  const registry = loadPermissionModeRegistry(dir);
  return registry.projects[projectIdentity(projectPath)];
}

/**
 * Set (or clear, when `mode` is `undefined`) the stored default for
 * `projectPath`. Read-modify-write under the same lock project-registry.ts
 * uses for its own file, so two concurrent `keryx` processes setting the mode
 * for different (or the same) project cannot lose one write to the other.
 *
 * Returns `false` on a lock timeout or a write failure — the caller's own
 * error contract decides what the operator sees; this never throws.
 */
export function setProjectPermissionMode(projectPath: string, mode: PermissionMode | undefined, dir?: string): boolean {
  const outcome = withRegistryLock(dir, (): boolean => {
    const registry = loadPermissionModeRegistry(dir);
    const key = projectIdentity(projectPath);
    const projects = { ...registry.projects };
    if (mode === undefined) {
      delete projects[key];
    } else {
      projects[key] = mode;
    }
    return saveRegistry({ schemaVersion: 1, projects }, dir);
  });
  return outcome ?? false;
}
