import { createSpawnSubagentTool } from "/Users/Goodea/goodea/keryx/src/harness/tool/builtin/spawn-subagent-tool";

const requests: any[] = [];
let round = 0;
const provider = {
  describe: () => ({
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      structuredOutput: false,
      reasoningMetadata: false,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    },
    descriptor: { providerId: "t16-child-offline" },
  }),
  stream: (request: any, options: { attemptId: string }) => {
    requests.push(request);
    round += 1;
    return (async function* () {
      if (round === 1) {
        yield { kind: "tool_call_start", sequence: 0, attemptId: options.attemptId, toolCallId: "cwd", toolName: "get_cwd" };
        yield { kind: "tool_call_end", sequence: 1, attemptId: options.attemptId, toolCallId: "cwd", input: "{}" };
        yield { kind: "tool_call_start", sequence: 2, attemptId: options.attemptId, toolCallId: "list", toolName: "list_dir" };
        yield { kind: "tool_call_end", sequence: 3, attemptId: options.attemptId, toolCallId: "list", input: JSON.stringify({ path: "." }) };
        yield { kind: "model_end", sequence: 4, attemptId: options.attemptId };
      } else {
        yield { kind: "text_delta", sequence: 0, attemptId: options.attemptId, text: "child completed after two tools" };
        yield { kind: "model_end", sequence: 1, attemptId: options.attemptId };
      }
    })();
  },
};

let id = 0;
const tool = createSpawnSubagentTool({
  cwd: "/Users/Goodea/goodea/keryx",
  getParentModel: () => ({ providerId: "ollama", modelId: "fixture" }),
  makeProvider: () => provider as any,
  getDetectedProviders: () => [{ name: "ollama" }],
  idSeq: () => `t16-child-${id++}`,
  clock: () => "2026-09-06T12:00:00.000Z",
});

const result = await tool.invoke({ task: "Use get_cwd and list_dir", mode: "read_only", max_tool_calls: 1 });
const secondRequestToolResults = (requests[1]?.messages ?? []).filter((entry: any) => entry.role === "tool");
console.log(JSON.stringify({
  configuredMaxToolCalls: 1,
  providerRequests: requests.length,
  actualToolResultsBeforeCompletion: secondRequestToolResults.length,
  toolResultIds: secondRequestToolResults.map((entry: any) => entry.toolCallId),
  resultStatus: result.status,
  resultIsError: result.isError,
  reservationLine: result.output.split("\n").find((line) => line.startsWith("MAE reservation:")),
}, null, 2));
