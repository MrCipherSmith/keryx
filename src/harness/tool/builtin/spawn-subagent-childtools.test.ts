// review-regression-w8:F-001: `deps.childTools(cwd)` runs after the MAE reservation is taken and
// SubagentStart has fired. A refusal from it (native-runtime rejects a cwd other than its own) must
// give both back, the way the hook-deny branch does, instead of leaking them.
import { expect, test } from "bun:test";
import {
  createSpawnSubagentTool,
  DEFAULT_SUBAGENT_LEDGER_RUNTIME_MS,
  SUBAGENT_CHILD_RESERVATION_MS,
} from "./spawn-subagent-tool";
import type { HookFireResult, HookRegistration, HookRuntime } from "../../hooks";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../../provider/types";

function stubProvider(): ProviderPort {
  return {
    describe: () => ({
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
    }),
    async *stream(_req, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: "ok" };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

function recordingHooks(): { runtime: HookRuntime; fires: string[] } {
  const fires: string[] = [];
  const runtime: HookRuntime = {
    interactive: true,
    registrations: (): readonly HookRegistration[] => [],
    inheritedHookIds: () => [],
    forChild: () => runtime,
    fire: async (event): Promise<HookFireResult> => {
      fires.push(event);
      return { decisions: [], additionalContext: [], records: [], warnings: [], anomalies: [] };
    },
  };
  return { runtime, fires };
}

test("a childTools refusal returns an Error result, balances SubagentStart and releases the reservation", async () => {
  const { runtime, fires } = recordingHooks();
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => stubProvider(),
    getDetectedProviders: () => [{ name: "ollama" }],
    hooks: runtime,
    childTools: () => {
      throw new Error("native-child-checkout-mismatch");
    },
  });

  const first = await tool.invoke({ task: "look", mode: "read_only", label: "first" });
  expect(first.isError).toBe(true);
  expect(first.status).toBe("Error");
  expect(first.output).toContain("native-child-checkout-mismatch");
  expect(fires.filter((e) => e === "SubagentStart")).toHaveLength(1);
  expect(fires.filter((e) => e === "SubagentStop")).toHaveLength(1);

  // The pool holds exactly DEFAULT_SUBAGENT_LEDGER_RUNTIME_MS / reservation admissions; a leaked
  // reservation would starve the loop before its end (admission denied before SubagentStart fires).
  const rounds = DEFAULT_SUBAGENT_LEDGER_RUNTIME_MS / SUBAGENT_CHILD_RESERVATION_MS;
  for (let i = 0; i < rounds; i++) {
    const result = await tool.invoke({ task: "again", mode: "read_only", label: `again-${i}` });
    expect(result.output).toContain("native-child-checkout-mismatch");
  }
  expect(fires.filter((e) => e === "SubagentStart")).toHaveLength(1 + rounds);
  expect(fires.filter((e) => e === "SubagentStop")).toHaveLength(1 + rounds);
});
