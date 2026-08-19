// Fleet + work-log bridge: spawn_subagent tool → TUI Workers panel / inspector.
// Tools are built before the TUI mounts; the shell registers a listener later.

import type { FleetWorkerStatus } from "./worker-fleet";

export type SubagentWorkKind = "task" | "text" | "reasoning" | "tool" | "result" | "system";

/**
 * Which runtime executed a child (flow 176, package specification §8.2).
 *
 * Absent means the native in-process runtime — the shape every dispatch had
 * before external agents existed, so an emitter that predates them needs no
 * change. `"external"` means a vendor CLI subprocess, which the sidebar marks
 * because the two cost different things: a native child spends this session's
 * token budget, an external one spends the operator's paid subscription. A row
 * that does not say which is which makes that difference invisible at exactly
 * the moment it matters.
 */
export type SubagentRuntimeKind = "external";

export type SubagentFleetEvent =
  | {
      kind: "upsert";
      id: string;
      label: string;
      status: FleetWorkerStatus;
      detail?: string;
      model?: string;
      task?: string;
      /** Set only for a child executed by an external agent CLI. */
      runtime?: SubagentRuntimeKind;
      /** Registry id of that CLI (`codex-cli`, `claude-cli`), when known. */
      agentId?: string;
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
