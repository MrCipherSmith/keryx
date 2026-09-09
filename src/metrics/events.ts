import type { ExecutionEvent, MetricValue, RetryRecord } from "./types";
export type { ExecutionEvent } from "./types";

export type EventAggregation = {
  metrics: Record<string, MetricValue>;
  retries: RetryRecord[];
};

// Defect (flow 238 / phase 6 / T5, #3): the aggregate used to count every
// element of the input array as-is. A replayed event (retried delivery, an
// at-least-once bus, a log re-ingested after a crash) carries the same
// `event_id` twice, and every count derived from `events.length`/`.filter`
// doubled right along with it. Dedupe by `event_id` up front — first
// occurrence wins — so the aggregate is a function of the SET of distinct
// events the run actually produced, not of how many times a transport
// happened to deliver them. Reproducibility (same synthetic events in, same
// aggregate out, replay-invariant) depends on this running before anything
// else touches `events`.
function dedupeByEventId(events: ExecutionEvent[]): ExecutionEvent[] {
  const seen = new Map<string, ExecutionEvent>();
  for (const event of events) {
    if (!seen.has(event.event_id)) seen.set(event.event_id, event);
  }
  return [...seen.values()];
}

export function aggregateExecutionEvents(
  rawEvents: ExecutionEvent[],
  bounds: { startedAt: string; finishedAt: string },
): EventAggregation {
  const events = dedupeByEventId(rawEvents);
  // Defect (flow 238 / phase 6 / T5, #4): this used to be
  // `events.length > 0 ? "exact" : "unknown"` — ANY non-empty array was
  // declared exact, even a single stray event with no evidence the capture
  // spans the run. Length is not provenance. What actually establishes
  // exactness here: the event stream is bounded by genuine lifecycle
  // bookends (`run_started` AND `run_finished`), which is the one signal in
  // this data that the capture ran start-to-finish rather than arriving as
  // a partial/orphaned fragment. Per-event `reliability` was considered and
  // rejected as the signal: no producer in this codebase ever sets it, so
  // gating on it would silently collapse every populated stream to
  // `unknown` — trading one false-precision proxy for a permanently-wrong
  // one, not an honest measurement.
  const hasRunStart = events.some((event) => event.type === "run_started");
  const hasRunFinish = events.some((event) => event.type === "run_finished");
  const sourceReliability = hasRunStart && hasRunFinish ? "exact" : "unknown";
  const metric = (
    value: number | null,
    source: string,
    reliability: "exact" | "unknown" = sourceReliability,
  ): MetricValue => ({
    value,
    reliability,
    source,
    ...(reliability === "unknown" ? { notes: "structured runtime events unavailable" } : {}),
  });
  const finishedCommands = events.filter((event) => event.type === "command_finished");
  const commandEvents = finishedCommands.length > 0
    ? finishedCommands
    : events.filter((event) => event.type === "command_started");
  const unique = (type: ExecutionEvent["type"], field: string): number =>
    new Set(
      events
        .filter((event) => event.type === type)
        .map((event) => String(event.details?.[field] ?? event.event_id)),
    ).size;

  const wall = elapsedSeconds(bounds.startedAt, bounds.finishedAt);
  const lifecycle = events.filter((event) => [
    "run_started",
    "run_paused",
    "run_resumed",
    "run_finished",
  ].includes(event.type));
  const active = lifecycle.length > 0 ? activeSeconds(lifecycle, bounds) : null;
  const paused = lifecycle.length > 0 ? Math.max(0, (wall ?? 0) - (active ?? 0)) : null;
  const retries = events.filter((event) => event.type === "retry_recorded").map(toRetry);

  return {
    metrics: {
      wall_time_seconds: metric(wall, "lifecycle", wall === null ? "unknown" : "exact"),
      active_time_seconds: metric(active, "lifecycle", active === null ? "unknown" : "exact"),
      paused_time_seconds: metric(paused, "lifecycle", paused === null ? "unknown" : "exact"),
      keryx_commands: metric(
        sourceReliability === "exact"
          ? commandEvents.filter((event) => event.details?.command_kind === "keryx").length
          : null,
        "runtime/gdctx",
      ),
      shell_commands: metric(
        sourceReliability === "exact"
          ? commandEvents.filter((event) => event.details?.command_kind === "shell").length
          : null,
        "runtime/gdctx",
      ),
      tool_calls: metric(
        sourceReliability === "exact" ? events.filter((event) => event.type === "tool_called").length : null,
        "runtime",
      ),
      context_files_read: metric(
        sourceReliability === "exact" ? unique("file_read", "path") : null,
        "runtime/gdctx",
      ),
      files_modified: metric(
        sourceReliability === "exact" ? unique("file_modified", "path") : null,
        "runtime/git",
      ),
      subagents: metric(
        sourceReliability === "exact" ? unique("subagent_started", "dispatch_id") : null,
        "runtime",
      ),
      retry_count: metric(sourceReliability === "exact" ? retries.length : null, "runtime"),
      keryx_overhead_seconds: metric(null, "runtime", "unknown"),
    },
    retries,
  };
}

function toRetry(event: ExecutionEvent): RetryRecord {
  const type = String(event.details?.retry_type ?? "unknown");
  const allowed = new Set(["task", "keryx", "environment", "expected-tdd", "external", "unknown"]);
  return {
    type: allowed.has(type) ? (type as RetryRecord["type"]) : "unknown",
    reason: String(event.details?.reason ?? "retry reason unavailable"),
    reliability: event.reliability ?? "exact",
    source: event.source,
    ...(typeof event.details?.affected_final_status === "boolean"
      ? { affected_final_status: event.details.affected_final_status }
      : {}),
    ...(typeof event.details?.consumed_user_time === "boolean"
      ? { consumed_user_time: event.details.consumed_user_time }
      : {}),
  };
}

function elapsedSeconds(startedAt: string, finishedAt: string): number | null {
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return null;
  return (finish - start) / 1000;
}

function activeSeconds(
  events: ExecutionEvent[],
  bounds: { startedAt: string; finishedAt: string },
): number | null {
  const start = Date.parse(bounds.startedAt);
  const finish = Date.parse(bounds.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return null;
  let active = false;
  let activeStart = start;
  let total = 0;
  for (const event of [...events].sort(
    (a, b) => Date.parse(a.timestamp_utc) - Date.parse(b.timestamp_utc),
  )) {
    const timestamp = Date.parse(event.timestamp_utc);
    if (!Number.isFinite(timestamp)) continue;
    if (event.type === "run_started" || event.type === "run_resumed") {
      if (!active) {
        active = true;
        activeStart = timestamp;
      }
    } else if (event.type === "run_paused" || event.type === "run_finished") {
      if (active) {
        total += Math.max(0, timestamp - activeStart);
        active = false;
      }
    }
  }
  if (active) total += Math.max(0, finish - activeStart);
  return total / 1000;
}
