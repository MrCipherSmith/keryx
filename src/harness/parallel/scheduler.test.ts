// RED tests for PA-01 (flow 016, W13 / T5): bounded ready-set waves,
// aggregate reservations, cancellation, and loop detection.
//
// Pins the frozen spec (implementation-plan.md PA-01): "Add bounded
// ready-set waves, aggregate reservations, cancellation, and loop
// detection." Negatives: "budget/loop negatives." Evidence: "concurrency
// and budget ceilings are enforced."
//
// This file covers AC1/AC2/AC3/AC5 (`acceptance-criteria.md`, flow
// 016-2026-07-13-keryx-harness-w13-parallel-scheduling):
//   - AC1: bounded ready-set waves — every task's `dependsOn` are all
//     scheduled in a strictly earlier wave; no wave exceeds
//     `maxConcurrency`; wave membership/ordering is deterministic (stable
//     by taskId).
//   - AC2: aggregate budget ceiling (fail-closed) — the scheduler reserves
//     aggregate budget by folding the REUSED W12 `inheritBudget` across the
//     tasks against a decrementing `parentRemaining`; a task whose
//     reservation would breach the running remaining denies the whole plan
//     (`{ok:false}` with a typed reason), never a silent over-grant.
//   - AC3: cancellation + loop detection — a cancelled task AND its
//     transitive dependents are excluded from every wave; a dependency
//     cycle (tasks remain but the ready-set is empty) is detected and
//     denies the plan with NO partial/ambiguous wave emitted.
//   - AC5: determinism — identical inputs yield a deep-equal plan; no
//     `Date.now`/`Math.random`.
//
// PA-01 impl (next dispatch, T6) implements `src/harness/parallel/scheduler.ts`:
//   - `planWaves(tasks: ChildTask[], config: PlanWavesConfig, deps?:
//     PlanWavesDeps): PlanWavesResult` — a PURE, deterministic function.
//     `deps` is OPTIONAL: every `ChildTask` already carries its own
//     `taskId`, and every `budgetRequest` already carries its own
//     `reservationId` (both fixture-supplied), so `planWaves` needs no
//     injected id source to stay deterministic. `PlanWavesDeps.idSeq` is
//     pinned for forward-compatibility (e.g. a future need to synthesize
//     wave ids) but is NOT exercised by these tests — every call below
//     omits the third argument.
//   - The aggregate reservation composes (does NOT reimplement) the W12
//     `inheritBudget` from `../child/isolation`, folding it across tasks in
//     stable taskId order against a decrementing `parentRemaining` copy
//     (mirrors the caller-driven aggregate pattern documented in
//     `isolation.ts`'s `inheritBudget` doc comment and exercised in
//     `../child/isolation.test.ts`'s "aggregate of multiple child
//     reservations" test).
//
// Until `src/harness/parallel/scheduler.ts` exists, the missing-module
// import is the expected RED failure ("Cannot find module './scheduler'")
// — NOT a bug in this test file. Do NOT create scheduler.ts here (T6's
// job).
//
// Deterministic: all ids are fixture constants; no `Date.now()`,
// `Math.random()`, network, or real fs/async. The scheduler is a pure sync
// function.
import { describe, expect, test } from "bun:test";
import type { BudgetReservation } from "../child/isolation";

// PINNED API (see dispatch) — PA-01 impl (T6) exports these; imports fail
// until then (expected RED: "Cannot find module './scheduler'").
import { executeWaves, planWaves, WaveExecutionError } from "./scheduler";
import type { ChildTask, PlanWavesConfig, PlanWavesResult, Wave, WaveExecutorDeps } from "./scheduler";

// ---------------------------------------------------------------------------
// Deterministic fixtures.
// ---------------------------------------------------------------------------

function budget(reservationId: string, maxRuntimeMs: number): BudgetReservation {
  return { reservationId, maxRuntimeMs };
}

function task(taskId: string, dependsOn: string[], maxRuntimeMs: number, cancelled?: boolean): ChildTask {
  const base: ChildTask = {
    taskId,
    dependsOn,
    budgetRequest: budget(`res-${taskId}`, maxRuntimeMs),
  };
  return cancelled !== undefined ? { ...base, cancelled } : base;
}

