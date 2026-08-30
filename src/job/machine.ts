import {
  JOB_INTENTS,
  STEP_STATUS_FLAGS,
  type JobIntent,
  type JobPhase,
  type JobStep,
  type JobStepStatus,
  type JobStepStatusFlag,
} from "./types";

// Explicit transitions, in the shape `src/flow/machine.ts` uses, so the two
// modules are learnable as one thing. The CLI is the only writer of job state
// and every move it may make is listed here.

const PHASE_TRANSITIONS: Record<JobPhase, JobPhase[]> = {
  CONTEXT: ["PLAN", "EXECUTION"],
  PLAN: ["EXECUTION"],
  EXECUTION: ["COMPLETION"],
  COMPLETION: [],
};

/** A phase moving to itself is a no-op, not a violation (`step` after `step`). */
export function canTransitionPhase(from: JobPhase, to: JobPhase): boolean {
  return from === to || (PHASE_TRANSITIONS[from]?.includes(to) ?? false);
}

export function assertPhaseTransition(from: JobPhase, to: JobPhase): void {
  if (!canTransitionPhase(from, to)) {
    throw new Error(
      `Invalid job phase transition: ${from} -> ${to}. Allowed from ${from}: ` +
        `${[from, ...(PHASE_TRANSITIONS[from] ?? [])].join(", ")}`,
    );
  }
}

/**
 * Step status transitions.
 *
 * `in_progress -> in_progress`, `completed -> in_progress` and
 * `failed -> in_progress` are the retry edges: a step re-entered after a failed
 * review round is the normal case, and refusing it would push the operator into
 * hand-editing `state.json`, which is the one thing this module exists to stop.
 * `retries` records that it happened (see `JobStepMetric`).
 */
const STEP_TRANSITIONS: Record<JobStepStatus, JobStepStatus[]> = {
  pending: ["in_progress", "completed", "skipped", "failed"],
  in_progress: ["in_progress", "completed", "skipped", "failed"],
  completed: ["in_progress"],
  skipped: ["pending", "in_progress"],
  failed: ["in_progress", "skipped"],
};

export function canTransitionStep(from: JobStepStatus, to: JobStepStatus): boolean {
  return STEP_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertStepTransition(id: string, from: JobStepStatus, to: JobStepStatus): void {
  if (canTransitionStep(from, to)) {
    return;
  }
  const allowed = (STEP_TRANSITIONS[from] ?? []).map(toStatusFlag);
  throw new Error(
    `Invalid --status for step "${id}": ${toStatusFlag(from)} -> ${toStatusFlag(to)}. ` +
      `Allowed from ${toStatusFlag(from)}: ${allowed.join(", ") || "(none)"}`,
  );
}

/**
 * A step that will not be visited again. `failed` is NOT terminal: it is the
 * one status that says the work did not happen, and letting it close a job is
 * the leak the completion gate exists to prevent.
 */
export function isTerminalStep(status: JobStepStatus): boolean {
  return status === "completed" || status === "skipped";
}

/**
 * The first step that is not terminal — the resumption fact §0.0 of the
 * job-orchestrator skill promises. Plan order is the answer; a job with every
 * step terminal answers `null`.
 */
export function firstOpenStep(steps: JobStep[]): JobStep | null {
  return steps.find((step) => !isTerminalStep(step.status)) ?? null;
}

// --- flag <-> persisted spelling -------------------------------------------

/** `--status in-progress` -> `in_progress`. Refuses anything outside the enum. */
export function parseStepStatus(raw: string | undefined): JobStepStatus {
  if (raw === undefined || !(STEP_STATUS_FLAGS as readonly string[]).includes(raw)) {
    throw new Error(
      `Invalid --status "${raw ?? ""}". Expected one of: ${STEP_STATUS_FLAGS.join(", ")}`,
    );
  }
  return (raw === "in-progress" ? "in_progress" : raw) as JobStepStatus;
}

/** `in_progress` -> `in-progress`, for anything an operator reads. */
export function toStatusFlag(status: JobStepStatus): JobStepStatusFlag {
  return (status === "in_progress" ? "in-progress" : status) as JobStepStatusFlag;
}

export function parseIntent(raw: string | undefined): JobIntent {
  if (raw === undefined) {
    return "implement";
  }
  if (!(JOB_INTENTS as readonly string[]).includes(raw)) {
    throw new Error(`Invalid --intent "${raw}". Expected one of: ${JOB_INTENTS.join(", ")}`);
  }
  return raw as JobIntent;
}

// --- completion gate --------------------------------------------------------

export type JobGateVerdict = {
  passed: boolean;
  /** Steps that are neither `completed` nor `skipped`. */
  open: string[];
  /** Steps explicitly recorded as `failed`. */
  failed: string[];
  total: number;
};

/**
 * Pure evaluation of the completion gate over an already-loaded step list.
 *
 * A `conditional` step is not exempt: the plan declares it, so the job must SAY
 * what happened to it — `--status skipped` is one keystroke and leaves a record,
 * whereas an exemption leaves the same silence the audit found everywhere else.
 */
export function evaluateJobGate(steps: JobStep[]): JobGateVerdict {
  const open: string[] = [];
  const failed: string[] = [];
  for (const step of steps) {
    if (step.status === "failed") {
      failed.push(step.id);
      continue;
    }
    if (!isTerminalStep(step.status)) {
      open.push(step.id);
    }
  }
  return { passed: open.length === 0 && failed.length === 0, open, failed, total: steps.length };
}
