// The surface-independent bus client (specification §5.1, §5.2, §5.4; flow 273
// task T5). `joinBus` owns everything a shell would otherwise have to
// reimplement: resolving the bus root, allocating a name, writing presence
// with every §4.1 field, positioning the read cursor at the end of the log,
// and starting the heartbeat and the poller. Both timers, the clock, the
// liveness probe and the host name are injectable, so tests never wait on a
// real interval and never depend on the real machine's hostname or pid table.
//
// `src/commands/shell.ts` (readline) and `src/tui/tui-shell.ts` (TUI) are the
// only callers. Neither reimplements the join/heartbeat/poll/leave sequence;
// they wire `status`, `onEvent` and `onPeers` to their own rendering and call
// `leave()` on their own shutdown paths.

import { execFile } from "node:child_process";
import { appendFileSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { processIsAlive } from "../lib/fs";
import { currentWriterVersion } from "../lib/install-plan";
import { processInstanceId } from "../session/lease";
import { resolveProjectRoot } from "../session/paths";
import { displaySafe } from "./display";
import { busEnabled, busPollMs, type BusEnabledInput } from "./enabled";
import { BusRefusal } from "./errors";
import { BUS_FILE_MODE } from "./files";
import { appendEvent, cursorAtEnd, readEvents, type BusCursor } from "./log";
import { createLeaseView, createPauseLease, resumePauseLease, type PauseLeaseView } from "./pause";
import { eventsPath, leasePath, presencePath, resolveBusRoot } from "./paths";
import {
  allocateName,
  classifyPresence,
  listPresence,
  writePresence,
  type PresenceClassifyOptions,
  type PresenceLiveness,
} from "./presence";
import {
  BUS_SCHEMA_VERSION,
  isAssignableBusName,
  MAX_ACTIVITY_CHARS,
  type BusEvent,
  type BusEventKind,
  type BusSender,
  type LeaseScope,
  type PauseLease,
  type PresenceRecord,
  type PresenceStatus,
  type PresenceSurface,
} from "./schema";
import { sendMessage, type SendableKind, type SendResult } from "./send";

const execFileAsync = promisify(execFile);

/** specification §5.1: the heartbeat runs every 5 s by default. */
export const DEFAULT_HEARTBEAT_MS = 5000;
/** Smallest heartbeat the `KERYX_BUS_HEARTBEAT_MS` test knob may set (review r1 F8). */
const MIN_ENV_HEARTBEAT_MS = 50;
/** `resolveRef`'s bounded lookback (review r1 F4). */
const MAX_RENDERED_STORE = 200;

/** A previewed event kind: `ack`, `override` and `lease-expired` are never rendered (§5.2). */
export type RenderableBusEventKind = Exclude<BusEventKind, "ack" | "override" | "lease-expired">;

export interface RenderedBusEvent {
  id: string;
  seq: number;
  /** First 8 characters of `id` (review r1 F4): what `/bus reply` and the TUI show instead of the full UUID. */
  shortId: string;
  fromName: string;
  /** The sender's instance id, so a reply reaches them even if they renamed since (review r1 F4). */
  fromInstanceId: string;
  kind: RenderableBusEventKind;
  /** `displaySafe`d, at most 160 characters. */
  preview: string;
  replyTo?: string;
  /**
   * The full, untruncated event body (redacted on write, same as `preview`'s
   * source, but never cut to 160 characters): flow 274, so a busInbox can
   * deliver the whole message into agent history rather than the display-only
   * preview. Optional so every pre-flow-274 caller that builds a
   * `RenderedBusEvent` fixture by hand (display/TUI tests) is unaffected;
   * `doPoll` below always sets it on the real delivery path, and
   * `../bus/inbox.ts`'s `BusInboxEvent` requires it of whatever is actually
   * pushed.
   */
  body?: string;
  /** True when addressed via `@all` (`to === ["*"]`); false/absent when addressed by name (flow 274). Optional for the same reason as `body`. */
  toStar?: boolean;
}

/** `BusClient.resolveRef`'s result: enough to address a reply without a fresh name lookup. */
export interface ResolvedBusRef {
  id: string;
  seq: number;
  fromInstanceId: string;
  fromName: string;
}

/** A live or stale peer, as shown in the fleet sidebar and `/bus` (never `gone`, never self). */
export interface BusPeer {
  record: PresenceRecord;
  state: "live" | "stale";
  ageMs: number;
}

/** The subset of `SessionLeaseHandle` the client needs, satisfied structurally. */
export interface BusClientSessionLease {
  refresh(patch?: { name?: string | null }): unknown;
}

/**
 * A getter, called at every use (join, each heartbeat, after `rename`, and
 * inside `setSession`) rather than a value captured once (review r1 F2): a
 * shell that swaps its lease handle (e.g. `/new`) hands the client a getter
 * that always reads the CURRENT lease, so a stale, already-released handle is
 * never refreshed and the new lease's name is never left null.
 */
export type BusSessionLeaseGetter = () => BusClientSessionLease | undefined;

/** Where a bus background failure was observed; see `./display.ts`'s `makeBusErrorReporter`. */
export type BusErrorWhere = "poll" | "heartbeat" | "session" | "ack";

/** Injectable timer source, so tests drive the heartbeat and the poller without a real wait. */
export interface BusTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const REAL_TIMERS: BusTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
};

