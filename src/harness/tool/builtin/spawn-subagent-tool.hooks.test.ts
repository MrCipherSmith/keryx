// `SubagentStart`/`SubagentStop` hook wiring on both `spawn_subagent` paths
// (flow 306, W6, task T6): the external `deps.runExternal` seam and the
// native/internal in-process `runAgentTurn` path.
import { expect, test } from "bun:test";
import { createSpawnSubagentTool, type StructuredSubagentResult } from "./spawn-subagent-tool";
import type { HookFireResult, HookRegistration, HookRuntime } from "../../hooks";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../../provider/types";

function stubProvider(text: string): ProviderPort {
  return {
    describe() {
      return {
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
    },
    async *stream(_req, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

/** A minimal fake `HookRuntime`: scripted per-event outcome, records every `fire()` call. */
function fakeHookRuntime(opts: {
  inherited?: string[];
  outcomeByEvent?: Partial<Record<string, HookFireResult["tightened"]>>;
}): { runtime: HookRuntime; fires: { event: string; payload: Record<string, unknown> }[] } {
  const fires: { event: string; payload: Record<string, unknown> }[] = [];
  const runtime: HookRuntime = {
    interactive: true,
    registrations: (): readonly HookRegistration[] => [],
    inheritedHookIds: () => opts.inherited ?? ["keryx.ctx-guard", "keryx.security-check-input"],
    forChild: () => runtime,
    fire: async (event, payload): Promise<HookFireResult> => {
      fires.push({ event, payload });
      const tightened = opts.outcomeByEvent?.[event];
      return {
        decisions: [],
        ...(tightened !== undefined ? { tightened } : {}),
        additionalContext: [],
        records: [],
        warnings: [],
        anomalies: [],
      };
    },
  };
  return { runtime, fires };
}

const EXTERNAL_RESULT: StructuredSubagentResult = {
  status: "Completed",
  output: "external child says hi",
  isError: false,
};

// ---------------------------------------------------------------------------
// External path.
// ---------------------------------------------------------------------------

test("external: SubagentStart deny prevents runExternal and releases the reservation", async () => {
  const { runtime, fires } = fakeHookRuntime({ outcomeByEvent: { SubagentStart: "deny" } });
  let externalCalled = false;
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => stubProvider("native answer"),
    getDetectedProviders: () => [{ name: "ollama" }],
    hooks: runtime,
    runExternal: async () => {
      externalCalled = true;
      return EXTERNAL_RESULT;
    },
  });

  const result = await tool.invoke({
    task: "Review auth module",
    mode: "read_only",
    label: "auth-check",
    runtime: { kind: "external", agent: "codex-cli" },
  });

  expect(externalCalled).toBe(false);
  expect(result.status).toBe("Denied");
  expect(result.isError).toBe(true);

  const startFire = fires.find((f) => f.event === "SubagentStart");
  expect(startFire).toBeDefined();
  expect(startFire?.payload.spawnKind).toBe("external");
  expect(startFire?.payload.inheritedHookIds).toEqual(["keryx.ctx-guard", "keryx.security-check-input"]);
  // Denied — no SubagentStop for a child that never started.
  expect(fires.some((f) => f.event === "SubagentStop")).toBe(false);
});

test("external: SubagentStart allow runs runExternal as before, and SubagentStop fires with its outcome", async () => {
  const { runtime, fires } = fakeHookRuntime({});
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => stubProvider("native answer"),
    getDetectedProviders: () => [{ name: "ollama" }],
    hooks: runtime,
    runExternal: async () => EXTERNAL_RESULT,
  });

  const result = await tool.invoke({
    task: "Review auth module",
    mode: "read_only",
    label: "auth-check",
    runtime: { kind: "external", agent: "codex-cli" },
  });

  expect(result).toEqual(EXTERNAL_RESULT);
  const stopFire = fires.find((f) => f.event === "SubagentStop");
  expect(stopFire?.payload.outcome).toBe("Completed");
});

// ---------------------------------------------------------------------------
// Native/internal path.
// ---------------------------------------------------------------------------

test("native: SubagentStart deny prevents runAgentTurn (provider never streams) and releases the reservation", async () => {
  const { runtime, fires } = fakeHookRuntime({ outcomeByEvent: { SubagentStart: "deny" } });
  let streamed = false;
  const provider: ProviderPort = {
    ...stubProvider("native answer"),
    async *stream(_req, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      streamed = true;
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: "should not run" };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => provider,
    getDetectedProviders: () => [{ name: "ollama" }],
    hooks: runtime,
  });

  const result = await tool.invoke({ task: "Review auth module", mode: "read_only", label: "auth-check" });

  expect(streamed).toBe(false);
  expect(result.status).toBe("Denied");
  expect(result.isError).toBe(true);
  const startFire = fires.find((f) => f.event === "SubagentStart");
  expect(startFire?.payload.spawnKind).toBe("internal");
  expect(fires.some((f) => f.event === "SubagentStop")).toBe(false);
});

test("native: SubagentStart allow runs the child as before, and SubagentStop fires with the completion status", async () => {
  const { runtime, fires } = fakeHookRuntime({});
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => stubProvider("native child answer"),
    getDetectedProviders: () => [{ name: "ollama" }],
    hooks: runtime,
  });

  const result = await tool.invoke({ task: "Review auth module", mode: "read_only", label: "auth-check" });

  expect(result.isError).toBe(false);
  expect(result.output).toMatch(/native child answer/);
  const stopFire = fires.find((f) => f.event === "SubagentStop");
  expect(stopFire?.payload.outcome).toBe("Completed");
});

