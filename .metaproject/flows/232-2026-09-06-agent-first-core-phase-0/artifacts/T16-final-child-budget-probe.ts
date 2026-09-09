/**
 * T16 final independent review — spawn_subagent child budget probe.
 *
 * Deterministic in-memory provider, built-in read tools only. No network, no
 * model API call. Covers dispatch item (6) beyond the two preserved probes:
 *   D1 max_rounds and max_tool_calls set together map to DISTINCT limits
 *   D2 a child finishing inside its round budget is "Completed", not
 *      blanket-mapped to BudgetExhausted
 *   D3 a max_rounds request above MAX_SUBAGENT_MAX_ROUNDS is capped and the
 *      reservation/prompt report the CAPPED value (truthful, not the ask)
 *   D4 max_tool_calls 0 denies every invocation and reports calls<=0
 */
import { createSpawnSubagentTool } from "/Users/Goodea/goodea/keryx/src/harness/tool/builtin/spawn-subagent-tool";

type Script = "tool-every-round" | "tool-then-text";

function makeProbe(script: Script): {
  provider: unknown;
  requests: any[];
  events: any[];
  makeTool: () => ReturnType<typeof createSpawnSubagentTool>;
} {
  const requests: any[] = [];
  const events: any[] = [];
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
      descriptor: { providerId: "t16-final-child" },
    }),
    stream: (request: any, options: { attemptId: string }) => {
      requests.push(request);
      round += 1;
      const emitTool = script === "tool-every-round" || round === 1;
      const callId = `cwd-${round}`;
      return (async function* () {
        if (emitTool) {
          yield { kind: "tool_call_start", sequence: 0, attemptId: options.attemptId, toolCallId: callId, toolName: "get_cwd" };
          yield { kind: "tool_call_end", sequence: 1, attemptId: options.attemptId, toolCallId: callId, input: "{}" };
          yield { kind: "model_end", sequence: 2, attemptId: options.attemptId };
        } else {
          yield { kind: "text_delta", sequence: 0, attemptId: options.attemptId, text: "child finished within budget" };
          yield { kind: "model_end", sequence: 1, attemptId: options.attemptId };
        }
      })();
    },
  };
  let id = 0;
  return {
    provider,
    requests,
    events,
    makeTool: () =>
      createSpawnSubagentTool({
        cwd: "/Users/Goodea/goodea/keryx",
        getParentModel: () => ({ providerId: "ollama", modelId: "fixture" }),
        makeProvider: () => provider as any,
        getDetectedProviders: () => [{ name: "ollama" }],
        idSeq: () => `t16-final-child-${id++}`,
        clock: () => "2026-09-06T13:20:00.000Z",
        onFleetEvent: (event) => events.push(event),
      }),
  };
}

function toolInvocations(events: any[]): string[] {
  return events.filter((e) => e.kind === "log" && e.entry?.kind === "tool").map((e) => e.entry.text);
}

function firstTaskText(requests: any[]): string {
  return requests[0]?.messages?.filter((m: any) => m.role === "user").at(-1)?.content ?? "";
}

const cases: Record<string, unknown> = {};

// ---------------------------------------------------------------- D1
{
  const probe = makeProbe("tool-every-round");
  const result = await probe.makeTool().invoke({
    task: "Call get_cwd repeatedly.",
    mode: "read_only",
    max_rounds: 5,
    max_tool_calls: 2,
  });
  const reservation = result.output.split("\n").find((l) => l.startsWith("MAE reservation:")) ?? "";
  cases.D1_distinct_round_and_call_limits = {
    configured: { max_rounds: 5, max_tool_calls: 2 },
    providerRequests: probe.requests.length,
    invocations: toolInvocations(probe.events).length,
    status: result.status,
    reservationLine: reservation,
    systemInstructionMentions: {
      calls: /You may invoke at most 2 tools in total/.test(probe.requests[0]?.systemInstruction ?? ""),
      rounds: /You have up to 5 model turns/.test(probe.requests[0]?.systemInstruction ?? ""),
    },
    expect: "call cap (2) binds first: requests=2, invocations=2, reservation shows rounds<=5 AND calls<=2",
    pass:
      probe.requests.length === 2 &&
      toolInvocations(probe.events).length === 2 &&
      reservation.includes("rounds≤5") &&
      reservation.includes("calls≤2") &&
      result.status === "BudgetExhausted",
  };
}

