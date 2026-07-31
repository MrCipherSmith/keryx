// User-global project registry (flow 127 / roadmap R4a).
//
// `keryx init` writes a `.metaproject/` into a directory and nothing on the
// machine records that it happened, so an install cannot answer "which projects
// am I initialized in". That is fine while the only entry point is a terminal
// already sitting in the project, and it stops being fine the moment anything
// addresses projects from outside one — which is what the remote entry and the
// Telegram transport in docs/requirements both depend on.
//
// Scope, deliberately narrow: this answers WHICH projects exist and HOW they are
// addressed. It is not a second source of project truth. Configuration, policy
// and content stay in each project's own `.metaproject/`, and this file holds no
// credential material — `assertNoSecrets` enforces that rather than trusting it.
//
// Every function is best-effort and never throws: a corrupt registry must not be
// able to break `keryx init`.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** One registered project. Addressing only — see the module comment. */
export interface ProjectEntry {
  /** Opaque, stable across re-registration of the same path. */
  projectId: string;
  /** Absolute project path. Declared explicitly by callers; never inferred. */
  path: string;
  /** Human-facing label. Safe to render. */
  displayName: string;
  /**
   * `missing` means the path no longer exists. The entry is RETAINED: an
   * unmounted disk is not an instruction to forget a project. Only an explicit
   * `forget` removes one.
   */
  state: "active" | "missing";
  registeredAt: string;
  lastSeenAt?: string;
  /** Reserved for transport bindings (e.g. a Telegram topic). Nothing writes it yet. */
  transportBindings?: Array<{ transport: string; bindingId: string }>;
}

export interface ProjectRegistry {
  schemaVersion: 1;
  projects: ProjectEntry[];
}

const EMPTY: ProjectRegistry = { schemaVersion: 1, projects: [] };

/**
 * Field names that must never appear on a registry entry. The registry sits next
 * to `auth.json`, and "it holds no secrets" is worth asserting rather than
 * assuming — a future field added carelessly is exactly how that would stop
 * being true.
 */
const FORBIDDEN_FIELDS = ["token", "apiKey", "secret", "credential", "password", "key"];

/** Same resolution as the rest of the user-global config (auth.json, sandbox.json). */
function configDir(dir?: string): string {
  if (dir !== undefined) {
    return dir;
  }
  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    const base = appData !== undefined && appData.length > 0 ? appData : path.join(home, "AppData", "Roaming");
    return path.join(base, "keryx");
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? xdg : path.join(home, ".local", "share");
  return path.join(base, "keryx");
}

/** Absolute path to `projects.json`. */
export function projectRegistryPath(dir?: string): string {
  return path.join(configDir(dir), "projects.json");
}

/** True when an entry carries a field that looks like a credential. */
export function hasSecretShapedField(entry: Record<string, unknown>): boolean {
  return Object.keys(entry).some((field) => FORBIDDEN_FIELDS.includes(field));
}

/**
 * Read the registry. A missing, unreadable, malformed or structurally wrong file
 * degrades to an empty registry — never a throw, because `keryx init` must
 * succeed even when this file is damaged. `onWarn` surfaces the degradation so
 * it is visible rather than silent.
 */
export function loadProjectRegistry(dir?: string, onWarn?: (message: string) => void): ProjectRegistry {
  const file = projectRegistryPath(dir);
  if (!existsSync(file)) {
    return { ...EMPTY, projects: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as ProjectRegistry).projects)
    ) {
      onWarn?.(`project registry at ${file} is malformed; continuing with an empty registry`);
      return { ...EMPTY, projects: [] };
    }
    const projects = (parsed as ProjectRegistry).projects.filter(
      (entry) => typeof entry?.path === "string" && entry.path.length > 0,
    );
    return { schemaVersion: 1, projects };
  } catch {
    onWarn?.(`project registry at ${file} is unreadable; continuing with an empty registry`);
    return { ...EMPTY, projects: [] };
  }
}

