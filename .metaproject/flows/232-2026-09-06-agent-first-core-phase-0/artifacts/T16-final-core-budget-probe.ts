/**
 * T16 final independent review — core round/call budget probe.
 *
 * Deterministic in-memory provider + in-memory tools only. No network, no
 * model API call, no filesystem writes. Covers the T19 contract cases that the
 * committed focused tests do NOT assert:
 *   C1 text-only completion inside the final allowed round is a CLEAN finish
 *   C2 text-only completion when maxRounds === 1
 *   C3 no-progress wrap-up consumes the last remaining round (exact boundary)
 *   C4 no-progress with no round left makes no wrap-up request
 *   C5 toolless action reprompt at the ceiling issues no extra request
 *   C6 toolless action reprompt with capacity uses one budgeted round
 *   C7 abort mid-batch stops locally with no further provider request
 *   C8 maxToolCalls reason wins over an untouched high maxRounds
 *   C9 maxRounds 0 with an interactive picker still issues no request on cancel
 */
import { runAgentTurn } from "/Users/Goodea/goodea/keryx/src/commands/agent";
import type { AgentDeps, AgentIO } from "/Users/Goodea/goodea/keryx/src/commands/agent";
import type { InteractiveTool } from "/Users/Goodea/goodea/keryx/src/harness/tool/builtin/interactive-tools";
import type {
  NormalizedEvent,
  NormalizedRequest,
  ProviderDescription,
  ProviderPort,
} from "/Users/Goodea/goodea/keryx/src/harness/provider/types";

const DESCRIPTION: ProviderDescription = {
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
  descriptor: { providerId: "t16-final-offline" },
};

type Round = readonly Partial<NormalizedEvent>[];

function scripted(rounds: readonly Round[], fallback?: Round): {
  provider: ProviderPort;
  requests: NormalizedRequest[];
} {
  const requests: NormalizedRequest[] = [];
  let index = 0;
  return {
    requests,
    provider: {
      describe: () => DESCRIPTION,
      stream: (request, options) => {
        requests.push(request);
        const events =
          rounds[index] ?? fallback ?? [{ kind: "text_delta", text: "UNSCRIPTED-EXTRA-REQUEST" }, { kind: "model_end" }];
        index += 1;
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          let sequence = 0;
          for (const event of events) {
            yield { sequence: sequence++, attemptId: options.attemptId, kind: "model_end", ...event } as NormalizedEvent;
          }
        })();
      },
    },
  };
}

function toolRound(id: string, value: string, name = "probe_tool"): Round {
  return [
    { kind: "tool_call_start", toolCallId: id, toolName: name },
    { kind: "tool_call_end", toolCallId: id, input: JSON.stringify({ value }) },
    { kind: "model_end" },
  ];
}

function textRound(text: string): Round {
  return [{ kind: "text_delta", text }, { kind: "model_end" }];
}

function makeTool(record: string[], opts: { fail?: boolean; onInvoke?: () => void } = {}): InteractiveTool {
  return {
    definition: {
      name: "probe_tool",
      description: "in-memory probe",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      record.push(String(input.value));
      opts.onInvoke?.();
      return opts.fail === true
        ? { output: "probe failure: unavailable", isError: true }
        : { output: `ok:${String(input.value)}`, isError: false };
    },
  };
}

function baseDeps(provider: ProviderPort, tools: InteractiveTool[], extra: Partial<AgentDeps>): AgentDeps {
  let id = 0;
  return {
    provider,
    providerId: "t16-final-offline",
    modelId: "fixture",
    tools,
    systemInstruction: "offline probe",
    idSeq: () => `t16f-${id++}`,
    ...extra,
  } as AgentDeps;
}

const cases: Record<string, unknown> = {};

