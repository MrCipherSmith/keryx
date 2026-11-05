import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { callRound, okReply, scriptedProvider } from "../../commands/agent.test-helpers";
import { buildInteractiveAgentTools } from "../../commands/interactive-agent-tools";
import { createDefaultSearchProviderController } from "../../harness/search";
import { createMetaprojectAdapter } from "../../harness/tool/metaproject-adapter";
import type { InteractiveTool } from "../../harness/tool/builtin/interactive-tools";
import { createReviewAgentHost, type ReviewAgentHostOptions } from "./host";

const fakeExternalGeneralHostFactory: NonNullable<ReviewAgentHostOptions["externalGeneralHostFactory"]> = async (options) => ({
  adapter: {
    id: "keryx-external-general",
    capabilities: { readOnlyEnforced: true, resultPersistence: true, cancellation: true, hierarchy: true, usageAccounting: false },
    async execute(request) {
      if (!(await options.authorize({ operation: "spawn", runId: request.runId, parentDispatchId: request.dispatchId }))) {
        throw new Error("test external authority was denied");
      }
      const controller = options.controller();
      if (controller === undefined) throw new Error("test external controller is unavailable");
      const admission = await controller.spawn(request.dispatchId, {
        taskId: `${request.taskId}-soldier`, task: "Inspect delegated scope", attempt: request.attempt,
        entity: "review-worker", role: "worker", adapterId: "native", scopeIds: request.scopeIds,
      }) as { ok: boolean; dispatchId?: string; message?: string };
      if (!admission.ok || admission.dispatchId === undefined) throw new Error(admission.message ?? "test child was refused");
      await controller.wait(admission.dispatchId);
      return { content: { child: await controller.result(admission.dispatchId) } };
    },
    async cancel() {},
    async reconcile() { return "unknown" as const; },
  },
  limitations: { toolProfile: "bridge-only", sourceRead: false, authRefresh: false },
  async close() {},
});
const preflightingExternalGeneralHostFactory: NonNullable<ReviewAgentHostOptions["externalGeneralHostFactory"]> = async (options) => {
  const evidence = await options.preflightProvider({ provider: options.provider, model: options.model, configDir: options.configDir });
  if (!evidence.hostPreparedCredential || evidence.provider !== options.provider || evidence.model !== options.model) throw new Error("invalid test provider preflight");
  return fakeExternalGeneralHostFactory(options);
};

function hostTestSeams(): Pick<ReviewAgentHostOptions, "externalGeneralHostFactory" | "configDir"> {
  return { externalGeneralHostFactory: fakeExternalGeneralHostFactory, configDir: path.join(process.cwd(), ".metaproject", "keryx") };
}

