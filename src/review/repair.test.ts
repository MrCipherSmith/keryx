// The repair fills in typing and refuses judgement.

import { describe, expect, test } from "bun:test";
import { repairMechanicalOmissions } from "./repair";

describe("what it fills in", () => {
  test("an absent id is minted from the finding's position", () => {
    const findings = [{ problem: "a" }, { problem: "b" }, { problem: "c" }];
    const repairs = repairMechanicalOmissions(findings as never);
    expect(findings.map((f) => (f as { id?: string }).id)).toEqual(["F-001", "F-002", "F-003"]);
    expect(repairs).toHaveLength(3);
    expect(repairs[0]).toEqual({ finding: "F-001", field: "id", source: "position 1 in the report" });
  });

  test("a minted id never collides with one the report already used", () => {
    const findings = [{ id: "F-001", problem: "a" }, { problem: "b" }];
    repairMechanicalOmissions(findings as never);
    expect((findings[1] as { id?: string }).id).toBe("F-002");
  });

  test("and skips past a taken number rather than overwriting it", () => {
    // Position 1 would mint F-001, which the second finding already holds.
    const findings = [{ problem: "a" }, { id: "F-001", problem: "b" }];
    repairMechanicalOmissions(findings as never);
    expect((findings[0] as { id?: string }).id).toBe("F-002");
    expect((findings[1] as { id?: string }).id).toBe("F-001");
  });

  test("an absent problem is taken from the finding's own title", () => {
    const findings = [{ id: "F-001", title: "the guard drops a real phone number" }];
    const repairs = repairMechanicalOmissions(findings as never);
    expect((findings[0] as { problem?: string }).problem).toBe("the guard drops a real phone number");
    expect(repairs).toEqual([{ finding: "F-001", field: "problem", source: "the finding's own title" }]);
  });

  test("a blank string counts as absent — an empty id is not an id", () => {
    const findings = [{ id: "   ", problem: "  ", title: "something" }];
    repairMechanicalOmissions(findings as never);
    expect((findings[0] as { id?: string }).id).toBe("F-001");
    expect((findings[0] as { problem?: string }).problem).toBe("something");
  });
});

describe("what it leaves alone", () => {
  test("a finding that has everything is untouched and reports no repair", () => {
    const findings = [{ id: "F-042", problem: "stated", title: "different" }];
    expect(repairMechanicalOmissions(findings as never)).toEqual([]);
    expect(findings[0]).toEqual({ id: "F-042", problem: "stated", title: "different" });
  });

  test("no title means no problem is invented", () => {
    // The reviewer never stated the defect, so the refusal downstream is right.
    const findings = [{ id: "F-001", impact: "bad" }];
    repairMechanicalOmissions(findings as never);
    expect((findings[0] as { problem?: string }).problem).toBeUndefined();
  });

  test("AC4 — class_scope, evidence and disposition are never filled in", () => {
    const findings = [{ severity: "blocker", title: "t" }];
    repairMechanicalOmissions(findings as never);
    const repaired = findings[0] as Record<string, unknown>;
    expect(repaired["class_scope"]).toBeUndefined();
    expect(repaired["evidence"]).toBeUndefined();
    expect(repaired["disposition"]).toBeUndefined();
    expect(repaired["impact"]).toBeUndefined();
    expect(repaired["suggested_fix"]).toBeUndefined();
    expect(repaired["confidence"]).toBeUndefined();
  });
});

describe("the acceptance check", () => {
  test("AC4 — a repair that wrote anything outside id and problem is refused", () => {
    // Simulates the widening this guard exists to catch: the array is mutated
    // behind the repair's back, exactly as a future edit to repair.ts would.
    const findings = [{ id: "F-001", problem: "stated" }] as Array<Record<string, unknown>>;
    const sneaky = new Proxy(findings, {
      get(target, prop, receiver) {
        if (prop === "entries") {
          return function* entries(): Generator<[number, Record<string, unknown>]> {
            const finding = target[0] as Record<string, unknown>;
            finding["class_scope"] = { sites: ["invented"], enumeration_method: "none" };
            yield [0, finding];
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(() => repairMechanicalOmissions(sneaky as never)).toThrow(/class_scope/);
  });

  test("a repair that changed the number of findings is refused", () => {
    const findings = [{ id: "F-001", problem: "stated" }] as Array<Record<string, unknown>>;
    const growing = new Proxy(findings, {
      get(target, prop, receiver) {
        if (prop === "entries") {
          return function* entries(): Generator<[number, Record<string, unknown>]> {
            target.push({ id: "F-002", problem: "appeared from nowhere" });
            yield [0, target[0] as Record<string, unknown>];
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(() => repairMechanicalOmissions(growing as never)).toThrow(/number of findings/);
  });
});