test("native: the child's OWN tool calls fire PreToolUse under a restricted, per-child hook runtime (flow 306, W6, T13)", async () => {
  const { runtime, fires } = fakeHookRuntime({});
  const base = stubProvider("unused");
  let requests = 0;
  const provider: ProviderPort = {
    ...base,
    describe: () => ({ ...base.describe(), capabilities: { ...base.describe().capabilities, toolCalls: true } }),
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      requests += 1;
      if (requests === 1) {
        yield { kind: "tool_call_start", sequence: 0, attemptId: opts.attemptId, toolCallId: "c1", toolName: "get_cwd" };
        yield { kind: "tool_call_end", sequence: 1, attemptId: opts.attemptId, toolCallId: "c1", input: "{}" };
      } else {
        yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: "the cwd is /proj" };
      }
      yield { kind: "model_end", sequence: 2, attemptId: opts.attemptId };
    },
  };
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => provider,
    getDetectedProviders: () => [{ name: "ollama" }],
    hooks: runtime,
  });

  const result = await tool.invoke({ task: "Read the cwd", mode: "read_only", label: "cwd-check", max_rounds: 2 });

  expect(result.isError).toBe(false);
  const startFire = fires.find((f) => f.event === "SubagentStart");
  expect(startFire).toBeDefined();
  const preToolUseFires = fires.filter((f) => f.event === "PreToolUse");
  expect(preToolUseFires.length).toBeGreaterThan(0);
  const childPreToolUse = preToolUseFires.find((f) => f.payload.toolName === "get_cwd");
  expect(childPreToolUse).toBeDefined();
  // Fired under the CHILD's own session/run identity, never the parent's
  // `sessionId`/`runId` the fake `fakeHookRuntime` was constructed with
  // (`forChild` mints a fresh pair) — and never mixed into the
  // `SubagentStart`/`SubagentStop` bracket's own payloads.
  expect(childPreToolUse?.payload.sessionId).not.toBe(startFire?.payload.sessionId);
});

test("native: a registration scoped appliesToChildAgents:false is absent from the child's own fires", async () => {
  // Tracks which REGISTRATION IDS actually matched a fired event — not just
  // that `fire()` was called (the runtime always "fires" the event even with
  // zero matching registrations; that alone proves nothing about exclusion).
  const ranHookIds: { event: string; hookIds: string[] }[] = [];
  const runtime: HookRuntime = {
    interactive: true,
    registrations: (): readonly HookRegistration[] => [
      { id: "parent-only", event: "PreToolUse", matcher: "*", class: "observe", handler: { kind: "command", argv: ["x"] }, timeoutMs: 1000, runsIn: "sandbox", network: "none", appliesToChildAgents: false, profiles: [], enabled: true, scope: "project", order: 0 },
    ],
    inheritedHookIds: () => [],
    forChild() {
      // Mirrors the REAL implementation's own filter (enabled &&
      // appliesToChildAgents !== false) so this fake actually exercises the
      // same exclusion the production `HookRuntimeImpl.forChild` performs.
      const childRegs = this.registrations().filter((r) => r.enabled && r.appliesToChildAgents !== false);
      const child: HookRuntime = {
        interactive: false,
        registrations: () => childRegs,
        inheritedHookIds: () => childRegs.map((r) => r.id),
        forChild: () => child,
        fire: async (event) => {
          const matched = childRegs.filter((r) => r.event === event).map((r) => r.id);
          ranHookIds.push({ event, hookIds: matched });
          return { decisions: [], additionalContext: [], records: [], warnings: [], anomalies: [] };
        },
      };
      return child;
    },
    fire: async (event) => {
      const matched = runtime.registrations().filter((r) => r.event === event).map((r) => r.id);
      ranHookIds.push({ event, hookIds: matched });
      return { decisions: [], additionalContext: [], records: [], warnings: [], anomalies: [] };
    },
  };
  const base = stubProvider("unused");
  let requests = 0;
  const provider: ProviderPort = {
    ...base,
    describe: () => ({ ...base.describe(), capabilities: { ...base.describe().capabilities, toolCalls: true } }),
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      requests += 1;
      if (requests === 1) {
        yield { kind: "tool_call_start", sequence: 0, attemptId: opts.attemptId, toolCallId: "c1", toolName: "get_cwd" };
        yield { kind: "tool_call_end", sequence: 1, attemptId: opts.attemptId, toolCallId: "c1", input: "{}" };
      } else {
        yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: "the cwd is /proj" };
      }
      yield { kind: "model_end", sequence: 2, attemptId: opts.attemptId };
    },
  };
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => provider,
    getDetectedProviders: () => [{ name: "ollama" }],
    hooks: runtime,
  });
  await tool.invoke({ task: "Read the cwd", mode: "read_only", label: "cwd-check", max_rounds: 2 });
  // "parent-only" never actually RAN for any fired event — the parent-level
  // brackets only fire SubagentStart/SubagentStop (a different event, so it
  // could never match a PreToolUse registration anyway), and the child's own
  // PreToolUse fire matched zero registrations because `forChild` already
  // excluded it (`appliesToChildAgents: false`).
  expect(ranHookIds.some((r) => r.hookIds.includes("parent-only"))).toBe(false);
  expect(ranHookIds.some((r) => r.event === "PreToolUse")).toBe(true); // the fire still happens...
  expect(ranHookIds.find((r) => r.event === "PreToolUse")?.hookIds).toEqual([]); // ...but with nothing to run
});

test("hooks absent: neither SubagentStart nor SubagentStop ever fires (byte-identical)", async () => {
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => stubProvider("native child answer"),
    getDetectedProviders: () => [{ name: "ollama" }],
  });
  const result = await tool.invoke({ task: "Review auth module", mode: "read_only", label: "auth-check" });
  expect(result.isError).toBe(false);
});