// ---------------------------------------------------------------- D2
{
  const probe = makeProbe("tool-then-text");
  const result = await probe.makeTool().invoke({
    task: "Call get_cwd once then summarize.",
    mode: "read_only",
    max_rounds: 3,
  });
  cases.D2_clean_finish_inside_budget_is_Completed = {
    configured: { max_rounds: 3 },
    providerRequests: probe.requests.length,
    invocations: toolInvocations(probe.events).length,
    status: result.status,
    isError: result.isError,
    expect: "requests=2 (< max_rounds), status=Completed, isError=false",
    pass: probe.requests.length === 2 && result.status === "Completed" && result.isError === false,
  };
}

// ---------------------------------------------------------------- D3
{
  const probe = makeProbe("tool-then-text");
  const result = await probe.makeTool().invoke({
    task: "Call get_cwd once then summarize.",
    mode: "read_only",
    max_rounds: 100,
  });
  const reservation = result.output.split("\n").find((l) => l.startsWith("MAE reservation:")) ?? "";
  const task = firstTaskText(probe.requests);
  cases.D3_over_cap_request_is_capped_and_reported_truthfully = {
    requested: 100,
    cap: 24,
    reservationLine: reservation,
    taskTextRoundBudget: /Round budget: 24 rounds/.test(task),
    systemInstructionRounds: /You have up to 24 model turns/.test(probe.requests[0]?.systemInstruction ?? ""),
    promisesTheAsk: /rounds≤100/.test(reservation) || /up to 100 model turns/.test(probe.requests[0]?.systemInstruction ?? ""),
    expect: "every model-facing and result-facing number is 24, never 100",
    pass:
      reservation.includes("rounds≤24") &&
      /Round budget: 24 rounds/.test(task) &&
      /You have up to 24 model turns/.test(probe.requests[0]?.systemInstruction ?? "") &&
      !/100/.test(reservation),
  };
}

// ---------------------------------------------------------------- D4
{
  const probe = makeProbe("tool-every-round");
  const result = await probe.makeTool().invoke({
    task: "Call get_cwd.",
    mode: "read_only",
    max_tool_calls: 0,
  });
  const reservation = result.output.split("\n").find((l) => l.startsWith("MAE reservation:")) ?? "";
  // NOTE: the fleet "tool" log records every ATTEMPTED call by NAME only
  // (measured below), so it is not an invocation counter. Whether `tool.invoke`
  // was reached is proved at the core seam instead — see case C10 in
  // T16-final-core-budget-probe.ts, which counts real invocations directly.
  const entries = probe.events.filter((e) => e.kind === "log" && e.entry?.kind === "tool").map((e) => e.entry.text);
  cases.D4_zero_call_budget_stops_the_child_immediately = {
    configured: { max_tool_calls: 0 },
    providerRequests: probe.requests.length,
    attemptedCallLogEntries: entries,
    status: result.status,
    reservationLine: reservation,
    expect: "requests=1 (no tool result ever returned to the model), status=BudgetExhausted, reservation shows calls<=0",
    pass: probe.requests.length === 1 && result.status === "BudgetExhausted" && reservation.includes("calls≤0"),
  };
}

const failed = Object.entries(cases).filter(([, v]) => (v as { pass: boolean }).pass !== true);
console.log(JSON.stringify({ cases, failedCases: failed.map(([n]) => n), allPassed: failed.length === 0 }, null, 2));
if (failed.length > 0) process.exitCode = 1;
