// AFC-06 (flow 234): the canonical freshness classifier. Normative source:
// docs/requirements/keryx-agent-first-core/policies.md, "Lifecycle и
// freshness". Six input classes, each covered on the memory surface here;
// `src/wiki/provenance.test.ts` covers the same six on the wiki surface
// through the same `computeLifecycle` function (imported from this module).

import { describe, expect, test } from "bun:test";
import { computeLifecycle, type LifecycleInput } from "./lifecycle";

const NOW = new Date("2026-06-15T00:00:00.000Z");

function accepted(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  return { status: "accepted", ...overrides };
}

describe("computeLifecycle — date boundary (AC1 class 1)", () => {
  test("validFrom == observedAt is current (lower bound inclusive)", () => {
    const result = computeLifecycle(accepted({ validFrom: "2026-06-15" }), NOW);
    expect(result).toMatchObject({ state: "current", current: true, historical: false });
  });

  test("validTo == observedAt is NOT current (upper bound exclusive)", () => {
    const result = computeLifecycle(accepted({ validFrom: "2026-01-01", validTo: "2026-06-15" }), NOW);
    expect(result.current).toBe(false);
    expect(result.historical).toBe(true);
    expect(result.state).toBe("expired");
  });

  test("one day before validTo is still current", () => {
    const result = computeLifecycle(accepted({ validFrom: "2026-01-01", validTo: "2026-06-16" }), NOW);
    expect(result).toMatchObject({ state: "current", current: true });
  });

  test("missing validFrom/validTo means an absent bound, not a failure", () => {
    const result = computeLifecycle(accepted(), NOW);
    expect(result).toMatchObject({ state: "current", current: true, historical: false, reasons: [] });
  });
});

describe("computeLifecycle — future (AC1 class 2)", () => {
  test("validFrom later than observedAt is not current", () => {
    const result = computeLifecycle(accepted({ validFrom: "2026-07-01" }), NOW);
    expect(result.current).toBe(false);
    expect(result.historical).toBe(true);
    expect(result.state).toBe("future");
    expect(result.reasons).toContain("not-yet-valid");
  });
});

describe("computeLifecycle — deprecated (AC1 class 3)", () => {
  test("status=deprecated is never current, regardless of dates", () => {
    const result = computeLifecycle({ status: "deprecated", validFrom: "2020-01-01" }, NOW);
    expect(result).toMatchObject({ state: "deprecated", current: false, historical: true });
  });
});

describe("computeLifecycle — conflict (AC1 class 4)", () => {
  test("status=conflict is never current", () => {
    const result = computeLifecycle({ status: "conflict" }, NOW);
    expect(result).toMatchObject({ state: "conflict", current: false, historical: true });
  });

  test("a broken supersession chain (pointer resolves to nothing) is conflict, not current or superseded", () => {
    const lookup = () => undefined;
    const result = computeLifecycle(accepted({ supersededBy: "decisions/ghost.md" }), NOW, lookup);
    expect(result).toMatchObject({ state: "conflict", current: false, historical: true });
    expect(result.reasons).toContain("broken-supersession-chain");
  });

  test("a cyclic supersession chain is conflict, not current or superseded", () => {
    const lookup = (pointer: string): LifecycleInput | undefined => {
      if (pointer === "a") return accepted({ supersededBy: "b" });
      if (pointer === "b") return accepted({ supersededBy: "a" });
      return undefined;
    };
    const result = computeLifecycle(accepted({ supersededBy: "a" }), NOW, lookup);
    expect(result).toMatchObject({ state: "conflict", current: false, historical: true });
    expect(result.reasons).toContain("cyclic-supersession-chain");
  });

  test("a supersededBy pointer to an ineffective (future) replacement is conflict, not superseded", () => {
    const lookup = (pointer: string): LifecycleInput | undefined =>
      pointer === "replacement" ? accepted({ validFrom: "2099-01-01" }) : undefined;
    const result = computeLifecycle(accepted({ supersededBy: "replacement" }), NOW, lookup);
    expect(result).toMatchObject({ state: "conflict", current: false, historical: true });
    expect(result.reasons).toContain("superseding-item-not-effective");
  });
});

describe("computeLifecycle — superseded (AC1 class 5)", () => {
  test("status=superseded is never current", () => {
    const result = computeLifecycle({ status: "superseded" }, NOW);
    expect(result).toMatchObject({ state: "superseded", current: false, historical: true });
  });

  test("an accepted entry with a supersededBy pointer and no lookup is superseded", () => {
    const result = computeLifecycle(accepted({ supersededBy: "decisions/newer.md" }), NOW);
    expect(result).toMatchObject({ state: "superseded", current: false, historical: true });
  });

  test("a supersededBy pointer to a currently-effective replacement is cleanly superseded", () => {
    const lookup = (pointer: string): LifecycleInput | undefined =>
      pointer === "replacement" ? accepted() : undefined;
    const result = computeLifecycle(accepted({ supersededBy: "replacement" }), NOW, lookup);
    expect(result).toMatchObject({ state: "superseded", current: false, historical: true });
  });
});

describe("computeLifecycle — malformed date (AC1 class 6)", () => {
  test("a malformed validFrom yields an invalid lifecycle, not a silently-current one", () => {
    const result = computeLifecycle(accepted({ validFrom: "not-a-date" }), NOW);
    expect(result).toMatchObject({ state: "invalid", current: false, historical: true });
    expect(result.reasons).toContain("malformed-valid-from");
  });

  test("an ambiguous/impossible calendar date (Feb 30) yields an invalid lifecycle", () => {
    const result = computeLifecycle(accepted({ validTo: "2026-02-30" }), NOW);
    expect(result).toMatchObject({ state: "invalid", current: false, historical: true });
    expect(result.reasons).toContain("malformed-valid-to");
  });

  test("malformed date takes priority over a would-be-disqualifying status", () => {
    const result = computeLifecycle({ status: "deprecated", validFrom: "13/32/2026" }, NOW);
    expect(result.state).toBe("invalid");
    expect(result.reasons).toContain("malformed-valid-from");
  });
});

describe("computeLifecycle — status handling shared by all classes", () => {
  test("a missing status never becomes accepted", () => {
    const result = computeLifecycle({ status: null }, NOW);
    expect(result).toMatchObject({ state: "unknown", current: false, historical: true });
  });

  test("an unrecognized status never becomes accepted", () => {
    const result = computeLifecycle({ status: "archived" }, NOW);
    expect(result).toMatchObject({ state: "unknown", current: false, historical: true });
  });

  test("draft is historical and not current", () => {
    const result = computeLifecycle({ status: "draft" }, NOW);
    expect(result).toMatchObject({ state: "draft", current: false, historical: true });
  });

  test("historical is exactly the complement of current for every state (AC1 requirement 3)", () => {
    const cases: LifecycleInput[] = [
      accepted(),
      accepted({ validFrom: "2099-01-01" }),
      { status: "draft" },
      { status: "deprecated" },
      { status: "conflict" },
      { status: "superseded" },
      { status: "bogus" },
      accepted({ validFrom: "nope" }),
    ];
    for (const input of cases) {
      const result = computeLifecycle(input, NOW);
      expect(result.historical).toBe(result.state !== "current");
      expect(result.current).toBe(result.state === "current");
    }
  });
});
