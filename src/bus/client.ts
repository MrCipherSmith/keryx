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

/** A previewed event kind: `ack`, `override` and `lease-expired` are never rendered (§5.2). */
export type RenderableBusEventKind = Exclude<BusEventKind, "ack" | "override" | "lease-expired">;

export interface RenderedBusEvent {
  id: string;
  seq: number;
  fromName: string;
  kind: RenderableBusEventKind;
  /** `displaySafe`d, at most 160 characters. */
  preview: string;
  replyTo?: string;
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
  sessionLease?: BusClientSessionLease | undefined;
  status: () => { status: Exclude<PresenceStatus, "held">; activity: string };
  onEvent: (event: RenderedBusEvent) => void;
  onPeers: (peers: BusPeer[]) => void;
  /** A poll or heartbeat failure; never thrown into the shell. */
  onError?: ((error: unknown) => void) | undefined;
  now?: (() => number) | undefined;
  timers?: BusTimers | undefined;
  isAlive?: ((pid: number) => boolean) | undefined;
  host?: string | undefined;
  /** Default 5000 (specification §5.1). */
  heartbeatMs?: number | undefined;
  /** Default `busPollMs(env)` (specification §5.1, §7.4). */
  pollMs?: number | undefined;
}

export interface BusClient {
  readonly instanceId: string;
  readonly root: string;
  /** True when the requested name was already held by a live peer (D-06), so the caller can say so. */
  readonly nameWasTaken: boolean;
  readonly name: string;
  peers(): BusPeer[];
  setSession(sessionId: string): Promise<void>;
  /** Unique among live peers (D-06), or refuses with a `BusRefusal`. */
  rename(newName: string): Promise<void>;
  send(toLabel: string, kind: SendableKind, body: string, replyTo?: string): Promise<SendResult>;
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
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const pollMs = opts.pollMs ?? busPollMs(opts.env);

  const instanceId = processInstanceId();
  const { root } = await resolveBusRoot(opts.cwd);
  const checkout = resolveProjectRoot(opts.cwd);

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

  const state = { name, sessionId: opts.sessionId, branch: await resolveCurrentBranch(checkout) };
  const startedAt = new Date(now()).toISOString();

  const writeCurrentPresence = async (): Promise<void> => {
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
  };

  await writeCurrentPresence();
  let cursor: BusCursor = await cursorAtEnd(root);

  // ---- heartbeat: rewrite presence, refresh the branch, patch the lease. ----
  let heartbeatInFlight = false;
  const heartbeatTick = (): void => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    void (async () => {
      try {
        state.branch = await resolveCurrentBranch(checkout);
        await writeCurrentPresence();
        opts.sessionLease?.refresh({ name: state.name });
      } catch (error) {
        opts.onError?.(error);
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
    cursor = read.cursor;
    const mine = read.events.filter((event) => addressedToMe(event, instanceId));
    for (const event of mine) {
      const kind = event.kind;
      if (!isRenderable(kind)) continue;
      const rendered: RenderedBusEvent = {
        id: event.id,
        seq: event.seq,
        fromName: event.from.name,
        kind,
        preview: preview(event.body),
        ...(event.refs?.replyTo !== undefined ? { replyTo: event.refs.replyTo } : {}),
      };
      opts.onEvent(rendered);
    }
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
      .catch((error: unknown) => opts.onError?.(error))
      .finally(() => {
        pollInFlight = false;
      });
  };
  const pollTimer = timers.setInterval(pollTick, pollMs);
  unref(pollTimer);

  // ---- leave: idempotent, synchronous-safe (specification §5.4). ----
  let left = false;
  const removePresenceSync = (): void => {
    try {
      unlinkSync(presencePath(root, instanceId));
    } catch {
      // Best effort: already gone, or the process cannot write here any more.
    }
  };
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
      state.sessionId = sessionId;
      await writeCurrentPresence();
    },
    async rename(newName) {
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
      opts.sessionLease?.refresh({ name: newName });
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
    pollNow() {
      return doPoll();
    },
    leave,
  };

  return client;
}
