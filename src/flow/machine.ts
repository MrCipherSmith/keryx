import type { FlowStatus, FlowTask } from "./types";

// Strict status state machine (spec section 6). The CLI is the only writer of
// flow state, and every transition must be listed here.
const TRANSITIONS: Record<FlowStatus, FlowStatus[]> = {
  initializing: ["ready", "blocked"],
  ready: ["in-progress", "blocked"],
  "in-progress": ["implemented", "blocked"],
  implemented: ["completing", "blocked"],
  completing: ["done", "in-progress", "blocked"],
  blocked: [], // unblock restores previousStatus explicitly
  done: [],
};

export function canTransition(from: FlowStatus, to: FlowStatus): boolean {
  if (to === "blocked") {
    return from !== "done" && from !== "blocked";
  }
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: FlowStatus, to: FlowStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid flow transition: ${from} -> ${to}. Allowed from ${from}: ${[
        ...(TRANSITIONS[from] ?? []),
        ...(from !== "done" && from !== "blocked" ? ["blocked"] : []),
      ].join(", ") || "(none)"}`,
    );
  }
}

// --- Task-level completion-gate mapping (TM-01 §6.4) ---
//
// Pure, context-free mapping from a task's (status, disposition) to its gate
// outcome.
//
// History: this function shipped deliberately unwired, because TM-01 §8 OPEN-4
// deferred disposition finalization and flow-level gate wiring to FI-01/FI-02.
// The deferral was reasonable when written and wrong in effect: with the gate
// asserted only in Markdown, 24 of 184 completed flows shipped carrying 34
// unfinished tasks, 24 of them the review step itself. Flow 201 closes OPEN-4
// by wiring `evaluateTaskGate` into `service.complete()` — opt-in per package
// (`FlowState.gates.tasks`) so the historical packages are not rewritten.
export type TaskGateStatus = "not-terminal" | "terminal-pass" | "terminal-fail";

export function taskGateStatus(task: FlowTask): TaskGateStatus {
  if (task.status !== "done") {
    return "not-terminal";
  }
  // status "done": disposition clarifies HOW it ended. Absent disposition is
  // treated as implicit "completed" (v1 compat). Only "failed" gate-fails.
  return task.disposition === "failed" ? "terminal-fail" : "terminal-pass";
}

/**
 * A `skipped` task passes the gate only when the skip carries a recorded
 * reason (flow 201, AC3).
 *
 * `taskGateStatus` maps `skipped -> terminal-pass` per TM-01 §6.2 and stays
 * that way: it is a pure (status, disposition) mapping and a reason is neither.
 * The extra condition therefore lives here, one level up, where the whole task
 * is visible. An unreasoned skip is the one shape that would let a task be
 * closed without work and without a trace — exactly the leak this gate exists
 * to close.
 */
export function isUnreasonedSkip(task: FlowTask): boolean {
  return task.disposition === "skipped" && !task.dispositionReason?.trim();
}

/**
 * The dispositions `taskGateStatus` is allowed to map to `terminal-pass`.
 *
 * Anything else — a typo, a value from a newer writer, a hand-edit — is treated
 * as failing rather than passing. The first version of this gate cast the CLI's
 * `--disposition` straight to the type without validating it, so
 * `--disposition skiped` persisted verbatim, missed the `=== "skipped"` reason
 * check, missed the `=== "failed"` fail check, and passed. A gate whose default
 * for the unrecognised case is "pass" is not a gate.
 */
const GATE_PASSING_DISPOSITIONS: ReadonlySet<string> = new Set(["completed", "skipped"]);

/**
 * A task that ended `blocked` did not get done, and closing a flow over it is
 * the same leak as closing over an open one.
 *
 * This is not a hypothetical CLI abuse: `ManagedFlowPort` maps a harness
 * completion gate of `blocked` to `disposition: "blocked"` and writes it through
 * `taskDone`, so a harness run that ends blocked would mark its task done, pass
 * the gate, and complete the flow — with no reason recorded anywhere, because
 * unlike `skipped` nothing required one. It was a cheaper bypass than the one
 * this gate was written to prevent.
 */
export function isBlockedTask(task: FlowTask): boolean {
  return task.disposition === "blocked";
}

/** A disposition this build does not recognise. Fails the gate; never passes it. */
export function isUnknownDisposition(task: FlowTask): boolean {
  if (task.disposition === undefined || task.disposition === null) {
    return false; // absent disposition is v1-compatible implicit "completed"
  }
  if (task.disposition === "failed" || task.disposition === "blocked") {
    return false; // recognised, and handled by their own predicates
  }
  return !GATE_PASSING_DISPOSITIONS.has(task.disposition);
}

export type TaskGateVerdict = {
  passed: boolean;
  /** Non-terminal tasks: status is not yet "done". */
  open: string[];
  /** Terminal but explicitly failed (disposition "failed"). */
  failed: string[];
  /** disposition "skipped" with no recorded reason. */
  unreasonedSkips: string[];
  /** disposition "blocked" — terminal, but the work did not happen. */
  blocked: string[];
  /** A disposition this build does not recognise; never allowed to pass. */
  unknownDisposition: string[];
  total: number;
};

/**
 * Pure evaluation of the flow-level task gate over an already-loaded task list.
 * No I/O, so it is testable directly and reusable by any caller that has a
 * `FlowState` in hand.
 */
export function evaluateTaskGate(tasks: FlowTask[]): TaskGateVerdict {
  const open: string[] = [];
  const failed: string[] = [];
  const unreasonedSkips: string[] = [];
  const blocked: string[] = [];
  const unknownDisposition: string[] = [];
  for (const task of tasks) {
    const status = taskGateStatus(task);
    if (status === "not-terminal") {
      open.push(task.id);
      continue;
    }
    if (status === "terminal-fail") {
      failed.push(task.id);
      continue;
    }
    // Everything below reaches `terminal-pass` from the pure (status,
    // disposition) mapping and is then refused here, where the whole task is
    // visible. Ordered most-specific first so a task appears in exactly one
    // bucket and the operator gets one reason, not three.
    if (isUnknownDisposition(task)) {
      unknownDisposition.push(task.id);
      continue;
    }
    if (isBlockedTask(task)) {
      blocked.push(task.id);
      continue;
    }
    if (isUnreasonedSkip(task)) {
      unreasonedSkips.push(task.id);
    }
  }
  return {
    passed:
      open.length === 0 &&
      failed.length === 0 &&
      unreasonedSkips.length === 0 &&
      blocked.length === 0 &&
      unknownDisposition.length === 0,
    open,
    failed,
    unreasonedSkips,
    blocked,
    unknownDisposition,
    total: tasks.length,
  };
}
