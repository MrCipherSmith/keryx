// Session lease (agent bus P0, specification §2.2, §6; decisions D-07, D-09).
//
// One interactive instance holds an open session at a time. The lease is a
// directory lock at `<sessionDir>/active.lease/` whose `owner.json` follows
// `docs/requirements/keryx-agent-bus/schemas/session-lease.schema.json`.
//
// Leasing is OPT-IN and lives only here: `openSession` (store.ts) is unchanged
// and takes no lock, because store tests open a session and then
// `continueLast` it in the same process, and because a pure store function
// should not be tied to the lifetime of the process calling it.
//
// All raw filesystem I/O is in `lib/fs.ts` (`acquireLeaseSync` and friends).
// This file only resolves the lease path, so the config-dir writer/reader
// guards, which flag a file that both names `sessionDir(` and makes a raw fs
// call, stay accurate without an exemption.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import {
  acquireLeaseSync,
  inspectLeaseSync,
  type LeaseHandle,
  type LeaseOptions,
  readLeaseOwnerSync,
  reclaimStaleLeaseSync,
} from "../lib/fs";
import { resolveProjectRoot, sessionDir } from "./paths";
import {
  findSession,
  forkSession,
  isExternalRunSession,
  listSessions,
  openSession,
  shortSessionId,
  type OpenSessionOptions,
  type SessionSummary,
} from "./store";

/** A holder whose heartbeat is older than this is no longer live (D-09). */
export const SESSION_LEASE_STALE_MS = 15_000;
/** How often an open session's lease is refreshed. */
export const SESSION_LEASE_HEARTBEAT_MS = 5_000;

/** `owner.json`, exactly the fields of `session-lease.schema.json`. */
export interface SessionLeaseOwner {
  schemaVersion: 1;
  token: string;
  pid: number;
  host: string;
  instanceId: string;
  /** null in P0; the bus name after joinBus (specification §5.1). */
  name: string | null;
  acquiredAt: string;
  heartbeatAt: string;
}

export type SessionLeaseState = "free" | "mine" | "live" | "stale";

export interface SessionLeaseHandle {
  readonly sessionId: string;
  readonly lockPath: string;
  /** The owner record as this handle last wrote it. */
  readonly owner: SessionLeaseOwner;
  readonly released: boolean;
  /** The unref'd heartbeat timer; undefined once released. Exposed for tests. */
  readonly heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * True once another owner took the lease (or its directory disappeared)
   * while this handle still meant to hold it. A lost handle stops its
   * heartbeat and never releases, since the lease on disk is not ours.
   */
  readonly lost: boolean;
  /** The record found on disk when the loss was noticed; undefined if the directory was gone. */
  readonly lostTo: SessionLeaseOwner | undefined;
  /** Refresh now, merging `patch`. False once released or lost. */
  refresh(patch?: Partial<Pick<SessionLeaseOwner, "name">>): boolean;
  /**
   * Check the disk now (not only at the next heartbeat) and return `lost`.
   * Callers run it right before a persist, so a take-over since the last
   * heartbeat is caught at the write. Released handles only report the flag.
   */
  checkLost(): boolean;
  /**
   * Call `cb` once when the lease is lost (at once when it already is).
   * Returns an unsubscribe function.
   */
  onLost(cb: () => void): () => void;
  /** Same as `releaseSessionLease(this)`. */
  release(): void;
}

/** Liveness knobs. Tests inject these; production uses the defaults. */
export interface SessionLeaseTiming {
  staleMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  host?: string;
}

let instanceId: string | undefined;

/** This process's instance id: a UUID minted lazily, once per process. */
export function processInstanceId(): string {
  instanceId ??= randomUUID();
  return instanceId;
}

/** Smallest staleMs the test knob may set. */
const MIN_ENV_STALE_MS = 250;
/** Smallest heartbeatMs the test knob may set. */
const MIN_ENV_HEARTBEAT_MS = 50;

