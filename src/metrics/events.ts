import type { ExecutionEvent, MetricValue, RetryRecord } from "./types";
export type { ExecutionEvent } from "./types";

export type EventAggregation = {
  metrics: Record<string, MetricValue>;
  retries: RetryRecord[];
};

export function aggregateExecutionEvents(
  events: ExecutionEvent[],
  bounds: { startedAt: string; finishedAt: string },
): EventAggregation {
  const sourceReliability = events.length > 0 ? "exact" : "unknown";
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
