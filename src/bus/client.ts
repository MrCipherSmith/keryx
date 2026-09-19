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
import { unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { processIsAlive } from "../lib/fs";
import { currentWriterVersion } from "../lib/install-plan";
import { processInstanceId } from "../session/lease";
import { resolveProjectRoot } from "../session/paths";
import { displaySafe } from "./display";
import { busEnabled, busPollMs, type BusEnabledInput } from "./enabled";
import { BusRefusal } from "./errors";
import { cursorAtEnd, readEvents, type BusCursor } from "./log";
import { presencePath, resolveBusRoot } from "./paths";
import {
  allocateName,
  classifyPresence,
  listPresence,
  writePresence,
  type PresenceClassifyOptions,
  type PresenceLiveness,
} from "./presence";
import {
  isAssignableBusName,
  MAX_ACTIVITY_CHARS,
  type BusEvent,
  type BusEventKind,
  type BusSender,
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
export type BusErrorWhere = "poll" | "heartbeat" | "session";

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
  /** One poll cycle now, awaited; for tests. Returns every event addressed to this instance. */
  pollNow(): Promise<BusEvent[]>;
  /** Idempotent and synchronous-safe: stops both timers and removes presence. */
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

  await writeCurrentPresence();
  let cursor: BusCursor;
  try {
    // specification §5.1: the session lease learns this instance's bus name
    // right at join, not only from the first heartbeat.
    opts.sessionLease?.()?.refresh({ name: state.name });
    cursor = await cursorAtEnd(root);
  } catch (error) {
    // review r1 F7: anything after the presence write that throws (a lease
    // refresh, `cursorAtEnd`) orphans that presence record unless it is
    // unlinked here before the failure propagates.
    removePresenceSync();
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
  const heartbeatTimer = timers.setInterval(heartbeatTick, heartbeatMs);
  unref(heartbeatTimer);

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
  const pollTimer = timers.setInterval(pollTick, pollMs);
  unref(pollTimer);

  // ---- leave: idempotent, synchronous-safe (specification §5.4). ----
  const leave = (): void => {
    if (left) return;
    left = true;
    timers.clearInterval(heartbeatTimer);
    timers.clearInterval(pollTimer);
    process.off("exit", onExit);
    removePresenceSync();
  };
  function onExit(): void {
    leave();
  }
  process.on("exit", onExit);

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
    pollNow() {
      return doPoll();
    },
    leave,
  };

  return client;
}
