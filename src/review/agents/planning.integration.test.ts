import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReviewPlan, createReviewRuntimePlanRegistration, type ReviewPlanInput } from "./planning";
import {
  ReviewAgentController,
  createLargeReviewConfig,
  type ReviewAgentAdapter,
  type ReviewAgentEntityPolicyResolver,
} from "./index";

const roots: string[] = [];
afterAll(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-review-agents-plan-integration-"));
  roots.push(root);
  return root;
}

function input(planVersion: number): ReviewPlanInput {
  return {
    revision: "abc123",
    planVersion,
    areas: [{ id: "checkout", title: "Checkout", requiredAspects: ["logic"], ownerAssignmentId: "checkout-general" }],
    boundaries: [],
    assignments: [
      {
        id: "checkout-general",
        agentInstanceId: "general-instance",
        kind: "coordinator",
        entity: "review-coordinator",
        areaIds: ["checkout"],
        scopeIds: ["slice-checkout"],
        coverage: [],
      },
      {
        id: "planned-logic-leaf",
        agentInstanceId: "leaf-template",
        kind: "worker",
        entity: "review-worker",
        parentAssignmentId: "checkout-general",
        areaIds: ["checkout"],
        scopeIds: ["slice-checkout"],
        coverage: [{ areaId: "checkout", scopeId: "slice-checkout", aspect: "logic" }],
      },
    ],
  };
}

const policies: ReviewAgentEntityPolicyResolver = {
  resolve: async (entity) => ({
    "review-coordinator": { name: entity, role: "coordinator" as const, allowedSkills: [], allowedChildren: ["review-worker"] },
    "review-worker": { name: entity, role: "worker" as const, allowedSkills: ["review-logic"], allowedChildren: [] },
  })[entity],
};

test("registered plan bounds dynamic general children and invalidates their old coverage after supersession", async () => {
  let dynamicDispatchId: string | undefined;
  const adapter: ReviewAgentAdapter = {
    id: "fake",
    capabilities: { readOnlyEnforced: true, resultPersistence: true, cancellation: true, hierarchy: true },
    execute: async (request, context) => {
      if (request.role === "coordinator") {
        const child = await context.spawnChild({
          taskId: "dynamic-logic-leaf",
          attempt: 1,
          entity: "review-worker",
          role: "worker",
          adapterId: "fake",
          skillRef: "review-logic",
          scopeIds: ["slice-checkout"],
        });
        dynamicDispatchId = child.dispatchId;
        return { content: { child: child.dispatchId } };
      }
      return { content: { evidenceIds: ["logic-check-1"] } };
    },
  };
  const controller = await ReviewAgentController.create({
    storageDir: await tempRoot(),
    ownerId: "plan-owner",
    runId: "plan-run",
    revision: "abc123",
    config: createLargeReviewConfig({
      allowedAdapters: ["fake"],
      allowedEntities: ["review-coordinator", "review-worker"],
      allowedSkills: ["review-logic"],
    }),
    adapters: [adapter],
    authority: { authorize: async () => true },
    entityPolicies: policies,
  });
  const plan1 = createReviewRuntimePlanRegistration(createReviewPlan(input(1)), [
    { waveId: "review-round-1", reviewRound: 1, assignmentIds: ["checkout-general"] },
  ]);
  await controller.registerPlan(plan1);

  const general = await controller.spawn({
    taskId: "checkout-general",
    attempt: 1,
    entity: "review-coordinator",
    role: "coordinator",
    adapterId: "fake",
    scopeIds: ["slice-checkout"],
  });
  expect(general.ok).toBe(true);
  if (!general.ok) return;
  const generalResult = await controller.wait(general.dispatchId);
  if (generalResult.status !== "completed") throw new Error(generalResult.error ?? generalResult.status);
  expect(generalResult.status).toBe("completed");
  expect(dynamicDispatchId).toBeDefined();
  if (dynamicDispatchId === undefined) return;
  const leaf = await controller.wait(dynamicDispatchId);
  expect(leaf.status).toBe("completed");
  expect(leaf.resultId).toBeDefined();
  if (leaf.resultId === undefined) return;
  expect(await controller.recordCoverage({
    scopeId: "slice-checkout",
    aspect: "logic",
    dispatchId: dynamicDispatchId,
    status: "result",
    resultId: leaf.resultId,
    evidence: ["logic-check-1"],
  })).toBe(true);

  const plan2 = createReviewRuntimePlanRegistration(createReviewPlan(input(2)), [
    { waveId: "review-round-2", reviewRound: 2, assignmentIds: ["checkout-general"] },
  ]);
  await controller.registerPlan(plan2);
  expect(await controller.recordCoverage({
    scopeId: "slice-checkout",
    aspect: "logic",
    dispatchId: dynamicDispatchId,
    status: "result",
    resultId: leaf.resultId,
    evidence: ["logic-check-1"],
  })).toBe(false);
  expect(await controller.coverage()).toEqual([]);
});

