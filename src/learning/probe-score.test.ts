import { describe, expect, test } from "bun:test";
import { wilsonInterval } from "../metrics/benchmark";
import { newcombeInterval, scoreProbe, verdictForDelta, type ProbeArmCounts, type ProbeScoreInput } from "./probe-score";

function arm(seeds = 10, successes = 5): ProbeArmCounts {
  return { seeds, successes, answered: seeds, failed: 0, tokens: 100, toolCalls: 4 };
}
function input(overrides: Partial<ProbeScoreInput> = {}): ProbeScoreInput {
  return { taskKind: "stochastic", seeds: 10, goldClean: true, environmentMatches: true,
    budgetExceeded: false, arms: { base: arm(), probe: arm() }, ...overrides };
}
describe("AC10 Wilson/Newcombe", () => {
  test("reuses Wilson arm intervals", () => {
    const result = scoreProbe(input());
    const expected = wilsonInterval(5, 10);
    expect(result.arms.base?.ci[0]).toBe(expected?.lower);
    expect(result.arms.base?.ci[1]).toBe(expected?.upper);
    expect(result.arms.probe?.ci[0]).toBe(expected?.lower);
    expect(result.arms.probe?.ci[1]).toBe(expected?.upper);
  });
  test("numeric oracle for 2/10 vs 8/10", () => {
    const delta = newcombeInterval({ seeds: 10, successes: 2 }, { seeds: 10, successes: 8 });
    expect(delta?.rate).toBeCloseTo(0.6, 12);
    expect(delta?.ci[0]).toBeCloseTo(1.61823565e-01, 7);
    expect(delta?.ci[1]).toBeCloseTo(8.02682045e-01, 7);
  });
  test("zero/all successes: finite ordered bounds; arm swap symmetry", () => {
    for (const n of [1, 3, 10, 10000]) for (const b of [0, n]) for (const p of [0, n]) {
      const result = scoreProbe(input({ taskKind: "deterministic", seeds: n, arms: { base: arm(n, b), probe: arm(n, p) } }));
      const reversed = newcombeInterval({ seeds: n, successes: p }, { seeds: n, successes: b });
      for (const value of [result.arms.base, result.arms.probe, result.delta]) {
        expect(value).not.toBeNull();
        expect(Number.isFinite(value?.ci[0])).toBe(true);
        expect(Number.isFinite(value?.ci[1])).toBe(true);
        expect(value?.ci[0]).toBeGreaterThanOrEqual(-1);
        expect(value?.ci[1]).toBeLessThanOrEqual(1);
        expect(value?.ci[0]).toBeLessThanOrEqual(value?.ci[1] ?? NaN);
      }
      expect(result.delta?.ci[0]).toBeCloseTo(-(reversed?.ci[1] ?? NaN), 12);
      expect(result.delta?.ci[1]).toBeCloseTo(-(reversed?.ci[0] ?? NaN), 12);
    }
  });
  test.each([0, -1, 0.5, NaN, Infinity])("invalid denominator %s has no interval", (seeds) => {
    expect(newcombeInterval({ seeds, successes: 0 }, { seeds: 3, successes: 1 })).toBeNull();
  });
  test.each([-1, 4, 0.5, NaN, Infinity])("invalid successes %s have no interval", (successes) => {
    expect(newcombeInterval({ seeds: 3, successes }, { seeds: 3, successes: 1 })).toBeNull();
  });
});
describe("AC10 verdict boundaries", () => {
  test.each([[0, 10, "improved"], [10, 0, "regressed"], [5, 5, "indistinguishable"], [5, 6, "indistinguishable"]] as const)("%s vs %s -> %s", (b, p, verdict) => {
    expect(scoreProbe(input({ arms: { base: arm(10, b), probe: arm(10, p) } })).verdict).toBe(verdict);
  });
  test.each([[[0, 0.5], "indistinguishable"], [[-0.5, 0], "indistinguishable"], [[0, 0], "indistinguishable"], [[-0.5, 0.5], "indistinguishable"], [[Number.EPSILON, 1], "improved"], [[-1, -Number.EPSILON], "regressed"]] as const)("CI %s -> %s", (ci, verdict) => {
    expect(verdictForDelta(ci)).toBe(verdict);
  });
  test("deterministic one allowed; stochastic two underpowered, three allowed", () => {
    expect(scoreProbe(input({ taskKind: "deterministic", seeds: 1, arms: { base: arm(1, 0), probe: arm(1, 1) } })).verdict).toBe("indistinguishable");
    expect(scoreProbe(input({ seeds: 2 })).reason).toBe("underpowered");
    expect(scoreProbe(input({ seeds: 3, arms: { base: arm(3, 0), probe: arm(3, 3) } })).verdict).toBe("improved");
    expect(scoreProbe(input({ taskKind: "deterministic", seeds: 0 })).reason).toBe("underpowered");
  });
});
describe("AC10 exact six-reason precedence", () => {
  const reasons = ["no-task", "underpowered", "gold-leak", "environment-drift", "budget-exceeded", "run-failed"] as const;
  for (let mask = 0; mask < 64; mask++) test(`competing reasons ${mask}`, () => {
    const flags = reasons.map((_, i) => Boolean(mask & (1 << i)));
    const result = scoreProbe(input({ taskKind: flags[0] ? null : "stochastic", seeds: flags[1] ? 2 : 10,
      goldClean: !flags[2], environmentMatches: !flags[3], budgetExceeded: flags[4] ?? false,
      arms: { base: arm(), probe: { ...arm(), failed: flags[5] ? 1 : 0 } } }));
    const reason = reasons.find((_, i) => flags[i]);
    if (reason) expect(result).toEqual({ verdict: "unmeasurable", reason, arms: { base: null, probe: null }, delta: null });
    else { expect(result.verdict).toBe("indistinguishable"); expect(result.reason).toBeUndefined(); }
  });
  test.each(["base", "probe"] as const)("failed/unanswered/truncated/invalid %s arm", (which) => {
    for (const overrides of [{ failed: 1 }, { answered: 9 }, { seeds: 9 }, { successes: 11 }]) {
      const fixture = input(); fixture.arms[which] = { ...arm(), ...overrides };
      expect(scoreProbe(fixture).reason).toBe("run-failed");
      expect(scoreProbe({ ...fixture, budgetExceeded: true }).reason).toBe("budget-exceeded");
    }
  });
});
describe("AC10 pure counts and telemetry", () => {
  test("telemetry never decides verdict; deltas are probe minus base; input unchanged", () => {
    const fixture = input({ arms: { base: { ...arm(10, 0), tokens: 0, toolCalls: 100000 }, probe: { ...arm(10, 10), tokens: 1000000, toolCalls: 0 } } });
    const original = structuredClone(fixture);
    Object.freeze(fixture.arms.base); Object.freeze(fixture.arms.probe); Object.freeze(fixture.arms); Object.freeze(fixture);
    const result = scoreProbe(fixture);
    expect(result.verdict).toBe("improved"); expect(result.delta?.tokens).toBe(1000000); expect(result.delta?.toolCalls).toBe(-100000);
    expect(scoreProbe(fixture)).toEqual(result); expect(fixture).toEqual(original);
    expect(result.delta?.ci).toEqual(scoreProbe(input({ arms: { base: arm(10, 0), probe: arm(10, 10) } })).delta?.ci);
  });
  test("unknown telemetry is omitted rather than fabricated zero", () => {
    const bare = { seeds: 10, successes: 5, answered: 10, failed: 0 };
    const result = scoreProbe(input({ arms: { base: bare, probe: { ...bare, tokens: 50 } } }));
    expect(result.arms.base).not.toHaveProperty("tokens"); expect(result.arms.probe?.tokens).toBe(50);
    expect(result.delta).not.toHaveProperty("tokens"); expect(result.delta).not.toHaveProperty("toolCalls");
  });
});