/** A whole number of milliseconds from an environment variable, if well-formed. */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/**
 * TEST-ONLY knobs: `KERYX_SESSION_LEASE_STALE_MS` and
 * `KERYX_SESSION_LEASE_HEARTBEAT_MS` let the subprocess tests shorten D-09's
 * 15 s / 5 s so a stale holder can be produced without waiting. They are not
 * documented for users, and they are guarded because a tiny staleMs would let
 * `--take-over` seize a live shell and silently reclaim remote holders:
 *
 * - honoured only in a test context: `NODE_ENV === "test"` (set by `bun test`)
 *   or `KERYX_TEST_LEASE_TIMING === "1"` (set by the subprocess tests);
 * - staleMs only when >= 250 ms; heartbeatMs only when >= 50 ms and at most
 *   staleMs / 3, so the process's own lease cannot flap;
 * - any other value is ignored and the default applies;
 * - an explicit option always wins over them.
 */
function leaseTimingEnvEnabled(): boolean {
  return process.env.NODE_ENV === "test" || process.env.KERYX_TEST_LEASE_TIMING === "1";
}

/**
 * staleMs / heartbeatMs from the options, then the guarded test knobs, then
 * the D-09 defaults. The default heartbeat never exceeds a third of staleMs.
 * Exported for tests.
 */
export function resolveSessionLeaseTiming(
  timing: SessionLeaseTiming = {},
): Required<Pick<SessionLeaseTiming, "staleMs" | "heartbeatMs">> & SessionLeaseTiming {
  const fromEnv = leaseTimingEnvEnabled();
  const envStale = fromEnv ? envInt("KERYX_SESSION_LEASE_STALE_MS") : undefined;
  const staleMs = timing.staleMs ?? (envStale !== undefined && envStale >= MIN_ENV_STALE_MS ? envStale : SESSION_LEASE_STALE_MS);
  const maxHeartbeat = Math.floor(staleMs / 3);
  const envHeartbeat = fromEnv ? envInt("KERYX_SESSION_LEASE_HEARTBEAT_MS") : undefined;
  const heartbeatMs =
    timing.heartbeatMs ??
    (envHeartbeat !== undefined && envHeartbeat >= MIN_ENV_HEARTBEAT_MS && envHeartbeat <= maxHeartbeat
      ? envHeartbeat
      : Math.max(1, Math.min(SESSION_LEASE_HEARTBEAT_MS, maxHeartbeat)));
  return { ...timing, staleMs, heartbeatMs };
}

const resolveTiming = resolveSessionLeaseTiming;

function isMine(holder: Pick<SessionLeaseOwner, "instanceId" | "pid"> | undefined): boolean {
  return holder !== undefined && holder.instanceId === processInstanceId() && holder.pid === process.pid;
}

function leaseOptions(timing: ReturnType<typeof resolveTiming>): LeaseOptions<SessionLeaseOwner> {
  return {
    staleMs: timing.staleMs,
    ...(timing.now !== undefined ? { now: timing.now } : {}),
    ...(timing.isAlive !== undefined ? { isAlive: timing.isAlive } : {}),
    ...(timing.host !== undefined ? { host: timing.host } : {}),
  };
}

/** `<sessionDir>/active.lease`, specification §2.2. */
export function sessionLeasePath(cwd: string, sessionId: string, dataDir?: string): string {
  return path.join(sessionDir(resolveProjectRoot(cwd), sessionId, dataDir), "active.lease");
}

/**
 * Who holds `sessionId`. A **gone** holder (D-09) reads as `free`, because the
 * next acquirer reclaims it silently. `mine` is this very process instance.
 */
export function sessionLeaseState(
  cwd: string,
  sessionId: string,
  dataDir?: string,
  timing?: SessionLeaseTiming,
): { state: SessionLeaseState; holder?: SessionLeaseOwner } {
  const resolved = resolveTiming(timing);
  const seen = inspectLeaseSync<SessionLeaseOwner>(sessionLeasePath(cwd, sessionId, dataDir), leaseOptions(resolved));
  if (seen.state === "free" || seen.state === "gone") return { state: "free" };
  if (isMine(seen.holder)) return { state: "mine", holder: seen.holder as SessionLeaseOwner };
  return { state: seen.state, ...(seen.holder !== undefined ? { holder: seen.holder } : {}) };
}

