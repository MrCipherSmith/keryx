import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveOrCreateWorkspace } from "./workspace-resolve";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "./workspace-service";
import { workspaceListTool } from "../harness/tool/builtin/workspace-lifecycle-tool";
import type { NormalizedEvent, ProviderDescription, ProviderPort } from "../harness/provider/types";

const time = "2026-08-17T00:00:00.000Z";

const DESCRIPTION: ProviderDescription = {
  capabilities: {
    streaming: true,
    toolCalls: false,
    parallelToolCalls: false,
    structuredOutput: false,
    reasoningMetadata: false,
    promptCaching: false,
    vision: false,
    tokenCounting: false,
    modelListing: false,
  },
  descriptor: { providerId: "stub" },
};

/** A model-turn provider that answers immediately with fixed text. */
function stubModelProvider(text: string): ProviderPort {
  return {
    describe: () => DESCRIPTION,
    stream: (_req, opts) =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text };
        yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
      })(),
  };
}

/** A model-turn provider that never answers (bounded-timeout probe). */
function hangingModelProvider(): ProviderPort {
  return {
    describe: () => DESCRIPTION,
    stream: () =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        await new Promise(() => {});
      })(),
  };
}

/** A model-turn provider that throws if invoked at all — proves the "empty
 * list" path never calls the model (nothing to judge over). */
function unreachableModelProvider(): ProviderPort {
  return {
    describe: () => DESCRIPTION,
    stream: () => {
      throw new Error("model turn should never run when the workspace list is empty");
    },
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
    providerFactory: () => unreachableModelProvider(),
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
    providerFactory: () => stubModelProvider("BIND workspace-fork-tests"),
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
    providerFactory: () => stubModelProvider("BIND workspace-made-up-id"),
  });
  expect(result).toEqual({ ok: false, reason: "ambiguous" });
});

test("no match among existing workspaces creates a new one with the model's chosen title", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-unrelated", "Totally unrelated topic");
  const result = await resolveOrCreateWorkspace({
    cwd,
    topicHint: "a brand new investigation",
    providerFactory: () => stubModelProvider("CREATE Brand new investigation"),
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
    providerFactory: () => stubModelProvider("I'm not sure, maybe either one?"),
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
    providerFactory: () => hangingModelProvider(),
    modelTurnTimeoutMs: 100,
  });
  expect(result).toEqual({ ok: false, reason: "ambiguous" });
  const listed = await workspaceListTool(cwd).invoke({});
  expect(JSON.parse(listed.output)).toHaveLength(1);
});

test("no credential and no injected factory fails closed with no_credential, never creates", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-a", "A");
  const result = await resolveOrCreateWorkspace({
    cwd,
    topicHint: "no credential case",
    env: {}, // no ANTHROPIC_API_KEY or any other provider key
  });
  expect(result).toEqual({ ok: false, reason: "no_credential" });
  const listed = await workspaceListTool(cwd).invoke({});
  expect(JSON.parse(listed.output)).toHaveLength(1);
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
    providerFactory: () => unreachableModelProvider(),
  });
  expect(result).toMatchObject({ ok: true, action: "created" });
});
