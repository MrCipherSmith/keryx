// Managed-flow port (flow 014, W11 / FI-01).
//
// The single, one-directional bridge from a typed harness completion artifact
// to the Task Manager. It maps a `CompletionGateResult` + evidence refs + a
// `TaskRunLink` into exactly one `FlowService.taskDone` call and returns the
// resulting `FlowState`.
//
// Invariants (frozen acceptance):
//   - @SC_R09_SINGLE_COORDINATOR: managed-flow completion advances ONLY through
//     Task Manager. The port never advances flow state itself.
//   - @SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED (D-02): the harness NEVER writes
//     flow.json. The port performs no filesystem write and no network access —
//     it depends only on the injected `FlowService` (which is the sole
//     flow-state writer) and pure type/enumeration mapping. It imports the
//     Task Manager *types* and the completion-gate *type*, never `src/flow/store`
//     (the writer).
//
// Deterministic and side-effect-free beyond the single injected `taskDone`
// call: no `Date.now`, `Math.random`, `fetch`, or `fs`.

import type { FlowService, FlowState, TaskDisposition, TaskRunLink } from "../../flow/types";
import type { CompletionGateResult } from "../completion/gate";

/**
 * Map a completion-gate status to the terminal Task Manager disposition:
 *   - `"pass"`    -> `"completed"`
 *   - `"fail"`    -> `"failed"`
 *   - `"blocked"` -> `"blocked"` (an undisposed blocker remains)
 *   - anything else (`"unknown"`) -> `"failed"` (never a false completion).
 */
export function gateToDisposition(gate: CompletionGateResult): TaskDisposition {
  switch (gate.status) {
    case "pass":
      return "completed";
    case "blocked":
      return "blocked";
    case "fail":
    default:
      return "failed";
  }
}

/**
 * Why a non-passing gate ended the way it did, in one line, for the task's
 * `dispositionReason`.
 *
 * The port held this detail — `unresolvedBlockerIds`, and the failing checks'
 * own messages — and dropped it, so a harness-blocked task landed on disk with
 * a terminal disposition and no record anywhere of what blocked it. A `pass`
 * needs no explanation and gets none.
 */
export function gateToReason(gate: CompletionGateResult): string | undefined {
  if (gate.status === "pass") {
    return undefined;
  }
  const blockers = gate.unresolvedBlockerIds ?? [];
  if (blockers.length > 0) {
    return `unresolved blockers: ${blockers.join(", ")}`;
  }
  const failing = (gate.checks ?? [])
    .filter((check) => check.status !== "pass")
    .map((check) => check.detail ?? check.checkId)
    .filter((detail): detail is string => Boolean(detail));
  return failing.length > 0 ? failing.join("; ") : `completion gate: ${gate.status}`;
}

/** Input to a single managed-flow completion through the Task Manager. */
export interface CompleteFromGateInput {
  cwd: string;
  flowId: string;
  taskId: string;
  gate: CompletionGateResult;
  evidenceRefs: string[];
  runLink: TaskRunLink;
}

/**
 * The managed-flow port: the harness's only channel for advancing a managed
 * flow's completion state. Backed by a Task Manager `FlowService`.
 */
export interface ManagedFlowPort {
  completeFromGate(input: CompleteFromGateInput): Promise<FlowState>;
}

/**
 * Build a `ManagedFlowPort` backed by the injected Task Manager `service`.
 *
 * `completeFromGate` calls EXACTLY `service.taskDone(...)` once with the gate's
 * mapped disposition plus the supplied evidence refs / run link, and returns
 * its `FlowState`. It does nothing else — no fs write, no network — so the
 * Task Manager remains the single coordinator and sole flow-state writer.
 */
export function createTaskManagerFlowPort(service: FlowService): ManagedFlowPort {
  return {
    completeFromGate({ cwd, flowId, taskId, gate, evidenceRefs, runLink }) {
      return service.taskDone({
        cwd,
        id: flowId,
        taskId,
        disposition: gateToDisposition(gate),
        reason: gateToReason(gate),
        evidenceRefs,
        runLink,
      });
    },
  };
}