function named(tools: readonly InteractiveTool[], name: string): InteractiveTool {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

async function registerPlan(
  tools: readonly InteractiveTool[], runId: string, revision: string,
  root: { taskId: string; entity: string; role: "coordinator" | "worker"; scopeId: string },
  childTaskId?: string,
): Promise<void> {
  const rootAssignment = {
    id: root.taskId, agentInstanceId: `${root.taskId}-agent`, kind: root.role, entity: root.entity,
    areaIds: ["area"], scopeIds: [root.scopeId], coverage: root.role === "worker" ? [{ areaId: "area", scopeId: root.scopeId, aspect: "logic" }] : [],
  };
  const assignments = childTaskId === undefined ? [rootAssignment] : [rootAssignment, {
    id: childTaskId, agentInstanceId: `${childTaskId}-agent`, kind: "worker", entity: "review-worker", parentAssignmentId: root.taskId,
    areaIds: ["area"], scopeIds: [root.scopeId], coverage: [{ areaId: "area", scopeId: root.scopeId, aspect: "logic" }],
  }];
  const result = await named(tools, "review_agents_plan").invoke({
    run_id: runId,
    plan: { revision, planVersion: 1, areas: [{ id: "area", title: "Area", requiredAspects: ["logic"], ownerAssignmentId: root.taskId }], boundaries: [], assignments },
    waves: [{ wave_id: "wave-1", review_round: 1, assignment_ids: [root.taskId] }],
  });
  if (result.isError) throw new Error(result.output);
}

describe("Review agents host binding", () => {
  test("runs a coordinator and child through the interactive shell roster without parent-turn beforeAction", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".metaproject", "data", "review-agents-host-"));
    const scripted = scriptedProvider([
      callRound("delegate", "review_agents_spawn_children", JSON.stringify({ tasks: [{
        task_id: "logic-child", task: "Review child scope", entity: "review-worker", role: "worker", scope_ids: ["src/a.ts"],
      }] })),
      okReply,
      okReply,
    ]);
    try {
      const host = createReviewAgentHost({
        ...hostTestSeams(),
        projectRoot: process.cwd(), runsRoot: path.join(root, "runs"), ownerId: "test-host",
        snapshotRevision: async (_projectRoot, _revision, destination) => {
          await mkdir(path.join(destination, "source"), { recursive: true });
          return "a".repeat(40);
        },
      });
      const reviewTools = host.tools({
        provider: scripted.provider, providerId: "scripted", modelId: "test",
        io: () => ({ requestApproval: async () => true, permissionMode: () => "ask" }), authorizeReviewAgentAction: () => true,
      });
      const tools = buildInteractiveAgentTools({
        cwd: process.cwd(), metaprojectPort: createMetaprojectAdapter(process.cwd()), searchController: createDefaultSearchProviderController(),
        spawnTool: { definition: { name: "spawn_subagent", description: "unused", risk: "delegate", inputSchema: { type: "object" } }, invoke: async () => ({ output: "unused", isError: true }) },
        reviewAgents: { tools: reviewTools },
      });

      const started = await named(tools, "review_agents_start").invoke({ run_id: "run-1", revision: "HEAD" });
      expect(started.isError).toBe(false);
      await registerPlan(tools, "run-1", JSON.parse(started.output).revision, { taskId: "area", entity: "review-coordinator", role: "coordinator", scopeId: "src/a.ts" }, "logic-child");
      const admitted = await named(tools, "review_agents_spawn").invoke({
        run_id: "run-1", task_id: "area", task: "Coordinate the area", attempt: 1,
        entity: "review-coordinator", role: "coordinator", adapter_id: "native", idempotency_key: "root-area", scope_ids: ["src/a.ts"],
      });
      expect(admitted.isError).toBe(false);
      const dispatchId = (JSON.parse(admitted.output) as { dispatchId: string }).dispatchId;
      const terminal = await named(tools, "review_agents_wait").invoke({ run_id: "run-1", dispatch_id: dispatchId });
      expect(terminal.isError).toBe(false);
      expect(JSON.parse(terminal.output).status).toBe("completed");
      const state = await host.controller("run-1").then((controller) => controller.status());
      expect(Object.values((state as { assignments: Record<string, { parentDispatchId?: string }> }).assignments)).toHaveLength(2);
      expect(Object.values((state as { assignments: Record<string, { parentDispatchId?: string }> }).assignments).some((record) => record.parentDispatchId === dispatchId)).toBe(true);
      expect((state as { assignments: Record<string, { idempotencyKey: string }> }).assignments[dispatchId]?.idempotencyKey).toContain("root-area");
      const publicStatus = await named(tools, "review_agents_status").invoke({ run_id: "run-1" });
      expect(JSON.parse(publicStatus.output).results).toBeUndefined();
      expect(Array.isArray(JSON.parse(publicStatus.output).resultIds)).toBe(true);
      expect(await host.close()).toEqual({ stopped: true, activeRunIds: ["run-1"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("does not inherit mutable parent tools into the review snapshot", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".metaproject", "data", "review-agents-host-tools-"));
    const scripted = scriptedProvider([okReply]);
    try {
      const host = createReviewAgentHost({
        ...hostTestSeams(),
        projectRoot: process.cwd(), runsRoot: path.join(root, "runs"), ownerId: "test-host",
        snapshotRevision: async (_projectRoot, _revision, destination) => { await mkdir(path.join(destination, "source"), { recursive: true }); return "b".repeat(40); },
      });
      const tools = host.tools({ provider: scripted.provider, providerId: "scripted", modelId: "test", io: () => ({}), authorizeReviewAgentAction: () => true });
      expect(tools.map((tool) => tool.definition.name)).toEqual([
        "review_agents_start", "review_agents_plan", "review_agents_spawn", "review_agents_status", "review_agents_wait", "review_agents_result", "review_agents_cancel",
      ]);
      expect(tools.some((tool) => ["apply_patch", "shell_exec", "slate_note", "spawn_subagent"].includes(tool.definition.name))).toBe(false);
      const spawnSchema = named(tools, "review_agents_spawn").definition.inputSchema as { properties: Record<string, unknown> };
      expect(spawnSchema.properties.budget_class).toBeUndefined();
      expect(spawnSchema.properties.idempotency_key).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses root spawn before a host-approved plan and rejects caller-supplied plan metadata", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".metaproject", "data", "review-agents-host-plan-gate-"));
    const scripted = scriptedProvider([okReply]);
    try {
      const host = createReviewAgentHost({
        ...hostTestSeams(), projectRoot: process.cwd(), runsRoot: path.join(root, "runs"), ownerId: "plan-host",
        snapshotRevision: async (_projectRoot, _revision, destination) => { await mkdir(path.join(destination, "source"), { recursive: true }); return "f".repeat(40); },
      });
      const tools = host.tools({ provider: scripted.provider, providerId: "scripted", modelId: "test", io: () => ({}), authorizeReviewAgentAction: () => true });
      await named(tools, "review_agents_start").invoke({ run_id: "plan-gate", revision: "HEAD" });
      const spawn = await named(tools, "review_agents_spawn").invoke({ run_id: "plan-gate", task_id: "leaf", attempt: 1, entity: "review-worker", role: "worker", adapter_id: "native", scope_ids: ["src/a.ts"] });
      expect(spawn).toMatchObject({ isError: true });
      expect(spawn.output).toContain("registered host-approved plan");
      const suppliedHash = await named(tools, "review_agents_plan").invoke({ run_id: "plan-gate", plan: {}, waves: [], plan_hash: "0".repeat(64) });
      expect(suppliedHash).toMatchObject({ isError: true });
      expect(suppliedHash.output).toContain("unsupported fields");
      await host.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("refuses a symlinked run directory before reading runtime or controller state", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".metaproject", "data", "review-agents-host-symlink-"));
    const runs = path.join(root, "runs");
    const outside = path.join(root, "outside");
    await mkdir(runs, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(runs, "escaped"));
    try {
      const host = createReviewAgentHost({ ...hostTestSeams(), projectRoot: process.cwd(), runsRoot: runs, ownerId: "symlink-host" });
      const scripted = scriptedProvider([okReply]);
      const tools = host.tools({ provider: scripted.provider, providerId: "scripted", modelId: "test", io: () => ({}), authorizeReviewAgentAction: () => true });
      const status = await named(tools, "review_agents_status").invoke({ run_id: "escaped" });
      expect(status).toMatchObject({ isError: true });
      expect(status.output).toContain("symlink");
      await host.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("does not let detached coordinator execution outlive its root authority lease", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".metaproject", "data", "review-agents-host-expiry-"));
    let clock = 0;
    const scripted = scriptedProvider([callRound("late-delegate", "review_agents_spawn_children", JSON.stringify({ tasks: [{
      task_id: "late-child", entity: "review-worker", role: "worker", scope_ids: ["src/a.ts"],
    }] }))]);
    const provider = {
      describe: () => scripted.provider.describe(),
      stream: (...args: Parameters<typeof scripted.provider.stream>) => {
        clock = 8 * 60 * 60 * 1_000;
        return scripted.provider.stream(...args);
      },
    };
    try {
      const host = createReviewAgentHost({
        ...hostTestSeams(),
        projectRoot: process.cwd(), runsRoot: path.join(root, "runs"), ownerId: "expiry-host", now: () => clock,
        snapshotRevision: async (_projectRoot, _revision, destination) => { await mkdir(path.join(destination, "source"), { recursive: true }); return "c".repeat(40); },
      });
      const tools = host.tools({ provider, providerId: "scripted", modelId: "test", io: () => ({ requestApproval: async () => true }), authorizeReviewAgentAction: () => true });
      const started = await named(tools, "review_agents_start").invoke({ run_id: "expiry", revision: "HEAD" });
      await registerPlan(tools, "expiry", JSON.parse(started.output).revision, { taskId: "area", entity: "review-coordinator", role: "coordinator", scopeId: "src/a.ts" }, "late-child");
      const admitted = await named(tools, "review_agents_spawn").invoke({ run_id: "expiry", task_id: "area", attempt: 1, entity: "review-coordinator", role: "coordinator", adapter_id: "native", scope_ids: ["src/a.ts"] });
      const dispatchId = (JSON.parse(admitted.output) as { dispatchId: string }).dispatchId;
      const terminal = await named(tools, "review_agents_wait").invoke({ run_id: "expiry", dispatch_id: dispatchId });
      expect(JSON.parse(terminal.output).status).toBe("failed");
      const state = await host.controller("expiry").then((controller) => controller.status()) as { assignments: Record<string, unknown> };
      expect(Object.keys(state.assignments)).toHaveLength(1);
      await host.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);

  test("pins a run to the provider selected at start across shell model rebuilds", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".metaproject", "data", "review-agents-host-provider-"));
    const first = scriptedProvider([okReply]);
    const second = scriptedProvider([okReply]);
    try {
      const host = createReviewAgentHost({
        ...hostTestSeams(),
        projectRoot: process.cwd(), runsRoot: path.join(root, "runs"), ownerId: "provider-host",
        snapshotRevision: async (_projectRoot, _revision, destination) => { await mkdir(path.join(destination, "source"), { recursive: true }); return "d".repeat(40); },
      });
      const firstTools = host.tools({ provider: first.provider, providerId: "first", modelId: "one", io: () => ({}), authorizeReviewAgentAction: () => true });
      const secondTools = host.tools({ provider: second.provider, providerId: "second", modelId: "two", io: () => ({}), authorizeReviewAgentAction: () => true });
      const started = await named(firstTools, "review_agents_start").invoke({ run_id: "provider-pin", revision: "HEAD" });
      expect(JSON.parse(started.output).runtimePinned).toEqual({ providerId: "first", modelId: "one" });
      await registerPlan(firstTools, "provider-pin", JSON.parse(started.output).revision, { taskId: "leaf", entity: "review-worker", role: "worker", scopeId: "src/a.ts" });
      const admitted = await named(secondTools, "review_agents_spawn").invoke({ run_id: "provider-pin", task_id: "leaf", attempt: 1, entity: "review-worker", role: "worker", adapter_id: "native", scope_ids: ["src/a.ts"] });
      const dispatchId = JSON.parse(admitted.output).dispatchId as string;
      await named(secondTools, "review_agents_wait").invoke({ run_id: "provider-pin", dispatch_id: dispatchId });
      expect(first.requests).toHaveLength(1);
      expect(second.requests).toHaveLength(0);
      await host.close();
      const restarted = createReviewAgentHost({ ...hostTestSeams(), projectRoot: process.cwd(), runsRoot: path.join(root, "runs"), ownerId: "provider-host-restarted" });
      const restartedTools = restarted.tools({ provider: second.provider, providerId: "second", modelId: "two", io: () => ({}), authorizeReviewAgentAction: () => true });
      const reopened = await named(restartedTools, "review_agents_status").invoke({ run_id: "provider-pin" });
      expect(reopened).toMatchObject({ isError: true });
      expect(reopened.output).toContain("pinned to first/one");
      await restarted.close();
      const matching = createReviewAgentHost({ ...hostTestSeams(), projectRoot: process.cwd(), runsRoot: path.join(root, "runs"), ownerId: "provider-host" });
      const matchingTools = matching.tools({ provider: first.provider, providerId: "first", modelId: "one", io: () => ({}), authorizeReviewAgentAction: () => true });
      expect((await named(matchingTools, "review_agents_status").invoke({ run_id: "provider-pin" })).isError).toBe(false);
      await matching.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);

  test("runs an external Keryx general and native soldier through the shared ledger", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".metaproject", "data", "review-agents-host-external-"));
    const scripted = scriptedProvider([okReply]);
    try {
      const host = createReviewAgentHost({
        ...hostTestSeams(),
        externalGeneralHostFactory: preflightingExternalGeneralHostFactory,
        projectRoot: process.cwd(), runsRoot: path.join(root, "runs"), ownerId: "external-host",
        snapshotRevision: async (_projectRoot, _revision, destination) => { await mkdir(path.join(destination, "source"), { recursive: true }); return "e".repeat(40); },
      });
      const tools = host.tools({
        provider: scripted.provider, providerId: "ollama", modelId: "test",
        io: () => ({ requestApproval: async () => true, permissionMode: () => "ask" }), authorizeReviewAgentAction: () => true,
      });
      const started = await named(tools, "review_agents_start").invoke({ run_id: "external", revision: "HEAD" });
      expect(started.isError).toBe(false);
      const startPayload = JSON.parse(started.output);
      expect(startPayload.config.allowedAdapters).toEqual(["native", "keryx-external-general"]);
      expect(startPayload.capabilityProfile["keryx-external-general"]).toMatchObject({
        toolParity: false, sourceInspection: false, bridgeOnly: true, oauthRefresh: false,
      });
      await registerPlan(tools, "external", startPayload.revision, { taskId: "external-area", entity: "review-coordinator", role: "coordinator", scopeId: "src/a.ts" }, "external-area-soldier");
      const admitted = await named(tools, "review_agents_spawn").invoke({
        run_id: "external", task_id: "external-area", task: "Coordinate external review", attempt: 1,
        entity: "review-coordinator", role: "coordinator", adapter_id: "keryx-external-general", scope_ids: ["src/a.ts"],
      });
      expect(admitted.isError).toBe(false);
      const dispatchId = JSON.parse(admitted.output).dispatchId as string;
      const terminal = await named(tools, "review_agents_wait").invoke({ run_id: "external", dispatch_id: dispatchId });
      expect(JSON.parse(terminal.output).status).toBe("completed");
      const state = await host.controller("external").then((controller) => controller.status()) as { assignments: Record<string, { adapterId: string; parentDispatchId?: string }> };
      expect(Object.values(state.assignments)).toHaveLength(2);
      expect(Object.values(state.assignments)).toContainEqual(expect.objectContaining({ adapterId: "native", parentDispatchId: dispatchId }));
      expect(scripted.requests).toHaveLength(1);
      await host.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);

  test("rechecks the background-safe live authority before an external bridge operation", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".metaproject", "data", "review-agents-host-external-revoke-"));
    const scripted = scriptedProvider([okReply]);
    try {
      const host = createReviewAgentHost({
        ...hostTestSeams(), projectRoot: process.cwd(), runsRoot: path.join(root, "runs"), ownerId: "external-revoke-host",
        snapshotRevision: async (_projectRoot, _revision, destination) => { await mkdir(path.join(destination, "source"), { recursive: true }); return "1".repeat(40); },
      });
      const tools = host.tools({
        provider: scripted.provider, providerId: "ollama", modelId: "test", io: () => ({}), authorizeReviewAgentAction: () => false,
      });
      const started = await named(tools, "review_agents_start").invoke({ run_id: "external-revoke", revision: "HEAD" });
      await registerPlan(tools, "external-revoke", JSON.parse(started.output).revision, { taskId: "external-area", entity: "review-coordinator", role: "coordinator", scopeId: "src/a.ts" }, "external-area-soldier");
      const admitted = await named(tools, "review_agents_spawn").invoke({ run_id: "external-revoke", task_id: "external-area", attempt: 1, entity: "review-coordinator", role: "coordinator", adapter_id: "keryx-external-general", scope_ids: ["src/a.ts"] });
      const dispatchId = JSON.parse(admitted.output).dispatchId as string;
      const terminal = await named(tools, "review_agents_wait").invoke({ run_id: "external-revoke", dispatch_id: dispatchId });
      expect(JSON.parse(terminal.output).status).toBe("failed");
      expect(scripted.requests).toHaveLength(0);
      await host.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);
});
