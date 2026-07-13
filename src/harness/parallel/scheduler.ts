// Bounded ready-set wave scheduler (flow 016, W13 / PA-01).
//
// A PARENT plans how to fan a set of child tasks out into concurrency- and
// budget-bounded waves. Pure, deterministic, and fail-closed:
//   - Bounded ready-set waves — each wave holds only tasks whose `dependsOn`
//     are ALL scheduled in a STRICTLY earlier wave, sorted deterministically by
//     `taskId`, capped at `maxConcurrency`.
//   - Aggregate reservations — budget is reserved by FOLDING the reused W12
//     `inheritBudget` (`../child/isolation`) across the scheduled tasks in plan
//     order against a decrementing copy of `parentRemaining`. The sum of granted
//     reservations can never exceed the parent's remaining budget; a task whose
//     reservation would breach the running remaining DENIES the whole plan
//     (never a silent over-grant, never a partial plan).
//   - Cancellation — a `cancelled` task AND its transitive dependents are
//     excluded from every wave; the rest still schedule.
//   - Loop detection — if non-excluded tasks remain but no ready-set can be
//     formed (a dependency cycle), the plan is DENIED with no partial waves.
//
// Nothing here reads a clock/RNG, opens a socket, touches the filesystem, or
// writes flow state — planning NEVER owns completion. Optional fields are set
// via conditional spread to respect `exactOptionalPropertyTypes`.
import { type BudgetReservation, inheritBudget, type ParentRemainingBudget } from "../child/isolation";

/** A child task to schedule: its dependencies and its requested budget reservation. */
export interface ChildTask {
  taskId: string;
  dependsOn: string[];
  budgetRequest: BudgetReservation;
  cancelled?: boolean;
}

/** Ceilings the plan must respect: per-wave concurrency and the parent's remaining budget. */
export interface PlanWavesConfig {
  maxConcurrency: number;
  parentRemaining: ParentRemainingBudget;
}

/**
 * Injected dependencies for {@link planWaves}. `idSeq` is pinned for
 * forward-compatibility (e.g. synthesizing wave ids) but is NOT required: every
 * task and reservation already carries its own id, so the plan stays
 * deterministic without an injected id source.
 */
export interface PlanWavesDeps {
  idSeq: () => string;
}

/** One scheduled wave: its taskIds and the index-aligned granted reservations. */
export interface Wave {
  taskIds: string[];
  reservations: BudgetReservation[];
}

/** Result of {@link planWaves}: the full wave plan or a fail-closed denial. */
export type PlanWavesResult = { ok: true; waves: Wave[] } | { ok: false; reason: string };

/** Deterministic total order over taskIds (no locale dependence). */
function byTaskId(a: ChildTask, b: ChildTask): number {
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/**
 * Compute the fail-closed exclusion closure: every `cancelled` task plus every
 * task that (transitively) depends on an excluded task. Iterates to a fixpoint.
 */
function computeExcluded(tasks: readonly ChildTask[]): Set<string> {
  const excluded = new Set<string>();
  for (const t of tasks) {
    if (t.cancelled === true) excluded.add(t.taskId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (excluded.has(t.taskId)) continue;
      if (t.dependsOn.some((dep) => excluded.has(dep))) {
        excluded.add(t.taskId);
        changed = true;
      }
    }
  }
  return excluded;
}

/**
 * Decrement a running remaining budget by a granted reservation. Tool-call
 * budget is only decremented when BOTH the remaining budget and the reservation
 * carry one (a reservation without a cap does not consume tool-call budget).
 */
function decrementRemaining(
  remaining: ParentRemainingBudget,
  reservation: BudgetReservation,
): ParentRemainingBudget {
  const maxRuntimeMs = remaining.maxRuntimeMs - reservation.maxRuntimeMs;
  if (remaining.maxToolCalls !== undefined && reservation.maxToolCalls !== undefined) {
    return { maxRuntimeMs, maxToolCalls: remaining.maxToolCalls - reservation.maxToolCalls };
  }
  return remaining.maxToolCalls !== undefined
    ? { maxRuntimeMs, maxToolCalls: remaining.maxToolCalls }
    : { maxRuntimeMs };
}

/**
 * Plan a set of child tasks into bounded ready-set waves with aggregate budget
 * reservation, cancellation, and cycle detection. Pure, synchronous, and
 * deterministic: identical inputs yield a deep-equal result. `deps` is accepted
 * for forward-compatibility but unused.
 */
export function planWaves(tasks: ChildTask[], config: PlanWavesConfig, _deps?: PlanWavesDeps): PlanWavesResult {
  // Fail closed on a degenerate concurrency ceiling: a non-positive
  // `maxConcurrency` can schedule no task, so the wave loop would never make
  // progress and would spin forever. Deny rather than hang.
  if (!Number.isInteger(config.maxConcurrency) || config.maxConcurrency < 1) {
    return { ok: false, reason: `maxConcurrency must be a positive integer, got ${config.maxConcurrency}` };
  }

  const excluded = computeExcluded(tasks);
  const universe = tasks.filter((t) => !excluded.has(t.taskId));

  // --- Structure pass: form bounded, dependency-ordered waves. ------------
  const scheduled = new Set<string>();
  const waveTaskLists: ChildTask[][] = [];
  while (scheduled.size < universe.length) {
    const ready = universe
      .filter((t) => !scheduled.has(t.taskId) && t.dependsOn.every((dep) => scheduled.has(dep)))
      .sort(byTaskId);

    // No progress with tasks still pending ⇒ a dependency cycle (or an
    // unsatisfiable dependency). Fail closed: deny the WHOLE plan, no partial
    // waves.
    if (ready.length === 0) {
      return { ok: false, reason: "dependency cycle detected: no ready task set could be formed" };
    }

    const waveTasks = ready.slice(0, config.maxConcurrency);
    // Mark scheduled only AFTER the wave is chosen so deps must resolve in a
    // strictly earlier wave (never the same wave).
    for (const t of waveTasks) scheduled.add(t.taskId);
    waveTaskLists.push(waveTasks);
  }

  // --- Budget pass: fold inheritBudget across the plan in wave/taskId order.
  // The running `remaining` carries ACROSS waves so the ceiling is enforced
  // over the entire plan, not reset per wave.
  let remaining = config.parentRemaining;
  const waves: Wave[] = [];
  for (const waveTasks of waveTaskLists) {
    const taskIds: string[] = [];
    const reservations: BudgetReservation[] = [];
    for (const t of waveTasks) {
      const granted = inheritBudget(remaining, t.budgetRequest);
      if (!granted.ok) {
        return { ok: false, reason: granted.reason };
      }
      taskIds.push(t.taskId);
      reservations.push(granted.reservation);
      remaining = decrementRemaining(remaining, granted.reservation);
    }
    waves.push({ taskIds, reservations });
  }

  return { ok: true, waves };
}
