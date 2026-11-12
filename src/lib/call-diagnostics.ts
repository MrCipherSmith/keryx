/**
 * Always-on, in-memory diagnostics for tool calls that never come back (flow 487).
 *
 * The failure this exists for: a parent `spawn_subagent` call that stays `running` for hours
 * after every child finished, with both bounded layers (the spawn backstop and the call
 * watchdog) silent. The existing traces (`KERYX_PHASE_TRACE`, `keryx shell --debug`) are opt-in,
 * so the one time it happened nothing had been recorded.
 *
 * So this keeps a small amount of state in memory at all times (a registry of in-flight calls
 * with the stage each is in, a ring buffer of the last phase labels, counters, and named
 * probes onto other subsystems such as the approval dock) and touches the disk ONLY when
 * something looks stuck or the operator asks (`/diag`). A healthy session writes nothing.
 *
 * Everything here is best-effort: no function may throw into the turn it observes, and probe
 * output must be free of secrets and file contents (names, counts, ages and flags only).
 */
import { statSync } from "node:fs";
import path from "node:path";
import { appendOwnerOnlyLine, ensureKeryxSubdir } from "./config-dir";

export type DiagOutcome = "ok" | "error" | "watchdog" | "aborted";

export interface DiagCall {
  readonly id: string;
  readonly name: string;
  readonly startedAt: number;
  stage: string;
  stageSince: number;
  stageChanges: number;
}

