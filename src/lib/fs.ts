import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Generic Node fs-error predicate: true when `error` is an ENOENT (not found). */
export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Single source of truth for the stale-lock reclaim threshold `withFileLock`'s
 * `removeStaleLock` uses, and the default `isLockHeld` mirrors it with (flow
 * 165 AC5) — was an inline `30000` literal duplicated nowhere else; now both
 * consult this one constant so the two never drift apart.
 */
export const DEFAULT_LOCK_STALE_MS = 30000;

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; retryMs?: number; staleMs?: number; heartbeatMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const retryMs = options.retryMs ?? 25;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? Math.max(100, Math.floor(staleMs / 3));
  const startedAt = Date.now();
  const owner = { pid: process.pid, token: randomUUID() };
  const ownerPath = path.join(lockPath, "owner.json");

  await mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(ownerPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await removeStaleLock(lockPath, staleMs);
      if (Date.now() - startedAt >= timeoutMs) {
        // eslint-disable-next-line preserve-caught-error -- Preserve the sanitized public diagnostic without exposing the raw caught value or stack.
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await delay(retryMs);
    }
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    if (await ownsLock(ownerPath, owner.token)) {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

/**
 * Read-only mirror of `removeStaleLock`'s own staleness/aliveness rule (flow
 * 165 AC5, `src/sac/catch-up.ts`'s classifier is the intended caller): a
 * fresh-mtime lock (age <= `staleMs`) is always held, unconditionally, even
 * before an `owner.json` sidecar exists yet — this is what keeps the narrow
 * `mkdir(lockPath)` / `writeFile(ownerPath, ...)` acquisition window in
 * `withFileLock` from ever reading as "not held". Past `staleMs`, held iff
 * the recorded owner pid is still alive (aliveness wins over age, exactly
 * like `removeStaleLock`). Unlike `removeStaleLock`, this function never
 * mutates or removes the lock directory — a missing lock dir or any other
 * read failure (ENOENT, ENOTDIR, ...) degrades to "not held" rather than
 * throwing.
 */
export async function isLockHeld(lockPath: string, staleMs = DEFAULT_LOCK_STALE_MS): Promise<boolean> {
  try {
    const stats = await stat(lockPath);
    if (Date.now() - stats.mtimeMs <= staleMs) return true;
    const owner = await readLockOwner(path.join(lockPath, "owner.json"));
    return owner !== undefined && processIsAlive(owner.pid);
  } catch {
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function removeStaleLock(lockPath: string, staleMs: number): Promise<void> {
  try {
    const stats = await stat(lockPath);
    if (Date.now() - stats.mtimeMs <= staleMs) return;
    const owner = await readLockOwner(path.join(lockPath, "owner.json"));
    if (owner && processIsAlive(owner.pid)) return;
    const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
    await rename(lockPath, stalePath);
    await rm(stalePath, { recursive: true, force: true });
  } catch {
    // Another process may have released the lock between mkdir attempts.
  }
}

async function readLockOwner(ownerPath: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    return Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && typeof value.token === "string"
      ? { pid: Number(value.pid), token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
}

async function ownsLock(ownerPath: string, token: string): Promise<boolean> {
  return (await readLockOwner(ownerPath))?.token === token;
}

/** True when a process with `pid` exists (EPERM counts: it exists, it just is not ours). */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Long-held lease (agent bus P0, specification §3.1, decisions D-07 / D-09).
//
// `withFileLock` covers one callback; a lease outlives it and is held for the
// lifetime of an interactive session. It shares the on-disk shape (a directory
// plus `owner.json`) and nothing else. In particular it does NOT use
// `withFileLock`'s "a live pid wins over age" rule: a reused pid would keep a
// crashed holder alive forever. D-09 instead says:
//
//   live   `heartbeatAt` is at most `staleMs` old;
//   stale  older than that, the holder is on THIS host and its pid is alive
//          (hung, or its event loop stalled) — reclaimed only by an explicit
//          take-over (`reclaimStaleLeaseSync`);
//   gone   anything else — reclaimed silently by `acquireLeaseSync`.
//
// A missing, partial or corrupt `owner.json` is judged by the directory mtime
// instead: fresh means live (the acquisition window between `mkdirSync` and the
// `wx` write, mirroring `isLockHeld`), older than `staleMs` means gone.
//
// Everything here is synchronous because `openSession` and its callers are.
// ---------------------------------------------------------------------------

/** The fields the lease primitive itself relies on. Callers add their own. */
export interface LeaseOwnerBase {
  token: string;
  pid: number;
  host: string;
  /** ISO-8601 timestamp of the latest heartbeat. */
  heartbeatAt: string;
}

export type LeaseLiveness = "live" | "stale" | "gone";

export interface LeaseOptions<T extends LeaseOwnerBase = LeaseOwnerBase> {
  staleMs: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. Also stamps `refresh()`. */
  now?: () => number;
  /** Pid probe, injectable for tests. Defaults to `processIsAlive`. */
  isAlive?: (pid: number) => boolean;
  /** This host's name. Defaults to `os.hostname()`. */
  host?: string;
  /**
   * Treat a holder for which this returns true as gone, whatever its liveness.
   * Lets a caller reclaim a lease its own process left behind without having
   * the handle any more. Never consulted for an unreadable `owner.json`.
   */
  reclaimIf?: (holder: T) => boolean;
  /**
   * TEST SEAM, never set in production. Called at the points where another
   * process may interleave: `create` between the `mkdir` and the `owner.json`
   * write, `refresh` and `release` right after the handle judged the lease its
   * own and before it acts on that judgement. Tests use it to inject a rival's
   * take-over deterministically instead of relying on timing.
   */
  raceHook?: (point: "create" | "refresh" | "release") => void;
}

export interface LeaseHandle<T extends LeaseOwnerBase = LeaseOwnerBase> {
  /** The owner record as last written by this handle. */
  readonly owner: T;
  /**
   * Rewrite `owner.json` atomically (temp file in the lease directory, then
   * rename) with a fresh `heartbeatAt` and `patch` merged in (`token` in a
   * patch is ignored), then touch the directory mtime. Returns false, and
   * writes nothing, once the lease is released or no longer carries this
   * handle's token on disk.
   */
  refresh(patch?: Partial<T>): boolean;
  /**
   * True while the lease directory on disk is the one this handle created
   * (same inode) and still carries this handle's token. Read-only. False also
   * when that cannot be told right now (see `ownership`), so a write that
   * needs certainty is skipped.
   */
  holds(): boolean;
  /**
   * Whose lease this is, as far as the disk can tell right now (read-only):
   *
   * - `held`: our directory (same inode) with our token in a readable record;
   * - `lost`: the directory is gone, its inode differs, or a well-formed
   *   record carries another token — someone else has the lease;
   * - `unknown`: the record cannot be read or is malformed (EMFILE, EIO, a
   *   torn read, ...). Not a loss: ask again at the next check.
   */
  ownership(): LeaseOwnership;
  /** Remove the lease directory iff the token on disk is ours. Idempotent. */
  release(): void;
}

export type LeaseOwnership = "held" | "lost" | "unknown";

export type AcquireLeaseResult<T extends LeaseOwnerBase = LeaseOwnerBase> =
  | { ok: true; handle: LeaseHandle<T> }
  | { ok: false; holder: T | undefined; state: "live" | "stale" };

export type LeaseInspection<T extends LeaseOwnerBase = LeaseOwnerBase> =
  | { state: "free" }
  | { state: LeaseLiveness; holder: T | undefined };

const LEASE_OWNER_FILE = "owner.json";
const MAX_LEASE_ATTEMPTS = 3;

/**
 * The lease's `owner.json`, or undefined when it is missing, unreadable, not
 * JSON, or lacks a well-formed `token`/`pid`/`host`/`heartbeatAt`.
 */
export function readLeaseOwnerSync<T extends LeaseOwnerBase = LeaseOwnerBase>(lockPath: string): T | undefined {
  try {
    const value = JSON.parse(readFileSync(path.join(lockPath, LEASE_OWNER_FILE), "utf8")) as unknown;
    if (value === null || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    const wellFormed =
      typeof record.token === "string" &&
      record.token.length > 0 &&
      Number.isSafeInteger(record.pid) &&
      Number(record.pid) > 0 &&
      typeof record.host === "string" &&
      typeof record.heartbeatAt === "string" &&
      !Number.isNaN(Date.parse(record.heartbeatAt));
    return wellFormed ? (record as unknown as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Classify a lease directory by the D-09 rule without touching it. */
export function inspectLeaseSync<T extends LeaseOwnerBase = LeaseOwnerBase>(
  lockPath: string,
  opts: LeaseOptions<T>,
): LeaseInspection<T> {
  const now = (opts.now ?? Date.now)();
  let dirMtimeMs: number;
  try {
    dirMtimeMs = statSync(lockPath).mtimeMs;
  } catch (error) {
    if (isNotFound(error)) return { state: "free" };
    throw error;
  }
  const holder = readLeaseOwnerSync<T>(lockPath);
  if (holder === undefined) {
    return { state: now - dirMtimeMs <= opts.staleMs ? "live" : "gone", holder: undefined };
  }
  if (opts.reclaimIf?.(holder) === true) {
    return { state: "gone", holder };
  }
  // Known limit (clock skew): `heartbeatAt` is stamped by the HOLDER's clock
  // and judged by OURS. On one host that is the same clock. Across hosts
  // sharing a data dir, a holder whose clock runs ahead reads live for longer
  // than staleMs after it died, and one whose clock runs more than staleMs
  // behind reads as not live while it is still heartbeating — and, being on
  // another host, as gone, so it is reclaimed silently. P0 does not correct
  // for skew; a holder that loses its lease this way finds out on its next
  // refresh (SessionLeaseHandle.onLost) and stops writing.
  if (now - Date.parse(holder.heartbeatAt) <= opts.staleMs) {
    return { state: "live", holder };
  }
  const thisHost = opts.host ?? hostname();
  const isAlive = opts.isAlive ?? processIsAlive;
  return { state: holder.host === thisHost && isAlive(holder.pid) ? "stale" : "gone", holder };
}

/**
 * Acquire the lease at `lockPath` for `owner`. A **gone** holder is reclaimed
 * silently and acquisition retried; a **live** or **stale** one is reported
 * and left alone. Creates the directory 0700 and `owner.json` 0600.
 */
export function acquireLeaseSync<T extends LeaseOwnerBase>(
  lockPath: string,
  owner: T,
  opts: LeaseOptions<T>,
): AcquireLeaseResult<T> {
  return acquireOrReclaim(lockPath, owner, opts, false);
}

/**
 * Explicit take-over (`--take-over`): acquire the lease at `lockPath` for
 * `owner`, reclaiming a **stale** holder as well as a gone one. A **live**
 * holder is refused (`{ ok: false, state: "live" }`) and left untouched. A free
 * lease is simply acquired.
 */
export function reclaimStaleLeaseSync<T extends LeaseOwnerBase>(
  lockPath: string,
  owner: T,
  opts: LeaseOptions<T>,
): AcquireLeaseResult<T> {
  return acquireOrReclaim(lockPath, owner, opts, true);
}

function acquireOrReclaim<T extends LeaseOwnerBase>(
  lockPath: string,
  owner: T,
  opts: LeaseOptions<T>,
  takeStale: boolean,
): AcquireLeaseResult<T> {
  const now = opts.now ?? Date.now;
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < MAX_LEASE_ATTEMPTS; attempt += 1) {
    const createdIno = tryCreateLease(lockPath, owner, opts.raceHook);
    if (createdIno !== undefined) {
      return { ok: true, handle: createLeaseHandle(lockPath, owner, createdIno, now, opts.raceHook) };
    }
    const seen = inspectLeaseSync(lockPath, opts);
    if (seen.state === "free") continue; // released between our mkdir and the look
    if (seen.state === "live" || (seen.state === "stale" && !takeStale)) {
      return { ok: false, holder: seen.holder, state: seen.state };
    }
    removeLeaseDirIfUnchanged(lockPath, seen.holder?.token);
  }
  // Every attempt lost a race to another acquirer. Report what is there now.
  const last = inspectLeaseSync(lockPath, opts);
  return {
    ok: false,
    holder: last.state === "free" ? undefined : last.holder,
    state: last.state === "stale" ? "stale" : "live",
  };
}

/**
 * mkdir + exclusive owner write. Returns the new directory's inode, or
 * undefined when the directory already exists (or, see below, was replaced
 * before our record landed in it).
 */
function tryCreateLease(
  lockPath: string,
  owner: LeaseOwnerBase,
  raceHook?: LeaseOptions["raceHook"],
): number | undefined {
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (isAlreadyExistsError(error)) return undefined;
    throw error;
  }
  // Our directory, by identity. Everything below that removes something checks
  // it first: between the mkdir and the write, a reclaimer's rename-back
  // (`moveLeaseAside`) can land another holder's lease on this path, and a
  // blind `rm -r lockPath` would then delete THEIR lease.
  let createdIno: number;
  try {
    createdIno = statSync(lockPath).ino;
  } catch (error) {
    if (isNotFound(error)) return undefined; // already reclaimed from under us
    throw error;
  }
  raceHook?.("create");
  const ownerPath = path.join(lockPath, LEASE_OWNER_FILE);
  try {
    chmodSync(lockPath, 0o700); // mkdir's mode is filtered by the umask
    writeFileSync(ownerPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    const stillOurs = inodeOf(lockPath) === createdIno;
    if (stillOurs) {
      // Only a record we may have half-written is removed; `wx` failing with
      // EEXIST means the file there is not ours, so it stays, and so does the
      // (then non-empty) directory.
      if (!isAlreadyExistsError(error)) rmSync(ownerPath, { force: true });
      try {
        rmdirSync(lockPath); // only when empty
      } catch {
        // Not empty: something that is not ours is in it; leave it.
      }
    }
    // A lease that replaced our directory is another holder's: report the path
    // as taken (the caller inspects it) instead of failing the acquire.
    if (!stillOurs || isAlreadyExistsError(error)) return undefined;
    throw error;
  }
  return createdIno;
}

/** The inode at `target`, or undefined when nothing (readable) is there. */
function inodeOf(target: string): number | undefined {
  try {
    return statSync(target).ino;
  } catch {
    return undefined;
  }
}

/**
 * Move the lease directory aside to a unique name, then either remove it
 * (`removeIf` says the one moved is the one meant) or rename it back. The
 * rename is atomic, so what is judged is exactly what is removed.
 *
 * When the rename-back fails, a newer lease has taken the path meanwhile. With
 * `keepOnConflict` the moved directory is left where it is (its holder's data
 * is kept; that holder's next refresh finds the path is not its lease and
 * reports the lease lost); without it, the moved one is removed, as a
 * reclaimer that judged it gone would have.
 *
 * Remaining window: a rename-back lands on an EMPTY directory that a third
 * acquirer made between its `mkdir` and its `owner.json` write (POSIX rename
 * replaces an empty directory). That acquirer's write then fails, and
 * `tryCreateLease` sees the inode is no longer its own and leaves the lease.
 */
function moveLeaseAside(
  lockPath: string,
  removeIf: (moved: LeaseOwnerBase | undefined) => boolean,
  keepOnConflict: boolean,
): void {
  const aside = `${lockPath}.aside.${process.pid}.${randomUUID()}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return; // someone else already removed or reclaimed it
  }
  if (!removeIf(readLeaseOwnerSync(aside))) {
    try {
      renameSync(aside, lockPath);
      return;
    } catch {
      if (keepOnConflict) return;
    }
  }
  rmSync(aside, { recursive: true, force: true });
}

/**
 * Remove a lease directory judged gone (or stale, on take-over), and only that
 * one: when another acquirer replaced it after the judgement, the fresh lease
 * is renamed back. A readable record with another token is someone else's.
 */
function removeLeaseDirIfUnchanged(lockPath: string, expectedToken: string | undefined): void {
  moveLeaseAside(lockPath, (moved) => moved === undefined || moved.token === expectedToken, false);
}

function createLeaseHandle<T extends LeaseOwnerBase>(
  lockPath: string,
  initial: T,
  createdIno: number,
  now: () => number,
  raceHook?: LeaseOptions["raceHook"],
): LeaseHandle<T> {
  let current: T = { ...initial };
  let released = false;
  const ownerPath = path.join(lockPath, LEASE_OWNER_FILE);
  // Ours means: the directory this handle created (inode) with our token in it.
  // Only positive evidence of another owner is a loss; a record that cannot be
  // read or parsed right now is `unknown`, never `lost` (review r2 N2).
  const ownership = (): LeaseOwnership => {
    let ino: number;
    try {
      ino = statSync(lockPath).ino;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      return code === "ENOENT" || code === "ENOTDIR" ? "lost" : "unknown";
    }
    if (ino !== createdIno) return "lost";
    const record = readLeaseOwnerSync(lockPath);
    if (record === undefined) return "unknown";
    return record.token === initial.token ? "held" : "lost";
  };
  // `refresh` and `release` act only on `held`: on `unknown` they skip the
  // write, so an unreadable or foreign record is never renamed over or removed.
  const holds = (): boolean => ownership() === "held";

  return {
    get owner(): T {
      return current;
    },
    refresh(patch?: Partial<T>): boolean {
      if (released || !holds()) return false;
      raceHook?.("refresh");
      const next: T = { ...current, ...patch, token: initial.token, heartbeatAt: new Date(now()).toISOString() };
      const tmp = path.join(lockPath, `.${LEASE_OWNER_FILE}.${randomUUID()}.tmp`);
      try {
        writeFileSync(tmp, JSON.stringify(next), { encoding: "utf8", flag: "wx", mode: 0o600 });
        // Re-check immediately before the rename: a take-over since the check
        // above must not have its record replaced by ours. The window left is
        // the few instructions between this check and the rename; a
        // directory lease without a kernel lock cannot close it entirely.
        if (!holds()) {
          rmSync(tmp, { force: true });
          return false;
        }
        renameSync(tmp, ownerPath);
      } catch {
        rmSync(tmp, { force: true });
        return false;
      }
      current = next;
      try {
        const touched = new Date();
        utimesSync(lockPath, touched, touched);
      } catch {
        // The owner record carries the heartbeat; the mtime is a secondary signal.
      }
      return true;
    },
    holds,
    ownership,
    release(): void {
      if (released) return;
      released = true;
      // Cheap pre-check: never move a lease that is plainly someone else's (a
      // lost lease is released on exit too), since moving it, even briefly,
      // would make its holder's refresh fail.
      if (!holds()) return;
      raceHook?.("release");
      // Then the authoritative, atomic check: move whatever is there aside,
      // and remove it only if it is ours; otherwise put it back, and if that
      // loses a race, keep the other holder's data where it is.
      moveLeaseAside(lockPath, (moved) => moved?.token === initial.token, true);
    },
  };
}
