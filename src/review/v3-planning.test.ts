import { describe, expect, test } from "bun:test";
import {
  ReviewPlanError,
  assertPlanRevision,
  canValidateFinding,
  createReviewPlan,
  createReviewRuntimePlanRegistration,
  evaluateReviewPlan,
  type ReviewPlanInput,
} from "./v3-planning";

function completeInput(): ReviewPlanInput {
  return {
    revision: "abc123",
    planVersion: 1,
    areas: [
      { id: "checkout", title: "Checkout behavior", requiredAspects: ["logic", "security"], ownerAssignmentId: "general-checkout" },
      { id: "notifications", title: "Notifications", requiredAspects: ["logic"], ownerAssignmentId: "direct-worker" },
    ],
    boundaries: [
      { id: "checkout-notifications", areaIds: ["checkout", "notifications"], ownerAssignmentId: "boundary-worker" },
    ],
    assignments: [
      {
        id: "general-checkout",
        agentInstanceId: "agent-general-1",
        kind: "coordinator",
        entity: "review-coordinator",
        areaIds: ["checkout"],
        scopeIds: ["slice-checkout"],
        coverage: [],
      },
      {
        id: "logic-worker",
        agentInstanceId: "agent-worker-1",
        kind: "worker",
        entity: "review-worker",
        parentAssignmentId: "general-checkout",
        areaIds: ["checkout"],
        scopeIds: ["slice-checkout"],
        coverage: [{ areaId: "checkout", scopeId: "slice-checkout", aspect: "logic" }],
      },
      {
        id: "security-worker",
        agentInstanceId: "agent-worker-2",
        kind: "worker",
        entity: "review-worker",
        parentAssignmentId: "general-checkout",
        areaIds: ["checkout"],
        scopeIds: ["slice-checkout"],
        coverage: [{ areaId: "checkout", scopeId: "slice-checkout", aspect: "security" }],
      },
      {
        id: "direct-worker",
        agentInstanceId: "agent-worker-3",
        kind: "worker",
        entity: "review-worker",
        areaIds: ["notifications"],
        scopeIds: ["slice-notifications"],
        coverage: [{ areaId: "notifications", scopeId: "slice-notifications", aspect: "logic" }],
      },
      {
        id: "boundary-worker",
        agentInstanceId: "agent-worker-boundary",
        kind: "worker",
        entity: "review-worker",
        areaIds: ["checkout", "notifications"],
        scopeIds: ["slice-checkout", "slice-notifications"],
        coverage: [],
      },
      {
        id: "validator",
        agentInstanceId: "agent-validator-1",
        kind: "validator",
        entity: "review-validator",
        areaIds: [],
        scopeIds: [],
        coverage: [],
      },
    ],
  };
}

