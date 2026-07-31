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
const SECRET_WORDS = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "cookie",
  "bearer",
  "auth",
  "apikey",
  "jwt",
  "signature",
]);

/**
 * `key` on its own is not a marker: `sortKey` and `apiKey` are indistinguishable
 * by that word alone, and treating it as a secret deletes the first while
 * catching the second. So `key` counts only when qualified by one of these.
 */
const KEY_QUALIFIERS = new Set(["api", "private", "secret", "access", "signing", "encryption", "session"]);

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
/**
 * Total time to wait for a contended lock before giving up.
 *
 * Deliberately LONGER than {@link LOCK_STALE_MS}: with the shorter value a
 * caller gave up before a genuinely crashed holder's lock became breakable, so
 * every registration failed for a window instead of waiting it out.
 */
const LOCK_TIMEOUT_MS = 15_000;

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

  // A nonce identifies THIS holder. Without it, a holder whose critical section
  // ran past the stale threshold has its lock broken by someone else and then
  // deletes the new holder's lock in its own `finally` — letting a third caller
  // in while the second is still inside, which is the lost update the lock
  // exists to prevent.
  const nonce = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: number | null = null;

  while (handle === null) {
    // The deadline is checked FIRST, before the stale branch. Checking it only
    // in the contended branch meant an unremovable stale lock (read-only or
    // root-owned config dir) spun forever at full CPU instead of degrading to a
    // reported write failure.
    if (Date.now() > deadline) {
      return null;
    }
    try {
      handle = openSync(lockPath, "wx", 0o600);
      writeFileSync(handle, nonce, { encoding: "utf8" });
    } catch {
      const age = statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs;
      if (age !== undefined && Date.now() - age > LOCK_STALE_MS) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Someone else broke it first, or we cannot remove it at all; either
          // way sleep and retry until the deadline rather than spinning.
        }
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
    // Only remove the lock if it is still OURS. If it was broken as stale and
    // retaken, the file now holds someone else's nonce and must be left alone.
    try {
      if (readFileSync(lockPath, "utf8") === nonce) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // Gone already, or unreadable; a leftover goes stale and is broken above.
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

/**
 * Split a field name into lowercase words across camelCase, snake_case,
 * kebab-case and SCREAMING_CASE.
 */
function fieldWords(field: string): string[] {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+|\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * True when `field` looks like a credential name.
 *
 * Matched on whole WORDS, not raw substrings. A bare `includes` meant `key`
 * matched `monkeyPatch` and `sortKey`, `auth` matched `authoredAt`, and `cred`
 * matched `credibility` — each of which would then be deleted on the next
 * write, permanently and invisibly.
 */
function isSecretShapedName(field: string): boolean {
  const words = fieldWords(field);
  if (words.some((word) => SECRET_WORDS.has(word))) {
    return true;
  }
  // `key` only in company: apiKey and privateKey are credentials, sortKey and
  // keyboardLayout are not, and nothing in the word alone separates them.
  return words.includes("key") && words.some((word) => KEY_QUALIFIERS.has(word));
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
export function stripSecretShapedFields<T>(value: T, onStrip?: (field: string) => void): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripSecretShapedFields(item, onStrip)) as unknown as T;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [field, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretShapedName(field)) {
      // Named, not silent. Dropping data invisibly is how a future field gets
      // destroyed with nobody able to explain where it went.
      onStrip?.(field);
      continue;
    }
    cleaned[field] = stripSecretShapedFields(nested, onStrip);
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
export function saveProjectRegistry(
  registry: ProjectRegistry,
  dir?: string,
  onWarn?: (message: string) => void,
): boolean {
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
        (field) => onWarn?.(`project registry: dropped credential-shaped field "${field}"`),
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
      if (!saveProjectRegistry(registry, options.dir, options.onWarn)) {
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
    if (!saveProjectRegistry(registry, options.dir, options.onWarn)) {
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
export function forgetProject(
  projectId: string,
  dir?: string,
  onWarn?: (message: string) => void,
): ForgetOutcome {
  const outcome = withRegistryLock(dir, (): ForgetOutcome => {
    // Same treatment as registerProject: a writer that loads silently and then
    // rewrites destroys every entry the loader dropped. Fixing that in one
    // writer and not the other just moved the defect.
    let damaged = false;
    const registry = loadProjectRegistry(dir, (message) => {
      damaged = true;
      onWarn?.(message);
    });
    if (damaged) {
      quarantineDamagedRegistry(dir, onWarn);
    }
    const before = registry.projects.length;
    registry.projects = registry.projects.filter((entry) => entry.projectId !== projectId);
    if (registry.projects.length === before) {
      return "not-found";
    }
    return saveProjectRegistry(registry, dir, onWarn) ? "removed" : "write-failed";
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
  // Written with String.fromCharCode ranges rather than an escape literal: the
  // escaped form was introduced by a patch script that doubled the backslashes,
  // producing a literal-character class that stripped digits and capitals and no
  // control character at all. A range built from code points cannot be wrong in
  // that way, and the tests below pin both halves of the behaviour.
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    if (!isControl) {
      out += char;
    }
  }
  return out;
}
