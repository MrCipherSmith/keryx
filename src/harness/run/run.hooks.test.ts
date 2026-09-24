// Tests for the OPTIONAL `RunDeps.hooks` integration in `runOffline` (flow 306,
// W6, task T6). Pins:
//   - AC1: a PreToolUse gate hook returning `{"decision":"ask"}` for a call
//     `decide()` would otherwise `allow` yields a final `ask` (interactive)
//     or `deny` (headless), through `runOffline`'s existing decision
//     pipeline.
//   - AC15 (byte-identical subset): with `deps.hooks` supplied but every hook
//     firing "allow", the composed decision/tool execution/output are
//     unaffected; `hookInvocations`/`hookWarnings` are populated on
//     `RunResult` only when `deps.hooks` was supplied.
// Reuses the same fixtures/style as `run.test.ts` (FakeProvider/FakeToolExecutor).
import { createHash } from "node:crypto";
import path from "node:path";
import { expect, test } from "bun:test";
import type { HarnessConfig } from "../config";
import type { HookFireResult, HookRegistration, HookRuntime } from "../hooks";
import { FakeProvider, type FakeProviderTranscript, requestHashOf } from "../provider/fake-provider";
import type { NormalizedRequest, ProviderPort } from "../provider/types";
import type { PolicyProfile } from "../policy/types";
import { FAKE_READONLY_TOOL, FakeToolExecutor } from "../tool/fake-tool";
import { ToolRegistry } from "../tool/registry";
import type { HarnessRunInput } from "../types";
import { runOffline } from "./run";
import type { RunDeps, RunResult } from "./run";

const SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function makeDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

const readOnlyProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "read-only-review",
  profileVersion: "1.0.0",
  fingerprint: sha256("read-only-review:1.0.0"),
  trustMode: "read-only",
  defaults: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

function buildConfig(): HarnessConfig {
  return {
    schemaVersion: 1,
    enabled: true,
    defaultRole: "build",
    defaultProvider: "fake-provider",
    defaultModel: "fixture-model",
    policyProfile: "read-only-review",
    limits: { maxRunSeconds: 300, maxConcurrentChildren: 1, maxToolOutputBytes: 65_536, maxRetries: 1 },
  };
}

function buildInput(overrides?: Partial<HarnessRunInput>): HarnessRunInput {
  return {
    schemaVersion: 1,
    request: "run the fixture scenario",
    projectRoot: "/repo",
    role: "build",
    policy: "read-only-review",
    budget: { maxSeconds: 60, maxToolCalls: 5, maxRetries: 1 },
    provider: "fake-provider",
    model: "fixture-model",
    credentialRef: "cred-ref-1",
    ...overrides,
  };
}

function buildRegistry(...defs: Parameters<ToolRegistry["register"]>[0][]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const def of defs) registry.register(def);
  return registry;
}

function makeTranscript(transcriptId: string, calls: { toolCallId: string; toolName: string; input: Record<string, unknown> }[]): FakeProviderTranscript {
  const events: FakeProviderTranscript["events"] = [
    ...calls.map((call, index) => ({
      sequence: index,
      kind: "tool_call" as const,
      payload: { toolName: call.toolName, toolCallId: call.toolCallId, input: call.input },
    })),
    { sequence: calls.length, kind: "text_delta" as const, payload: { text: "Task complete." } },
    { sequence: calls.length + 1, kind: "finish" as const, payload: {} },
  ];
  return {
    schemaVersion: 1,
    transcriptId,
    providerId: "fake-provider",
    providerRevision: "fake-1.0.0",
    requestHash: "0".repeat(64),
    events,
  };
}

function buildFixtureRequest(requestId: string): NormalizedRequest {
  return {
    providerId: "fake-provider",
    modelId: "fixture-model",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "fixture prompt" }],
    budget: { maxOutputTokens: 1000, runReservation: 1000 },
    stream: true,
    requestId,
    parentRunId: "run-fixture",
  };
}

