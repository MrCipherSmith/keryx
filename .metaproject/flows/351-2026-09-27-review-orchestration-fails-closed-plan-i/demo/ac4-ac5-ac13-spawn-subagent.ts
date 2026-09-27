// Flow 347 AC12 demonstration script for AC4/AC5/AC13.
// Drives the REAL spawn_subagent tool in
// src/harness/tool/builtin/spawn-subagent-tool.ts with a scripted child
// provider, copying the scriptedChildProvider/toolCalls/textRound/childTool
// helper patterns from src/harness/tool/builtin/spawn-subagent-tool.test.ts.
//
// Run with: bun run <this file>   (cwd = repo root)

import {
  createSpawnSubagentTool,
  type SpawnSubagentFleetEvent,
} from "../../../../src/harness/tool/builtin/spawn-subagent-tool.ts";
import type {
  NormalizedEvent,
  NormalizedRequest,
  ProviderPort,
  StreamOptions,
} from "../../../../src/harness/provider/types.ts";

const PROBE_CAPABILITIES_T7 = {
  streaming: true,
  toolCalls: true,
  parallelToolCalls: true,
  structuredOutput: false,
  reasoningMetadata: false,
  promptCaching: false,
  vision: false,
  tokenCounting: false,
  modelListing: false,
};

function scriptedChildProvider(
  script: (requestIndex: number) => readonly Partial<NormalizedEvent>[],
): { provider: ProviderPort; requests: NormalizedRequest[] } {
  const requests: NormalizedRequest[] = [];
  return {
    requests,
    provider: {
      describe: () => ({ capabilities: { ...PROBE_CAPABILITIES_T7 }, descriptor: { providerId: "scripted-child" } }),
      async *stream(request, opts: StreamOptions): AsyncGenerator<NormalizedEvent> {
        requests.push(request);
        let sequence = 0;
        for (const event of script(requests.length)) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...event } as NormalizedEvent;
        }
      },
    },
  };
}

function toolCalls(...specs: { id: string; name: string; input?: string }[]): Partial<NormalizedEvent>[] {
  return [
    ...specs.flatMap((s) => [
      { kind: "tool_call_start" as const, toolCallId: s.id, toolName: s.name },
      { kind: "tool_call_end" as const, toolCallId: s.id, input: s.input ?? "{}" },
    ]),
    { kind: "model_end" },
  ];
}

function textRound(text: string): Partial<NormalizedEvent>[] {
  return [{ kind: "text_delta", text }, { kind: "model_end" }];
}

function childTool(provider: ProviderPort, events: SpawnSubagentFleetEvent[], configuredMaxToolCalls?: number) {
  return createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fixture" }),
    makeProvider: () => provider,
    getDetectedProviders: () => [{ name: "ollama" }],
    onFleetEvent: (event) => events.push(event),
    ...(configuredMaxToolCalls !== undefined ? { configuredMaxToolCalls } : {}),
  });
}

function toolMessages(request: NormalizedRequest | undefined): string[] {
  return (request?.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content);
}

function lastUpsert(events: SpawnSubagentFleetEvent[]): Extract<SpawnSubagentFleetEvent, { kind: "upsert" }> | undefined {
  const upserts = events.filter((e): e is Extract<SpawnSubagentFleetEvent, { kind: "upsert" }> => e.kind === "upsert");
  return upserts[upserts.length - 1];
}

async function scenarioAdvisory(): Promise<void> {
  console.log("\n=== Scenario A (AC4/AC13): model-supplied max_tool_calls: 3 is advisory; child makes 5 calls, not stopped ===");
  const events: SpawnSubagentFleetEvent[] = [];
  const paths = ["a", "b", "c", "d", "e"];
  const { provider, requests } = scriptedChildProvider((n) =>
    n <= paths.length
      ? toolCalls({ id: `t${n}`, name: "list_dir", input: JSON.stringify({ path: paths[n - 1] }) })
      : textRound("completed after five calls"),
  );
  const result = await childTool(provider, events).invoke({ task: "explore", max_tool_calls: 3, max_rounds: 20 });

  console.log(`child NOT stopped -- result.status: ${result.status} (expected "Completed")`);
  console.log(`requests made: ${requests.length} (5 tool-call rounds + 1 text round = 6)`);
  const lastResults = toolMessages(requests[requests.length - 1]);
  console.log(`tool results seen by child in the final tool-bearing request: ${lastResults.length}`);
  const warned = lastResults.map((c) => c.includes("Return your result now."));
  console.log(`80% budget-warning line present per result: ${JSON.stringify(warned)}`);
  const warnLine = lastResults.find((c) => c.includes("Return your result now."));
  console.log(`--- example warning line seen by the child ---\n${warnLine?.split("\n").filter((l) => l.includes("Return your result now."))[0]}`);
  console.log(`output first line: ${JSON.stringify(result.output.split("\n")[0])}`);
  console.log(`fleet event status: ${lastUpsert(events)?.status} (expected "done")`);
}

async function scenarioHardCap(): Promise<void> {
  console.log("\n=== Scenario B (AC4/AC5): operator-configured hard cap (configuredMaxToolCalls: 3) stops the child ===");
  const events: SpawnSubagentFleetEvent[] = [];
  const { provider, requests } = scriptedChildProvider((n) =>
    n === 1
      ? toolCalls(
          { id: "a", name: "list_dir", input: '{"path":"a"}' },
          { id: "b", name: "list_dir", input: '{"path":"b"}' },
          { id: "c", name: "list_dir", input: '{"path":"c"}' },
        )
      : toolCalls({
          id: "submit",
          name: "submit_result",
          input: JSON.stringify({ status: "partial", summary: "read three listings", result: { findings: ["F-1", "F-2"] } }),
        }),
  );
  // configuredMaxToolCalls (or KERYX_SUBAGENT_MAX_TOOL_CALLS) is the documented
  // hard-cap config setting per AC4; here passed via the dependency injection
  // point the CLI env var resolves to (resolveSubagentMaxToolCalls).
  const result = await childTool(provider, events, 3).invoke({ task: "review", max_tool_calls: 40 });

  console.log(`requests made: ${requests.length} (expected 2: the tool-call round + the wrap-up round)`);
  const wrapUp = requests[1];
  console.log(`final request tools offered: ${JSON.stringify(wrapUp?.tools?.map((t) => t.name))} (expected only submit_result)`);
  console.log(`result.status: ${result.status} (expected "BudgetExhausted")`);
  const [firstLine, ...rest] = result.output.split("\n");
  console.log(`output first line: ${JSON.stringify(firstLine)}`);
  console.log(`--- full parent-visible output ---\n${result.output}`);
  const final = lastUpsert(events);
  console.log(`fleet event status: ${final?.status} (expected NOT "done")`);
  console.log(`fleet event detail: ${final?.detail}`);
}

await scenarioAdvisory();
await scenarioHardCap();
