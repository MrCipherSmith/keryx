/**
 * T10 aggregate acceptance review — independent budget probe for AC3.
 *
 * Written from scratch by the T10 reviewer; it is NOT a rerun of
 * T16-final-core-budget-probe.ts or T21-terminal-reason-probe.ts. Every case
 * carries a hard assertion on the observable outcome (provider request count,
 * actual tool invocation count, finishReason, emitted TerminalState.reason).
 *
 * Deterministic in-memory provider + in-memory tools only. No network, no
 * model API call, no filesystem writes, no working-tree edits.
 */
const { runAgentTurn } = await import("/Users/Goodea/goodea/keryx/src/commands/agent");

type Event = Record<string, unknown>;
type Round = readonly Event[];

const DESCRIPTION = {
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
  descriptor: { providerId: "t10-offline" },
};

function scripted(rounds: readonly Round[], fallback?: Round) {
  const requests: unknown[] = [];
  let index = 0;
  return {
    requests,
    provider: {
      describe: () => DESCRIPTION,
      stream: (request: unknown, options: { attemptId: string }) => {
        requests.push(request);
        const events =
          rounds[index] ?? fallback ?? [{ kind: "text_delta", text: "UNSCRIPTED-EXTRA-REQUEST" }, { kind: "model_end" }];
        index += 1;
        return (async function* () {
          let sequence = 0;
          for (const event of events) {
            yield { sequence: sequence++, attemptId: options.attemptId, kind: "model_end", ...event };
          }
        })();
      },
    },
  };
}

function toolRound(id: string, value: string): Round {
  return [
    { kind: "tool_call_start", toolCallId: id, toolName: "probe_tool" },
    { kind: "tool_call_end", toolCallId: id, input: JSON.stringify({ value }) },
    { kind: "model_end" },
  ];
}

/** Two independent tool calls emitted inside ONE model round. */
function twoToolRound(prefix: string): Round {
  return [
    { kind: "tool_call_start", toolCallId: `${prefix}a`, toolName: "probe_tool" },
    { kind: "tool_call_end", toolCallId: `${prefix}a`, input: JSON.stringify({ value: `${prefix}-a` }) },
    { kind: "tool_call_start", toolCallId: `${prefix}b`, toolName: "probe_tool" },
    { kind: "tool_call_end", toolCallId: `${prefix}b`, input: JSON.stringify({ value: `${prefix}-b` }) },
    { kind: "model_end" },
  ];
}

function textRound(text: string): Round {
  return [{ kind: "text_delta", text }, { kind: "model_end" }];
}

function makeTool(record: string[], opts: { fail?: boolean } = {}) {
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
    invoke: async (input: { value: string }) => {
      record.push(String(input.value));
      return opts.fail === true
        ? { output: "probe failure: unavailable", isError: true }
        : { output: `ok:${String(input.value)}`, isError: false };
    },
  };
}

function baseDeps(provider: unknown, tools: unknown[], extra: Record<string, unknown>) {
  let id = 0;
  return {
    provider,
    providerId: "t10-offline",
    modelId: "fixture",
    tools,
    systemInstruction: "offline probe",
    idSeq: () => `t10-${id++}`,
    ...extra,
  };
}

type CaseRun = {
  providerRequests: number;
  invocations: number;
  finishReason: string | null;
  terminalStateReasons: string[];
};

async function run(
  rounds: readonly Round[],
  deps: Record<string, unknown>,
  opts: { fail?: boolean; noTools?: boolean } = {},
): Promise<CaseRun> {
  const { provider, requests } = scripted(rounds, textRound("UNSCRIPTED-EXTRA-REQUEST"));
  const invoked: string[] = [];
  const terminalStates: Array<{ reason: string }> = [];
  const tools = opts.noTools === true ? [] : [makeTool(invoked, { fail: opts.fail === true })];
  const result = await runAgentTurn(
    {
      write: () => undefined,
      onSystem: () => undefined,
      onTerminalState: (state: { reason: string }) => terminalStates.push(state),
    } as never,
    baseDeps(provider, tools, deps) as never,
    [],
    "run the probe",
  );
  return {
    providerRequests: requests.length,
    invocations: invoked.length,
    finishReason: (result as { finishReason?: string }).finishReason ?? null,
    terminalStateReasons: terminalStates.map((s) => s.reason),
  };
}

const cases: Record<string, unknown> = {};
const same = toolRound("same", "same-input");

// C1 — the configured MODEL-ROUND ceiling is inclusive of every provider
// request: with maxRounds=3 and an endlessly tool-calling model, exactly 3
// provider requests are spent and the stop reason is the round budget.
{
  const r = await run([same, same, same, same, same], { maxRounds: 3, unattended: true });
  cases.C1_round_ceiling_is_inclusive_of_every_request = {
    ...r,
    expected: "providerRequests === 3, finishReason 'budget', reason 'budget_exhausted'",
    pass:
      r.providerRequests === 3 &&
      r.finishReason === "budget" &&
      r.terminalStateReasons.length === 1 &&
      r.terminalStateReasons[0] === "budget_exhausted",
  };
}

// C2 — maxRounds=0 spends NO provider request at all (a ceiling of zero is
// honoured rather than rounded up to one).
{
  const r = await run([same], { maxRounds: 0, unattended: true });
  cases.C2_zero_rounds_makes_no_request = {
    ...r,
    expected: "providerRequests === 0, reason 'budget_exhausted'",
    pass:
      r.providerRequests === 0 &&
      r.finishReason === "budget" &&
      r.terminalStateReasons[0] === "budget_exhausted",
  };
}

