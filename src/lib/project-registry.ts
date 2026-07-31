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
// credential material — `stripSecretShapedFields` ENFORCES that on every write,
// rather than the comment asserting it and nothing checking.
//
// Every function is best-effort and never throws: a corrupt registry must not be
// able to break `keryx init`.
//
// Concurrency: two `keryx init` runs at once is ordinary, and the update is a
// read-modify-write of one file. It is therefore serialized by an exclusive lock
// file, not merely written atomically — atomic writes stop a TORN file, they do
// nothing about a LOST update, and the first version of this module confused the
// two.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
 * Substrings that mark a field as credential-shaped. Matched case-insensitively
 * against the whole key and applied recursively, because the earlier exact,
 * case-sensitive, top-level-only list missed `accessToken`, `API_KEY`,
 * `privateKey`, `cookie` and anything nested.
 *
 * The registry sits next to `auth.json`. "It holds no secrets" has to be
 * enforced on write, not asserted in a comment.
 */
const SECRET_FIELD_MARKERS = ["token", "key", "secret", "cred", "passw", "cookie", "bearer", "auth"];

/** Fields that legitimately contain one of the markers and must not be stripped. */
const SECRET_MARKER_EXCEPTIONS = new Set(["displayName", "projectId", "path", "state"]);

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

/** How long a lock may be held before it is treated as abandoned. */
const LOCK_STALE_MS = 10_000;
/** Total time to wait for a contended lock before giving up. */
const LOCK_TIMEOUT_MS = 5_000;

function sleepSync(ms: number): void {
  const bunSleep = (globalThis as { Bun?: { sleepSync?: (ms: number) => void } }).Bun?.sleepSync;
  if (typeof bunSleep === "function") {
    bunSleep(ms);
    return;
  }
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy-wait fallback; the critical section is a few file operations long.
  }
}

/**
 * Run `fn` while holding an exclusive lock on the registry.
 *
 * Atomic writes prevent a TORN file; they do nothing about a LOST update, and
 * the read-modify-write here is exactly the shape that loses one. Two `keryx
 * init` runs at once is an ordinary thing to do, so the whole load-modify-save
 * is serialized instead.
 *
 * A lock older than {@link LOCK_STALE_MS} is treated as abandoned — a process
 * killed mid-write must not wedge every future registration.
 *
 * Returns `null` when the lock could not be taken, which callers surface as a
 * write failure rather than a throw.
 */
function withRegistryLock<T>(dir: string | undefined, fn: () => T): T | null {
  const lockPath = `${projectRegistryPath(dir)}.lock`;
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: number | null = null;
  while (handle === null) {
    try {
      handle = openSync(lockPath, "wx", 0o600);
    } catch {
      const age = statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs;
      if (age !== undefined && Date.now() - age > LOCK_STALE_MS) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Someone else broke it first; loop and retry.
        }
        continue;
      }
      if (Date.now() > deadline) {
        return null;
      }
      sleepSync(15);
    }
  }

  try {
    return fn();
  } finally {
    try {
      closeSync(handle);
    } catch {
      // already closed
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // best effort; a leftover lock goes stale and is broken above
    }
  }
}

/**
 * Keep only entries that are structurally sound.
 *
 * A half-valid entry is worse than a missing one: an entry with no `projectId`
 * can never be removed by `forget`, which contradicts the promise that an entry
 * is only ever removed by an explicit operator action.
 */
function validEntry(candidate: unknown): candidate is ProjectEntry {
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  const entry = candidate as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    entry.path.length > 0 &&
    typeof entry.projectId === "string" &&
    entry.projectId.length > 0 &&
    typeof entry.displayName === "string" &&
    (entry.state === "active" || entry.state === "missing") &&
    typeof entry.registeredAt === "string"
  );
}

/**
 * The identity of a project path: its real path when it resolves, its lexical
 * resolution otherwise.
 *
 * Lexical resolution alone is not identity — the same project reached through a
 * symlink, or through a differently-cased path on a case-insensitive
 * filesystem, produced a second entry with a second id, which is exactly what
 * "idempotent by path" was supposed to prevent.
 */
function projectIdentity(projectPath: string): string {
  const absolute = path.resolve(projectPath);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/** True when `field` looks like a credential name. Case-insensitive, substring. */
function isSecretShapedName(field: string): boolean {
  if (SECRET_MARKER_EXCEPTIONS.has(field)) {
    return false;
  }
  const lower = field.toLowerCase();
  return SECRET_FIELD_MARKERS.some((marker) => lower.includes(marker));
}

/** True when `value` carries a credential-shaped field at any depth. */
export function hasSecretShapedField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasSecretShapedField(item));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([field, nested]) => isSecretShapedName(field) || hasSecretShapedField(nested),
  );
}

/**
 * Remove credential-shaped fields at any depth, returning the cleaned value.
 *
 * Called on every write, so a secret that reached the file by any route — a
 * careless future field, a hand-edit, another tool — is dropped rather than
 * faithfully re-serialized next to `auth.json`.
 */
