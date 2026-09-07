import { createSpawnSubagentTool } from "/Users/Goodea/goodea/keryx/src/harness/tool/builtin/spawn-subagent-tool";

const requests: any[] = [];
const fleetEvents: any[] = [];
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
    descriptor: { providerId: "t16-recheck-round-budget" },
  }),
  stream: (request: any, options: { attemptId: string }) => {
    requests.push(request);
    round += 1;
    const callId = `cwd-${round}`;
    return (async function* () {
      yield {
        kind: "tool_call_start",
        sequence: 0,
        attemptId: options.attemptId,
        toolCallId: callId,
        toolName: "get_cwd",
      };
      yield {
        kind: "tool_call_end",
        sequence: 1,
        attemptId: options.attemptId,
        toolCallId: callId,
        input: "{}",
      };
      yield { kind: "model_end", sequence: 2, attemptId: options.attemptId };
    })();
  },
};

let id = 0;
const tool = createSpawnSubagentTool({
  cwd: "/Users/Goodea/goodea/keryx",
  getParentModel: () => ({ providerId: "ollama", modelId: "fixture" }),
  makeProvider: () => provider as any,
  getDetectedProviders: () => [{ name: "ollama" }],
  idSeq: () => `t16-recheck-${id++}`,
  clock: () => "2026-09-06T12:15:00.000Z",
  onFleetEvent: (event) => fleetEvents.push(event),
});

const result = await tool.invoke({
  task: "Call get_cwd once, then continue working.",
  mode: "read_only",
  max_rounds: 1,
});
const actualToolCalls = fleetEvents.filter(
  (event) => event.kind === "log" && event.entry?.kind === "tool",
);

console.log(JSON.stringify({
  configuredMaxRounds: 1,
  providerRequests: requests.length,
  requestSummaries: requests.map((request, index) => ({
    request: index + 1,
    roles: request.messages.map((message: any) => message.role),
    priorToolResults: request.messages.filter((message: any) => message.role === "tool").length,
    finalUserText: request.messages.filter((message: any) => message.role === "user").at(-1)?.content,
  })),
  actualToolInvocations: actualToolCalls.length,
  toolNames: actualToolCalls.map((event) => event.entry.text),
  resultStatus: result.status,
  resultIsError: result.isError,
  reservationLine: result.output.split("\n").find((line) => line.startsWith("MAE reservation:")),
}, null, 2));