export interface StageStat {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface DiagMetrics {
  callsStarted: number;
  callsSettled: number;
  callsByOutcome: Record<string, number>;
  /** Time spent per stage, over every call that left that stage. */
  stages: Record<string, StageStat>;
  /** Counters for `event()` kinds, e.g. `watchdog.fired`, `backstop.fired`, `approval.rearm`. */
  events: Record<string, number>;
  dumps: number;
  /** Largest event-loop delay seen by the stall watcher: how long the process itself was blocked. */
  maxLoopLagMs: number;
}

export type DiagProbe = () => unknown;

export interface DiagSnapshot {
  readonly ts: string;
  readonly reason: string;
  readonly pid: number;
  readonly sessionId: string | undefined;
  readonly uptimeMs: number;
  readonly calls: ReadonlyArray<{ id: string; name: string; ageMs: number; stage: string; stageAgeMs: number; stageChanges: number }>;
  readonly metrics: DiagMetrics;
  readonly probes: Record<string, unknown>;
  readonly loop: { lastLagMs: number; maxLagMs: number };
  readonly process: { rssBytes: number | undefined; activeResources: Record<string, number> | undefined };
  readonly recent: readonly string[];
}

export interface CallDiagnosticsOptions {
  now?: () => number;
  /** Phase labels kept for a dump. */
  ringSize?: number;
  /** Where a dump goes. Absent: nothing is written (the snapshot is still returned). */
  sink?: (line: string) => void;
}

export interface WatcherOptions {
  sessionId: string;
  /** Config dir override (tests); defaults to the resolved keryx config dir. */
  configDir?: string;
  intervalMs?: number;
  /** A call that stays in one stage this long is suspected of being stuck. */
  stallMs?: number;
  /** While something stays suspect, dump again after this long. */
  repeatMs?: number;
  /** Dump file size cap; past it dumps are dropped (a stuck loop must not fill the disk). */
  maxFileBytes?: number;
}

export const DEFAULT_WATCH_INTERVAL_MS = 30_000;
/** Above the 8 min spawn backstop, below the 12 min call watchdog. */
export const DEFAULT_STALL_MS = 10 * 60_000;
export const DEFAULT_REPEAT_MS = 15 * 60_000;
export const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const SNAPSHOT_RECENT = 120;

export interface CallDiagnostics {
  begin(id: string, name: string): void;
  stage(id: string, stage: string): void;
  end(id: string, outcome: DiagOutcome): void;
  /** A countable moment (also lands in the ring buffer). */
  event(kind: string, detail?: string): void;
  /** One phase label for the ring buffer (what `tracePhase` feeds). */
  record(label: string): void;
  /** Register a named read-only view of another subsystem. Returns an unregister function. */
  probe(name: string, fn: DiagProbe): () => void;
  snapshot(reason: string): DiagSnapshot;
  /** Write a snapshot to the sink. Returns it, or undefined when the sink refused. */
  dump(reason: string): DiagSnapshot | undefined;
  /** Start the periodic stall check; the returned function stops it. */
  start(opts: WatcherOptions): () => void;
  /** Where dumps for the running watcher go, if started. */
  dumpPath(): string | undefined;
  /** One watcher tick, exposed so tests need no real timers. */
  tick(): void;
  inFlight(): readonly DiagCall[];
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function emptyMetrics(): DiagMetrics {
  return { callsStarted: 0, callsSettled: 0, callsByOutcome: {}, stages: {}, events: {}, dumps: 0, maxLoopLagMs: 0 };
}

export function createCallDiagnostics(options: CallDiagnosticsOptions = {}): CallDiagnostics {
  const now = options.now ?? ((): number => Date.now());
  const ringSize = options.ringSize ?? 300;
  let sink = options.sink;
  const bornAt = now();
  const calls = new Map<string, DiagCall>();
  const probes = new Map<string, DiagProbe>();
  let ring: string[] = [];
  const metrics = emptyMetrics();
  let sessionId: string | undefined;
  let file: string | undefined;
  let lastLagMs = 0;
  let lastTickAt: number | undefined;
  let intervalMs = DEFAULT_WATCH_INTERVAL_MS;
  let stallMs = DEFAULT_STALL_MS;
  let repeatMs = DEFAULT_REPEAT_MS;
  let lastDumpAt: number | undefined;
  let lastDumpIds = new Set<string>();

  const record = (label: string): void => {
    ring.push(`${new Date(now()).toISOString()} ${label}`);
    if (ring.length > ringSize) ring = ring.slice(ring.length - ringSize);
  };

  const leaveStage = (call: DiagCall, at: number): void => {
    const ms = Math.max(0, at - call.stageSince);
    const stat = (metrics.stages[call.stage] ??= { count: 0, totalMs: 0, maxMs: 0 });
    stat.count += 1;
    stat.totalMs += ms;
    if (ms > stat.maxMs) stat.maxMs = ms;
  };

  const snapshot = (reason: string): DiagSnapshot => {
    const at = now();
    const probed: Record<string, unknown> = {};
    for (const [name, fn] of probes) {
      try {
        probed[name] = fn();
      } catch (e) {
        probed[name] = { probeError: errText(e) };
      }
    }
    let rssBytes: number | undefined;
    try {
      rssBytes = process.memoryUsage().rss;
    } catch {
      rssBytes = undefined;
    }
    let activeResources: Record<string, number> | undefined;
    try {
      const list = (process as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.();
      if (list !== undefined) {
        activeResources = {};
        for (const kind of list) activeResources[kind] = (activeResources[kind] ?? 0) + 1;
      }
    } catch {
      activeResources = undefined;
    }
    return {
      ts: new Date(at).toISOString(),
      reason,
      pid: process.pid,
      sessionId,
      uptimeMs: at - bornAt,
      calls: [...calls.values()].map((c) => ({
        id: c.id,
        name: c.name,
        ageMs: at - c.startedAt,
        stage: c.stage,
        stageAgeMs: at - c.stageSince,
        stageChanges: c.stageChanges,
      })),
      metrics: structuredClone(metrics),
      probes: probed,
      loop: { lastLagMs: lastLagMs, maxLagMs: metrics.maxLoopLagMs },
      process: { rssBytes, activeResources },
      recent: ring.slice(-SNAPSHOT_RECENT),
    };
  };

  const dump = (reason: string): DiagSnapshot | undefined => {
    let snap: DiagSnapshot;
    try {
      snap = snapshot(reason);
    } catch {
      return undefined;
    }
    if (sink === undefined) return snap;
    try {
      metrics.dumps += 1;
      sink(JSON.stringify({ ...snap, metrics: { ...snap.metrics, dumps: metrics.dumps } }));
    } catch {
      return undefined;
    }
    return snap;
  };

  const tick = (): void => {
    const at = now();
    if (lastTickAt !== undefined) {
      // A timer that fires much later than asked means the process itself was blocked or starved.
      const lag = Math.max(0, at - lastTickAt - intervalMs);
      lastLagMs = lag;
      if (lag > metrics.maxLoopLagMs) metrics.maxLoopLagMs = lag;
    }
    lastTickAt = at;
    const suspects = [...calls.values()].filter((c) => at - c.stageSince >= stallMs);
    if (suspects.length === 0) {
      lastDumpIds = new Set();
      return;
    }
    const ids = new Set(suspects.map((c) => c.id));
    const fresh = [...ids].some((id) => !lastDumpIds.has(id));
    const due = lastDumpAt === undefined || at - lastDumpAt >= repeatMs;
    if (!fresh && !due) return;
    lastDumpAt = at;
    lastDumpIds = ids;
    record(`diag stall suspected: ${suspects.map((c) => `${c.name}#${c.id}@${c.stage}`).join(", ")}`);
    dump("stall");
  };

  return {
    begin(id, name) {
      const at = now();
      calls.set(id, { id, name, startedAt: at, stage: "start", stageSince: at, stageChanges: 0 });
      metrics.callsStarted += 1;
    },
    stage(id, next) {
      const call = calls.get(id);
      if (call === undefined) return;
      const at = now();
      leaveStage(call, at);
      call.stage = next;
      call.stageSince = at;
      call.stageChanges += 1;
    },
    end(id, outcome) {
      const call = calls.get(id);
      if (call === undefined) return;
      leaveStage(call, now());
      calls.delete(id);
      metrics.callsSettled += 1;
      metrics.callsByOutcome[outcome] = (metrics.callsByOutcome[outcome] ?? 0) + 1;
    },
    event(kind, detail) {
      metrics.events[kind] = (metrics.events[kind] ?? 0) + 1;
      record(detail === undefined ? `event ${kind}` : `event ${kind} ${detail}`);
    },
    record,
    probe(name, fn) {
      probes.set(name, fn);
      return () => {
        if (probes.get(name) === fn) probes.delete(name);
      };
    },
    snapshot,
    dump,
    inFlight: () => [...calls.values()],
    dumpPath: () => file,
    tick,
    start(opts) {
      sessionId = opts.sessionId;
      intervalMs = opts.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
      stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
      repeatMs = opts.repeatMs ?? DEFAULT_REPEAT_MS;
      const cap = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
      if (sink === undefined) {
        // Resolved lazily: a healthy session never creates the directory or the file.
        sink = (line: string): void => {
          if (file === undefined) {
            const dir = ensureKeryxSubdir(["diagnostics"], opts.configDir);
            file = path.join(dir, `${opts.sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.ndjson`);
          }
          try {
            if (statSync(file).size >= cap) return;
          } catch {
            // not created yet
          }
          appendOwnerOnlyLine(file, line);
        };
      }
      lastTickAt = now();
      const timer = setInterval(() => {
        try {
          tick();
        } catch {
          // the watcher must never disturb the session it watches
        }
      }, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

/** The process-wide instance every call site feeds. */
export const callDiagnostics: CallDiagnostics = createCallDiagnostics();