export function stripSecretShapedFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripSecretShapedFields(item)) as unknown as T;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [field, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretShapedName(field)) {
      continue;
    }
    cleaned[field] = stripSecretShapedFields(nested);
  }
  return cleaned as unknown as T;
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
    const raw = (parsed as ProjectRegistry).projects as unknown[];
    const projects = raw.filter(validEntry);
    if (projects.length !== raw.length) {
      onWarn?.(
        `project registry at ${file}: dropped ${raw.length - projects.length} malformed entr${raw.length - projects.length === 1 ? "y" : "ies"}`,
      );
    }
    return { schemaVersion: 1, projects };
  } catch {
    onWarn?.(`project registry at ${file} is unreadable; continuing with an empty registry`);
    return { ...EMPTY, projects: [] };
  }
}

/**
 * Move a damaged registry aside before overwriting it.
 *
 * Rewriting over corruption silently destroys whatever registrations were in
 * there. The operator gets a file they can inspect instead of a registry that
 * quietly lost every other project.
 */
function quarantineDamagedRegistry(dir: string | undefined, onWarn?: (message: string) => void): void {
  const file = projectRegistryPath(dir);
  if (!existsSync(file)) {
    return;
  }
  const backup = `${file}.corrupt-${Date.now()}`;
  try {
    renameSync(file, backup);
    onWarn?.(`project registry was damaged; the previous file was kept at ${backup}`);
  } catch {
    onWarn?.("project registry was damaged and could not be preserved before rewriting");
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
  // A pid is not unique: two processes sharing this directory across PID
  // namespaces (containers with a bind-mounted home) collide, and each can
  // rename the other's half-written temp into place.
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const sorted: ProjectRegistry = {
      schemaVersion: 1,
      // Sorted by path so the file is byte-stable and diffable regardless of
      // registration order.
      projects: stripSecretShapedFields(
        [...registry.projects].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      ),
    };
    const handle = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(handle, `${JSON.stringify(sorted, null, 2)}\n`, { encoding: "utf8" });
      // Durability: without this the rename can land while the data has not,
      // leaving a zero-length registry after a power loss.
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temp, file);
    return true;
  } catch {
    // Never leave the temp behind: a throw between create and rename would
    // otherwise orphan it forever.
    try {
      unlinkSync(temp);
    } catch {
      // nothing to clean up
    }
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
  options: {
    dir?: string;
    displayName?: string;
    now?: () => string;
    onWarn?: (message: string) => void;
  } = {},
): RegisterOutcome {
  const absolute = projectIdentity(projectPath);
  if (!isInitializedProject(absolute)) {
    return {
      ok: false,
      reason: "not-a-project",
      message: `${absolute} is not an initialized keryx project (no .metaproject/ directory). Run keryx init there first.`,
    };
  }

  const now = options.now?.() ?? new Date().toISOString();

  // The whole read-modify-write is inside the lock. Loading outside it and
  // saving inside would still lose an update.
  const outcome = withRegistryLock(options.dir, (): RegisterOutcome => {
    let damaged = false;
    const registry = loadProjectRegistry(options.dir, (message) => {
      damaged = true;
      options.onWarn?.(message);
    });
    if (damaged) {
      quarantineDamagedRegistry(options.dir, options.onWarn);
    }

    const existing = registry.projects.find((entry) => projectIdentity(entry.path) === absolute);
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
  });

  return (
    outcome ?? {
      ok: false,
      reason: "write-failed",
      message: "could not acquire the project registry lock",
    }
  );
}

export type ForgetOutcome = "removed" | "not-found" | "write-failed";

/**
 * Remove exactly one entry by id.
 *
 * The outcome is typed rather than a boolean: reporting a failed write as "no
 * such id" tells the operator the project is gone when it is still registered.
 */
export function forgetProject(projectId: string, dir?: string): ForgetOutcome {
  const outcome = withRegistryLock(dir, (): ForgetOutcome => {
    const registry = loadProjectRegistry(dir);
    const before = registry.projects.length;
    registry.projects = registry.projects.filter((entry) => entry.projectId !== projectId);
    if (registry.projects.length === before) {
      return "not-found";
    }
    return saveProjectRegistry(registry, dir) ? "removed" : "write-failed";
  });
  return outcome ?? "write-failed";
}

/**
 * True only when the path holds a `.metaproject` DIRECTORY.
 *
 * `existsSync` alone accepts a plain file named `.metaproject`, or a symlink to
 * any directory at all — neither is an initialized project, and both would
 * register and then report `active` forever.
 */
function isInitializedProject(projectPath: string): boolean {
  return statSync(path.join(projectPath, ".metaproject"), { throwIfNoEntry: false })?.isDirectory() === true;
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
  return isInitializedProject(projectPath);
}

/**
 * Deterministic machine-readable projection. Sorted by path; contains no
 * secrets.
 *
 * Warnings are part of the payload, not dropped: without them a machine
 * consumer cannot tell a corrupt registry from an empty one, since both would
 * be an empty project list with a success exit code.
 */
export function emitProjectsJson(entries: ProjectEntry[], warnings: string[] = []): string {
  const projects = stripSecretShapedFields(
    [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
  return JSON.stringify({ schemaVersion: 1, projects, warnings: [...warnings].sort() }, null, 2);
}

/**
 * Remove control characters before rendering a filesystem-derived string.
 *
 * `displayName` and `path` come from directory names, which an attacker or an
 * accident can fill with ANSI escapes. Printing them raw lets a directory name
 * rewrite the operator's terminal.
 */
export function sanitizeForDisplay(value: string): string {
  return value.replace(/[\\u0000-\\u001F\\u007F-\\u009F]/g, "");
}