// ---------------------------------------------------------------- C1
{
  const { provider, requests } = scripted([toolRound("c1", "one"), textRound("Final answer inside the last round.")]);
  const invoked: string[] = [];
  const out: string[] = [];
  const sys: string[] = [];
  const io: AgentIO = { write: (s) => out.push(s), onSystem: (s) => sys.push(s) };
  const result = await runAgentTurn(io, baseDeps(provider, [makeTool(invoked)], { maxRounds: 2 }), [], "run the probe");
  cases.C1_text_only_in_final_allowed_round_is_clean = {
    configuredMaxRounds: 2,
    providerRequests: requests.length,
    invocations: invoked.length,
    finishReason: result.finishReason ?? null,
    assistantTextDelivered: out.join("").includes("Final answer inside the last round."),
    budgetNoticeEmitted: /\[budget\]/.test(sys.join("")),
    expect: "requests=2, finishReason=null, text delivered, no [budget] notice",
    pass:
      requests.length === 2 &&
      result.finishReason === undefined &&
      out.join("").includes("Final answer inside the last round.") &&
      !/\[budget\]/.test(sys.join("")),
  };
}

// ---------------------------------------------------------------- C2
{
  const { provider, requests } = scripted([textRound("Answered without tools.")]);
  const invoked: string[] = [];
  const sys: string[] = [];
  const result = await runAgentTurn(
    { write: () => undefined, onSystem: (s) => sys.push(s) },
    baseDeps(provider, [makeTool(invoked)], { maxRounds: 1 }),
    [],
    "run the probe",
  );
  cases.C2_text_only_at_maxRounds_1_is_clean = {
    providerRequests: requests.length,
    finishReason: result.finishReason ?? null,
    budgetNoticeEmitted: /\[budget\]/.test(sys.join("")),
    expect: "requests=1, finishReason=null, no [budget] notice",
    pass: requests.length === 1 && result.finishReason === undefined && !/\[budget\]/.test(sys.join("")),
  };
}

// ---------------------------------------------------------------- C3
// MAX_ATTEMPTS_PER_HASH = 3: rounds 1-3 execute the identical failing call,
// round 4's identical call is denied -> no-progress. maxRounds 5 leaves exactly
// one round for the wrap-up, so total provider requests must be exactly 5.
{
  const same = toolRound("same", "same-input");
  const { provider, requests } = scripted([same, same, same, same], textRound("wrap-up text"));
  const invoked: string[] = [];
  const sys: string[] = [];
  const result = await runAgentTurn(
    { write: () => undefined, onSystem: (s) => sys.push(s) },
    baseDeps(provider, [makeTool(invoked, { fail: true })], { maxRounds: 5 }),
    [],
    "run the probe",
  );
  const wrapUp = requests.at(-1);
  cases.C3_no_progress_wrapup_consumes_last_round = {
    configuredMaxRounds: 5,
    providerRequests: requests.length,
    invocations: invoked.length,
    wrapUpHasNoTools: wrapUp?.tools === undefined,
    finishReason: result.finishReason ?? null,
    wrapUpAsked: /Asking the model for a short wrap-up/.test(sys.join("")),
    expect: "requests=5 (<=maxRounds), last request tool-free, finishReason=no-progress",
    pass:
      requests.length === 5 &&
      wrapUp?.tools === undefined &&
      result.finishReason === "no-progress" &&
      invoked.length === 3,
  };
}

// ---------------------------------------------------------------- C4
{
  const same = toolRound("same", "same-input");
  const { provider, requests } = scripted([same, same, same, same], textRound("UNBUDGETED-WRAPUP"));
  const invoked: string[] = [];
  const sys: string[] = [];
  const result = await runAgentTurn(
    { write: () => undefined, onSystem: (s) => sys.push(s) },
    baseDeps(provider, [makeTool(invoked, { fail: true })], { maxRounds: 4 }),
    [],
    "run the probe",
  );
  cases.C4_no_progress_without_capacity_makes_no_wrapup_request = {
    configuredMaxRounds: 4,
    providerRequests: requests.length,
    finishReason: result.finishReason ?? null,
    localStopNotice: /No model rounds remain for a wrap-up/.test(sys.join("")),
    expect: "requests=4 (== maxRounds), finishReason=no-progress, local stop notice",
    pass:
      requests.length === 4 &&
      result.finishReason === "no-progress" &&
      /No model rounds remain for a wrap-up/.test(sys.join("")),
  };
}