function unref(handle: unknown): void {
  (handle as { unref?: () => void } | undefined)?.unref?.();
}

export interface JoinBusOptions {
  cwd: string;
  sessionId: string;
  surface: PresenceSurface;
  /** `--name`; takes priority over `shellConfig.bus.name`. */
  requestedName?: string | undefined;
  shellConfig?: object | null | undefined;
  env: Readonly<Record<string, string | undefined>>;
  sessionLease?: BusSessionLeaseGetter | undefined;
  status: () => { status: Exclude<PresenceStatus, "held">; activity: string };
  onEvent: (event: RenderedBusEvent) => void;
  onPeers: (peers: BusPeer[]) => void;
  /** A poll, heartbeat or session-patch failure; never thrown into the shell. */
  onError?: ((error: unknown, where: BusErrorWhere) => void) | undefined;
  now?: (() => number) | undefined;
  timers?: BusTimers | undefined;
  isAlive?: ((pid: number) => boolean) | undefined;
  host?: string | undefined;
  /** Default 5000 (specification §5.1), or `KERYX_BUS_HEARTBEAT_MS` in a test context (review r1 F8). */
  heartbeatMs?: number | undefined;
  /** Default `busPollMs(env)` (specification §5.1, §7.4). */
  pollMs?: number | undefined;
  /**
   * TEST SEAM: the current git branch of `cwd`, resolved once at join and
   * again on every heartbeat. Defaults to a real `git rev-parse`; injected by
   * tests that need to control exactly when that lookup resolves (review r1
   * F1's race between an in-flight heartbeat and a concurrent `leave()`).
   */
  resolveBranch?: ((cwd: string) => Promise<string | null>) | undefined;
}

