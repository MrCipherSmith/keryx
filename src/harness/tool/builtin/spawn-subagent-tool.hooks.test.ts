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