/** Flattens every taskId scheduled across all waves, in wave/within-wave order. */
function flattenTaskIds(waves: readonly Wave[]): string[] {
  return waves.flatMap((wave) => wave.taskIds);
}

/** Returns the (0-based) wave index a taskId is scheduled in, or -1 if absent. */
function waveIndexOf(waves: readonly Wave[], taskId: string): number {
  return waves.findIndex((wave) => wave.taskIds.includes(taskId));
}

function expectOk(result: PlanWavesResult): asserts result is { ok: true; waves: Wave[] } {
  if (!result.ok) throw new Error(`expected ok:true, got ok:false (reason: ${result.reason})`);
}

function expectDenied(result: PlanWavesResult): asserts result is { ok: false; reason: string } {
  if (result.ok) throw new Error("expected ok:false, got ok:true");
}

// ============================================================================
// 1. Bounded ready-set waves (AC1)
// ============================================================================

describe("AC1 — planWaves: bounded ready-set waves respect maxConcurrency", () => {
  test("3 independent tasks with maxConcurrency:2 split into 2 waves (2 then 1), stable taskId order", () => {
    // Deliberately unsorted input order to prove the scheduler imposes a
    // stable taskId order, not insertion order.
    const tasks: ChildTask[] = [task("task-3", [], 10_000), task("task-1", [], 10_000), task("task-2", [], 10_000)];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectOk(result);
    expect(result.waves).toHaveLength(2);

    const wave0 = result.waves[0];
    const wave1 = result.waves[1];
    if (!wave0 || !wave1) throw new Error("expected exactly 2 waves");

    expect(wave0.taskIds).toEqual(["task-1", "task-2"]);
    expect(wave1.taskIds).toEqual(["task-3"]);

    // No wave exceeds maxConcurrency.
    for (const wave of result.waves) {
      expect(wave.taskIds.length).toBeLessThanOrEqual(config.maxConcurrency);
    }

    // Each wave's reservations correspond 1:1 (by reservationId) to its taskIds.
    expect(wave0.reservations.map((r) => r.reservationId)).toEqual(["res-task-1", "res-task-2"]);
    expect(wave1.reservations.map((r) => r.reservationId)).toEqual(["res-task-3"]);
  });

  test("a single wave is emitted when maxConcurrency is not exceeded", () => {
    const tasks: ChildTask[] = [task("only-1", [], 1_000), task("only-2", [], 1_000)];
    const config: PlanWavesConfig = { maxConcurrency: 5, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectOk(result);
    expect(result.waves).toHaveLength(1);
    const wave0 = result.waves[0];
    if (!wave0) throw new Error("expected exactly 1 wave");
    expect(wave0.taskIds).toEqual(["only-1", "only-2"]);
  });
});

// ============================================================================
// 2. Dependency ordering across waves (AC1)
// ============================================================================

describe("AC1 — planWaves: a task's deps are all scheduled in a strictly earlier wave", () => {
  test("A has no deps; B and C both dependOn A; maxConcurrency:2 → A in wave 1, B & C in wave 2", () => {
    const tasks: ChildTask[] = [task("A", [], 5_000), task("B", ["A"], 5_000), task("C", ["A"], 5_000)];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectOk(result);
    expect(result.waves).toHaveLength(2);

    const wave0 = result.waves[0];
    const wave1 = result.waves[1];
    if (!wave0 || !wave1) throw new Error("expected exactly 2 waves");

    expect(wave0.taskIds).toEqual(["A"]);
    expect(wave1.taskIds).toEqual(["B", "C"]);

    // B and C never appear in or before A's wave.
    const aIndex = waveIndexOf(result.waves, "A");
    const bIndex = waveIndexOf(result.waves, "B");
    const cIndex = waveIndexOf(result.waves, "C");
    expect(aIndex).toBe(0);
    expect(bIndex).toBeGreaterThan(aIndex);
    expect(cIndex).toBeGreaterThan(aIndex);
  });
});

// ============================================================================
// 3. Aggregate budget ceiling fail-closed (AC2, KEY negative)
// ============================================================================

describe("AC2 — planWaves: aggregate budget ceiling composed from inheritBudget, fail-closed", () => {
  test("individually-fitting requests whose SUM exceeds parentRemaining deny the plan (breaching task denied)", () => {
    // b-1, b-2, b-3 each request 40_000ms; parentRemaining is 100_000ms.
    // Folded in stable taskId order: b-1 (40_000, remaining -> 60_000),
    // b-2 (40_000, remaining -> 20_000), b-3 (40_000 > 20_000 remaining) ->
    // denied. Each individual request (40_000) fits under the ORIGINAL
    // 100_000 parentRemaining, so this is genuinely an aggregate breach,
    // not a per-task one.
    const tasks: ChildTask[] = [task("b-1", [], 40_000), task("b-2", [], 40_000), task("b-3", [], 40_000)];
    const config: PlanWavesConfig = { maxConcurrency: 3, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectDenied(result);
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.reason).toMatch(/budget|exceed/i);
    // Fail-closed: a denial is a denial, never a truncated/partial plan.
    expect("waves" in result).toBe(false);
  });

  test("a set whose Σ budgetRequest <= parentRemaining is granted; Σ granted reservations never exceeds parentRemaining", () => {
    const tasks: ChildTask[] = [task("p-1", [], 50_000), task("p-2", [], 50_000)];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectOk(result);
    const totalGrantedRuntimeMs = result.waves
      .flatMap((wave) => wave.reservations)
      .reduce((sum, reservation) => sum + reservation.maxRuntimeMs, 0);

    // A child (in aggregate) can NEVER be granted more than the parent had.
    expect(totalGrantedRuntimeMs).toBeLessThanOrEqual(config.parentRemaining.maxRuntimeMs);
    expect(totalGrantedRuntimeMs).toBe(100_000);
  });

  test("a single task requesting more than parentRemaining is denied (per-task breach, not just aggregate)", () => {
    const tasks: ChildTask[] = [task("solo", [], 200_000)];
    const config: PlanWavesConfig = { maxConcurrency: 1, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectDenied(result);
    expect(result.reason).toMatch(/budget|exceed/i);
  });
});

// ============================================================================
// 3b. Fail-closed tool-call cap composition (review-polish item H, flow 028/T5)
// ============================================================================
//
// `planWaves` folds `../child/isolation`'s `inheritBudget` across scheduled
// tasks (see the module header). Review item H (cap-less child under a capped
// parent) was DEFERRED, not implemented as a deny — `inheritBudget` is shared
// and a cap-less child legitimately means "0 tool-call sub-budget" (see the
// "H (deferred)" block in `../child/isolation.test.ts`). This test LOCKS the
// current, correct behavior: `planWaves` schedules a runtime-only (cap-less)
// task under a capped `parentRemaining`.
describe("H (deferred) — planWaves schedules a cap-less (0-tool-call) child under a capped parentRemaining", () => {
  test("a single cap-less task (budgetRequest omitting maxToolCalls) under a maxToolCalls-capped parentRemaining is scheduled (runtime-only child; tool-call bounding is a runtime concern)", () => {
    const tasks: ChildTask[] = [
      {
        taskId: "solo-no-cap",
        dependsOn: [],
        budgetRequest: { reservationId: "res-solo-no-cap", maxRuntimeMs: 10_000 },
      },
    ];
    const config: PlanWavesConfig = {
      maxConcurrency: 1,
      parentRemaining: { maxRuntimeMs: 100_000, maxToolCalls: 10 },
    };

    const result = planWaves(tasks, config);

    expectOk(result);
    expect(result.waves[0]?.taskIds).toEqual(["solo-no-cap"]);
  });
});

// ============================================================================
// 4. Cancellation (AC3)
// ============================================================================

describe("AC3 — planWaves: cancellation excludes the task AND its transitive dependents", () => {
  test("a cancelled task, its direct dependent, and its transitive (2-level) dependent are all excluded; independent tasks still schedule", () => {
    const tasks: ChildTask[] = [
      task("A", [], 1_000, true), // cancelled
      task("B", ["A"], 1_000), // depends directly on cancelled A
      task("D", ["B"], 1_000), // transitively depends on cancelled A via B
      task("C", [], 1_000), // independent, not cancelled
    ];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectOk(result);
    const scheduled = flattenTaskIds(result.waves);

    expect(scheduled).not.toContain("A");
    expect(scheduled).not.toContain("B");
    expect(scheduled).not.toContain("D");
    // The rest (C) still schedules.
    expect(scheduled).toContain("C");
    expect(scheduled).toEqual(["C"]);
  });

  test("cancellation of one branch does not block an unrelated ready task from being in the first wave", () => {
    const tasks: ChildTask[] = [task("X", [], 1_000, true), task("Y", [], 1_000)];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectOk(result);
    expect(result.waves).toHaveLength(1);
    const wave0 = result.waves[0];
    if (!wave0) throw new Error("expected exactly 1 wave");
    expect(wave0.taskIds).toEqual(["Y"]);
  });
});

// ============================================================================
// 5. Loop detection (AC3, KEY negative)
// ============================================================================

describe("AC3 — planWaves: dependency cycles are detected and deny the plan with no partial waves", () => {
  test("a 2-node cycle (X depends on Y, Y depends on X) is denied with a reason mentioning a cycle", () => {
    const tasks: ChildTask[] = [task("X", ["Y"], 1_000), task("Y", ["X"], 1_000)];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectDenied(result);
    expect(result.reason).toMatch(/cycle/i);
    // No partial/truncated wave plan is ever returned alongside a denial.
    expect("waves" in result).toBe(false);
  });

  test("a self-dependency (Z depends on itself) is denied with a reason mentioning a cycle", () => {
    const tasks: ChildTask[] = [task("Z", ["Z"], 1_000)];
    const config: PlanWavesConfig = { maxConcurrency: 1, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectDenied(result);
    expect(result.reason).toMatch(/cycle/i);
    expect("waves" in result).toBe(false);
  });

  test("a cycle among a subset of tasks denies the WHOLE plan, not just the cyclic subset", () => {
    // M is perfectly schedulable on its own, but N/O form a cycle. The
    // whole plan must fail closed — no partial wave containing only M.
    const tasks: ChildTask[] = [task("M", [], 1_000), task("N", ["O"], 1_000), task("O", ["N"], 1_000)];
    const config: PlanWavesConfig = { maxConcurrency: 3, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectDenied(result);
    expect(result.reason).toMatch(/cycle/i);
    expect("waves" in result).toBe(false);
  });
});

describe("AC1/AC5 — planWaves fails closed on a degenerate maxConcurrency (no infinite loop)", () => {
  test("maxConcurrency of 0 is denied (would otherwise never make progress)", () => {
    const tasks: ChildTask[] = [task("a", [], 1_000)];
    const config: PlanWavesConfig = { maxConcurrency: 0, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectDenied(result);
    expect(result.reason).toMatch(/maxConcurrency/i);
    expect("waves" in result).toBe(false);
  });

  test("a negative maxConcurrency is denied", () => {
    const tasks: ChildTask[] = [task("a", [], 1_000)];
    const config: PlanWavesConfig = { maxConcurrency: -1, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectDenied(result);
    expect(result.reason).toMatch(/maxConcurrency/i);
  });

  test("a non-integer maxConcurrency is denied", () => {
    const tasks: ChildTask[] = [task("a", [], 1_000)];
    const config: PlanWavesConfig = { maxConcurrency: 1.5, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planWaves(tasks, config);

    expectDenied(result);
    expect(result.reason).toMatch(/maxConcurrency/i);
  });
});

// ============================================================================
// 6. Determinism (AC5)
// ============================================================================

describe("AC5 — planWaves is pure and deterministic (no Date.now/Math.random)", () => {
  test("identical inputs (bounded-wave fixture) called twice yield a deep-equal plan", () => {
    const tasks: ChildTask[] = [task("task-3", [], 10_000), task("task-1", [], 10_000), task("task-2", [], 10_000)];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const first = planWaves(tasks, config);
    const second = planWaves(tasks, config);

    expect(first).toEqual(second);
  });

  test("identical inputs (dependency-ordering fixture) called twice yield a deep-equal plan", () => {
    const tasks: ChildTask[] = [task("A", [], 5_000), task("B", ["A"], 5_000), task("C", ["A"], 5_000)];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const first = planWaves(tasks, config);
    const second = planWaves(tasks, config);

    expect(first).toEqual(second);
  });

  test("identical inputs (denial fixture) called twice yield a deep-equal denial", () => {
    const tasks: ChildTask[] = [task("X", ["Y"], 1_000), task("Y", ["X"], 1_000)];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const first = planWaves(tasks, config);
    const second = planWaves(tasks, config);

    expect(first).toEqual(second);
  });
});

// --- flow 090 (AC3): ChildTask.modelRequest is carried, fold is model-agnostic
describe("planWaves — optional modelRequest is threaded, not interpreted", () => {
  const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000, maxToolCalls: 20 } };

  test("adding modelRequest to tasks does not change the wave plan", () => {
    const plain: ChildTask[] = [task("A", [], 1_000), task("B", ["A"], 1_000)];
    const withModel: ChildTask[] = [
      { ...task("A", [], 1_000), modelRequest: { kind: "tier", tier: "cheap" } },
      { ...task("B", ["A"], 1_000), modelRequest: { kind: "explicit", providerId: "ollama", modelId: "llama3" } },
    ];
    expect(planWaves(withModel, config)).toEqual(planWaves(plain, config));
  });

  test("a task carrying modelRequest still schedules successfully", () => {
    const tasks: ChildTask[] = [{ ...task("A", [], 1_000), modelRequest: { kind: "inherit" } }];
    const result = planWaves(tasks, config);
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// 7. executeWaves (flow 171, Phase D / D1a) — actually RUNNING a planWaves plan.
// ============================================================================
//
// Every test below is fully deterministic: no `Date.now`, no real
// `setTimeout` sleep. Concurrency and "wall-clock" timing are proven via
// manually-controlled deferred promises and a tiny injected fake clock
// (`FakeClock` below), never real elapsed time.

/** Flushes the microtask queue `n` times — enough hops for a chain of
 * `Promise.allSettled`/`await` continuations inside `executeWaves` to run,
 * without ever waiting on a real timer. */
async function flushMicrotasks(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

/**
 * A minimal deterministic fake clock for proving "wall-clock time bounded by
 * max(delay), not sum(delay)" WITHOUT any real timer. `wait(delayTicks)`
 * resolves only once `advance()` has been called `delayTicks` times after the
 * call to `wait` — the test drives `advance()` itself, so elapsed "time" is
 * just an integer the test fully controls.
 */
class FakeClock {
  private tick = 0;
  private pending: Array<{ at: number; resolve: () => void }> = [];

  wait(delayTicks: number): Promise<void> {
    const at = this.tick + delayTicks;
    return new Promise<void>((resolve) => {
      this.pending.push({ at, resolve });
    });
  }

  /** Advance the fake clock by one tick, resolving anything now due. */
  advance(): void {
    this.tick += 1;
    const due = this.pending.filter((p) => p.at <= this.tick);
    this.pending = this.pending.filter((p) => p.at > this.tick);
    for (const p of due) p.resolve();
  }

  get now(): number {
    return this.tick;
  }
}

describe("D1a — executeWaves: wave-order enforcement (later wave never starts before the earlier one settles)", () => {
  test("wave 1's task only starts after BOTH wave-0 siblings have been resolved (deferred promises, no real sleep)", async () => {
    const tasks: ChildTask[] = [
      task("a1", [], 1_000),
      task("a2", [], 1_000),
      task("b1", ["a1", "a2"], 1_000),
    ];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };
    const planned = planWaves(tasks, config);
    expectOk(planned);
    expect(planned.waves).toHaveLength(2);
    expect(planned.waves[0]?.taskIds).toEqual(["a1", "a2"]);
    expect(planned.waves[1]?.taskIds).toEqual(["b1"]);

    const events: string[] = [];
    const resolvers: Record<string, () => void> = {};
    const deps: WaveExecutorDeps<ChildTask, string> = {
      run: (t) =>
        new Promise<string>((resolve) => {
          events.push(`start:${t.taskId}`);
          resolvers[t.taskId] = () => resolve(t.taskId);
        }),
    };

    const execPromise = executeWaves(tasks, planned.waves, deps);

    // Both wave-0 siblings are dispatched SYNCHRONOUSLY (the `.map()` call
    // inside `executeWaves` invokes `deps.run` for every task in the wave
    // before the function's own first `await`) — proving genuine concurrent
    // dispatch, not a serial "await one, then start the next" loop. Wave 1's
    // task must NOT have started: it depends on wave 0, which has not
    // resolved yet.
    expect(events).toEqual(["start:a1", "start:a2"]);

    resolvers["a1"]?.();
    resolvers["a2"]?.();
    await flushMicrotasks();

    expect(events).toContain("start:b1");
    expect(events.indexOf("start:b1")).toBeGreaterThan(events.indexOf("start:a2"));

    resolvers["b1"]?.();
    const result = await execPromise;

    expect(result.get("a1")).toBe("a1");
    expect(result.get("a2")).toBe("a2");
    expect(result.get("b1")).toBe("b1");
  });
});

describe("AC9 — executeWaves: within-wave concurrency (fake-clock wall-time bounded by max(delay), not sum(delay))", () => {
  test("3 independent tasks with distinct injected delays (3, 7, 1 ticks) each complete at their OWN delay, and the whole wave needs only max(delay)=7 ticks, not sum(delay)=11", async () => {
    const clock = new FakeClock();
    const delays: Record<string, number> = { d1: 3, d2: 7, d3: 1 };
    const completedAt: Record<string, number> = {};

    const tasks: ChildTask[] = Object.keys(delays).map((id) => task(id, [], 1_000));
    const config: PlanWavesConfig = { maxConcurrency: 3, parentRemaining: { maxRuntimeMs: 100_000 } };
    const planned = planWaves(tasks, config);
    expectOk(planned);
    expect(planned.waves).toHaveLength(1); // fully independent tasks -> one wave

    const deps: WaveExecutorDeps<ChildTask, number> = {
      run: async (t) => {
        const delay = delays[t.taskId];
        if (delay === undefined) throw new Error(`no fixture delay for ${t.taskId}`);
        await clock.wait(delay);
        completedAt[t.taskId] = clock.now;
        return delay;
      },
    };

    const execPromise = executeWaves(tasks, planned.waves, deps);

    // Drive the fake clock forward tick by tick, exactly max(delays)=7 ticks.
    // If the executor ran tasks SEQUENTIALLY instead of concurrently, d1
    // would not resolve until tick 3, d2 not until tick 3+7=10, d3 not until
    // tick 10+1=11 (sum(delay)=11) — 7 ticks would leave the wave still
    // unsettled. Instead every task resolves at exactly its OWN delay value,
    // proving they were all dispatched together at tick 0.
    for (let i = 0; i < 7; i++) {
      await Promise.resolve();
      clock.advance();
      await Promise.resolve();
    }
    await flushMicrotasks();

    const result = await execPromise;

    expect(result.get("d1")).toBe(3);
    expect(result.get("d2")).toBe(7);
    expect(result.get("d3")).toBe(1);

    expect(completedAt["d1"]).toBe(3);
    expect(completedAt["d2"]).toBe(7);
    expect(completedAt["d3"]).toBe(1);

    // The whole wave finished within max(delays) = 7 ticks, well under
    // sum(delays) = 11 — the property AC1/AC9 requires.
    expect(clock.now).toBe(7);
  });
});

describe("D1a — executeWaves: sibling isolation on a rejecting run()", () => {
  test("one sibling's run() throwing does not abort or corrupt the other siblings dispatched in the SAME wave", async () => {
    const tasks: ChildTask[] = [task("ok-1", [], 1_000), task("boom", [], 1_000), task("ok-2", [], 1_000)];
    const config: PlanWavesConfig = { maxConcurrency: 3, parentRemaining: { maxRuntimeMs: 100_000 } };
    const planned = planWaves(tasks, config);
    expectOk(planned);
    expect(planned.waves).toHaveLength(1);

    const completed: string[] = [];
    const deps: WaveExecutorDeps<ChildTask, string> = {
      run: async (t) => {
        if (t.taskId === "boom") {
          throw new Error("boom failed");
        }
        // Yield once so `boom`'s rejection has every opportunity to reach
        // the executor FIRST. A `Promise.all`-based (rather than
        // `Promise.allSettled`-based) implementation would short-circuit the
        // whole wave the instant ANY promise rejects — this yield would then
        // catch that bug by giving the reject a head start over completion.
        await Promise.resolve();
        completed.push(t.taskId);
        return t.taskId;
      },
    };

    let caught: unknown;
    try {
      await executeWaves(tasks, planned.waves, deps);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(WaveExecutionError);
    const err = caught as WaveExecutionError<string>;
    expect(err.waveIndex).toBe(0);
    expect(err.failedTaskIds).toEqual(["boom"]);
    expect(err.causes).toHaveLength(1);
    expect((err.causes[0] as Error).message).toBe("boom failed");

    // The critical assertion: both non-rejecting siblings ran to completion
    // even though `boom` rejected in the same wave.
    expect(completed).toContain("ok-1");
    expect(completed).toContain("ok-2");

    // T9 (code-verifier fix): the SAME-wave siblings that fulfilled must be
    // recoverable from the thrown error's `partialResults` — a caller (e.g.
    // `runConcurrentSpawnBatch` in agent.ts) must be able to return their
    // REAL results instead of overwriting them with a generic wave-error
    // fallback just because `boom` rejected alongside them.
    expect(err.partialResults.size).toBe(2);
    expect(err.partialResults.get("ok-1")).toBe("ok-1");
    expect(err.partialResults.get("ok-2")).toBe("ok-2");
    expect(err.partialResults.has("boom")).toBe(false);
  });

  test("a rejection in an EARLIER wave stops a later wave from ever starting (fail-closed on partial success)", async () => {
    const tasks: ChildTask[] = [task("a1", [], 1_000), task("b1", ["a1"], 1_000)];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };
    const planned = planWaves(tasks, config);
    expectOk(planned);
    expect(planned.waves).toHaveLength(2);

    let b1Started = false;
    const deps: WaveExecutorDeps<ChildTask, string> = {
      run: async (t) => {
        if (t.taskId === "a1") throw new Error("a1 failed");
        b1Started = true;
        return t.taskId;
      },
    };

    let caught: unknown;
    try {
      await executeWaves(tasks, planned.waves, deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WaveExecutionError);
    expect(b1Started).toBe(false);
    // T9: `a1` is the ONLY task in wave 0, and it rejected, so wave 0 has no
    // fulfilled siblings and wave 1 (`b1`) never even started — the thrown
    // error's `partialResults` must be empty, not just missing an
    // assertion. A caller must be able to tell "nothing settled" apart from
    // "everything settled" purely from this map.
    const err = caught as WaveExecutionError<string>;
    expect(err.partialResults.size).toBe(0);
  });
});

describe("D1a — executeWaves: defensive checks on a malformed Wave (should be unreachable via planWaves output)", () => {
  test("a wave taskId with no matching entry in `tasks` fails that wave via WaveExecutionError, not a silent skip", async () => {
    const tasks: ChildTask[] = [task("known", [], 1_000)];
    const waves: Wave[] = [{ taskIds: ["known", "unknown"], reservations: [budget("res-known", 1_000), budget("res-unknown", 1_000)] }];

    const deps: WaveExecutorDeps<ChildTask, string> = {
      run: async (t) => t.taskId,
    };

    let caught: unknown;
    try {
      await executeWaves(tasks, waves, deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WaveExecutionError);
    expect((caught as WaveExecutionError).failedTaskIds).toEqual(["unknown"]);
  });
});
