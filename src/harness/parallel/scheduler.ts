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
import type { ChildModelRequest } from "../child/model";

/** A child task to schedule: its dependencies and its requested budget reservation. */
export interface ChildTask {
  taskId: string;
  dependsOn: string[];
  budgetRequest: BudgetReservation;
  cancelled?: boolean;
  /**
   * Optional model/provider request carried through to the child's dispatch
   * (flow 090). Scheduling and the budget fold are model-agnostic — this field is
   * threaded, not interpreted, by `planWaves`.
   */
  modelRequest?: ChildModelRequest;
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

// ---------------------------------------------------------------------------
// executeWaves (flow 171, Phase D / D1a): actually RUN a `planWaves` plan.
// `planWaves` above only plans (pure, sync, no clock/network/fs); this is the
// paired executor that dispatches `deps.run` against a real (or fake, in
// tests) async boundary, in wave order.
// ---------------------------------------------------------------------------

/** Injected dependencies for {@link executeWaves}. */
export interface WaveExecutorDeps<TTask, TResult> {
  /**
   * Runs one task to completion. Must not throw for an ordinary child
   * failure — failures are values (Phase D2's `SubagentCompletionStatus`),
   * not exceptions, so a well-behaved `run` never aborts its wave siblings by
   * rejecting. `executeWaves` stays defensively robust regardless (see the
   * sibling-isolation note below) for a `run` that rejects anyway.
   */
  run: (task: TTask, reservation: BudgetReservation) => Promise<TResult>;
}

/**
 * Raised by {@link executeWaves} when one or more `run` calls within a single
 * wave rejected. Every sibling task in that wave has already SETTLED
 * (fulfilled or rejected) by the time this is thrown — see the sibling-
 * isolation note on {@link executeWaves} — so this error never represents lost
 * or aborted in-flight work, only a wave that did not fully succeed.
 *
 * `TResult` defaults to `unknown` so callers that only need `waveIndex`/
 * `failedTaskIds`/`causes` (e.g. a plain `instanceof` check) never have to
 * name it; a caller that wants typed access to {@link partialResults} should
 * narrow/cast at the catch site to the same `TResult` it passed to
 * {@link executeWaves}.
 */
export class WaveExecutionError<TResult = unknown> extends Error {
  /** The wave index (0-based) the rejection(s) occurred in. */
  readonly waveIndex: number;
  /** taskIds that rejected, in wave dispatch order. */
  readonly failedTaskIds: readonly string[];
  /** The underlying rejection reasons, index-aligned with `failedTaskIds`. */
  readonly causes: readonly unknown[];
  /**
   * Every task that had already SETTLED SUCCESSFULLY by the time this error
   * was thrown: every task from a fully-succeeded EARLIER wave, plus every
   * fulfilled sibling from the SAME wave as the rejection(s) that caused this
   * throw (recall `executeWaves` dispatches a wave via `Promise.allSettled`,
   * so a rejecting sibling never prevents its wave-mates from settling and
   * being recorded here). A task from a wave that never started because an
   * earlier wave already failed has NO entry here — the caller must
   * synthesize its own fallback for any `taskId` missing from this map
   * (whether or not it's also in `failedTaskIds`). Added specifically so a
   * catcher does not have to treat the whole sub-batch as failed just
   * because ONE task in it did (see the `runConcurrentSpawnBatch` catch site
   * in `agent.ts` for the motivating bug this fixed).
   */
  readonly partialResults: ReadonlyMap<string, TResult>;