describe("review V3 coverage planning", () => {
  test("builds a revision-bound immutable snapshot instead of retaining caller-owned arrays", () => {
    const input = completeInput();
    const plan = createReviewPlan(input);

    input.areas[0]!.title = "mutated after creation";
    input.assignments[1]!.coverage.push({ areaId: "checkout", scopeId: "slice-checkout", aspect: "security" });

    expect(plan.revision).toBe("abc123");
    expect(plan.areas[0]!.title).toBe("Checkout behavior");
    expect(plan.assignments[1]!.coverage).toEqual([{ areaId: "checkout", scopeId: "slice-checkout", aspect: "logic" }]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.areas)).toBe(true);
    expect(Object.isFrozen(plan.areas[0])).toBe(true);
    expect(Object.isFrozen(plan.assignments[1]!.coverage)).toBe(true);
  });

  test("requires explicit area/aspect coverage and accepts direct root workers", () => {
    const input = completeInput();
    input.assignments = input.assignments.filter((assignment) => assignment.id !== "security-worker");
    const incomplete = evaluateReviewPlan(createReviewPlan(input));

    expect(incomplete.ready).toBe(false);
    expect(incomplete.uncovered).toEqual([{ areaId: "checkout", aspect: "security" }]);

    input.assignments.push({
      id: "direct-security-worker",
      agentInstanceId: "agent-worker-4",
      kind: "worker",
      entity: "review-worker",
      areaIds: ["checkout"],
      scopeIds: ["slice-checkout"],
      coverage: [{ areaId: "checkout", scopeId: "slice-checkout", aspect: "security" }],
    });
    const complete = evaluateReviewPlan(createReviewPlan(input));

    expect(complete.ready).toBe(true);
    expect(complete.uncovered).toEqual([]);
  });

  test("reports missing behavioral-area and cross-area boundary owners", () => {
    const input = completeInput();
    delete input.areas[0]!.ownerAssignmentId;
    delete input.boundaries[0]!.ownerAssignmentId;

    const evaluation = evaluateReviewPlan(createReviewPlan(input));

    expect(evaluation.ready).toBe(false);
    expect(evaluation.unownedAreaIds).toEqual(["checkout"]);
    expect(evaluation.unownedBoundaryIds).toEqual(["checkout-notifications"]);
  });

  test("rejects malformed ownership, coverage and hierarchy references before dispatch", () => {
    const input = completeInput();
    input.assignments[1]!.parentAssignmentId = "direct-worker";
    input.assignments[1]!.coverage = [{ areaId: "checkout", scopeId: "slice-checkout", aspect: "invented" }];
    input.areas[0]!.ownerAssignmentId = "missing-assignment";

    expect(() => createReviewPlan(input)).toThrow(ReviewPlanError);
    try {
      createReviewPlan(input);
    } catch (error) {
      expect((error as ReviewPlanError).issues).toEqual(expect.arrayContaining([
        expect.stringContaining("missing-assignment"),
        expect.stringContaining("parent direct-worker is not a coordinator"),
        expect.stringContaining("unknown aspect invented"),
      ]));
    }
  });

  test("builds a deterministic runtime registration with bounded coordinator delegation", () => {
    const plan = createReviewPlan(completeInput());
    const waves = [
      { waveId: "review-a", reviewRound: 1, assignmentIds: ["general-checkout"] },
      { waveId: "review-b", reviewRound: 1, assignmentIds: ["direct-worker", "boundary-worker", "validator"] },
    ];

    const registration = createReviewRuntimePlanRegistration(plan, waves);
    expect(registration).toEqual(createReviewRuntimePlanRegistration(plan, waves));
    expect(registration.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(registration).toMatchObject({ revision: "abc123", planVersion: 1 });
    expect(registration.assignments.find(({ taskId }) => taskId === "logic-worker")).toEqual({
      taskId: "logic-worker",
      parentTaskId: "general-checkout",
      entity: "review-worker",
      role: "worker",
      scopeIds: ["slice-checkout"],
      waveId: "review-a",
      coverage: [{ scopeId: "slice-checkout", aspect: "logic" }],
    });
    expect(registration.assignments.find(({ taskId }) => taskId === "general-checkout")).toMatchObject({
      waveId: "review-a",
      allowDynamicChildren: true,
      delegatedCoverage: [
        { scopeId: "slice-checkout", aspect: "logic" },
        { scopeId: "slice-checkout", aspect: "security" },
      ],
    });
    expect(Object.isFrozen(registration)).toBe(true);
  });

  test("rejects registration gaps and coverage outside an assignment scope", () => {
    const plan = createReviewPlan(completeInput());
    expect(() => createReviewRuntimePlanRegistration(plan, [
      { waveId: "only", reviewRound: 1, assignmentIds: ["general-checkout", "direct-worker", "validator"] },
    ])).toThrow(/boundary-worker.*wave/);

    const outsideScope = completeInput();
    outsideScope.assignments[1]!.coverage[0]!.scopeId = "slice-notifications";
    expect(() => createReviewPlan(outsideScope)).toThrow(/scope.*outside/i);

    const emptyScope = completeInput();
    emptyScope.assignments[0]!.scopeIds = [];
    expect(() => createReviewPlan(emptyScope)).toThrow(/requires at least one scope/i);
  });

  test("changes the plan hash when the approved wave mapping changes", () => {
    const plan = createReviewPlan(completeInput());
    const roots = plan.assignments.filter(({ parentAssignmentId }) => parentAssignmentId === undefined).map(({ id }) => id);
    const first = createReviewRuntimePlanRegistration(plan, [
      { waveId: "wave-a", reviewRound: 1, assignmentIds: roots },
    ]);
    const second = createReviewRuntimePlanRegistration(plan, [
      { waveId: "wave-b", reviewRound: 2, assignmentIds: roots },
    ]);

    expect(first.planHash).not.toBe(second.planHash);
  });

  test("invalidates the plan when the reviewed revision changes", () => {
    const plan = createReviewPlan(completeInput());

    expect(assertPlanRevision(plan, "abc123")).toEqual({ ok: true });
    expect(assertPlanRevision(plan, "def456")).toEqual({
      ok: false,
      reason: "stale_revision",
      plannedRevision: "abc123",
      actualRevision: "def456",
    });
  });

  test("allows only an independent validator instance to validate a finding", () => {
    const input = completeInput();
    input.assignments.push({
      id: "self-validator",
      agentInstanceId: "agent-worker-1",
      kind: "validator",
      entity: "review-validator",
      areaIds: [],
      scopeIds: [],
      coverage: [],
    });
    const plan = createReviewPlan(input);

    expect(canValidateFinding(plan, "validator", "logic-worker")).toEqual({ ok: true });
    expect(canValidateFinding(plan, "self-validator", "logic-worker")).toEqual({
      ok: false,
      reason: "same_agent_instance",
    });
    expect(canValidateFinding(plan, "logic-worker", "security-worker")).toEqual({
      ok: false,
      reason: "assignment_is_not_validator",
    });
    expect(canValidateFinding(plan, "validator", "validator")).toEqual({
      ok: false,
      reason: "same_assignment",
    });
  });
});