// ---------------------------------------------------------------- C5
{
  const { provider, requests } = scripted([textRound("Checking the probe:")], textRound("UNSCRIPTED-EXTRA"));
  const invoked: string[] = [];
  const result = await runAgentTurn(
    { write: () => undefined, onSystem: () => undefined },
    baseDeps(provider, [makeTool(invoked)], { maxRounds: 1, unattended: true }),
    [],
    "run the probe now",
  );
  cases.C5_toolless_reprompt_at_ceiling_issues_no_extra_request = {
    configuredMaxRounds: 1,
    providerRequests: requests.length,
    finishReason: result.finishReason ?? null,
    expect: "requests=1, finishReason=budget",
    pass: requests.length === 1 && result.finishReason === "budget",
  };
}

// ---------------------------------------------------------------- C6
{
  const { provider, requests } = scripted(
    [textRound("Checking the probe:"), textRound("Done, no tools available.")],
    textRound("UNSCRIPTED-EXTRA"),
  );
  const invoked: string[] = [];
  const result = await runAgentTurn(
    { write: () => undefined, onSystem: () => undefined },
    baseDeps(provider, [makeTool(invoked)], { maxRounds: 2, unattended: true }),
    [],
    "run the probe now",
  );
  cases.C6_toolless_reprompt_with_capacity_uses_one_budgeted_round = {
    configuredMaxRounds: 2,
    providerRequests: requests.length,
    finishReason: result.finishReason ?? null,
    expect: "requests=2 (<= maxRounds), clean finish",
    pass: requests.length === 2 && result.finishReason === undefined,
  };
}

// ---------------------------------------------------------------- C7
{
  const controller = new AbortController();
  const { provider, requests } = scripted(
    [
      [
        { kind: "tool_call_start", toolCallId: "a1", toolName: "probe_tool" },
        { kind: "tool_call_end", toolCallId: "a1", input: JSON.stringify({ value: "first" }) },
        { kind: "tool_call_start", toolCallId: "a2", toolName: "probe_tool" },
        { kind: "tool_call_end", toolCallId: "a2", input: JSON.stringify({ value: "second" }) },
        { kind: "model_end" },
      ],
    ],
    textRound("UNSCRIPTED-EXTRA"),
  );
  const invoked: string[] = [];
  const sys: string[] = [];
  const result = await runAgentTurn(
    { write: () => undefined, onSystem: (s) => sys.push(s) },
    baseDeps(provider, [makeTool(invoked, { onInvoke: () => controller.abort() })], { maxRounds: 10 }),
    [],
    "run the probe",
    { signal: controller.signal },
  );
  cases.C7_abort_mid_batch_stops_locally = {
    providerRequests: requests.length,
    invocations: invoked.length,
    finishReason: result.finishReason ?? null,
    stopNotice: /Model turn interrupted by user/.test(sys.join("")),
    expect: "requests=1, only the first call ran, no wrap-up request",
    pass: requests.length === 1 && invoked.length === 1 && result.finishReason === undefined,
  };
}

// ---------------------------------------------------------------- C8
{
  const { provider, requests } = scripted(
    [toolRound("t1", "one"), toolRound("t2", "two")],
    textRound("UNSCRIPTED-EXTRA"),
  );
  const invoked: string[] = [];
  const result = await runAgentTurn(
    { write: () => undefined, onSystem: () => undefined },
    baseDeps(provider, [makeTool(invoked)], { maxRounds: 10, maxToolCalls: 1, unattended: true }),
    [],
    "run the probe",
  );
  cases.C8_call_budget_reason_independent_of_round_budget = {
    configuredMaxRounds: 10,
    configuredMaxToolCalls: 1,
    providerRequests: requests.length,
    invocations: invoked.length,
    finishReason: result.finishReason ?? null,
    expect: "requests=1, invocations=1, finishReason=tool-call-budget (not budget)",
    pass: requests.length === 1 && invoked.length === 1 && result.finishReason === "tool-call-budget",
  };
}

