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

// --- `dependsOn`, read (flow 209, AC6) ---
//
// `dependsOn` was written by `flow task add --depends`, migrated by
// `store.ts:175`, typed in `types.ts:64` — and read by nothing, for two
// releases. `flow-orchestrator`'s documented "resume at the first task not done,
// respecting `dependsOn` order" had no code behind it, so the ordering an
// operator declared was advice to a model and nothing more.
//
// The two functions below are that code. `nextTask` is the resume decision
// (`keryx flow next`); `dependencyIssues` is the integrity check
// (`keryx flow check`, which exits non-zero). Both are pure over an already
// loaded task list, so both are testable without touching disk — and both are
// reached from the CLI, which is what "used" has to mean after `attempts.count`.

/** What `keryx flow next` answers. Exactly one of the three shapes. */
export type NextTaskDecision =
  | { kind: "ready"; task: FlowTask }
  | { kind: "blocked"; blocked: Array<{ task: FlowTask; waitingOn: string[] }> }
  | { kind: "none" };

/** A task is satisfied for ordering purposes once it is `done`, however it ended. */
function isSatisfied(task: FlowTask | undefined): boolean {
  return task?.status === "done";
}

/**
 * The first task that is not done and whose declared dependencies are all done.
 *
 * "First" is the task list's own order, which is creation order: `dependsOn`
 * constrains it, and does not replace it. A dependency naming a task that does
 * not exist is treated as UNSATISFIED rather than ignored — the alternative is
 * that a typo silently unblocks the task it was meant to hold back, which is the
 * failure mode of every check that defaults to permissive.
 *
 * `blocked` (rather than `none`) when work remains but nothing is startable:
 * that is a real state — a dependency cycle, or a typo — and reporting it as
 * "nothing left to do" would close a flow over open work, which is the leak the
 * task gate exists to stop.
 */
export function nextTask(tasks: readonly FlowTask[]): NextTaskDecision {
  const byId = new Map(tasks.map((task) => [task.id.toUpperCase(), task]));
  const blocked: Array<{ task: FlowTask; waitingOn: string[] }> = [];
  for (const task of tasks) {
    if (task.status === "done") {
      continue;
    }
    const waitingOn = (task.dependsOn ?? [])
      .map((dependency) => dependency.toUpperCase())
      .filter((dependency) => !isSatisfied(byId.get(dependency)));
    if (waitingOn.length === 0) {
      return { kind: "ready", task };
    }
    blocked.push({ task, waitingOn });
  }
  return blocked.length === 0 ? { kind: "none" } : { kind: "blocked", blocked };
}

/** One way a task list's `dependsOn` graph is broken. */
export type DependencyIssue = {
  task: string;
  kind: "unknown-dependency" | "self-dependency" | "cycle";
  message: string;
};

/**
 * Everything wrong with the declared dependency graph.
 *
 * Reported by `keryx flow check`, which fails on it. Without this the three
 * shapes below are all silently equivalent to "no dependencies": a dependency on
 * a task that was renamed, a task depending on itself, and a cycle each produce a
 * `dependsOn` array nothing can satisfy, and before AC6 nothing looked.
 */
export function dependencyIssues(tasks: readonly FlowTask[]): DependencyIssue[] {
  const known = new Set(tasks.map((task) => task.id.toUpperCase()));
  const issues: DependencyIssue[] = [];
  for (const task of tasks) {
    for (const raw of task.dependsOn ?? []) {
      const dependency = raw.toUpperCase();
      if (dependency === task.id.toUpperCase()) {
        issues.push({
          task: task.id,
          kind: "self-dependency",
          message: `${task.id} depends on itself, so it can never become ready`,
        });
        continue;
      }
      if (!known.has(dependency)) {
        issues.push({
          task: task.id,
          kind: "unknown-dependency",
          message: `${task.id} depends on ${dependency}, which is not a task in this flow — the dependency can never be satisfied`,
        });
      }
    }
  }
  for (const id of tasksInCycles(tasks)) {
    issues.push({
      task: id,
      kind: "cycle",
      message: `${id} is part of a dependsOn cycle, so neither it nor anything waiting on it can ever start`,
    });
  }
  return issues;
}

/**
 * Ids that cannot be ordered — i.e. that remain after repeatedly removing every
 * task whose dependencies are all outside the remaining set.
 *
 * A Kahn-style peel rather than a DFS, because the answer wanted here is "which
 * tasks are stuck", not "which edge closed the loop": every member of a cycle,
 * and everything downstream of one, is equally unable to start, and naming only
 * the back-edge would send an operator to one task out of four.
 */
function tasksInCycles(tasks: readonly FlowTask[]): string[] {
  const known = new Set(tasks.map((task) => task.id.toUpperCase()));
  const remaining = new Map(
    tasks.map((task) => [
      task.id.toUpperCase(),
      (task.dependsOn ?? [])
        .map((dependency) => dependency.toUpperCase())
        .filter((dependency) => known.has(dependency) && dependency !== task.id.toUpperCase()),
    ]),
  );
  let peeled = true;
  while (peeled) {
    peeled = false;
    for (const [id, dependencies] of remaining) {
      if (dependencies.every((dependency) => !remaining.has(dependency))) {
        remaining.delete(id);
        peeled = true;
      }
    }
  }
  return [...remaining.keys()].sort();
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
