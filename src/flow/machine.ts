import type { AttemptEntry, AttemptOutcome, FlowStatus, FlowTask } from "./types";

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

/**
 * A generated scaffold row that nothing has touched since `flow init` wrote it
 * (flow 211, AC8).
 *
 * Every clause is an observed fact about the record: `origin` was written at
 * creation, `status` is still the initial one, and the attempt log is empty.
 * There is deliberately no time term. "Untouched" is checkable; "stale" would
 * need a threshold, and a threshold invites a rule that closes the row when it
 * trips — which would record a judgement nobody made. This predicate only ever
 * decides how a task is DESCRIBED in a gate failure; it never changes whether
 * the gate passes.
 */
export function isUntouchedScaffold(task: FlowTask): boolean {
  return task.origin === "scaffold" && task.status === "todo" && (task.attempts?.count ?? 0) === 0;
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

// --- Resume state: what a restarting or handed-off agent is allowed to conclude ---
//
// `nextTask` answers "which task is next". It does not answer the question an
// agent picking work up actually has to answer first: has anyone already been
// here? Before this, it could not be answered from the record at all. The
// attempt log's ORDER — the one thing that separates "an attempt opened and
// never closed" from "an attempt opened and ended" — was written by
// `recordAttempt` and read by nothing: `flow status` printed a bare count, and
// `flow next` printed "this is the first task that is not done" for a task
// nobody had touched and for a task an agent had started and died inside,
// byte for byte the same line.
//
// That is the whole handoff/resume hazard in one sentence. Redoing a task whose
// first attempt already half-landed duplicates work silently; skipping one that
// never started loses it silently. The record has to be able to say "I cannot
// tell", and it has to say it in words that are not the words for either of the
// other two answers.
//
// The measurement that fixed the shape of this type: across all 200 flow
// packages in this repository, 1739 tasks, 99 have an attempt log ending in
// `started` — and all 99 are `done`. `taskDone --disposition completed`
// deliberately does not append a closing entry (see `service.taskDone`), so for
// a completed task the log ALWAYS ends open. `status` is therefore the first
// thing consulted below, not the log; a classifier that read the log first
// would have accused all 99 of being interrupted.

/** Outcomes that leave an attempt OPEN: something began and never reported an end. */
const NON_TERMINAL_OUTCOMES: ReadonlySet<AttemptOutcome> = new Set(["started", "paused"]);

/**
 * What the persisted record supports concluding about one task, for an agent
 * that did not run the earlier attempts.
 *
 * The three answers the resume path has to keep apart are `done` ("this step
 * already happened"), `never-started` ("this step never started") and
 * `unresolved` ("I cannot tell"). `ended` is the fourth real state — attempted,
 * and the attempt reported how it ended — and is deliberately NOT folded into
 * `never-started`: a retry after a recorded failure is a different act from a
 * first try, and the count is the retry budget a restart used to reset.
 *
 * `unresolved` never claims the earlier agent died. It cannot know that: the
 * flow lock is held for the duration of one mutation, not for the duration of a
 * task, so an open attempt is equally consistent with another agent still
 * working. The claim it makes is only the true one — that no end was recorded.
 */
export type TaskResumeState =
  /** The task is `done`. This step already happened, however it ended. */
  | { kind: "done" }
  /**
   * No attempt was ever recorded against this task.
   *
   * That is a statement about the record, not about the world: a package
   * written before the attempt log existed carries no entries because nothing
   * could write one, and `readFlow`'s v1 migration back-fills `{count: 0}` for
   * such a task only when its status is still `todo`. A `todo` task that
   * nothing has ever claimed to attempt is the one case where "no record" and
   * "nothing happened" coincide, and it is the only case this arm covers.
   */
  | { kind: "never-started" }
  /** Every recorded attempt reported an end. Safe to start again; this would be attempt `attempts + 1`. */
  | { kind: "ended"; outcome: AttemptOutcome; at: string; attempts: number }
  /**
   * An attempt is open, or the log cannot account for the attempts claimed.
   * Whether its work partially landed is UNKNOWN and cannot be resolved from
   * this record.
   *
   * `openedAt` can be an INFERRED timestamp rather than an observed one: for a
   * pre-attempt-log package whose task was mid-flight, `migrateTask` synthesises
   * a single `started` entry dated from the flow's own history. Treat it as
   * "no later than", not as the moment work began. No such task exists in this
   * repository today (all 99 open-ended logs belong to `done` tasks), so this is
   * a caveat on the field's meaning and not a live inaccuracy.
   */
  | {
      kind: "unresolved";
      reason: "attempt-not-closed" | "count-without-log" | "log-incomplete";
      attempts: number;
      openedAt?: string | undefined;
      detail?: string | undefined;
    };

/**
 * Classify one task for resume. Pure; no I/O.
 *
 * Order matters and is load-bearing:
 *  1. `done` first — see the note above on the 99 completed tasks whose logs end
 *     open. `status` and `attempts` are written by the same atomic `writeFlow`,
 *     so there is no window in which a task is really finished while its status
 *     still says otherwise; trusting `status` here is not optimism.
 *  2. `count`/`log` disagreement next. `recordAttempt` keeps them in step and
 *     the v1 migration writes them in step (0 mismatches in 1739 real tasks),
 *     so a disagreement means a hand-edit or a truncated file — an absence of
 *     evidence, which is exactly what must NOT be rendered as "never started".
 *  3. Only then the last entry's outcome.
 */
export function taskResumeState(task: FlowTask): TaskResumeState {
  if (task.status === "done") {
    return { kind: "done" };
  }
  const log = task.attempts?.log ?? [];
  const count = task.attempts?.count ?? 0;
  if (count === 0 && log.length === 0) {
    return { kind: "never-started" };
  }
  if (log.length === 0) {
    // The counter says work was attempted and the log has nothing to date it
    // against. "Never started" would be a lie in the safe-looking direction.
    return { kind: "unresolved", reason: "count-without-log", attempts: count };
  }
  const last = log[log.length - 1] as AttemptEntry;
  if (count !== log.length) {
    return {
      kind: "unresolved",
      reason: "log-incomplete",
      attempts: Math.max(count, log.length),
      openedAt: last.at,
      ...(last.detail === undefined ? {} : { detail: last.detail }),
    };
  }
  if (NON_TERMINAL_OUTCOMES.has(last.outcome)) {
    return {
      kind: "unresolved",
      reason: "attempt-not-closed",
      attempts: count,
      openedAt: last.at,
      ...(last.detail === undefined ? {} : { detail: last.detail }),
    };
  }
  return { kind: "ended", outcome: last.outcome, at: last.at, attempts: count };
}

/**
 * What `keryx flow next` answers. Exactly one of the three shapes.
 *
 * `ready` carries the resume state as well as the task, because the two
 * together are the answer to "what do I do next" and the task alone is not:
 * "start T2" and "T2 was already started by someone who never came back" call
 * for different acts, and a caller that has to fetch the second fact from a
 * different command is a caller that will not.
 *
 * `unresolved` lists EVERY not-done task carrying an open attempt, not just the
 * ready one. A flow can have several tasks dispatched in parallel; reporting
 * only the first would hide the rest behind it until it closed.
 */
export type NextTaskDecision = (
  | { kind: "ready"; task: FlowTask; resume: TaskResumeState }
  | { kind: "blocked"; blocked: Array<{ task: FlowTask; waitingOn: string[] }> }
  | { kind: "none" }
) & { unresolved: Array<{ task: FlowTask; resume: TaskResumeState }> };

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
  // Every not-done task carrying an open attempt, collected before the loop
  // returns: `ready` short-circuits on the first startable task, and the
  // unresolved ones behind it are exactly the ones a partial handoff leaves.
  const unresolved = tasks
    .map((task) => ({ task, resume: taskResumeState(task) }))
    .filter((entry) => entry.resume.kind === "unresolved");
  let ready: { kind: "ready"; task: FlowTask; resume: TaskResumeState } | null = null;
  for (const task of tasks) {
    if (task.status === "done") {
      continue;
    }
    const waitingOn = (task.dependsOn ?? [])
      .map((dependency) => dependency.toUpperCase())
      .filter((dependency) => !isSatisfied(byId.get(dependency)));
    if (waitingOn.length === 0) {
      ready = { kind: "ready", task, resume: taskResumeState(task) };
      break;
    }
    blocked.push({ task, waitingOn });
  }
  if (ready) {
    return { ...ready, unresolved };
  }
  return blocked.length === 0
    ? { kind: "none", unresolved }
    : { kind: "blocked", blocked, unresolved };
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
