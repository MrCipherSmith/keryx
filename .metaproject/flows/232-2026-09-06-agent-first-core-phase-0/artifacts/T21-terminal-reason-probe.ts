/**
 * T21 independent review — asserting probe for the T16-final major (F-001)
 * and the three genuine budget/ask_user stop reasons.
 *
 * Unlike the reviewer's own C11 case in T16-final-core-budget-probe.ts (which
 * records `terminalStateReasons` for review WITHOUT asserting it — its own
 * `expect` string says so explicitly), every case here has a hard assertion
 * on the emitted `TerminalState.reason`. This is deliberately a SEPARATE
 * probe, not an edit to the preserved T16-final-core-budget-probe.ts (which
 * must stay unchanged per the dispatch).
 *
 * Dual-mode: by default it imports `runAgentTurn` from this repo's own
 * `src/commands/agent.ts` (working tree, untouched). Set
 * `T21_AGENT_MODULE_URL` to a `file://` URL pointing at an alternate copy
 * (e.g. a scratch directory with the F-001 fix manually reverted) to prove
 * the regression genuinely depends on the production change — see
 * `T21-review.md`'s revert-experiment section for how this is invoked
 * against a scratch copy. Read-only: this script itself is never edited
 * between the two invocations, only the module URL changes.
 *
 * Deterministic in-memory provider + in-memory tool only. No network, no
 * model API call, no filesystem writes, no working-tree edits.
 */
const agentModuleUrl =
  process.env.T21_AGENT_MODULE_URL ?? "file:///Users/Goodea/goodea/keryx/src/commands/agent.ts";

const { runAgentTurn } = (await import(agentModuleUrl)) as typeof import(
  "/Users/Goodea/goodea/keryx/src/commands/agent"
);

type NormalizedEventPartial = Record<string, unknown>;

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
  descriptor: { providerId: "t21-offline" },
};

type Round = readonly NormalizedEventPartial[];

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
    providerId: "t21-offline",
    modelId: "fixture",
    tools,
    systemInstruction: "offline probe",
    idSeq: () => `t21-${id++}`,
    ...extra,
  };
}

const cases: Record<string, unknown> = {};

// ---------------------------------------------------------------- T21-A
// The major: an UNATTENDED no-progress stop (round & call budgets both have
// capacity) must report "no_progress", NOT "budget_exhausted". This is the
// same scenario as the reviewer's C11, but with a hard assertion.
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
    } as never,
    baseDeps(provider, [makeTool(invoked, { fail: true })], {
      maxRounds: 20,
      maxToolCalls: 50,
      unattended: true,
    }) as never,
    [],
    "run the probe",
  );
  const reasons = terminalStates.map((s) => s.reason);
  cases.T21A_no_progress_reports_no_progress_not_budget_exhausted = {
    providerRequests: requests.length,
    invocations: invoked.length,
    roundsRemaining: 20 - requests.length,
    callsRemaining: 50 - invoked.length,
    finishReason: result.finishReason ?? null,
    terminalStateReasons: reasons,
    pass:
      result.finishReason === "no-progress" &&
      requests.length < 20 &&
      invoked.length < 50 &&
      reasons.length === 1 &&
      reasons[0] === "no_progress" &&
      reasons[0] !== "budget_exhausted",
  };
}

// ---------------------------------------------------------------- T21-B
// The genuine round-budget stop must still report "budget_exhausted".
{
  const { provider, requests } = scripted([toolRound("b1", "one")], textRound("UNSCRIPTED-EXTRA"));
  const invoked: string[] = [];
  const terminalStates: Array<{ reason: string }> = [];
  const result = await runAgentTurn(
    {
      write: () => undefined,
      onSystem: () => undefined,
      onTerminalState: (state: { reason: string }) => terminalStates.push(state),
    } as never,
    baseDeps(provider, [makeTool(invoked)], { maxRounds: 1, unattended: true }) as never,
    [],
    "run the probe",
  );
  const reasons = terminalStates.map((s) => s.reason);
  cases.T21B_round_budget_stop_reports_budget_exhausted = {
    providerRequests: requests.length,
    finishReason: result.finishReason ?? null,
    terminalStateReasons: reasons,
    pass: requests.length === 1 && reasons.length === 1 && reasons[0] === "budget_exhausted",
  };
}

// ---------------------------------------------------------------- T21-C
// The genuine tool-call-budget stop must still report
// "tool_call_budget_exhausted".
{
  const { provider, requests } = scripted([toolRound("c1", "one"), toolRound("c2", "two")], textRound("UNSCRIPTED-EXTRA"));
  const invoked: string[] = [];
  const terminalStates: Array<{ reason: string }> = [];
  const result = await runAgentTurn(
    {
      write: () => undefined,
      onSystem: () => undefined,
      onTerminalState: (state: { reason: string }) => terminalStates.push(state),
    } as never,
    baseDeps(provider, [makeTool(invoked)], { maxRounds: 10, maxToolCalls: 1, unattended: true }) as never,
    [],
    "run the probe",
  );
  const reasons = terminalStates.map((s) => s.reason);
  cases.T21C_tool_call_budget_stop_reports_tool_call_budget_exhausted = {
    providerRequests: requests.length,
    invocations: invoked.length,
    finishReason: result.finishReason ?? null,
    terminalStateReasons: reasons,
    pass:
      result.finishReason === "tool-call-budget" &&
      reasons.length === 1 &&
      reasons[0] === "tool_call_budget_exhausted",
  };
}

// ---------------------------------------------------------------- T21-D
// The ask_user interception (unattended) must still report
// "ask_user_unanswerable".
{
  const askUserRound: Round = [
    { kind: "tool_call_start", toolCallId: "d1", toolName: "ask_user" },
    { kind: "tool_call_end", toolCallId: "d1", input: JSON.stringify({ question: "which one?" }) },
    { kind: "model_end" },
  ];
  const { provider, requests } = scripted([askUserRound], textRound("UNSCRIPTED-EXTRA"));
  const terminalStates: Array<{ reason: string }> = [];
  const result = await runAgentTurn(
    {
      write: () => undefined,
      onSystem: () => undefined,
      onTerminalState: (state: { reason: string }) => terminalStates.push(state),
    } as never,
    baseDeps(provider, [], { maxRounds: 10, unattended: true }) as never,
    [],
    "run the probe",
  );
  const reasons = terminalStates.map((s) => s.reason);
  cases.T21D_ask_user_stop_reports_ask_user_unanswerable = {
    providerRequests: requests.length,
    finishReason: result.finishReason ?? null,
    terminalStateReasons: reasons,
    pass: requests.length === 1 && reasons.length === 1 && reasons[0] === "ask_user_unanswerable",
  };
}

const failed = Object.entries(cases).filter(([, value]) => (value as { pass: boolean }).pass !== true);
console.log(
  JSON.stringify(
    { agentModuleUrl, cases, failedCases: failed.map(([name]) => name), allPassed: failed.length === 0 },
    null,
    2,
  ),
);
if (failed.length > 0) process.exitCode = 1;
