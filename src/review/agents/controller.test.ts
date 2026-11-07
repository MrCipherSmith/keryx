import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReviewAgentController, createLargeReviewConfig, validateReviewAgentConfig, type ReviewAgentAdapter, type ReviewAgentAdapterContext, type ReviewAgentAdapterRequest } from "./index";

const roots: string[] = [];
setDefaultTimeout(30_000);
afterAll(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function tempRoot(): Promise<string> { const value = await mkdtemp(path.join(tmpdir(), "keryx-review-agents-")); roots.push(value); return value; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((settle) => { resolve = settle; }); return { promise, resolve }; }
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) { if (Date.now() >= deadline) throw new Error("condition timed out"); await Bun.sleep(10); }
}
function rawAdapter(execute: (request: ReviewAgentAdapterRequest, context: ReviewAgentAdapterContext) => Promise<unknown>): ReviewAgentAdapter {
  return { id: "fake", capabilities: { readOnlyEnforced: true, resultPersistence: true, cancellation: true, hierarchy: true }, execute: async (request, context) => ({ content: await execute(request, context) }), cancel: async () => undefined };
}
function adapter(execute: (request: ReviewAgentAdapterRequest, context: ReviewAgentAdapterContext) => Promise<unknown>): ReviewAgentAdapter {
  return rawAdapter(async (request, context) => ({ ...reviewResult(), summary: JSON.stringify(await execute(request, context)) }));
}
function reviewResult() {
  return { reviewer: "review-worker", status: "DONE", summary: "Reviewed", findings: [], stats: { blocker: 0, major: 0, minor: 0, info: 0 } };
}

