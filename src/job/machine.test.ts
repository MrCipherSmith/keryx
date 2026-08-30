// Pure unit cover for the job state machine.
//
// The end-to-end suite in `job.e2e.test.ts` is the one that can see a missing
// writer; this file pins the rules the writer applies, where they can be
// asserted without a temp directory — the same division `src/flow/machine.test.ts`
// and `src/flow/review-gate.e2e.test.ts` keep. Nothing here reads or writes disk.

import { describe, expect, test } from "bun:test";
import {
  assertPhaseTransition,
  assertStepTransition,
  canTransitionPhase,
  canTransitionStep,
  evaluateJobGate,
  firstOpenStep,
  isTerminalStep,
  parseIntent,
  parseStepStatus,
  toStatusFlag,
} from "./machine";
import { defaultPlan } from "./plans";
import { STEP_STATUS_FLAGS, type JobStep } from "./types";

function step(id: string, status: JobStep["status"], conditional = false): JobStep {
  return { id, type: "t", agent: "a", status, ...(conditional ? { conditional } : {}) };
}

describe("step status spelling", () => {
  test("the CLI flag maps to the schema's persisted enum value", () => {
    // The schema enum is `in_progress`; the command surface is `in-progress`.
    // Getting this backwards writes a value the schema rejects, so it is pinned
    // in both directions rather than re-derived at each call site.
    expect(parseStepStatus("in-progress")).toBe("in_progress");
    expect(toStatusFlag("in_progress")).toBe("in-progress");
  });

  test("every flag round-trips", () => {
    for (const flag of STEP_STATUS_FLAGS) {
      expect(toStatusFlag(parseStepStatus(flag))).toBe(flag);
    }
  });

  test("refuses the underscored spelling, and anything else, naming the valid values", () => {
    for (const bad of ["in_progress", "done", "", undefined]) {
      expect(() => parseStepStatus(bad)).toThrow(/Expected one of: pending, in-progress/);
    }
  });
});

describe("parseIntent", () => {
  test("defaults to implement and refuses anything outside the schema enum", () => {
    expect(parseIntent(undefined)).toBe("implement");
    expect(parseIntent("review")).toBe("review");
    expect(() => parseIntent("refactor")).toThrow(
      /Invalid --intent "refactor"\. Expected one of: implement, analyze, review, custom/,
    );
  });
});

describe("step transitions", () => {
  test("the retry edges are open", () => {
    expect(canTransitionStep("failed", "in_progress")).toBe(true);
    expect(canTransitionStep("completed", "in_progress")).toBe(true);
    expect(canTransitionStep("in_progress", "in_progress")).toBe(true);
  });

  test("a completed step cannot silently become pending again", () => {
    expect(canTransitionStep("completed", "pending")).toBe(false);
    expect(() => assertStepTransition("review", "completed", "pending")).toThrow(
      /Invalid --status for step "review": completed -> pending/,
    );
  });

  test("the refusal names the allowed values in CLI spelling", () => {
    expect(() => assertStepTransition("x", "completed", "failed")).toThrow(
      /Allowed from completed: in-progress/,
    );
  });
});

describe("terminality", () => {
  test("completed and skipped are terminal; failed is not", () => {
    expect(isTerminalStep("completed")).toBe(true);
    expect(isTerminalStep("skipped")).toBe(true);
    expect(isTerminalStep("failed")).toBe(false);
    expect(isTerminalStep("in_progress")).toBe(false);
    expect(isTerminalStep("pending")).toBe(false);
  });

  test("firstOpenStep answers in plan order and answers null when nothing is open", () => {
    const steps = [step("a", "completed"), step("b", "failed"), step("c", "pending")];
    expect(firstOpenStep(steps)?.id).toBe("b");
    expect(firstOpenStep([step("a", "completed"), step("b", "skipped")])).toBeNull();
  });
});

describe("completion gate", () => {
  test("passes only when every step is completed or skipped", () => {
    expect(evaluateJobGate([step("a", "completed"), step("b", "skipped")]).passed).toBe(true);
  });

  test("a conditional step is NOT exempt — it must be explicitly skipped", () => {
    const verdict = evaluateJobGate([step("a", "completed"), step("b", "pending", true)]);
    expect(verdict.passed).toBe(false);
    expect(verdict.open).toEqual(["b"]);
  });

  test("open and failed steps are reported in separate buckets", () => {
    const verdict = evaluateJobGate([
      step("a", "completed"),
      step("b", "failed"),
      step("c", "in_progress"),
    ]);
    expect(verdict).toMatchObject({ passed: false, open: ["c"], failed: ["b"], total: 3 });
  });
});

describe("phase transitions", () => {
  test("the documented path is the only path", () => {
    expect(canTransitionPhase("PLAN", "EXECUTION")).toBe(true);
    expect(canTransitionPhase("EXECUTION", "COMPLETION")).toBe(true);
    expect(canTransitionPhase("EXECUTION", "EXECUTION")).toBe(true);
    expect(canTransitionPhase("PLAN", "COMPLETION")).toBe(false);
    expect(canTransitionPhase("COMPLETION", "EXECUTION")).toBe(false);
  });

  test("an illegal move names what is allowed", () => {
    expect(() => assertPhaseTransition("PLAN", "COMPLETION")).toThrow(
      /Invalid job phase transition: PLAN -> COMPLETION\. Allowed from PLAN: PLAN, EXECUTION/,
    );
  });
});

describe("default plans", () => {
  test("every step carries the four fields the schema requires", () => {
    for (const intent of ["implement", "analyze", "review", "custom"] as const) {
      for (const planStep of defaultPlan(intent)) {
        expect(planStep.id.length).toBeGreaterThan(0);
        expect(planStep.type.length).toBeGreaterThan(0);
        expect(planStep.agent.length).toBeGreaterThan(0);
        expect(planStep.status).toBe("pending");
      }
    }
  });

  test("step ids are unique within a plan", () => {
    for (const intent of ["implement", "analyze", "review", "custom"] as const) {
      const ids = defaultPlan(intent).map((planStep) => planStep.id);
      expect(ids.length).toBe(new Set(ids).size);
    }
  });

  test("every `depends` names a step in the same plan", () => {
    for (const intent of ["implement", "analyze", "review", "custom"] as const) {
      const plan = defaultPlan(intent);
      const ids = new Set(plan.map((planStep) => planStep.id));
      for (const planStep of plan) {
        for (const dependency of planStep.depends ?? []) {
          expect(ids.has(dependency)).toBe(true);
        }
      }
    }
  });

  test("a plan is a fresh array each call — no shared mutable state between jobs", () => {
    const first = defaultPlan("review");
    first[0]!.status = "completed";
    expect(defaultPlan("review")[0]?.status).toBe("pending");
  });
});