export interface SkippedSession {
  summary: SessionSummary;
  holder: SessionLeaseOwner | undefined;
  state: "live" | "stale";
}

/**
 * The newest session in this project not held by ANOTHER instance (`mine`
 * counts as unleased). `skipped` names the newest held session passed over,
 * so the caller can say who holds it (§6.1).
 */
export function latestUnleasedSession(
  cwd: string,
  dataDir?: string,
  timing?: SessionLeaseTiming,
): { summary: SessionSummary | undefined; skipped?: SkippedSession } {
  let skipped: SkippedSession | undefined;
  for (const summary of listSessions(cwd, dataDir)) {
    // `-c` continues the shell's own kind of session, never the record of an
    // external agent run (flow 300, AC9).
    if (isExternalRunSession(summary)) continue;
    const { state, holder } = sessionLeaseState(cwd, summary.id, dataDir, timing);
    if (state === "free" || state === "mine") {
      return { summary, ...(skipped !== undefined ? { skipped } : {}) };
    }
    skipped ??= { summary, holder, state };
  }
  return { summary: undefined, ...(skipped !== undefined ? { skipped } : {}) };
}

/** `@<name> (pid <pid>)`, or `instance <first 8 of instanceId> (pid <pid>)` (§6.1). */
export function describeLeaseHolder(holder: SessionLeaseOwner | undefined): string {
  if (holder === undefined) return "another instance (still starting)";
  if (typeof holder.name === "string" && holder.name.length > 0) return `@${holder.name} (pid ${holder.pid})`;
  return `instance ${String(holder.instanceId).slice(0, 8)} (pid ${holder.pid})`;
}

/**
 * The session is leased by another instance. Callers that catch open errors
 * and fall back to a new session must rethrow this one.
 */
export class SessionLeasedError extends Error {
  readonly summary: SessionSummary;
  readonly holder: SessionLeaseOwner | undefined;
  readonly state: "live" | "stale";

  constructor(
    summary: SessionSummary,
    holder: SessionLeaseOwner | undefined,
    state: "live" | "stale",
    opts: { takeOverRefused?: boolean } = {},
  ) {
    const where = `session ${shortSessionId(summary.id)} is open in ${describeLeaseHolder(holder)}`;
    const hint =
      opts.takeOverRefused === true
        ? "; the holder is live, so --take-over is refused; use --fork"
        : state === "stale"
          ? "; use --fork or --take-over"
          : "; use --fork";
    super(`${where}${hint}`);
    this.name = "SessionLeasedError";
    this.summary = summary;
    this.holder = holder;
    this.state = state;
  }
}

// ---------------------------------------------------------------------------
// Handles held by this process, keyed by lease path. Re-opening a session this
// process already holds (for example `/resume` of the current session) returns
// the existing handle instead of refusing against ourselves.
// ---------------------------------------------------------------------------

const heldByThisProcess = new Map<string, SessionLeaseHandle>();