function fixtureProvider(transcript: FakeProviderTranscript, requestId: string): ProviderPort {
  const request = buildFixtureRequest(requestId);
  const stamped: FakeProviderTranscript = { ...transcript, requestHash: requestHashOf(request) };
  const fake = new FakeProvider([stamped]);
  return {
    describe: () => fake.describe(),
    stream: (_request, opts) => fake.stream(request, opts),
  };
}

function buildRunDeps(overrides: {
  provider: ProviderPort;
  toolRegistry: ToolRegistry;
  toolExecutor: import("../tool/types").ToolExecutorPort;
  interactive?: boolean;
  hooks?: HookRuntime;
}): RunDeps {
  const { clock, idSeq } = makeDeps();
  return {
    provider: overrides.provider,
    toolRegistry: overrides.toolRegistry,
    toolExecutor: overrides.toolExecutor,
    policyProfile: readOnlyProfile,
    clock,
    idSeq,
    interactive: overrides.interactive ?? true,
    ...(overrides.hooks !== undefined ? { hooks: overrides.hooks } : {}),
  };
}

/** A minimal fake `HookRuntime`: scripted per-event outcome, records every `fire()` call. */
function fakeHookRuntime(opts: {
  interactive?: boolean;
  outcomeByEvent?: Partial<Record<string, HookFireResult["tightened"]>>;
}): { runtime: HookRuntime; fires: { event: string; payload: Record<string, unknown> }[] } {
  const fires: { event: string; payload: Record<string, unknown> }[] = [];
  const runtime: HookRuntime = {
    interactive: opts.interactive ?? true,
    registrations: (): readonly HookRegistration[] => [],
    inheritedHookIds: () => [],
    forChild: () => runtime,
    fire: async (event, payload): Promise<HookFireResult> => {
      fires.push({ event, payload });
      const tightened = opts.outcomeByEvent?.[event];
      const decisions = tightened === undefined ? [] : [{ hookId: `fake-${event}`, decision: tightened }];
      return {
        decisions,
        ...(tightened !== undefined ? { tightened } : {}),
        additionalContext: [],
        records: [
          {
            hookId: `fake-${event}`,
            event: event as HookRegistration["event"],
            class: "gate",
            scope: "project",
            outcome: tightened ?? "none",
            durationMs: 1,
            changedOutcome: tightened === "deny" || tightened === "ask",
          },
        ],
        warnings: [],
        anomalies: [],
      };
    },
  };
  return { runtime, fires };
}

test("hooks absent: RunResult carries neither hookInvocations nor hookWarnings", async () => {
  const registry = buildRegistry(FAKE_READONLY_TOOL);
  const transcript = makeTranscript("t-hooks-absent", [
    { toolCallId: "call-1", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "value" } },
  ]);
  const provider = fixtureProvider(transcript, "req-hooks-absent");
  const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });
  const deps = buildRunDeps({ provider, toolRegistry: registry, toolExecutor: executor });

  const result: RunResult = await runOffline(buildInput(), buildConfig(), deps);
  expect(result.hookInvocations).toBeUndefined();
  expect(result.hookWarnings).toBeUndefined();
  expect(result.output.status).toBe("completed");
});

test("AC1: a PreToolUse hook returning ask tightens a decide()-allow to a final ask (interactive)", async () => {
  const registry = buildRegistry(FAKE_READONLY_TOOL);
  const transcript = makeTranscript("t-hooks-ask", [
    { toolCallId: "call-1", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "value" } },
  ]);
  const provider = fixtureProvider(transcript, "req-hooks-ask");
  const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });
  const { runtime } = fakeHookRuntime({ outcomeByEvent: { PreToolUse: "ask" } });
  const deps = buildRunDeps({ provider, toolRegistry: registry, toolExecutor: executor, hooks: runtime, interactive: true });

  const result: RunResult = await runOffline(buildInput(), buildConfig(), deps);
  const decision = result.decisions.find((d) => d.toolCallId === "call-1");
  expect(decision?.decision).toBe("ask");
  // A transport can never upgrade a policy decision past `ask`: the tool must
  // not have been executed.
  expect(result.sessionEntries.some((e) => e.entry.type === "tool_result")).toBe(false);
  expect(result.hookInvocations?.some((r) => r.hookId === "fake-PreToolUse")).toBe(true);
  expect(result.sessionEntries.some((e) => e.entry.type === "hook_invocation")).toBe(true);
});