for (const [name, content] of Object.entries({
  null: null,
  missingFieldsInText: '```REVIEW_RESULT\n{"status":"DONE"}\n```',
  invalidFindingsInText: JSON.stringify({ ...reviewResult(), findings: [{ severity: "critical" }] }),
  invalidStatsInText: JSON.stringify({ ...reviewResult(), stats: {} }),
  unclosedFence: "```REVIEW_RESULT\n" + JSON.stringify(reviewResult()),
  prose: "Everything looks fine",
  malformed: '```REVIEW_RESULT\n{"status":\n```',
  missingFields: { status: "DONE" },
  invalidStatus: { ...reviewResult(), status: "SUCCESS" },
  invalidFindings: { ...reviewResult(), findings: [{ id: "F1", severity: "critical" }] },
  invalidStats: { ...reviewResult(), stats: { blocker: -1, major: 0, minor: 0, info: 0 } },
})) {
  test(`invalid REVIEW_RESULT (${name}) fails without persisting a result`, async () => {
    const runtime = await controller({ adapter: rawAdapter(async () => content) });
    const admitted = await runtime.spawn({ taskId: "invalid", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
    if (!admitted.ok) throw new Error("admission failed");
    const result = await runtime.wait(admitted.dispatchId);
    expect(result.status).toBe("failed");
    expect(result.resultId).toBeUndefined();
    expect(result.error).toContain("invalid_review_result");
    expect(await runtime.result(admitted.dispatchId)).toBeUndefined();
  });
}

async function controller(options: { adapter: ReviewAgentAdapter; maxConcurrency?: number; maxLaunches?: number; maxDepth?: number; cancelCleanupTimeoutMs?: number; authorize?: (operation: string) => boolean | Promise<boolean>; clock?: () => Date }): Promise<ReviewAgentController> {
  return ReviewAgentController.create({ storageDir: await tempRoot(), ownerId: "test-owner", runId: "run-1", revision: "deadbeef", config: createLargeReviewConfig({ allowedAdapters: ["fake"], allowedSkills: ["review-logic"], runCeilings: { initialConcurrency: options.maxConcurrency ?? 12, maxActiveDescendants: options.maxConcurrency ?? 32, maxLaunches: options.maxLaunches ?? 512, maxDepth: options.maxDepth ?? 2 } }), adapters: [options.adapter], authority: { authorize: async ({ operation }) => options.authorize?.(operation) ?? true }, entityPolicies: testEntityPolicies, ...(options.cancelCleanupTimeoutMs === undefined ? {} : { cancelCleanupTimeoutMs: options.cancelCleanupTimeoutMs }), ...(options.clock === undefined ? {} : { clock: options.clock }) });
}

const testEntityPolicies = { resolve: async (entity: string) => ({
  "review-coordinator": { name: entity, role: "coordinator" as const, allowedSkills: [], allowedChildren: ["review-worker", "review-scout", "review-validator"] },
  "review-worker": { name: entity, role: "worker" as const, allowedSkills: ["review-logic"], allowedChildren: [] },
  "review-scout": { name: entity, role: "scout" as const, allowedSkills: [], allowedChildren: [] },
  "review-validator": { name: entity, role: "validator" as const, allowedSkills: ["review-verifier"], allowedChildren: [] },
}[entity]) };

test("independent assignments overlap under the controller concurrency ceiling", async () => {
  const started: string[] = []; const gates = new Map<string, ReturnType<typeof deferred<unknown>>>();
  const runtime = await controller({ maxConcurrency: 2, adapter: adapter(async (request) => { started.push(request.dispatchId); const gate = deferred<unknown>(); gates.set(request.dispatchId, gate); return gate.promise; }) });
  const first = await runtime.spawn({ taskId: "one", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  const second = await runtime.spawn({ taskId: "two", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  expect(first.ok && second.ok).toBe(true); await waitUntil(() => started.length === 2); expect(started).toHaveLength(2);
  for (const gate of gates.values()) gate.resolve("done");
  if (first.ok && second.ok) await Promise.all([runtime.wait(first.dispatchId), runtime.wait(second.dispatchId)]);
});

test("a coordinator releases its execution slot while its child runs", async () => {
  const trace: string[] = [];
  const runtime = await controller({ maxConcurrency: 1, adapter: adapter(async (request, context) => {
    if (request.role === "coordinator") { trace.push("general:start"); const [child] = await context.spawnChildren([{ taskId: "leaf", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: ["scope"] }]); trace.push(`general:${child?.status}`); return "general done"; }
    trace.push("leaf:run"); return "leaf done";
  }) });
  const admitted = await runtime.spawn({ taskId: "general", attempt: 1, entity: "review-coordinator", role: "coordinator", adapterId: "fake", scopeIds: ["scope"] });
  expect(admitted.ok).toBe(true); if (admitted.ok) expect((await runtime.wait(admitted.dispatchId)).status).toBe("completed");
  expect(trace).toEqual(["general:start", "leaf:run", "general:completed"]);
});

test("idempotency survives reopening and launch counts do not reset", async () => {
  let calls = 0; const fake = adapter(async () => { calls += 1; return "done"; }); const storageDir = await tempRoot();
  const deps = { storageDir, ownerId: "resume-owner", runId: "resume", revision: "abc", config: createLargeReviewConfig({ allowedAdapters: ["fake"], runCeilings: { maxLaunches: 1 } }), adapters: [fake], authority: { authorize: async () => true }, entityPolicies: testEntityPolicies };
  const firstController = await ReviewAgentController.create(deps);
  const first = await firstController.spawn({ taskId: "same", attempt: 1, idempotencyKey: "fixed", entity: "review-worker", role: "worker", adapterId: "fake" });
  expect(first.ok).toBe(true); if (first.ok) await firstController.wait(first.dispatchId);
  const reopened = await ReviewAgentController.open({ storageDir, ownerId: "resume-owner", adapters: [fake], authority: deps.authority, entityPolicies: testEntityPolicies });
  const duplicate = await reopened.spawn({ taskId: "same", attempt: 1, idempotencyKey: "fixed", entity: "review-worker", role: "worker", adapterId: "fake" });
  expect(duplicate).toMatchObject({ ok: true, reused: true });
  expect(await reopened.spawn({ taskId: "new", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" })).toMatchObject({ ok: false, code: "launch_limit" });
  expect(calls).toBe(1);
});

test("authority denial is enforced before an adapter starts", async () => {
  let calls = 0;
  const runtime = await controller({ authorize: (operation) => operation !== "spawn", adapter: adapter(async () => { calls += 1; return "unexpected"; }) });
  expect(await runtime.spawn({ taskId: "denied", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" })).toMatchObject({ ok: false, code: "authority_denied" });
  expect(calls).toBe(0);
});

test("unsupported adapters fail before useful work", async () => {
  let calls = 0;
  const weak: ReviewAgentAdapter = { id: "weak", capabilities: { readOnlyEnforced: false, resultPersistence: true, cancellation: false, hierarchy: false }, execute: async () => { calls += 1; return { content: "unexpected" }; } };
  const runtime = await ReviewAgentController.create({ storageDir: await tempRoot(), ownerId: "weak-owner", runId: "unsupported", revision: "abc", config: createLargeReviewConfig({ allowedAdapters: ["weak"] }), adapters: [weak], authority: { authorize: async () => true }, entityPolicies: testEntityPolicies });
  expect(await runtime.spawn({ taskId: "x", attempt: 1, entity: "review-worker", role: "worker", adapterId: "weak" })).toMatchObject({ ok: false, code: "adapter_unsupported" }); expect(calls).toBe(0);
});

test("measured-cost is fail-closed until pre-spend enforcement exists", async () => {
  await expect(ReviewAgentController.create({ storageDir: await tempRoot(), ownerId: "cost-owner", runId: "cost", revision: "abc", config: createLargeReviewConfig({ allowedAdapters: ["fake"], costMode: "measured-cost", spendingCeiling: { amount: 3, currency: "USD" } }), adapters: [adapter(async () => "unused")], authority: { authorize: async () => true }, entityPolicies: testEntityPolicies }))
    .rejects.toThrow("pre-spend admission ledger");
});

test("cancelling a coordinator cancels descendants and rejects a late result", async () => {
  const leafStarted = deferred<void>(); const late = deferred<unknown>();
  const runtime = await controller({ maxConcurrency: 2, adapter: adapter(async (request, context) => {
    if (request.role === "coordinator") { await context.spawnChildren([{ taskId: "leaf", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: ["scope"] }]); return "general late"; }
    leafStarted.resolve(); return late.promise;
  }) });
  const root = await runtime.spawn({ taskId: "general", attempt: 1, entity: "review-coordinator", role: "coordinator", adapterId: "fake", scopeIds: ["scope"] });
  expect(root.ok).toBe(true); await leafStarted.promise; if (!root.ok) return;
  await runtime.cancel(root.dispatchId, "operator stopped subtree"); late.resolve("too late");
  expect((await runtime.wait(root.dispatchId)).status).toBe("cancelled");
  const state = await runtime.status();
  if (state === undefined || "dispatchId" in state) throw new Error("run state unavailable");
  expect(Object.values(state.assignments).every((assignment) => assignment.status === "cancelled")).toBe(true);
});

test("full result IDs remain distinct for two executions of the same skill", async () => {
  const runtime = await controller({ adapter: adapter(async (request) => ({ evidence: request.scopeIds })) });
  const a = await runtime.spawn({ taskId: "a", attempt: 1, entity: "review-worker", role: "worker", skillRef: "review-logic", scopeIds: ["slice-a"], adapterId: "fake" });
  const b = await runtime.spawn({ taskId: "b", attempt: 1, entity: "review-worker", role: "worker", skillRef: "review-logic", scopeIds: ["slice-b"], adapterId: "fake" });
  if (!a.ok || !b.ok) throw new Error("admission failed");
  const [ar, br] = await Promise.all([runtime.wait(a.dispatchId), runtime.wait(b.dispatchId)]);
  expect(ar.resultId).toBeDefined(); expect(br.resultId).toBeDefined(); expect(ar.resultId).not.toBe(br.resultId);
  if (ar.resultId === undefined) throw new Error("result missing");
  expect((await runtime.result(a.dispatchId))?.content).toEqual({ ...reviewResult(), summary: JSON.stringify({ evidence: ["slice-a"] }) });
  expect((await runtime.result(b.dispatchId))?.content).toEqual({ ...reviewResult(), summary: JSON.stringify({ evidence: ["slice-b"] }) });
  expect(await runtime.recordCoverage({ scopeId: "slice-a", aspect: "logic", dispatchId: a.dispatchId, status: "result" })).toBe(false);
  expect(await runtime.recordCoverage({ scopeId: "made-up", aspect: "logic", dispatchId: a.dispatchId, status: "result", resultId: ar.resultId, evidence: ["x"] })).toBe(false);
  expect(await runtime.recordCoverage({ scopeId: "slice-a", aspect: "logic", dispatchId: a.dispatchId, status: "result", resultId: ar.resultId, evidence: ["finding-1"] })).toBe(true);
});

test("idempotency is parent-scoped and immutable within a parent", async () => {
  const childAdmissions: Array<{ first: unknown; mismatch: unknown }> = [];
  const runtime = await controller({ maxConcurrency: 4, adapter: adapter(async (request, context) => {
    if (request.role !== "coordinator") return request.taskId;
    const first = await context.controller.spawn({ taskId: "leaf-a", attempt: 1, idempotencyKey: "shared", entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: ["scope"] });
    const mismatch = await context.controller.spawn({ taskId: "leaf-b", attempt: 1, idempotencyKey: "shared", entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: ["scope"] });
    childAdmissions.push({ first, mismatch });
    if (first.ok) await context.controller.wait(first.dispatchId);
    return first.ok ? first.dispatchId : "refused";
  }) });
  const a = await runtime.spawn({ taskId: "general-a", attempt: 1, entity: "review-coordinator", role: "coordinator", adapterId: "fake", scopeIds: ["scope"] });
  if (!a.ok) throw new Error("coordinator admission failed");
  const ar = await runtime.wait(a.dispatchId);
  const b = await runtime.spawn({ taskId: "general-b", attempt: 1, entity: "review-coordinator", role: "coordinator", adapterId: "fake", scopeIds: ["scope"] });
  if (!b.ok) throw new Error("coordinator admission failed");
  const br = await runtime.wait(b.dispatchId);
  const aContent = (await runtime.result(ar.dispatchId))?.content;
  const bContent = (await runtime.result(br.dispatchId))?.content;
  expect(aContent).not.toBe(bContent);
  expect(childAdmissions).toHaveLength(2);
  expect(childAdmissions.every(({ mismatch }) => typeof mismatch === "object" && mismatch !== null && "ok" in mismatch && mismatch.ok === false && "code" in mismatch && mismatch.code === "invalid_input")).toBe(true);
});

test("failed process cancellation remains unresolved until the adapter settles", async () => {
  const gate = deferred<unknown>();
  const brokenCancel: ReviewAgentAdapter = {
    id: "fake",
    capabilities: { readOnlyEnforced: true, resultPersistence: true, cancellation: true, hierarchy: true },
    execute: async () => ({ content: await gate.promise }),
    cancel: async () => { throw new Error("kill failed"); },
  };
  const runtime = await controller({ adapter: brokenCancel });
  const admitted = await runtime.spawn({ taskId: "stubborn", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  if (!admitted.ok) throw new Error("admission failed");
  await waitUntil(async () => (await runtime.status(admitted.dispatchId))?.status === "running");
  await runtime.cancel(admitted.dispatchId, "operator cancelled");
  const unresolved = await runtime.status(admitted.dispatchId);
  expect(unresolved && "dispatchId" in unresolved ? unresolved.status : undefined).toBe("unresolved");
  const state = await runtime.status();
  if (state === undefined || "dispatchId" in state) throw new Error("run state unavailable");
  expect(state.reservedAgentTimeMs).toBeGreaterThan(0);
  gate.resolve("late");
  expect((await runtime.wait(admitted.dispatchId)).status).toBe("cancelled");
});

test("controller enforces the requested runtime even when an adapter ignores abort", async () => {
  const gate = deferred<unknown>(); let observedAbort = false;
  const runtime = await controller({ adapter: adapter(async (request) => {
    request.signal.addEventListener("abort", () => { observedAbort = true; }, { once: true });
    return gate.promise;
  }) });
  const admitted = await runtime.spawn({ taskId: "deadline", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake", maxRuntimeMs: 25 });
  if (!admitted.ok) throw new Error("admission failed");
  await waitUntil(async () => (await runtime.status(admitted.dispatchId))?.status === "cancelled");
  expect(observedAbort).toBe(true);
  gate.resolve("late");
  expect((await runtime.wait(admitted.dispatchId)).status).toBe("cancelled");
});

test("mutable reopen reconciles orphaned work before pumping durable queued assignments", async () => {
  const firstGate = deferred<unknown>(); const firstStarted = deferred<void>(); const calls: string[] = [];
  const fake: ReviewAgentAdapter = {
    id: "fake", capabilities: { readOnlyEnforced: true, resultPersistence: true, cancellation: true, hierarchy: true },
    execute: async (request) => {
      calls.push(request.taskId);
      if (request.taskId === "first") { firstStarted.resolve(); return { content: await firstGate.promise }; }
      return { content: reviewResult() };
    },
    cancel: async () => undefined,
    reconcile: async () => "cancelled",
  };
  const storageDir = await tempRoot();
  const config = createLargeReviewConfig({ allowedAdapters: ["fake"], runCeilings: { initialConcurrency: 1 } });
  const deps = { storageDir, ownerId: "recover-owner", runId: "recover", revision: "abc", config, adapters: [fake], authority: { authorize: async () => true }, entityPolicies: testEntityPolicies };
  const original = await ReviewAgentController.create(deps);
  const first = await original.spawn({ taskId: "first", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  if (!first.ok) throw new Error("first admission failed");
  await firstStarted.promise;
  const second = await original.spawn({ taskId: "second", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  if (!second.ok) throw new Error("second admission failed");
  expect((await original.status(second.dispatchId))?.status).toBe("queued");
  const reopened = await ReviewAgentController.open({ storageDir, ownerId: "recover-owner", adapters: [fake], authority: deps.authority, entityPolicies: testEntityPolicies });
  expect((await reopened.wait(second.dispatchId)).status).toBe("completed");
  expect(calls).toEqual(["first", "second"]);
  firstGate.resolve("late"); await original.close(); await reopened.close();
});

test("recovery keeps unknown processes unresolved, reserved, and occupying concurrency", async () => {
  const gate = deferred<unknown>(); let reconciles = 0; const calls: string[] = [];
  const fake: ReviewAgentAdapter = {
    id: "fake", capabilities: { readOnlyEnforced: true, resultPersistence: true, cancellation: true, hierarchy: true },
    execute: async (request) => { calls.push(request.taskId); return { content: await gate.promise }; },
    cancel: async () => { throw new Error("kill failed"); },
    reconcile: async () => { reconciles += 1; return "unknown"; },
  };
  const storageDir = await tempRoot();
  const config = createLargeReviewConfig({ allowedAdapters: ["fake"], runCeilings: { initialConcurrency: 1 } });
  const deps = { storageDir, ownerId: "unresolved-owner", runId: "unresolved", revision: "abc", config, adapters: [fake], authority: { authorize: async () => true }, entityPolicies: testEntityPolicies };
  const original = await ReviewAgentController.create(deps);
  const first = await original.spawn({ taskId: "first", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake", maxRuntimeMs: 10_000 });
  if (!first.ok) throw new Error("first admission failed");
  await waitUntil(async () => (await original.status(first.dispatchId))?.status === "running");
  await original.cancel(first.dispatchId, "stop");
  const second = await original.spawn({ taskId: "second", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  if (!second.ok) throw new Error("second admission failed");
  const reopened = await ReviewAgentController.open({ storageDir, ownerId: "unresolved-owner", adapters: [fake], authority: deps.authority, entityPolicies: testEntityPolicies });
  const state = await reopened.status();
  if (state === undefined || "dispatchId" in state) throw new Error("run state unavailable");
  expect(reconciles).toBe(1);
  expect(state.assignments[first.dispatchId]?.status).toBe("unresolved");
  expect(state.assignments[second.dispatchId]?.status).toBe("queued");
  expect(state.reservedAgentTimeMs).toBeGreaterThan(0);
  expect(calls).toEqual(["first"]);
  gate.resolve("late"); await original.close(); await reopened.close();
});

test("coordinator elapsed deadline continues while scoped waitChildren releases active time", async () => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const runtime = await controller({ maxConcurrency: 2, adapter: adapter(async (request, context) => {
    if (request.role !== "coordinator") { nowMs += 5_001; return "child"; }
    const child = await context.controller.spawn({ taskId: "leaf", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: ["scope"] });
    if (!child.ok) throw new Error("child refused");
    await context.controller.waitChildren([child.dispatchId]);
    return "coordinator";
  }), clock: () => new Date(nowMs) });
  const admitted = await runtime.spawn({ taskId: "general", attempt: 1, entity: "review-coordinator", role: "coordinator", adapterId: "fake", scopeIds: ["scope"], maxRuntimeMs: 5_000 });
  if (!admitted.ok) throw new Error("coordinator admission failed");
  expect((await runtime.wait(admitted.dispatchId)).status).toBe("cancelled");
});

test("config validation rejects malformed role ceilings and allowlists", () => {
  const invalidRole = structuredClone(createLargeReviewConfig());
  (invalidRole.roleCeilings.worker as { elapsedMs: number }).elapsedMs = -1;
  expect(() => validateReviewAgentConfig(invalidRole)).toThrow("roleCeilings.worker.elapsedMs");
  const invalidAllowlist = structuredClone(createLargeReviewConfig()) as unknown as { allowedAdapters: unknown };
  invalidAllowlist.allowedAdapters = "fake";
  expect(() => validateReviewAgentConfig(invalidAllowlist as never)).toThrow("allowedAdapters");
});

test("never-settling adapter cancellation returns after bounded cleanup as unresolved", async () => {
  const never = new Promise<never>(() => undefined);
  const fake: ReviewAgentAdapter = {
    id: "fake", capabilities: { readOnlyEnforced: true, resultPersistence: true, cancellation: true, hierarchy: true },
    execute: async () => never,
    cancel: async () => never,
  };
  const runtime = await controller({ adapter: fake, cancelCleanupTimeoutMs: 25 });
  const admitted = await runtime.spawn({ taskId: "never", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  if (!admitted.ok) throw new Error("admission failed");
  await waitUntil(async () => (await runtime.status(admitted.dispatchId))?.status === "running");
  await runtime.cancel(admitted.dispatchId, "stop");
  const current = await runtime.status(admitted.dispatchId);
  expect(current && "dispatchId" in current ? current.status : undefined).toBe("unresolved");
  await runtime.close();
});

test("global elapsed deadline blocks queued assignments instead of starting them late", async () => {
  const firstGate = deferred<unknown>(); const calls: string[] = []; let currentMs = 0;
  const fake = adapter(async (request) => { calls.push(request.taskId); if (request.taskId === "first") return firstGate.promise; return "late"; });
  const runtime = await ReviewAgentController.create({
    storageDir: await tempRoot(), ownerId: "deadline-owner", runId: "deadline-run", revision: "abc",
    config: createLargeReviewConfig({ allowedAdapters: ["fake"], runCeilings: { initialConcurrency: 1, elapsedDeadlineMs: 10_000 } }),
    adapters: [fake], authority: { authorize: async () => true }, entityPolicies: testEntityPolicies, clock: () => new Date(currentMs),
  });
  const first = await runtime.spawn({ taskId: "first", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  const second = await runtime.spawn({ taskId: "second", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  if (!first.ok || !second.ok) throw new Error("admission failed");
  currentMs = 20_000; firstGate.resolve("done");
  expect((await runtime.wait(first.dispatchId)).status).toBe("completed");
  await waitUntil(async () => (await runtime.status(second.dispatchId))?.status === "blocked");
  expect((await runtime.status(second.dispatchId))?.status).toBe("blocked");
  expect(calls).toEqual(["first"]);
  await runtime.close();
});

test("recovered running processes still require adapter stop confirmation", async () => {
  const never = new Promise<never>(() => undefined); let cancels = 0;
  const fake: ReviewAgentAdapter = {
    id: "fake", capabilities: { readOnlyEnforced: true, resultPersistence: true, cancellation: true, hierarchy: true },
    execute: async () => never,
    cancel: async () => { cancels += 1; },
    reconcile: async () => "running",
  };
  const storageDir = await tempRoot();
  const deps = { storageDir, ownerId: "recovered-cancel", runId: "recovered-cancel", revision: "abc", config: createLargeReviewConfig({ allowedAdapters: ["fake"] }), adapters: [fake], authority: { authorize: async () => true }, entityPolicies: testEntityPolicies };
  const original = await ReviewAgentController.create(deps);
  const admitted = await original.spawn({ taskId: "external", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  if (!admitted.ok) throw new Error("admission failed");
  await waitUntil(async () => (await original.status(admitted.dispatchId))?.status === "running");
  const reopened = await ReviewAgentController.open({ storageDir, ownerId: "recovered-cancel", adapters: [fake], authority: deps.authority, entityPolicies: testEntityPolicies });
  await reopened.cancel(admitted.dispatchId, "operator stop");
  expect(cancels).toBe(1);
  expect((await reopened.status(admitted.dispatchId))?.status).toBe("cancelled");
  await original.close(); await reopened.close();
});

test("hung reconciliation is bounded and becomes unresolved", async () => {
  const never = new Promise<never>(() => undefined);
  const fake: ReviewAgentAdapter = {
    id: "fake", capabilities: { readOnlyEnforced: true, resultPersistence: true, cancellation: true, hierarchy: true },
    execute: async () => never,
    cancel: async () => never,
    reconcile: async () => never,
  };
  const storageDir = await tempRoot();
  const deps = { storageDir, ownerId: "hung-reconcile", runId: "hung-reconcile", revision: "abc", config: createLargeReviewConfig({ allowedAdapters: ["fake"] }), adapters: [fake], authority: { authorize: async () => true }, entityPolicies: testEntityPolicies };
  const original = await ReviewAgentController.create(deps);
  const admitted = await original.spawn({ taskId: "external", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  if (!admitted.ok) throw new Error("admission failed");
  await waitUntil(async () => (await original.status(admitted.dispatchId))?.status === "running");
  const startedAt = Date.now();
  const reopened = await ReviewAgentController.open({ storageDir, ownerId: "hung-reconcile", adapters: [fake], authority: deps.authority, entityPolicies: testEntityPolicies, reconcileTimeoutMs: 25 });
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect((await reopened.status(admitted.dispatchId))?.status).toBe("unresolved");
  await original.close(); await reopened.close();
});

test("unresolved children and generals continue to consume their capacity ceilings", async () => {
  const never = new Promise<never>(() => undefined); let secondChild: unknown;
  const fake: ReviewAgentAdapter = {
    id: "fake", capabilities: { readOnlyEnforced: true, resultPersistence: true, cancellation: true, hierarchy: true },
    execute: async (request, context) => {
      if (request.role !== "coordinator") return never;
      const first = await context.controller.spawn({ taskId: "leaf-1", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: ["scope"] });
      if (!first.ok) throw new Error("first child refused");
      await waitUntil(async () => (await context.controller.status(first.dispatchId))?.status === "running");
      await context.controller.cancel(first.dispatchId, "stop");
      secondChild = await context.controller.spawn({ taskId: "leaf-2", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: ["scope"] });
      return { content: reviewResult() };
    },
    cancel: async () => { throw new Error("kill failed"); },
  };
  const storageDir = await tempRoot();
  const runtime = await ReviewAgentController.create({
    storageDir, ownerId: "capacity-owner", runId: "capacity", revision: "abc", cancelCleanupTimeoutMs: 25,
    config: createLargeReviewConfig({ allowedAdapters: ["fake"], runCeilings: { initialConcurrency: 2, maxActiveChildrenPerGeneral: 1, maxIncompleteGenerals: 1 } }),
    adapters: [fake], authority: { authorize: async () => true }, entityPolicies: testEntityPolicies,
  });
  const general = await runtime.spawn({ taskId: "general-1", attempt: 1, entity: "review-coordinator", role: "coordinator", adapterId: "fake", scopeIds: ["scope"] });
  if (!general.ok) throw new Error("general admission failed");
  await runtime.wait(general.dispatchId);
  expect(secondChild).toMatchObject({ ok: false, code: "child_limit" });
  await runtime.close();

  const generalAdapter: ReviewAgentAdapter = { ...fake, execute: async () => never };
  const generalRuntime = await ReviewAgentController.create({
    storageDir: await tempRoot(), ownerId: "general-capacity-owner", runId: "general-capacity", revision: "abc", cancelCleanupTimeoutMs: 25,
    config: createLargeReviewConfig({ allowedAdapters: ["fake"], runCeilings: { maxIncompleteGenerals: 1 } }),
    adapters: [generalAdapter], authority: { authorize: async () => true }, entityPolicies: testEntityPolicies,
  });
  const blocker = await generalRuntime.spawn({ taskId: "general-blocker", attempt: 1, entity: "review-coordinator", role: "coordinator", adapterId: "fake" });
  if (!blocker.ok) throw new Error("general admission failed");
  await waitUntil(async () => (await generalRuntime.status(blocker.dispatchId))?.status === "running");
  await generalRuntime.cancel(blocker.dispatchId, "stop");
  expect(await generalRuntime.spawn({ taskId: "general-2", attempt: 1, entity: "review-coordinator", role: "coordinator", adapterId: "fake" })).toMatchObject({ ok: false, code: "general_limit" });
  await generalRuntime.close();
});

test("resumed coordinators and validators are selected ahead of ordinary backlog", async () => {
  const gate = deferred<unknown>(); const trace: string[] = [];
  const runtime = await controller({ maxConcurrency: 1, adapter: adapter(async (request) => {
    trace.push(request.taskId);
    if (request.taskId === "active") return gate.promise;
    return request.taskId;
  }) });
  const active = await runtime.spawn({ taskId: "active", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  const backlog = await runtime.spawn({ taskId: "backlog", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  const validator = await runtime.spawn({ taskId: "validator", attempt: 1, entity: "review-validator", role: "validator", adapterId: "fake" });
  if (!active.ok || !backlog.ok || !validator.ok) throw new Error("admission failed");
  gate.resolve("done");
  await runtime.wait(validator.dispatchId); await runtime.wait(backlog.dispatchId);
  expect(trace).toEqual(["active", "validator", "backlog"]);
});

test("coordinator delegation attenuates scopes and preserves idempotent subset reuse", async () => {
  const admissions: unknown[] = [];
  const runtime = await controller({ maxConcurrency: 3, adapter: adapter(async (request, context) => {
    if (request.role !== "coordinator") return request.scopeIds;
    admissions.push(await context.controller.spawn({ taskId: "empty", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: [] }));
    admissions.push(await context.controller.spawn({ taskId: "outside", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: ["outside"] }));
    admissions.push(await context.controller.spawn({ taskId: "duplicate", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: ["a", "a"] }));
    admissions.push(await context.controller.spawn({ taskId: "blank", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: [""] }));
    const first = await context.controller.spawn({ taskId: "valid", attempt: 1, idempotencyKey: "valid", entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: ["a"] });
    const reused = await context.controller.spawn({ taskId: "valid", attempt: 1, idempotencyKey: "valid", entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: ["a"] });
    admissions.push(first, reused);
    if (first.ok) await context.controller.wait(first.dispatchId);
    return "done";
  }) });
  const general = await runtime.spawn({ taskId: "scope-general", attempt: 1, entity: "review-coordinator", role: "coordinator", adapterId: "fake", scopeIds: ["a", "b"] });
  if (!general.ok) throw new Error("general admission failed");
  expect((await runtime.wait(general.dispatchId)).status).toBe("completed");
  expect(admissions.slice(0, 4).every((entry) => typeof entry === "object" && entry !== null && "ok" in entry && entry.ok === false)).toBe(true);
  expect(admissions[4]).toMatchObject({ ok: true, reused: false });
  expect(admissions[5]).toMatchObject({ ok: true, reused: true });
});

test("an arbitrary unregistered wave cannot bypass the outside-wave launch ceiling", async () => {
  const storageDir = await tempRoot(); const fake = adapter(async () => "done");
  const runtime = await ReviewAgentController.create({
    storageDir, ownerId: "wave-owner", runId: "wave-run", revision: "abc",
    config: createLargeReviewConfig({ allowedAdapters: ["fake"], runCeilings: { maxLaunchesOutsideWaves: 1 } }),
    adapters: [fake], authority: { authorize: async () => true }, entityPolicies: testEntityPolicies,
  });
  const first = await runtime.spawn({ taskId: "outside-1", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
  if (first.ok) await runtime.wait(first.dispatchId);
  expect(await runtime.spawn({ taskId: "outside-2", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" })).toMatchObject({ ok: false, code: "launch_limit" });
  expect(await runtime.spawn({ taskId: "minted", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake", waveId: "not-in-plan" })).toMatchObject({ ok: false, code: "wave_limit" });
});

test("plan supersession cannot reset run-scoped wave and dynamic-child authority caps", async () => {
  const runtime = await ReviewAgentController.create({
    storageDir: await tempRoot(), ownerId: "plan-cap-owner", runId: "plan-cap", revision: "abc",
    config: createLargeReviewConfig({ allowedAdapters: ["fake"], runCeilings: { maxWaves: 1, maxReviewRounds: 2 } }),
    adapters: [adapter(async () => "done")], authority: { authorize: async () => true }, entityPolicies: testEntityPolicies,
  });
  const binding = { taskId: "worker", entity: "review-worker", role: "worker" as const, scopeIds: ["scope"], waveId: "wave-1", coverage: [{ scopeId: "scope", aspect: "logic" }] };
  await runtime.registerPlan({ planHash: "a".repeat(64), planVersion: 1, revision: "abc", waves: [{ waveId: "wave-1", reviewRound: 1 }], assignments: [binding] });
  await expect(runtime.registerPlan({ planHash: "b".repeat(64), planVersion: 2, revision: "abc", waves: [{ waveId: "wave-2", reviewRound: 2 }], assignments: [{ ...binding, waveId: "wave-2" }] })).rejects.toThrow("wave cap");
  await expect(runtime.registerPlan({
    planHash: "c".repeat(64), planVersion: 2, revision: "abc", waves: [{ waveId: "wave-2", reviewRound: 2 }],
    assignments: [{ taskId: "general", entity: "review-coordinator", role: "coordinator", scopeIds: ["scope"], waveId: "wave-2", coverage: [], delegatedCoverage: [{ scopeId: "scope", aspect: "logic" }], allowDynamicChildren: false }],
  })).rejects.toThrow("Dynamic-child authority");
});

for (const [name, content, status] of [
  ["object", reviewResult(), "completed"],
  ["JSON", JSON.stringify(reviewResult()), "completed"],
  ["fenced", "Result:\n```REVIEW_RESULT\n" + JSON.stringify(reviewResult()) + "\n```", "completed"],
  ["jsonFence", "```json\n" + JSON.stringify(reviewResult()) + "\n```", "completed"],
  ["concerns", { ...reviewResult(), status: "DONE_WITH_CONCERNS" }, "completed"],
  ["blocked", { ...reviewResult(), status: "BLOCKED" }, "blocked"],
  ["context", { ...reviewResult(), status: "NEEDS_CONTEXT" }, "blocked"],
  ["unreadable", { ...reviewResult(), inputs_unreadable: ["payload"] }, "blocked"],
  ["missingContext", { ...reviewResult(), needs_context: ["source"] }, "blocked"],
] as const) {
  test(`valid REVIEW_RESULT (${name}) reaches ${status} without publishing blocked results`, async () => {
    const runtime = await controller({ adapter: rawAdapter(async () => content) });
    const admitted = await runtime.spawn({ taskId: "valid", attempt: 1, entity: "review-worker", role: "worker", adapterId: "fake" });
    if (!admitted.ok) throw new Error("admission failed");
    const result = await runtime.wait(admitted.dispatchId);
    expect(result.status).toBe(status);
    if (status === "completed") {
      expect(result.resultId).toBeDefined();
      expect((await runtime.result(admitted.dispatchId))?.content).toEqual(content);
    } else {
      expect(result.resultId).toBeUndefined();
      expect(result.error).toBe("review_result_blocked");
      expect(await runtime.result(admitted.dispatchId)).toBeUndefined();
    }
  });
}