function wrapHandle(
  sessionId: string,
  lockPath: string,
  inner: LeaseHandle<SessionLeaseOwner>,
  heartbeatMs: number,
): SessionLeaseHandle {
  let released = false;
  let lost = false;
  let lostTo: SessionLeaseOwner | undefined;
  const lostListeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const onExit = (): void => {
    handle.release();
  };
  const stopHeartbeat = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  /** Another owner has the lease: stop, forget the handle, tell the listeners once. */
  const markLost = (): void => {
    if (lost || released) return;
    lost = true;
    lostTo = readLeaseOwnerSync<SessionLeaseOwner>(lockPath);
    stopHeartbeat();
    if (heldByThisProcess.get(lockPath) === handle) heldByThisProcess.delete(lockPath);
    const listeners = [...lostListeners];
    lostListeners.clear();
    for (const cb of listeners) {
      try {
        cb();
      } catch {
        // A listener's failure must not stop the others or the heartbeat path.
      }
    }
  };

  const handle: SessionLeaseHandle = {
    sessionId,
    lockPath,
    get owner() {
      return inner.owner;
    },
    get released() {
      return released;
    },
    get heartbeatTimer() {
      return timer;
    },
    get lost() {
      return lost;
    },
    get lostTo() {
      return lostTo;
    },
    refresh(patch) {
      if (released || lost) return false;
      if (inner.refresh(patch)) return true;
      // A failed refresh is a loss only on positive evidence that the lease on
      // disk is someone else's; a transient write or read error (a full disk,
      // EMFILE, a torn read) is not, and the next heartbeat tries again.
      if (inner.ownership() === "lost") markLost();
      return false;
    },
    checkLost() {
      if (!lost && !released && inner.ownership() === "lost") markLost();
      return lost;
    },
    onLost(cb) {
      if (lost) {
        cb();
        return () => {};
      }
      lostListeners.add(cb);
      return () => {
        lostListeners.delete(cb);
      };
    },
    release() {
      if (released) return;
      released = true;
      stopHeartbeat();
      lostListeners.clear();
      process.off("exit", onExit);
      if (heldByThisProcess.get(lockPath) === handle) heldByThisProcess.delete(lockPath);
      // A lost lease is someone else's now: leave it alone.
      if (!lost) inner.release();
    },
  };

  // A lost lease (someone took it over) stops refreshing and notifies; it
  // never rewrites another holder's record (`inner.refresh` checks first).
  timer = setInterval(() => {
    handle.refresh();
  }, heartbeatMs);
  timer.unref?.();
  process.on("exit", onExit);
  heldByThisProcess.set(lockPath, handle);
  return handle;
}

function mintOwner(now: () => number): SessionLeaseOwner {
  const at = new Date(now()).toISOString();
  return {
    schemaVersion: 1,
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    instanceId: processInstanceId(),
    name: null,
    acquiredAt: at,
    heartbeatAt: at,
  };
}

/**
 * Acquire the lease on `summary`, or throw `SessionLeasedError`. With
 * `takeOver`, a stale holder is reclaimed; a live one is still refused.
 */
function leaseSession(
  cwd: string,
  summary: SessionSummary,
  dataDir: string | undefined,
  timing: ReturnType<typeof resolveTiming>,
  takeOver: boolean,
): LeasedHandle {
  const lockPath = sessionLeasePath(cwd, summary.id, dataDir);
  const existing = heldByThisProcess.get(lockPath);
  if (existing !== undefined && !existing.released && !existing.lost) return { handle: existing, minted: false };

  const owner = mintOwner(timing.now ?? Date.now);
  const opts: LeaseOptions<SessionLeaseOwner> = {
    ...leaseOptions(timing),
    // A record naming this very instance with no live handle is our own
    // leftover (a release that failed half-way); reclaim it.
    reclaimIf: (holder) => isMine(holder),
  };
  const result = takeOver ? reclaimStaleLeaseSync(lockPath, owner, opts) : acquireLeaseSync(lockPath, owner, opts);
  if (!result.ok) {
    throw new SessionLeasedError(summary, result.holder, result.state, {
      takeOverRefused: takeOver && result.state === "live",
    });
  }
  return { handle: wrapHandle(summary.id, lockPath, result.handle, timing.heartbeatMs), minted: true };
}

/** A lease handle, and whether this call minted it (false: this process already held it). */
interface LeasedHandle {
  handle: SessionLeaseHandle;
  minted: boolean;
}

/**
 * The one line an operator sees when this shell's lease was taken (review F1):
 * which session, by whom, that nothing more is saved, and the way out.
 */
