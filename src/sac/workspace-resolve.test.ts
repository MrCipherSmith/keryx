import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveOrCreateWorkspace } from "./workspace-resolve";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "./workspace-service";
import type { ModelTurnPort } from "./model-turn-port";
// Read-back assertions deliberately still go through the CLIENT-side tool
// (`workspace_list`): `resolveOrCreateWorkspace` stopped calling that tool in
// flow 239 phase 7 and now drives `WorkspaceService` directly, so listing the
// result through the tool is the cross-check that the two still see the same
// workspaces. A test file is not part of any shipped graph, so this import has
// no packaging consequence (see `core-graph.test.ts`, which measures the
// artifact rather than the source).
import { workspaceListTool } from "../harness/tool/builtin/workspace-lifecycle-tool";

const time = "2026-08-17T00:00:00.000Z";

/**
 * The injected model-turn capability, in its three test shapes. These used to
 * be `ProviderPort` stubs behind an injected `providerFactory`; since flow 239
 * phase 7 core takes the whole turn as a port (`./model-turn-port.ts`), so a
 * stub is one function and names no provider at all.
 */
function stubModelTurn(text: string): ModelTurnPort {
  return async () => ({ credentialAvailable: true, text });
}

/** A port that never answers (bounded-timeout probe). */
function hangingModelTurn(): ModelTurnPort {
  return () => new Promise<never>(() => {});
}

/** A port that throws if invoked at all — proves the "empty list" path never
 * calls the model (nothing to judge over). */
function unreachableModelTurn(): ModelTurnPort {
  return () => {
    throw new Error("model turn should never run when the workspace list is empty");
  };
}

async function tempCwd(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-workspace-resolve-"));
}

async function createWorkspace(cwd: string, id: string, title: string): Promise<void> {
  const service = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
    now: () => new Date(time),
  });
  await service.create({ request: undefined, requestCorrelationId: randomUUID(), id, title });
}

test("an empty workspace list creates directly, never invoking the model", async () => {
  const cwd = await tempCwd();
  const result = await resolveOrCreateWorkspace({
    cwd,
    topicHint: "Investigate the flaky serve-turn tests",
    modelTurn: unreachableModelTurn(),
  });
  expect(result).toMatchObject({ ok: true, action: "created" });
  const listed = await workspaceListTool(cwd).invoke({});
  const workspaces = JSON.parse(listed.output) as Array<{ id: string; title: string }>;
  expect(workspaces).toHaveLength(1);
  if (result.ok) expect(workspaces[0]?.id).toBe(result.workspaceId);
  expect(workspaces[0]?.title).toContain("Investigate the flaky serve-turn tests");
});

test("a matching existing workspace is bound, not duplicated — AC-24: the model is only ever shown ids that were actually listed", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-fork-tests", "Session fork test flakes");
  const result = await resolveOrCreateWorkspace({
    cwd,
    topicHint: "keep debugging the same fork test flakes",
    modelTurn: stubModelTurn("BIND workspace-fork-tests"),
  });
  expect(result).toEqual({ ok: true, action: "bound-existing", workspaceId: "workspace-fork-tests" });
  const listed = await workspaceListTool(cwd).invoke({});
  expect(JSON.parse(listed.output)).toHaveLength(1); // still exactly one — nothing created
});

test("a hallucinated id (not in the real list) is never bound — treated as no decision", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-real", "Real workspace");
  const result = await resolveOrCreateWorkspace({
    cwd,
    topicHint: "something unrelated",
    modelTurn: stubModelTurn("BIND workspace-made-up-id"),
  });
  expect(result).toEqual({ ok: false, reason: "ambiguous" });
});

test("no match among existing workspaces creates a new one with the model's chosen title", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-unrelated", "Totally unrelated topic");
  const result = await resolveOrCreateWorkspace({
    cwd,
    topicHint: "a brand new investigation",
    modelTurn: stubModelTurn("CREATE Brand new investigation"),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.action).toBe("created");
  const listed = await workspaceListTool(cwd).invoke({});
  const workspaces = JSON.parse(listed.output) as Array<{ id: string; title: string }>;
  expect(workspaces).toHaveLength(2);
  expect(workspaces.find((w) => w.id === result.workspaceId)?.title).toBe("Brand new investigation");
});

test("an unparseable model response never creates speculatively", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-a", "A");
  const result = await resolveOrCreateWorkspace({
    cwd,
    topicHint: "ambiguous case",
    modelTurn: stubModelTurn("I'm not sure, maybe either one?"),
  });
  expect(result).toEqual({ ok: false, reason: "ambiguous" });
  const listed = await workspaceListTool(cwd).invoke({});
  expect(JSON.parse(listed.output)).toHaveLength(1); // nothing created
});

test("a hung model turn times out and fails closed, never creating speculatively", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-a", "A");
  const result = await resolveOrCreateWorkspace({
    cwd,
    topicHint: "slow judgment case",
    modelTurn: hangingModelTurn(),
    modelTurnTimeoutMs: 100,
  });
  expect(result).toEqual({ ok: false, reason: "ambiguous" });
  const listed = await workspaceListTool(cwd).invoke({});
  expect(JSON.parse(listed.output)).toHaveLength(1);
});

test("a supplied port with no credential fails closed with no_credential, never creates", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-a", "A");
  const result = await resolveOrCreateWorkspace({
    cwd,
    topicHint: "no credential case",
    env: {}, // no ANTHROPIC_API_KEY or any other provider key
    // The capability exists and answered honestly: "I have no key." That is a
    // different fact from the capability being absent (the test below), and the
    // two must not report the same reason.
    modelTurn: async () => ({ credentialAvailable: false, text: "" }),
  });
  expect(result).toEqual({ ok: false, reason: "no_credential" });
  const listed = await workspaceListTool(cwd).invoke({});
  expect(JSON.parse(listed.output)).toHaveLength(1);
});

test("no model-turn port at all refuses with no_model_turn — never a guess, never a silent skip", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-a", "A");
  // No `modelTurn`, and no process-wide port registered: core has no provider
  // registry of its own (AFC-19), so the only honest answer is a refusal that
  // names the missing capability.
  const result = await resolveOrCreateWorkspace({ cwd, topicHint: "unwired client case", env: {} });
  expect(result).toEqual({ ok: false, reason: "no_model_turn" });
  const listed = await workspaceListTool(cwd).invoke({});
  expect(JSON.parse(listed.output)).toHaveLength(1); // nothing created speculatively
});

test("an archived workspace is never offered as a bind candidate", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-archived", "Old topic");
  const service = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
    now: () => new Date(time),
  });
  await service.archive({ request: undefined, requestCorrelationId: randomUUID(), workspaceId: "workspace-archived" });
  // An archived workspace is excluded from the candidate list entirely, so the
  // resolver treats this exactly like the empty-list case: no model call.
  const result = await resolveOrCreateWorkspace({
    cwd,
    topicHint: "fresh topic",
    modelTurn: unreachableModelTurn(),
  });
  expect(result).toMatchObject({ ok: true, action: "created" });
});
