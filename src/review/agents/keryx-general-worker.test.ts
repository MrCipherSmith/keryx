import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { callRound, okReply, scriptedProvider } from "../../commands/agent.test-helpers";
import type { ReviewAgentAdapterRequest } from "./types";
import type { ExternalBridgeRequest } from "./external-adapter";
import {
  createKeryxExternalBridgeTools,
  KERYX_EXTERNAL_BRIDGE_TOOL_NAMES,
  runKeryxExternalWorker,
} from "./keryx-general-worker";
import { scopedProviderCredentials } from "./keryx-general-worker-entry";

function request(signal: AbortSignal): ReviewAgentAdapterRequest {
  return {
    runId: "run-1", dispatchId: "general-1", taskId: "task-1", task: "Review authentication boundaries", attempt: 1,
    revision: "deadbeef", entity: "review-coordinator", role: "coordinator", scopeIds: ["auth"], depth: 1, signal,
    limits: { elapsedMs: 60_000, modelRoundsDefault: 10, modelRoundsMax: 20, toolCallsMax: 40, maxChildLaunches: 8 },
  };
}

test("dedicated worker exposes only scoped bridge tools and consolidates a soldier result", async () => {
  const spawn = { taskId: "auth-worker", task: "inspect auth", attempt: 1, entity: "review-worker", role: "worker" as const, adapterId: "native" };
  const scripted = scriptedProvider([
    callRound("call-1", "review_agents_bridge_spawn", JSON.stringify(spawn)),
    okReply.map((event) => event.kind === "text_delta" ? { ...event, text: "one consolidated finding" } : event),
  ]);
  const calls: ExternalBridgeRequest[] = [];
  const bridge = {
    async invoke(next: ExternalBridgeRequest) {
      calls.push(next);
      return { ok: true as const, value: { ok: true, dispatchId: "soldier-1" } };
    },
  };
  const signal = new AbortController().signal;
  const result = await runKeryxExternalWorker({
    request: request(signal), provider: scripted.provider, providerId: "scripted", modelId: "test", bridge, signal,
  });
  expect(result.content).toBe("one consolidated finding");
  expect(calls).toEqual([{ operation: "spawn", input: spawn }]);
  expect(scripted.requests[0]?.tools?.map((tool) => tool.name)).toEqual([...KERYX_EXTERNAL_BRIDGE_TOOL_NAMES]);
  expect(scripted.requests[0]?.tools?.some((tool) => ["shell_exec", "spawn_subagent", "use_tool", "review_agents_start"].includes(tool.name))).toBe(false);
});

test("bridge spawn schema rejects host-only reserve selection and nested coordinators", () => {
  const tools = createKeryxExternalBridgeTools({ invoke: async () => ({ ok: true, value: {} }) });
  const schema = tools.find((tool) => tool.definition.name === "review_agents_bridge_spawn")?.definition.inputSchema as {
    properties: Record<string, unknown>;
  };
  expect(schema.properties.budgetClass).toBeUndefined();
  expect(schema.properties.parentDispatchId).toBeUndefined();
  expect(schema.properties.authorityRef).toBeUndefined();
  expect(schema.properties.role).toEqual({ type: "string", enum: ["worker", "scout", "validator"] });
});

test("a model request for shell_exec cannot reach any process or bridge operation", async () => {
  const scripted = scriptedProvider([
    callRound("escape", "shell_exec", JSON.stringify({ command: "keryx review agents start" })),
    okReply.map((event) => event.kind === "text_delta" ? { ...event, text: "finished without escape" } : event),
  ]);
  let bridgeCalls = 0;
  const signal = new AbortController().signal;
  const result = await runKeryxExternalWorker({
    request: request(signal), provider: scripted.provider, providerId: "scripted", modelId: "test",
    bridge: { invoke: async () => { bridgeCalls += 1; return { ok: true, value: {} }; } }, signal,
  });
  expect(result.content).toBe("finished without escape");
  expect(bridgeCalls).toBe(0);
});

test("partial text followed by provider authentication failure never becomes a completed review", async () => {
  const scripted = scriptedProvider([[
    { kind: "text_delta", text: "partial finding that must not persist" },
    { kind: "provider_error", error: { kind: "authentication", retryable: false, message: "unauthorized" } },
  ]]);
  const signal = new AbortController().signal;
  await expect(runKeryxExternalWorker({
    request: request(signal), provider: scripted.provider, providerId: "scripted", modelId: "test",
    bridge: { invoke: async () => ({ ok: true, value: {} }) }, signal,
  })).rejects.toThrow("provider attempt did not complete cleanly");
});

test("worker projects only the selected provider credential from auth storage", () => {
  const configDir = mkdtempSync(path.join(tmpdir(), "keryx-review-agents-auth-scope-"));
  try {
    writeFileSync(path.join(configDir, "auth.json"), JSON.stringify({
      apiKeys: { ANTHROPIC_API_KEY: "anthropic-secret", OPENAI_API_KEY: "openai-secret" },
      oauthGrants: { grok: { method: "device-code", access: "grok-access", obtainedAt: "2026-11-05T00:00:00.000Z" } },
    }), { mode: 0o600 });
    expect(scopedProviderCredentials("anthropic", configDir)).toEqual({ ANTHROPIC_API_KEY: "anthropic-secret" });
    expect(scopedProviderCredentials("openai", configDir)).toEqual({ OPENAI_API_KEY: "openai-secret" });
    expect(scopedProviderCredentials("grok", configDir)).toEqual({ XAI_API_KEY: "grok-access" });
    expect(scopedProviderCredentials("openai-codex", configDir)).toEqual({});
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