export function describeLeaseLoss(handle: Pick<SessionLeaseHandle, "sessionId" | "lostTo">): string {
  const short = shortSessionId(handle.sessionId);
  const by = handle.lostTo !== undefined ? describeLeaseHolder(handle.lostTo) : "another instance";
  return (
    `session ${short} was taken over by ${by}; this shell no longer saves it. ` +
    `Use /new, or restart with -r ${short} --fork to keep your turns.\n`
  );
}

/** `/compact` after the lease was lost: compaction writes the session, so it is refused. */
export const LOST_LEASE_COMPACT_REFUSAL =
  "Not compacted: another shell took this session over, and this shell no longer saves it. Use /new.\n";

/**
 * The persist guard every interactive surface puts in front of its saves
 * (review F1). `track` follows the lease the surface currently holds;
 * `canPersist` is false once that lease is lost, checking the disk so a
 * take-over since the last heartbeat is caught at the write; `notify` runs
 * once per lost lease with the operator line.
 */
export interface LeaseLossWatch {
  track(next: SessionLeaseHandle | undefined): void;
  canPersist(): boolean;
}

export function watchLeaseLoss(notify: (message: string, lost: SessionLeaseHandle) => void): LeaseLossWatch {
  let current: SessionLeaseHandle | undefined;
  let unsubscribe: (() => void) | undefined;
  return {
    track(next) {
      if (next === current) return;
      unsubscribe?.();
      unsubscribe = undefined;
      current = next;
      if (next !== undefined) {
        unsubscribe = next.onLost(() => {
          notify(describeLeaseLoss(next), next);
        });
      }
    },
    canPersist() {
      return current === undefined || !current.checkLost();
    },
  };
}

/**
 * `value`, or undefined once the lease guarding it is lost (review r2 N1).
 * `canPersist` checks the disk, so a take-over is caught at the read that
 * precedes a write, not only at the next heartbeat or save.
 */
export function whilePersisting<T>(value: T | undefined, canPersist: () => boolean): T | undefined {
  return value !== undefined && !canPersist() ? undefined : value;
}

/**
 * Gate every READ of `box.current` by `canPersist` (review r2 N1): once the
 * lease is lost, readers of the box (the readline agent's slate getters,
 * `getSessionDir` / `getSlateSession`, built before any session is open) see
 * undefined, so no slate tool writes into a session this shell no longer
 * holds. Writes to `box.current` are unchanged.
 */
export function gateBoxByLease<T>(box: { current: T | undefined }, canPersist: () => boolean): void {
  let value = box.current;
  Object.defineProperty(box, "current", {
    configurable: true,
    enumerable: true,
    get: () => whilePersisting(value, canPersist),
    set: (next: T | undefined) => {
      value = next;
    },
  });
}

/** Idempotent: stops the heartbeat, removes the exit hook, removes the lease if ours. */
export function releaseSessionLease(handle: SessionLeaseHandle | undefined): void {
  handle?.release();
}

export interface OpenLeasedSessionOptions extends OpenSessionOptions, SessionLeaseTiming {
  /** With `resumeId`: reclaim a STALE holder's lease. A live holder is refused. */
  takeOver?: boolean;
  /** With `resumeId`: fork the source (no lease needed on it) and lease the fork. */
  fork?: boolean;
}

export type OpenLeasedSessionResult = ReturnType<typeof openSession> & {
  lease: SessionLeaseHandle;
  /** `continueLast` passed over this held session (the newest one). */
  skipped?: SkippedSession;
};

/**
 * `openSession`, plus the session lease (specification §6.1).
 *
 * - `continueLast`: the newest session not leased by another instance; when
 *   every session is held, a new session, with `skipped` naming the holder.
 * - `resumeId`: leased by another live instance → `SessionLeasedError`
 *   (`--fork`); stale → the same error (`--fork or --take-over`) unless
 *   `takeOver`, which reclaims it. Nothing is read or written for a refused
 *   session: the lease is taken BEFORE the transcript is loaded.
 * - `fork` with `resumeId`: `forkSession` on the source, then open and lease
 *   the fork.
 *
 * On success the lease is refreshed every `heartbeatMs` by an unref'd timer and
 * released synchronously on `process.on("exit")`. Release it explicitly with
 * `releaseSessionLease` (or through `switchLeasedSession`).
 */