  constructor(
    waveIndex: number,
    failedTaskIds: readonly string[],
    causes: readonly unknown[],
    partialResults: ReadonlyMap<string, TResult>,
  ) {
    super(
      `executeWaves: wave ${waveIndex} had ${failedTaskIds.length} rejected task(s): ${failedTaskIds.join(", ")}`,
    );
    this.name = "WaveExecutionError";
    this.waveIndex = waveIndex;
    this.failedTaskIds = failedTaskIds;
    this.causes = causes;
    this.partialResults = partialResults;
  }
}

/**
 * Execute a {@link planWaves} plan: waves run STRICTLY in order (a later wave
 * may depend on an earlier one, per how `planWaves` already built `Wave[]`
 * from `ChildTask.dependsOn`); tasks WITHIN one wave run CONCURRENTLY via a
 * `Promise.allSettled`-backed dispatch, bounded by the wave's own size (a
 * wave is already `<= maxConcurrency` by construction — this executor adds no
 * separate cap of its own).
 *
 * Sibling isolation (the one case the spec left to the implementer): `run` is
 * documented not to throw for an ordinary child failure, but this executor
 * does not trust that. It dispatches every task in a wave via
 * `Promise.allSettled`, NOT `Promise.all` — every sibling's promise is
 * allowed to run to settlement (fulfilled or rejected) regardless of whether
 * another sibling in the SAME wave rejects, so one rejecting task can never
 * silently corrupt or abort its siblings. Once the whole wave has settled,
 * IF any task rejected, `executeWaves` throws a {@link WaveExecutionError}
 * aggregating every rejection in that wave and stops before starting the
 * next wave — a later wave's tasks may (per `planWaves`' own wave-ordering
 * contract) depend on this wave's tasks, so silently continuing forward on
 * top of a wave that did not fully succeed would be worse than failing
 * closed. This mirrors the fail-closed stance `planWaves` itself takes on a
 * budget/cycle denial: a partial, ambiguous result is never preferred over an
 * explicit failure.
 *
 * Pure aside from the injected `deps.run` boundary: no clock/RNG of its own,
 * no retry, no auto-recovery — see PRD R9, mechanical auto-retry on the
 * `SubagentCompletionStatus` values Phase D2 introduces is explicitly OUT of
 * scope for the harness and must not be added here or anywhere else keyed off
 * those values.
 */
export async function executeWaves<TTask extends { taskId: string }, TResult>(
  tasks: readonly TTask[],
  waves: readonly Wave[],
  deps: WaveExecutorDeps<TTask, TResult>,
): Promise<Map<string, TResult>> {
  const byTaskId = new Map<string, TTask>();
  for (const t of tasks) byTaskId.set(t.taskId, t);

  const results = new Map<string, TResult>();

  for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
    const wave = waves[waveIndex];
    if (wave === undefined) continue; // unreachable for a well-formed `waves` array; satisfies noUncheckedIndexedAccess

    const settled = await Promise.allSettled(
      wave.taskIds.map((taskId, i) => {
        const task = byTaskId.get(taskId);
        if (task === undefined) {
          return Promise.reject(
            new Error(`executeWaves: wave ${waveIndex} references unknown taskId "${taskId}" (not in \`tasks\`)`),
          );
        }
        const reservation = wave.reservations[i];
        if (reservation === undefined) {
          return Promise.reject(
            new Error(
              `executeWaves: wave ${waveIndex} taskIds/reservations length mismatch at index ${i} (malformed Wave)`,
            ),
          );
        }
        return deps.run(task, reservation);
      }),
    );

    const failedTaskIds: string[] = [];
    const causes: unknown[] = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const taskId = wave.taskIds[i];
      if (outcome === undefined || taskId === undefined) continue; // unreachable: settled is index-aligned with wave.taskIds
      if (outcome.status === "fulfilled") {
        results.set(taskId, outcome.value);
      } else {
        failedTaskIds.push(taskId);
        causes.push(outcome.reason);
      }
    }

    if (failedTaskIds.length > 0) {
      // `results` at this point already holds every fulfilled task from every
      // fully-succeeded EARLIER wave (accumulated across prior loop
      // iterations) plus every fulfilled SIBLING from THIS wave (the
      // `outcome.status === "fulfilled"` branch above runs before this
      // check) — exactly the partial-success set `WaveExecutionError`
      // documents. Snapshot it into a fresh `Map` so the thrown error owns
      // an immutable copy, not a live alias into this function's local.
      throw new WaveExecutionError(waveIndex, failedTaskIds, causes, new Map(results));
    }
  }

  return results;
}
