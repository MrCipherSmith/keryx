import { expect, test } from "bun:test";
import { aggregateExecutionEvents, type ExecutionEvent } from "./events";

const BOUNDS = { startedAt: "2026-07-10T10:00:00.000Z", finishedAt: "2026-07-10T10:00:10.000Z" };

function bookended(events: ExecutionEvent[]): ExecutionEvent[] {
  return [
    { event_id: "start", run_id: "run-a", type: "run_started", timestamp_utc: BOUNDS.startedAt, source: "runtime" },
    ...events,
    { event_id: "finish", run_id: "run-a", type: "run_finished", timestamp_utc: BOUNDS.finishedAt, source: "runtime" },
  ];
}

// Defect (flow 238 / phase 6 / T5, #3): replaying an event inflated the
// recorded cost. `aggregateExecutionEvents` counted every element of the
// input array without deduplicating by `event_id`, so the SAME event
// appearing twice (a genuine replay scenario: retried delivery, an
// at-least-once event bus, a log re-ingested after a crash) silently
// doubled every count it touched.
test("aggregateExecutionEvents dedupes replayed events by event_id, not just by an incidental field", () => {
  const once = aggregateExecutionEvents(
    bookended([
      { event_id: "cmd-1", run_id: "run-a", type: "command_finished", timestamp_utc: "2026-07-10T10:00:02.000Z", source: "gdctx", details: { command_kind: "keryx" } },
      { event_id: "tool-1", run_id: "run-a", type: "tool_called", timestamp_utc: "2026-07-10T10:00:03.000Z", source: "runtime" },
      { event_id: "retry-1", run_id: "run-a", type: "retry_recorded", timestamp_utc: "2026-07-10T10:00:04.000Z", source: "runtime", details: { retry_type: "task", reason: "flaky" } },
    ]),
    BOUNDS,
  );

  const replayed = aggregateExecutionEvents(
    bookended([
      { event_id: "cmd-1", run_id: "run-a", type: "command_finished", timestamp_utc: "2026-07-10T10:00:02.000Z", source: "gdctx", details: { command_kind: "keryx" } },
      // The same event_id delivered a second time (replay/retry ingestion),
      // NOT a second distinct command — must not count twice.
      { event_id: "cmd-1", run_id: "run-a", type: "command_finished", timestamp_utc: "2026-07-10T10:00:02.000Z", source: "gdctx", details: { command_kind: "keryx" } },
      { event_id: "tool-1", run_id: "run-a", type: "tool_called", timestamp_utc: "2026-07-10T10:00:03.000Z", source: "runtime" },
      { event_id: "tool-1", run_id: "run-a", type: "tool_called", timestamp_utc: "2026-07-10T10:00:03.000Z", source: "runtime" },
      { event_id: "retry-1", run_id: "run-a", type: "retry_recorded", timestamp_utc: "2026-07-10T10:00:04.000Z", source: "runtime", details: { retry_type: "task", reason: "flaky" } },
      { event_id: "retry-1", run_id: "run-a", type: "retry_recorded", timestamp_utc: "2026-07-10T10:00:04.000Z", source: "runtime", details: { retry_type: "task", reason: "flaky" } },
    ]),
    BOUNDS,
  );

  // Reproducibility: aggregating a replayed stream must equal aggregating
  // the de-duplicated stream once — the aggregate is a function of the SET
  // of distinct events, not of how many times the transport delivered them.
  expect(replayed.metrics.keryx_commands!.value).toBe(once.metrics.keryx_commands!.value);
  expect(replayed.metrics.tool_calls!.value).toBe(once.metrics.tool_calls!.value);
  expect(replayed.retries).toHaveLength(once.retries.length);

  expect(replayed.metrics.keryx_commands!.value).toBe(1);
  expect(replayed.metrics.tool_calls!.value).toBe(1);
  expect(replayed.retries).toHaveLength(1);
});

// Defect (flow 238 / phase 6 / T5, #4): any non-empty event array was
// declared `exact` — length is not provenance. A single stray event with no
// lifecycle bookends (no `run_started`/`run_finished`) is not evidence the
// capture is complete, yet the old code blessed it as `exact` anyway.
test("aggregateExecutionEvents does not call a capture 'exact' merely because the array is non-empty", () => {
  // Non-empty, but no run_started/run_finished bookends: nothing here
  // establishes the capture actually spans (and therefore completely
  // counts) the run. `length > 0` alone is the exact proxy the defect names.
  const unbookended = aggregateExecutionEvents(
    [
      { event_id: "cmd-1", run_id: "run-a", type: "command_finished", timestamp_utc: "2026-07-10T10:00:02.000Z", source: "gdctx", details: { command_kind: "keryx" } },
    ],
    BOUNDS,
  );
  expect(unbookended.metrics.keryx_commands!.reliability).toBe("unknown");
  expect(unbookended.metrics.keryx_commands!.value).toBeNull();

  // A genuinely bounded capture (both bookends present) is the actual signal
  // this run's event stream was captured start-to-finish.
  const bookendedResult = aggregateExecutionEvents(
    bookended([
      { event_id: "cmd-1", run_id: "run-a", type: "command_finished", timestamp_utc: "2026-07-10T10:00:02.000Z", source: "gdctx", details: { command_kind: "keryx" } },
    ]),
    BOUNDS,
  );
  expect(bookendedResult.metrics.keryx_commands!.reliability).toBe("exact");
  expect(bookendedResult.metrics.keryx_commands!.value).toBe(1);

  // Baseline preserved: truly empty stays unknown.
  const empty = aggregateExecutionEvents([], BOUNDS);
  expect(empty.metrics.keryx_commands!.reliability).toBe("unknown");
  expect(empty.metrics.keryx_commands!.value).toBeNull();
});