// C3 — attended round-limit stop with no picker wired: still bounded by the
// same inclusive ceiling and still makes no extra provider request.
{
  const r = await run([same, same, same], { maxRounds: 2 });
  cases.C3_attended_round_ceiling_also_inclusive = {
    ...r,
    expected: "providerRequests === 2, finishReason 'budget', no terminal state (attended)",
    pass: r.providerRequests === 2 && r.finishReason === "budget" && r.terminalStateReasons.length === 0,
  };
}

// C4 — the ROUND ceiling covers the no-progress wrap-up request too: with a
// repeatedly failing identical signature and a generous round budget, the
// wrap-up is a provider request and total requests never exceed maxRounds.
{
  const r = await run([same, same, same, same, same, same, same, same], { maxRounds: 6 }, { fail: true });
  cases.C4_wrapup_request_stays_inside_round_ceiling = {
    ...r,
    expected: "providerRequests <= 6, finishReason 'no-progress'",
    pass: r.providerRequests <= 6 && r.finishReason === "no-progress",
  };
}

// C5 — maxToolCalls is INDEPENDENT of maxRounds and is not represented by it:
// one call allowed out of two offered in the SAME round; the round budget is
// nowhere near exhausted when the stop happens, and the reason names the
// tool-call budget.
{
  const r = await run([twoToolRound("x"), twoToolRound("y")], {
    maxRounds: 10,
    maxToolCalls: 1,
    unattended: true,
  });
  cases.C5_tool_call_cap_is_independent_of_rounds = {
    ...r,
    roundsRemaining: 10 - r.providerRequests,
    expected:
      "invocations === 1, finishReason 'tool-call-budget', reason 'tool_call_budget_exhausted', providerRequests < 10",
    pass:
      r.invocations === 1 &&
      r.providerRequests < 10 &&
      r.finishReason === "tool-call-budget" &&
      r.terminalStateReasons.length === 1 &&
      r.terminalStateReasons[0] === "tool_call_budget_exhausted",
  };
}

// C6 — a tool-call cap spanning several rounds stops at the configured number
// of ACTUAL invocations, not at a round count.
{
  const r = await run(
    [toolRound("a", "1"), toolRound("b", "2"), toolRound("c", "3"), toolRound("d", "4")],
    { maxRounds: 20, maxToolCalls: 3, unattended: true },
  );
  cases.C6_multi_round_call_cap_counts_invocations = {
    ...r,
    expected: "invocations === 3, providerRequests < 20, reason 'tool_call_budget_exhausted'",
    pass:
      r.invocations === 3 &&
      r.providerRequests < 20 &&
      r.finishReason === "tool-call-budget" &&
      r.terminalStateReasons[0] === "tool_call_budget_exhausted",
  };
}

// C7 — maxToolCalls=0 blocks every invocation and is not silently ignored.
{
  const r = await run([same, same], { maxRounds: 10, maxToolCalls: 0, unattended: true });
  cases.C7_zero_call_budget_blocks_every_invocation = {
    ...r,
    expected: "invocations === 0, reason 'tool_call_budget_exhausted'",
    pass:
      r.invocations === 0 &&
      r.finishReason === "tool-call-budget" &&
      r.terminalStateReasons[0] === "tool_call_budget_exhausted",
  };
}

// C8 — with no tool-call cap configured, the tool budget never fires and the
// turn finishes normally (guards against a cap that is always on).
{
  const r = await run([toolRound("n", "1"), textRound("done")], { maxRounds: 10, unattended: true });
  cases.C8_absent_call_budget_never_fires = {
    ...r,
    expected: "invocations === 1, no terminal state, finishReason null",
    pass: r.invocations === 1 && r.terminalStateReasons.length === 0 && r.finishReason === null,
  };
}

// C9 — a stop with BOTH budgets holding capacity must not claim budget
// exhaustion (the T16-final major; verified here independently).
{
  const r = await run([same, same, same, same, same], { maxRounds: 20, maxToolCalls: 50, unattended: true }, { fail: true });
  cases.C9_non_budget_stop_reports_no_progress = {
    ...r,
    roundsRemaining: 20 - r.providerRequests,
    callsRemaining: 50 - r.invocations,
    expected: "reason 'no_progress' with both budgets unexhausted",
    pass:
      r.providerRequests < 20 &&
      r.invocations < 50 &&
      r.finishReason === "no-progress" &&
      r.terminalStateReasons.length === 1 &&
      r.terminalStateReasons[0] === "no_progress",
  };
}

// C10 — an invalid tool-call budget is rejected loudly rather than dropped.
{
  let thrown: string | null = null;
  try {
    await run([same], { maxRounds: 5, maxToolCalls: -1, unattended: true });
  } catch (error) {
    thrown = error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
  }
  cases.C10_invalid_call_budget_throws = {
    thrown,
    expected: "RangeError naming maxToolCalls",
    pass: thrown !== null && thrown.includes("RangeError") && thrown.includes("maxToolCalls"),
  };
}

const failed = Object.entries(cases).filter(([, value]) => (value as { pass: boolean }).pass !== true);
console.log(JSON.stringify({ cases, failedCases: failed.map(([name]) => name), allPassed: failed.length === 0 }, null, 2));
if (failed.length > 0) process.exitCode = 1;
