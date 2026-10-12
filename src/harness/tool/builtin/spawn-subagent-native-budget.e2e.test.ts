import { expect, test } from "bun:test";
import { createSpawnSubagentTool, ENV_SUBAGENT_TIMEOUT_MS } from "./spawn-subagent-tool";
import type { NormalizedEvent, NormalizedRequest, ProviderPort, StreamOptions } from "../../provider/types";

// Script only the LLM transport; admission, ledger, child turn and get_cwd are real.
test("native budget/preflight e2e: short reservation fits, snapshots grant nothing, guards remain", async () => {
  const old = process.env[ENV_SUBAGENT_TIMEOUT_MS];
  process.env[ENV_SUBAGENT_TIMEOUT_MS] = "0";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending: ReturnType<ReturnType<typeof createSpawnSubagentTool>["invoke"]>[] = [];
  const requests: NormalizedRequest[] = [];
  let created = 0;
  let entered = 0;
  let reset!: () => void;
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fixture" }),
    getDetectedProviders: () => [{ name: "ollama" }],
    onLedgerReady: (controls) => { reset = controls.resetBudget; },
    makeProvider: (): ProviderPort => {
      created++;
      let round = 0;
      return {
        describe: () => ({ descriptor: { providerId: "fixture" }, capabilities: {
          streaming: true, toolCalls: true, parallelToolCalls: false, structuredOutput: false,
          reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false,
        } }),
        async *stream(request, opts: StreamOptions): AsyncGenerator<NormalizedEvent> {
          requests.push(request);
          if (++round === 1) {
            entered++;
            await gate;
            yield { kind: "tool_call_start", sequence: 0, attemptId: opts.attemptId, toolCallId: "cwd", toolName: "get_cwd" };
            yield { kind: "tool_call_end", sequence: 1, attemptId: opts.attemptId, toolCallId: "cwd", input: "{}" };
          } else {
            const result = request.messages.find((m) => m.role === "tool");
            expect(result?.content).toContain(process.cwd());
            yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: "verified real child cwd" };
          }
          yield { kind: "model_end", sequence: 2, attemptId: opts.attemptId };
        },
      };
    },
  });
  const snapshot = async (extra: Record<string, unknown> = {}) => {
    const result = await tool.invoke({ task: "probe", preflight: true, ...extra });
    expect(result.isError).toBe(false);
    return JSON.parse(result.output);
  };
  const waitFor = async (count: number) => {
    const until = Date.now() + 3000;
    while (entered < count && Date.now() < until) await Bun.sleep(5);
    expect(entered).toBe(count);
  };
  try {
    const initial = await snapshot();
    expect(initial.budget.remainingRuntimeMs).toBe(4800000);
    expect(initial.budget.childCount).toBe(0);
    expect(initial.budget.reservationRuntimeMs).toBe(300000);
    expect(initial.budget.timeoutMs).toBe(0);
    expect(initial.capabilities.tools).toContain("get_cwd");
    expect(initial.capabilities).toMatchObject({ shell: false, testExecution: false, nestedSpawn: false });
    expect(initial.limits.summaryChars).toBe(16000);
    expect(initial.admission).toContain("not checked");
    expect(await snapshot()).toEqual(initial);
    expect(created).toBe(0);
    for (let n = 0; n < 15; n++) pending.push(tool.invoke({ task: "hold default reservation" }));
    pending.push(tool.invoke({ task: "hold 200k", timeout_ms: 200000 }));
    await waitFor(16);
    const tight = await snapshot();
    expect(tight.budget).toMatchObject({ remainingRuntimeMs: 100000, childCount: 16, canReserve: false });
    expect((await tool.invoke({ task: "must refuse default" })).status).toBe("Denied");
    expect((await tool.invoke({ task: "must refuse oversized", timeout_ms: 120000 })).status).toBe("Denied");
    expect(created).toBe(16);
    expect(await snapshot()).toEqual(tight);
    expect((await snapshot({ timeout_ms: 60000 })).budget.canReserve).toBe(true);
    expect((await snapshot({ runtime: { kind: "keryx", timeoutMs: 60000 } })).budget.reservationRuntimeMs).toBe(60000);
    process.env[ENV_SUBAGENT_TIMEOUT_MS] = "90000";
    expect((await snapshot({ timeout_ms: 200000 })).budget).toMatchObject({ reservationRuntimeMs: 90000, timeoutMs: 90000, canReserve: true });
    process.env[ENV_SUBAGENT_TIMEOUT_MS] = "0";
    for (const value of [0, -1, 1.5, NaN, Infinity, "60000", null]) {
      expect((await tool.invoke({ task: "invalid", timeout_ms: value })).status).toBe("Error");
    }
    expect((await tool.invoke({ task: "conflict", timeout_ms: 60000, runtime: { kind: "keryx", timeoutMs: 70000 } })).status).toBe("Error");
    expect((await tool.invoke({ task: "external", preflight: true, runtime: { kind: "external" } })).status).toBe("Error");
    pending.push(tool.invoke({ task: "short native child", runtime: { kind: "keryx", timeoutMs: 60000 } }));
    await waitFor(17);
    expect((await snapshot({ timeout_ms: 60000 })).budget).toMatchObject({ remainingRuntimeMs: 40000, childCount: 17, canReserve: false });
    release();
    const results = await Promise.all(pending);
    for (const result of results) {
      expect(result.status).toBe("Completed");
      expect(result.output).toContain("verified real child cwd");
    }
    expect(requests).toHaveLength(34);
    for (const request of requests) {
      expect(request.tools?.some((t) => ["shell_exec", "spawn_subagent"].includes(t.name))).toBe(false);
    }
    expect((await snapshot()).budget.remainingRuntimeMs).toBeGreaterThan(4700000);
    process.env[ENV_SUBAGENT_TIMEOUT_MS] = "90000";
    const tightened = tool.invoke({ task: "operator-tightened", timeout_ms: 200000 });
    pending.push(tightened);
    await waitFor(18);
    // Child is now fast; its actual reservation is also visible in its returned trace.
    expect((await tightened).output).toContain("runtime≤90000ms");
    reset();
    expect((await snapshot()).budget.childCount).toBe(0);
  } finally {
    release();
    await Promise.allSettled(pending);
    if (old === undefined) delete process.env[ENV_SUBAGENT_TIMEOUT_MS];
    else process.env[ENV_SUBAGENT_TIMEOUT_MS] = old;
  }
});
