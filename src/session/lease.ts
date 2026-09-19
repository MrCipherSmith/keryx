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
  reclaimStaleLeaseSync,
} from "../lib/fs";
import { resolveProjectRoot, sessionDir } from "./paths";
import {
  findSession,
  forkSession,
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
  /** Refresh now, merging `patch`. False once released or lost. */
  refresh(patch?: Partial<Pick<SessionLeaseOwner, "name">>): boolean;
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

/**
 * Positive integer from an environment variable, else `fallback`.
 *
 * TEST-ONLY knobs: `KERYX_SESSION_LEASE_STALE_MS` and
 * `KERYX_SESSION_LEASE_HEARTBEAT_MS` let the subprocess tests shorten D-09's
 * 15 s / 5 s so a stale holder can be produced without waiting. They are not
 * documented for users; an explicit option always wins over them.
 */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return value > 0 ? value : fallback;
}

function resolveTiming(timing: SessionLeaseTiming = {}): Required<Pick<SessionLeaseTiming, "staleMs" | "heartbeatMs">> &
  SessionLeaseTiming {
  return {
    ...timing,
    staleMs: timing.staleMs ?? envMs("KERYX_SESSION_LEASE_STALE_MS", SESSION_LEASE_STALE_MS),
    heartbeatMs: timing.heartbeatMs ?? envMs("KERYX_SESSION_LEASE_HEARTBEAT_MS", SESSION_LEASE_HEARTBEAT_MS),
  };
}

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
  let timer: ReturnType<typeof setInterval> | undefined;
  const onExit = (): void => {
    handle.release();
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
    refresh(patch) {
      if (released) return false;
      return inner.refresh(patch);
    },
    release() {
      if (released) return;
      released = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      process.off("exit", onExit);
      if (heldByThisProcess.get(lockPath) === handle) heldByThisProcess.delete(lockPath);
      inner.release();
    },
  };

  timer = setInterval(() => {
    // A lost lease (someone took it over) stops refreshing; it never rewrites
    // another holder's record because `inner.refresh` checks the token first.
    if (!handle.refresh()) {
      if (timer !== undefined) clearInterval(timer);
    }
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
): SessionLeaseHandle {
  const lockPath = sessionLeasePath(cwd, summary.id, dataDir);
  const existing = heldByThisProcess.get(lockPath);
  if (existing !== undefined && !existing.released) return existing;

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
  return wrapHandle(summary.id, lockPath, result.handle, timing.heartbeatMs);
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
  // refused session is never read) and is released again if the open throws;
  // without, the opened session is new and is leased right after.
  const openWith = (target: string | undefined, lease?: SessionLeaseHandle): OpenLeasedSessionResult => {
    try {
      const opened = openSession({ ...base, ...(target !== undefined ? { resumeId: target } : {}) });
      return { ...opened, lease: lease ?? leaseSession(cwd, opened.handle.summary, dataDir, timing, false) };
    } catch (error) {
      releaseSessionLease(lease);
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
      let lease: SessionLeaseHandle;
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