export function openLeasedSession(opts: OpenLeasedSessionOptions): OpenLeasedSessionResult {
  const { takeOver, fork, staleMs, heartbeatMs, now, isAlive, host, resumeId: rawResumeId, continueLast, ...base } =
    opts;
  const timing = resolveTiming({
    ...(staleMs !== undefined ? { staleMs } : {}),
    ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
    ...(now !== undefined ? { now } : {}),
    ...(isAlive !== undefined ? { isAlive } : {}),
    ...(host !== undefined ? { host } : {}),
  });
  const { cwd, dataDir } = base;
  const resumeId = rawResumeId !== undefined && rawResumeId.length > 0 ? rawResumeId : undefined;

  // The one `openSession` call. With `lease`, the lease was taken first (so a
  // refused session is never read) and, if the open throws, released again —
  // but only when THIS call minted it: a lease this process already held (a
  // `/resume` of the current session) stays with its session. Without
  // `lease`, the opened session is new and is leased right after.
  const openWith = (target: string | undefined, lease?: LeasedHandle): OpenLeasedSessionResult => {
    try {
      const opened = openSession({ ...base, ...(target !== undefined ? { resumeId: target } : {}) });
      return { ...opened, lease: lease?.handle ?? leaseSession(cwd, opened.handle.summary, dataDir, timing, false).handle };
    } catch (error) {
      if (lease?.minted === true) releaseSessionLease(lease.handle);
      throw error;
    }
  };

  if (fork === true) {
    if (resumeId === undefined) {
      throw new Error("--fork needs a session id (-r <id>).");
    }
    const forked = forkSession({
      cwd,
      sourceIdOrPrefix: resumeId,
      ...(dataDir !== undefined ? { dataDir } : {}),
    });
    const summary = forked.handle.summary;
    return openWith(summary.id, leaseSession(cwd, summary, dataDir, timing, false));
  }

  if (resumeId !== undefined) {
    const found = findSession(cwd, resumeId, dataDir);
    if (found === undefined) {
      // No lease to take: let the store raise its usual "no session matching" error.
      return openWith(resumeId);
    }
    return openWith(found.id, leaseSession(cwd, found, dataDir, timing, takeOver === true));
  }

  let skipped: SkippedSession | undefined;
  if (continueLast === true) {
    // Another instance may lease the chosen session between the look and the
    // acquire; look again rather than fail, a bounded number of times.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pick = latestUnleasedSession(cwd, dataDir, timing);
      skipped ??= pick.skipped;
      if (pick.summary === undefined) break;
      let lease: LeasedHandle;
      try {
        lease = leaseSession(cwd, pick.summary, dataDir, timing, false);
      } catch (error) {
        if (!(error instanceof SessionLeasedError)) throw error;
        skipped ??= { summary: error.summary, holder: error.holder, state: error.state };
        continue;
      }
      return { ...openWith(pick.summary.id, lease), ...(skipped !== undefined ? { skipped } : {}) };
    }
  }

  return { ...openWith(undefined), ...(skipped !== undefined ? { skipped } : {}) };
}

/**
 * In-process session switch (specification §6.2): acquire the target's lease
 * first (`openTarget`, normally a closure over `openLeasedSession`), and only
 * once that succeeded release `current`. When `openTarget` throws — a
 * `SessionLeasedError` or anything else — the error propagates and `current`
 * is left held and untouched. Switching to the session already held returns
 * the same handle and releases nothing.
 */
export function switchLeasedSession<R extends { lease: SessionLeaseHandle }>(
  current: SessionLeaseHandle | undefined,
  openTarget: () => R,
): R {
  const next = openTarget();
  if (current !== undefined && current !== next.lease) {
    releaseSessionLease(current);
  }
  return next;
}