export interface BusClient {
  readonly instanceId: string;
  readonly root: string;
  /** True when the requested name was already held by a live peer (D-06), so the caller can say so. */
  readonly nameWasTaken: boolean;
  readonly name: string;
  peers(): BusPeer[];
  /** No-ops after `leave()` (review r1 F1). */
  setSession(sessionId: string): Promise<void>;
  /** Unique among live peers (D-06), or refuses with a `BusRefusal`. No-ops after `leave()` (review r1 F1). */
  rename(newName: string): Promise<void>;
  send(toLabel: string, kind: SendableKind, body: string, replyTo?: string): Promise<SendResult>;
  /**
   * `ref` as `#12`, `12`, or a unique id/short-id prefix of at least 8
   * characters, resolved against the last 200 rendered events (review r1
   * F4). An unmatched or ambiguous prefix is `undefined`, never a throw.
   */
  resolveRef(ref: string): ResolvedBusRef | undefined;
  /**
   * Resolves `ref` and sends a `reply` to the ORIGINAL sender's instance id
   * (review r1 F4), so a sender who renamed since is still reached. Throws a
   * `BusRefusal("unknown-message")` when `ref` does not resolve.
   */
  reply(ref: string, body: string): Promise<SendResult>;
  /**
   * Like {@link send}, but writes `from.origin: "agent"` (specification §4.2,
   * D-12): the model's own `bus_send` tool call (`./agent-tools.ts`), never
   * the operator's own typed input. Shares every other refusal `send` has
   * (`unknown-recipient`, `recipient-not-live`, `recipient-is-self`,
   * `body-too-large`, …) plus its own, separately-counted 10/minute budget
   * (review r1 F3, F5).
   */
  sendAsAgent(toLabel: string, kind: SendableKind, body: string): Promise<SendResult>;
  /**
   * Like {@link reply} — same `resolveRef` lookup, same ORIGINAL-sender
   * addressing (review r1 F4) — but writes `from.origin: "agent"` (review r1
   * F3) and is counted against the agent budget, not the operator's.
   */
  replyAsAgent(ref: string, body: string): Promise<SendResult>;
  /** One poll cycle now, awaited; for tests. Returns every event addressed to this instance. */
  pollNow(): Promise<BusEvent[]>;
  /**
   * Mark the given delivered events acknowledged (flow 274, D-10): appends one
   * `ack` event per input, addressed to that event's sender, `refs.replyTo`
   * set to the delivered event's id. Fire-and-forget — never throws; a failed
   * append is reported via `onError("ack")`, same as a failed poll/heartbeat.
   * Call this AFTER the event has actually been placed in agent history, never
   * merely on read, so an ack is a durable "this reached the agent," not "this
   * was seen."
   */
  ack(events: readonly RenderedBusEvent[]): void;
  /**
   * Create a pause lease held by this instance (specification §4.3).
   * `origin` distinguishes the operator's own `/bus pause` (`"operator"`)
   * from the model's `bus_pause` tool call (`"agent"`); `keryx bus pause`
   * (origin `"cli"`) has no client and calls `createPauseLease` directly.
   * Shares `createPauseLease`'s refusals (`lease-already-held`,
   * `ttl-out-of-range`, `unknown-recipient`, `recipient-not-live`,
   * `recipient-is-self`). Refreshes {@link leaseView} before returning.
   */
  pause(toLabel: string, scope: LeaseScope, reason: string, ttlMs: number | undefined, origin: "operator" | "agent"): Promise<PauseLease>;
  /**
   * End a lease: allowed only when this instance is the lease's holder
   * (`resumePauseLease`'s `not-lease-holder` otherwise). `origin` mirrors
   * {@link pause}'s. Idempotent when the lease is already gone. Refreshes
   * {@link leaseView} before returning.
   */
  resume(leaseId: string, origin: "operator" | "agent"): Promise<void>;
  /** Release THIS instance from `leaseId` (`/bus override`); see {@link PauseLeaseView.override}. */
  override(leaseId: string): Promise<void>;
  /**
   * This instance's lease view (`./pause.ts`'s `createLeaseView`), refreshed
   * on every poll (and immediately after {@link pause}/{@link resume}/
   * {@link override}) — always the SAME object, so a caller may hold onto it
   * across polls rather than re-fetching.
   */
  leaseView(): PauseLeaseView;
  /**
   * Idempotent and synchronous-safe: stops both timers, removes presence, and
   * resumes every pause lease this instance holds (specification §5.4).
   *
   * The resume is itself synchronous-safe, because `leave()` runs from Node's
   * synchronous `"exit"` handler on an ordinary shutdown (SIGINT/SIGTERM
   * through the existing shutdown path, or a plain process exit), where no
   * async work scheduled here would ever complete: for each lease this
   * instance holds (as of the last `leaseView()` refresh), the lease FILE is
   * deleted synchronously first — that alone is enough for every peer, since
   * §4.3's "active" rule is file-existence based — and a best-effort `resume`
   * event is appended synchronously afterwards, bypassing the shared
   * `append.lock` (a small, accepted risk of a rare seq collision under a
   * concurrent writer, for an exit-time fallback that is otherwise silent).
   * A true crash (SIGKILL, or any signal Node cannot catch) runs none of
   * this; those leases are left for D-09's holder-gone liveness rule to
   * expire within one liveness window, exactly as documented there.
   */
  leave(): void;
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function shellConfigBusName(shellConfig: object | null | undefined): string | undefined {
  if (shellConfig === null || shellConfig === undefined) return undefined;
  const bus = (shellConfig as { bus?: unknown }).bus;
  if (typeof bus !== "object" || bus === null) return undefined;
  const name = (bus as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Best-effort current branch, or null (not a git checkout, `git` unavailable,
 * or any other failure). Mirrors `resolveTree` in
 * `src/session/slate-lifecycle.ts`: neither module is reusable from the
 * other, so this is its own small, narrowly-scoped shell-out.
 */
async function resolveCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

function toPeers(
  records: readonly PresenceRecord[],
  selfInstanceId: string,
  classify: (record: PresenceRecord) => PresenceLiveness,
  now: number,
): BusPeer[] {
  const peers: BusPeer[] = [];
  for (const record of records) {
    if (record.instanceId === selfInstanceId) continue;
    const state = classify(record);
    if (state === "gone") continue;
    peers.push({ record, state, ageMs: now - Date.parse(record.heartbeatAt) });
  }
  return peers.sort((a, b) => a.record.name.localeCompare(b.record.name) || a.record.instanceId.localeCompare(b.record.instanceId));
}

/** `to` names this instance, or is `["*"]` and this instance did not send it (specification §5.2). */
function addressedToMe(event: BusEvent, instanceId: string): boolean {
  if (event.to.includes(instanceId)) return true;
  return event.to.length === 1 && event.to[0] === "*" && event.from.instanceId !== instanceId;
}

const SYSTEM_KINDS = new Set<BusEventKind>(["ack", "override", "lease-expired"]);

function isRenderable(kind: BusEventKind): kind is RenderableBusEventKind {
  return !SYSTEM_KINDS.has(kind);
}

function preview(body: string | undefined): string {
  // `displaySafe` already collapses every control character (newlines
  // included) to a single space, so what remains IS the first line.
  return displaySafe(body ?? "").slice(0, 160);
}

/**
 * TEST-ONLY: `KERYX_BUS_HEARTBEAT_MS` lets the subprocess tests shorten the
 * 5 s default heartbeat so a SIGSTOP/SIGCONT liveness change can be observed
 * without a real wait (review r1 F8). Gated exactly like
 * `KERYX_BUS_PRESENCE_STALE_MS` (`./presence.ts`): not documented for users,
 * honoured only in a test context (`NODE_ENV === "test"`, set by `bun test`,
 * or `KERYX_TEST_BUS_TIMING === "1"`, set by the subprocess tests), and only
 * for a value >= 50 ms. An explicit `options.heartbeatMs` always wins.
 */
function heartbeatTimingEnvEnabled(): boolean {
  return process.env.NODE_ENV === "test" || process.env.KERYX_TEST_BUS_TIMING === "1";
}

function envHeartbeatMs(): number | undefined {
  if (!heartbeatTimingEnvEnabled()) return undefined;
  const raw = process.env.KERYX_BUS_HEARTBEAT_MS;
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= MIN_ENV_HEARTBEAT_MS ? value : undefined;
}

/** The first 8 characters of a bus id: what `/bus reply` and the TUI show instead of the full UUID. */
function shortIdOf(id: string): string {
  return id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// joinBus.
// ---------------------------------------------------------------------------

export async function joinBus(opts: JoinBusOptions): Promise<BusClient | { disabled: string }> {
  const enabledInput: BusEnabledInput = { env: opts.env, shellConfig: opts.shellConfig ?? null };
  const enablement = busEnabled(enabledInput);
  if (!enablement.enabled) return { disabled: enablement.reason };

  const now = opts.now ?? Date.now;
  const isAlive = opts.isAlive ?? processIsAlive;
  const host = opts.host ?? hostname();
  const timers = opts.timers ?? REAL_TIMERS;
  const heartbeatMs = opts.heartbeatMs ?? envHeartbeatMs() ?? DEFAULT_HEARTBEAT_MS;
  const pollMs = opts.pollMs ?? busPollMs(opts.env);
  const resolveBranch = opts.resolveBranch ?? resolveCurrentBranch;

  const instanceId = processInstanceId();
  const { root } = await resolveBusRoot(opts.cwd);
  const checkout = resolveProjectRoot(opts.cwd);

  // ---- leave-state, declared early so `writeCurrentPresence` (used from
  // join onward) can guard every write against a `leave()` landing mid-flight
  // (review r1 F1). ----
  let left = false;
  const removePresenceSync = (): void => {
    try {
      unlinkSync(presencePath(root, instanceId));
    } catch {
      // Best effort: already gone, or the process cannot write here any more.
    }
  };
  /**
   * Best-effort seq for the synchronous resume append below: the highest
   * `seq` claimed by any complete, parseable line currently in the CURRENT
   * segment, plus one. Mirrors `./log.ts`'s own crash recovery (it tail-scans
   * the segment rather than trusting `head.json` alone) rather than
   * `head.json` directly, so this fallback agrees with what the next real
   * `appendEvent` call would derive if `head.json` itself is stale. Never
   * throws: an unreadable or absent segment is worth exactly the same as "no
   * events yet" here — this whole path is a best-effort fallback, and the
   * lease FILE deletion below is what actually makes the lease inactive for
   * every peer.
   */
  const bestEffortSyncSeq = (): number => {
    try {
      const content = readFileSync(eventsPath(root), "utf8");
      let last = 0;
      for (const line of content.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const value = JSON.parse(line) as { seq?: unknown };
          if (typeof value.seq === "number" && value.seq > last) last = value.seq;
        } catch {
          // torn or foreign line: ignore, exactly like `./log.ts`'s reader.
        }
      }
      return last + 1;
    } catch {
      return 1;
    }
  };

  /**
   * Synchronous, best-effort resume of every lease this instance holds (see
   * {@link BusClient.leave}'s doc comment for why this must be synchronous
   * and why it bypasses `append.lock`). Never throws. Declared before
   * `leave()`, and before `leaseViewInstance` even exists, because the exit
   * hook now registers before the join's first write (#618): a crash in that
   * window calls `leave()` before `leaseViewInstance` is initialized, and
   * `leaseViewInstance.myLeases()` hitting that not-yet-initialized binding
   * is caught right here and treated as "nothing to resume yet" — exactly
   * right, since no lease could have been created by this instance before
   * join even started.
   */
  const syncResumeOwnLeases = (): void => {
    let mine: readonly PauseLease[];
    try {
      mine = leaseViewInstance.myLeases();
    } catch {
      return;
    }
    for (const lease of mine) {
      try {
        unlinkSync(leasePath(root, lease.leaseId));
      } catch {
        // best effort: already gone, or this process cannot write here any more.
      }
      try {
        // Addressed like the lease's own `targets` (§4.2's `resume` row:
        // "wakes: yes" — whoever was held is exactly who should wake up now),
        // mirroring the async `resumePauseLease`. `toLabel` is always "@all"
        // here rather than resolving a concrete target's current name: doing
        // that synchronously would mean a second sync directory read in an
        // exit-time fallback that is already documented as best-effort, for
        // a field `to` (not `toLabel`) is what actually routes the event.
        const event = {
          schemaVersion: BUS_SCHEMA_VERSION,
          seq: bestEffortSyncSeq(),
          id: randomUUID(),
          ts: new Date(now()).toISOString(),
          from: { instanceId: lease.holder.instanceId, name: lease.holder.name, origin: lease.holder.origin },
          to: lease.targets,
          toLabel: "@all",
          kind: "resume" as const,
          refs: { leaseId: lease.leaseId },
        };
        appendFileSync(eventsPath(root), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: BUS_FILE_MODE });
      } catch {
        // Best effort only: the lease FILE above is already gone, which is
        // enough for every peer (§4.3's "active" rule is file-existence
        // based) — this `resume` event is purely informational.
      }
    }
  };

  // Set once the join completes; `leave()` may run before then (see below).
  const liveTimers: { heartbeat?: unknown; poll?: unknown } = {};

  // ---- leave: idempotent, synchronous-safe (specification §5.4). ----
  const leave = (): void => {
    if (left) return;
    left = true;
    if (liveTimers.heartbeat !== undefined) timers.clearInterval(liveTimers.heartbeat);
    if (liveTimers.poll !== undefined) timers.clearInterval(liveTimers.poll);
    process.off("exit", onExit);
    syncResumeOwnLeases();
    removePresenceSync();
  };
  function onExit(): void {
    leave();
  }

  const classify = (record: PresenceRecord): PresenceLiveness => {
    const options: PresenceClassifyOptions = { now: now(), isAlive, host };
    return classifyPresence(record, options);
  };

  const requested = opts.requestedName ?? shellConfigBusName(opts.shellConfig);
  const presenceBeforeJoin = await listPresence(root);
  const liveNames = new Set(
    presenceBeforeJoin.filter((record) => record.instanceId !== instanceId && classify(record) === "live").map((record) => record.name),
  );
  const name = allocateName(requested, liveNames); // throws a typed BusRefusal for an invalid/reserved request
  const nameWasTaken = requested !== undefined && liveNames.has(requested);

  let peers = toPeers(presenceBeforeJoin, instanceId, classify, now());
  opts.onPeers(peers);

  const state = { name, sessionId: opts.sessionId, branch: await resolveBranch(checkout) };
  const startedAt = new Date(now()).toISOString();

  const writeCurrentPresence = async (): Promise<void> => {
    // review r1 F1: never recreate presence after leave() — before the write...
    if (left) return;
    const { status, activity } = opts.status();
    const record: PresenceRecord = {
      schemaVersion: 1,
      instanceId,
      name: state.name,
      pid: process.pid,
      host,
      sessionId: state.sessionId,
      checkout,
      branch: state.branch,
      surface: opts.surface,
      status,
      activity: displaySafe(activity).slice(0, MAX_ACTIVITY_CHARS),
      startedAt,
      heartbeatAt: new Date(now()).toISOString(),
      keryxVersion: currentWriterVersion(),
    };
    await writePresence(root, record);
    // ...and after: a leave() that landed WHILE the write above was in
    // flight would otherwise leave a freshly-recreated file behind it.
    if (left) removePresenceSync();
  };

  // The exit hook goes in BEFORE the first presence write, not once the join
  // returns: the caller cannot reach `leave()` until then, so a SIGINT/SIGTERM
  // handler that ends the process with `process.exit` while the rest of the
  // join is still awaited would otherwise leave the presence file behind.
  process.on("exit", onExit);
  let cursor: BusCursor;
  // `./pause.ts`'s cached reader for this instance: refreshed on every poll
  // (below) and right after pause/resume/override, so `leaseView()` always
  // reflects the last-known state without a caller ever awaiting a refresh.
  const leaseViewInstance = createLeaseView({ root, instanceId, now, liveness: { isAlive, host } });
  try {
    await writeCurrentPresence();
    // specification §5.1: the session lease learns this instance's bus name
    // right at join, not only from the first heartbeat.
    opts.sessionLease?.()?.refresh({ name: state.name });
    cursor = await cursorAtEnd(root);
    await leaseViewInstance.refresh();
  } catch (error) {
    // review r1 F7: anything after the presence write that throws (a lease
    // refresh, `cursorAtEnd`) orphans that presence record unless it is
    // unlinked here before the failure propagates; `leave()` also drops the
    // exit hook.
    leave();
    throw error;
  }

  // `resolveRef`'s bounded lookback (review r1 F4): the last MAX_RENDERED_STORE
  // rendered events, oldest first.
  const renderedStore: RenderedBusEvent[] = [];
  const rememberRendered = (event: RenderedBusEvent): void => {
    renderedStore.push(event);
    if (renderedStore.length > MAX_RENDERED_STORE) renderedStore.shift();
  };

  function resolveRefImpl(ref: string): ResolvedBusRef | undefined {
    const trimmed = ref.trim();
    const bare = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
    const looksLikeSeq = /^\d+$/.test(bare) && (trimmed.startsWith("#") || bare.length < 8);
    if (looksLikeSeq) {
      const seq = Number(bare);
      const found = renderedStore.find((event) => event.seq === seq);
      return found === undefined ? undefined : { id: found.id, seq: found.seq, fromInstanceId: found.fromInstanceId, fromName: found.fromName };
    }
    if (trimmed.length < 8) return undefined;
    const lower = trimmed.toLowerCase();
    const matches = renderedStore.filter((event) => event.id.toLowerCase().startsWith(lower));
    if (matches.length !== 1) return undefined; // none, or ambiguous
    const only = matches[0] as RenderedBusEvent;
    return { id: only.id, seq: only.seq, fromInstanceId: only.fromInstanceId, fromName: only.fromName };
  }

  // ---- heartbeat: rewrite presence, refresh the branch, patch the lease. ----
  let heartbeatInFlight = false;
  const heartbeatTick = (): void => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    void (async () => {
      try {
        state.branch = await resolveBranch(checkout);
        await writeCurrentPresence();
        opts.sessionLease?.()?.refresh({ name: state.name });
      } catch (error) {
        opts.onError?.(error, "heartbeat");
      } finally {
        heartbeatInFlight = false;
      }
    })();
  };
  liveTimers.heartbeat = timers.setInterval(heartbeatTick, heartbeatMs);
  unref(liveTimers.heartbeat);

  // ---- poll: read new events, render the addressed ones, refresh peers. ----
  const doPoll = async (): Promise<BusEvent[]> => {
    const read = await readEvents(root, cursor);
    const mine = read.events.filter((event) => addressedToMe(event, instanceId));
    for (const event of mine) {
      const kind = event.kind;
      if (!isRenderable(kind)) continue;
      const rendered: RenderedBusEvent = {
        id: event.id,
        seq: event.seq,
        shortId: shortIdOf(event.id),
        fromName: event.from.name,
        fromInstanceId: event.from.instanceId,
        kind,
        preview: preview(event.body),
        body: event.body ?? "",
        toStar: event.to.length === 1 && event.to[0] === "*",
        ...(event.refs?.replyTo !== undefined ? { replyTo: event.refs.replyTo } : {}),
      };
      rememberRendered(rendered);
      // review r1 F10: a throwing `onEvent` must not drop the rest of the
      // batch — caught and reported per event, then the loop continues.
      try {
        opts.onEvent(rendered);
      } catch (error) {
        opts.onError?.(error, "poll");
      }
    }
    // review r1 F10: advanced only once every event in this batch has been
    // OFFERED to `onEvent` (each independently caught above), never before.
    // A throw from one render can no longer cost the rest of the batch; if
    // the PROCESS itself dies mid-loop instead, the cursor has not moved yet
    // and the next poll re-delivers the whole batch rather than silently
    // skipping whatever this run never got to.
    cursor = read.cursor;
    const presence = await listPresence(root);
    peers = toPeers(presence, instanceId, classify, now());
    opts.onPeers(peers);
    await leaseViewInstance.refresh();
    return mine;
  };

  let pollInFlight = false;
  const pollTick = (): void => {
    if (pollInFlight) return;
    pollInFlight = true;
    void doPoll()
      .catch((error: unknown) => opts.onError?.(error, "poll"))
      .finally(() => {
        pollInFlight = false;
      });
  };
  liveTimers.poll = timers.setInterval(pollTick, pollMs);
  unref(liveTimers.poll);

  const client: BusClient = {
    instanceId,
    root,
    nameWasTaken,
    get name() {
      return state.name;
    },
    peers() {
      return peers;
    },
    async setSession(sessionId) {
      if (left) return; // review r1 F1: no-op after leave()
      state.sessionId = sessionId;
      try {
        await writeCurrentPresence();
        opts.sessionLease?.()?.refresh({ name: state.name });
      } catch (error) {
        // review r1 F10: setSession always resolves; a failure is reported,
        // never thrown into the caller as an unhandled rejection.
        opts.onError?.(error, "session");
      }
    },
    async rename(newName) {
      if (left) return; // review r1 F1: no-op after leave()
      if (!isAssignableBusName(newName)) {
        throw new BusRefusal("invalid-name", `"${newName}" must match ^[a-z0-9][a-z0-9-]{0,31}$`);
      }
      const presence = await listPresence(root);
      const taken = presence.some(
        (record) => record.instanceId !== instanceId && record.name === newName && classify(record) === "live",
      );
      if (taken) {
        throw new BusRefusal("name-taken", `"${newName}" is already held by a live peer`);
      }
      state.name = newName;
      await writeCurrentPresence();
      opts.sessionLease?.()?.refresh({ name: newName });
    },
    async send(toLabel, kind, body, replyTo) {
      const from: BusSender = { instanceId, name: state.name, origin: "operator" };
      return sendMessage(root, {
        toLabel,
        kind,
        body,
        ...(replyTo !== undefined ? { replyTo } : {}),
        origin: "operator",
        from,
        now,
        liveness: { isAlive, host },
        env: opts.env,
      });
    },
    resolveRef(ref) {
      return resolveRefImpl(ref);
    },
    async reply(ref, body) {
      const resolved = resolveRefImpl(ref);
      if (resolved === undefined) {
        throw new BusRefusal("unknown-message", `no rendered message matches ${JSON.stringify(ref)}`);
      }
      const from: BusSender = { instanceId, name: state.name, origin: "operator" };
      return sendMessage(root, {
        toLabel: `@${resolved.fromName}`,
        kind: "reply",
        body,
        replyTo: resolved.id,
        toInstanceId: resolved.fromInstanceId,
        origin: "operator",
        from,
        now,
        liveness: { isAlive, host },
        env: opts.env,
      });
    },
    async sendAsAgent(toLabel, kind, body) {
      const from: BusSender = { instanceId, name: state.name, origin: "agent" };
      return sendMessage(root, {
        toLabel,
        kind,
        body,
        origin: "agent",
        from,
        now,
        liveness: { isAlive, host },
        env: opts.env,
      });
    },
    async replyAsAgent(ref, body) {
      const resolved = resolveRefImpl(ref);
      if (resolved === undefined) {
        throw new BusRefusal("unknown-message", `no rendered message matches ${JSON.stringify(ref)}`);
      }
      const from: BusSender = { instanceId, name: state.name, origin: "agent" };
      return sendMessage(root, {
        toLabel: `@${resolved.fromName}`,
        kind: "reply",
        body,
        replyTo: resolved.id,
        toInstanceId: resolved.fromInstanceId,
        origin: "agent",
        from,
        now,
        liveness: { isAlive, host },
        env: opts.env,
      });
    },
    pollNow() {
      return doPoll();
    },
    ack(events) {
      if (left) return; // review r1 F1 pattern: no-op after leave()
      for (const event of events) {
        void (async () => {
          try {
            const from: BusSender = { instanceId, name: state.name, origin: "system" };
            await appendEvent(
              root,
              {
                from,
                to: [event.fromInstanceId],
                toLabel: `@${event.fromName}`,
                kind: "ack",
                refs: { replyTo: event.id },
              },
              { now },
            );
          } catch (error) {
            opts.onError?.(error, "ack");
          }
        })();
      }
    },
    async pause(toLabel, scope, reason, ttlMs, origin) {
      const holder = { instanceId, name: state.name, origin };
      const lease = await createPauseLease(root, {
        holder,
        toLabel,
        scope,
        reason,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        now,
        liveness: { isAlive, host },
      });
      await leaseViewInstance.refresh();
      return lease;
    },
    async resume(leaseId, origin) {
      await resumePauseLease(root, { leaseId, by: { instanceId, name: state.name, origin }, now });
      await leaseViewInstance.refresh();
    },
    async override(leaseId) {
      await leaseViewInstance.override(leaseId);
    },
    leaseView() {
      return leaseViewInstance;
    },
    leave,
  };

  return client;
}
