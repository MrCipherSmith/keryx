// Fleet bridge: background-job tools (start_job/watch_job) → TUI Activity panel.
// Mirrors subagent-bridge.ts's shape/pattern but is a SEPARATE listener slot —
// jobs and subagents are independently testable event streams that both feed
// the same WorkerFleet instance once the TUI shell subscribes both.

import type { FleetWorkerStatus } from "./worker-fleet";

export type JobFleetEvent =
  | { kind: "upsert"; id: string; label: string; status: FleetWorkerStatus; detail?: string }
  | { kind: "remove"; id: string };

let listener: ((e: JobFleetEvent) => void) | undefined;

/** Registered by the TUI shell while mounted; undefined in readline (no sidebar). */
export function setJobFleetListener(fn: ((e: JobFleetEvent) => void) | undefined): void {
  listener = fn;
}

export function emitJobFleet(event: JobFleetEvent): void {
  try {
    listener?.(event);
  } catch {
    // never break a job's output loop over a sidebar repaint failure
  }
}