// ---------------------------------------------------------------- C9
{
  const { provider, requests } = scripted([], textRound("UNSCRIPTED-EXTRA"));
  const invoked: string[] = [];
  const asked: string[] = [];
  const result = await runAgentTurn(
    { write: () => undefined, onSystem: () => undefined },
    baseDeps(provider, [makeTool(invoked)], {
      maxRounds: 0,
      askUser: async (request: { question: string }) => {
        asked.push(request.question);
        return "cancel";
      },
    }),
    [],
    "run the probe",
  );
  cases.C9_zero_rounds_interactive_issues_no_request = {
    providerRequests: requests.length,
    invocations: invoked.length,
    finishReason: result.finishReason ?? null,
    pickerOffers: asked.length,
    expect: "requests=0, invocations=0, finishReason=budget",
    pass: requests.length === 0 && invoked.length === 0 && result.finishReason === "budget",
  };
}

// ---------------------------------------------------------------- C10
// maxToolCalls === 0 is a valid deny-all invocation budget: `tool.invoke` must
// never be reached, and the reason must stay the call-budget one.
{
  const { provider, requests } = scripted([toolRound("z1", "one")], textRound("UNSCRIPTED-EXTRA"));
  const invoked: string[] = [];
  const result = await runAgentTurn(
    { write: () => undefined, onSystem: () => undefined },
    baseDeps(provider, [makeTool(invoked)], { maxRounds: 10, maxToolCalls: 0, unattended: true }),
    [],
    "run the probe",
  );
  cases.C10_zero_call_budget_never_reaches_invoke = {
    configuredMaxToolCalls: 0,
    providerRequests: requests.length,
    invocations: invoked.length,
    finishReason: result.finishReason ?? null,
    expect: "requests=1, invocations=0, finishReason=tool-call-budget",
    pass: requests.length === 1 && invoked.length === 0 && result.finishReason === "tool-call-budget",
  };
}

// ---------------------------------------------------------------- C11
// Truthfulness of the machine-readable terminal reason: an UNATTENDED turn
// that stops for no-progress while round and call capacity both remain.
{
  const same = toolRound("same", "same-input");
  const { provider, requests } = scripted([same, same, same, same], textRound("UNSCRIPTED-EXTRA"));
  const invoked: string[] = [];
  const terminalStates: Array<{ reason: string }> = [];
  const result = await runAgentTurn(
    {
      write: () => undefined,
      onSystem: () => undefined,
      onTerminalState: (state: { reason: string }) => terminalStates.push(state),
    } as unknown as AgentIO,
    baseDeps(provider, [makeTool(invoked, { fail: true })], {
      maxRounds: 20,
      maxToolCalls: 50,
      unattended: true,
    }),
    [],
    "run the probe",
  );
  cases.C11_unattended_no_progress_terminal_reason = {
    configuredMaxRounds: 20,
    configuredMaxToolCalls: 50,
    providerRequests: requests.length,
    roundsRemaining: 20 - requests.length,
    invocations: invoked.length,
    callsRemaining: 50 - invoked.length,
    finishReason: result.finishReason ?? null,
    terminalStateReasons: terminalStates.map((s) => s.reason),
    expect: "finishReason=no-progress; observed terminal reason recorded for review (no assertion)",
    pass: result.finishReason === "no-progress" && terminalStates.length === 1,
  };
}

const failed = Object.entries(cases).filter(([, value]) => (value as { pass: boolean }).pass !== true);
console.log(JSON.stringify({ cases, failedCases: failed.map(([name]) => name), allPassed: failed.length === 0 }, null, 2));
if (failed.length > 0) process.exitCode = 1;
