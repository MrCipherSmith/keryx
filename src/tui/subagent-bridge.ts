// Fleet + work-log bridge: spawn_subagent tool → TUI Workers panel / inspector.
// Tools are built before the TUI mounts; the shell registers a listener later.

import type { FleetWorkerStatus } from "./worker-fleet";

export type SubagentWorkKind = "task" | "text" | "reasoning" | "tool" | "result" | "system";

export type SubagentFleetEvent =
  | {
      kind: "upsert";
      id: string;
      label: string;
      status: FleetWorkerStatus;
      detail?: string;
      model?: string;
      task?: string;
    }
  | { kind: "log"; id: string; entry: { kind: SubagentWorkKind; text: string } }
  | { kind: "remove"; id: string };

let listener: ((e: SubagentFleetEvent) => void) | undefined;

export function setSubagentFleetListener(fn: ((e: SubagentFleetEvent) => void) | undefined): void {
  listener = fn;
}

export function emitSubagentFleet(event: SubagentFleetEvent): void {
  try {
    listener?.(event);
  } catch {
    // never break the agent turn
  }
}