test("AC1: the same PreToolUse ask fails closed to deny when interactive is false", async () => {
  const registry = buildRegistry(FAKE_READONLY_TOOL);
  const transcript = makeTranscript("t-hooks-ask-headless", [
    { toolCallId: "call-1", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "value" } },
  ]);
  const provider = fixtureProvider(transcript, "req-hooks-ask-headless");
  const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });
  const { runtime } = fakeHookRuntime({ outcomeByEvent: { PreToolUse: "ask" } });
  const deps = buildRunDeps({ provider, toolRegistry: registry, toolExecutor: executor, hooks: runtime, interactive: false });

  const result: RunResult = await runOffline(buildInput(), buildConfig(), deps);
  const decision = result.decisions.find((d) => d.toolCallId === "call-1");
  expect(decision?.decision).toBe("deny");
});

test("AC15 subset: every hook firing allow leaves the composed decision and tool execution unaffected", async () => {
  const registry = buildRegistry(FAKE_READONLY_TOOL);
  const transcript = makeTranscript("t-hooks-allow", [
    { toolCallId: "call-1", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "value" } },
  ]);
  const provider = fixtureProvider(transcript, "req-hooks-allow");
  const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });
  const { runtime, fires } = fakeHookRuntime({});
  const deps = buildRunDeps({ provider, toolRegistry: registry, toolExecutor: executor, hooks: runtime });

  const result: RunResult = await runOffline(buildInput(), buildConfig(), deps);
  expect(result.output.status).toBe("completed");
  const decision = result.decisions.find((d) => d.toolCallId === "call-1");
  expect(decision?.decision).toBe("allow");
  expect(result.sessionEntries.some((e) => e.entry.type === "tool_result")).toBe(true);

  // Every documented lifecycle event fired at least once for this run.
  const eventNames = fires.map((f) => f.event);
  for (const expected of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) {
    expect(eventNames).toContain(expected);
  }
});

test("PostToolUseFailure fires when the executor throws; observe-only (blocker recorded, hook cannot change it)", async () => {
  const registry = buildRegistry(FAKE_READONLY_TOOL);
  const transcript = makeTranscript("t-hooks-throw", [
    { toolCallId: "call-1", toolName: FAKE_READONLY_TOOL.toolId, input: {} }, // fails inputSchema -> executor throws
  ]);
  const provider = fixtureProvider(transcript, "req-hooks-throw");
  const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });
  const { runtime, fires } = fakeHookRuntime({});
  const deps = buildRunDeps({ provider, toolRegistry: registry, toolExecutor: executor, hooks: runtime });

  const result: RunResult = await runOffline(buildInput(), buildConfig(), deps);
  expect(fires.some((f) => f.event === "PostToolUseFailure")).toBe(true);
  expect(result.output.unresolvedBlockerIds.some((id) => id.startsWith("blocker:tool-rejected:"))).toBe(true);
});

test("UserPromptSubmit deny ends the run blocked without ever opening the provider stream", async () => {
  const registry = buildRegistry(FAKE_READONLY_TOOL);
  let streamCalls = 0;
  const provider: ProviderPort = {
    describe: () => fixtureProvider(makeTranscript("unused", []), "req-unused").describe(),
    stream: (request, opts) => {
      streamCalls += 1;
      return fixtureProvider(makeTranscript("t-unused", []), "req-unused").stream(request, opts);
    },
  };
  const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });
  const { runtime } = fakeHookRuntime({ outcomeByEvent: { UserPromptSubmit: "deny" } });
  const deps = buildRunDeps({ provider, toolRegistry: registry, toolExecutor: executor, hooks: runtime });

  const result: RunResult = await runOffline(buildInput(), buildConfig(), deps);
  expect(streamCalls).toBe(0);
  expect(result.output.status).toBe("blocked");
  expect(result.output.unresolvedBlockerIds).toContain("blocker:hook-denied:UserPromptSubmit");
});