/**
 * Write the registry atomically: a temp file in the same directory, then a
 * rename. A half-written registry would be indistinguishable from a corrupt one,
 * and two `keryx init` runs racing is an ordinary thing to do.
 *
 * Returns false rather than throwing — a registry that cannot be written must
 * not fail the init it was recording.
 */
export function saveProjectRegistry(registry: ProjectRegistry, dir?: string): boolean {
  const file = projectRegistryPath(dir);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const sorted: ProjectRegistry = {
      schemaVersion: 1,
      // Sorted by path so the file is byte-stable and diffable regardless of
      // registration order.
      projects: [...registry.projects].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(sorted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

export type RegisterOutcome =
  | { ok: true; entry: ProjectEntry; created: boolean }
  | { ok: false; reason: "not-a-project" | "write-failed"; message: string };

/**
 * Register a project, or refresh the record if that path is already registered.
 *
 * Idempotent by PATH, not by call: re-running `keryx init` updates the existing
 * entry and keeps its `projectId`, so anything that bound to that id keeps
 * working.
 */
export function registerProject(
  projectPath: string,
  options: { dir?: string; displayName?: string; now?: () => string } = {},
): RegisterOutcome {
  const absolute = path.resolve(projectPath);
  if (!existsSync(path.join(absolute, ".metaproject"))) {
    return {
      ok: false,
      reason: "not-a-project",
      message: `${absolute} is not an initialized keryx project (no .metaproject/). Run keryx init there first.`,
    };
  }

  const now = options.now?.() ?? new Date().toISOString();
  const registry = loadProjectRegistry(options.dir);
  const existing = registry.projects.find((entry) => entry.path === absolute);

  if (existing) {
    existing.state = "active";
    existing.lastSeenAt = now;
    if (options.displayName !== undefined) {
      existing.displayName = options.displayName;
    }
    if (!saveProjectRegistry(registry, options.dir)) {
      return { ok: false, reason: "write-failed", message: "could not write the project registry" };
    }
    return { ok: true, entry: existing, created: false };
  }

  const entry: ProjectEntry = {
    projectId: randomUUID(),
    path: absolute,
    displayName: options.displayName ?? path.basename(absolute),
    state: "active",
    registeredAt: now,
    lastSeenAt: now,
  };
  registry.projects.push(entry);
  if (!saveProjectRegistry(registry, options.dir)) {
    return { ok: false, reason: "write-failed", message: "could not write the project registry" };
  }
  return { ok: true, entry, created: true };
}

/** Remove exactly one entry by id. Returns false when no such id is registered. */
export function forgetProject(projectId: string, dir?: string): boolean {
  const registry = loadProjectRegistry(dir);
  const before = registry.projects.length;
  registry.projects = registry.projects.filter((entry) => entry.projectId !== projectId);
  if (registry.projects.length === before) {
    return false;
  }
  return saveProjectRegistry(registry, dir);
}

/**
 * The registry with each entry's `state` refreshed against the filesystem.
 *
 * A vanished path becomes `missing` and is REPORTED, not dropped. Deleting it
 * here would mean an unmounted disk silently erases the record.
 */
export function listProjects(dir?: string, onWarn?: (message: string) => void): ProjectEntry[] {
  const registry = loadProjectRegistry(dir, onWarn);
  return registry.projects.map((entry) => ({
    ...entry,
    state: isReachableProject(entry.path) ? "active" : "missing",
  }));
}

/**
 * A registered path counts as reachable only while it still holds a
 * `.metaproject/`.
 *
 * Checking the bare directory is not enough: a project someone de-initialized
 * would keep reporting `active` while nothing there is addressable any more.
 * An unmounted disk fails this check too, so both collapse to `missing` — which
 * is the right outcome, since the entry is retained either way and the operator
 * decides what it means.
 */
function isReachableProject(projectPath: string): boolean {
  return existsSync(path.join(projectPath, ".metaproject"));
}

/** Deterministic machine-readable projection. Sorted by path; contains no secrets. */
export function emitProjectsJson(entries: ProjectEntry[]): string {
  const projects = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify({ schemaVersion: 1, projects }, null, 2);
}
