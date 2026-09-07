import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type {
  NormalizedEvent,
  NormalizedRequest,
  ProviderDescription,
  ProviderPort,
} from "../harness/provider/types";
import type { TerminalState } from "../session/slate-terminal-state";

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
  descriptor: { providerId: "offline-budget-stub" },
};

function scriptedProvider(rounds: readonly (readonly Partial<NormalizedEvent>[])[]): {
  provider: ProviderPort;
  requests: NormalizedRequest[];
} {
  const requests: NormalizedRequest[] = [];
  let round = 0;
  return {
    requests,
    provider: {
      describe: () => DESCRIPTION,
      stream: (request, options) => {
        requests.push(request);
        const events = rounds[round] ?? [{ kind: "text_delta", text: "unexpected extra round" }];
        round += 1;
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          let sequence = 0;
          for (const event of events) {
            yield {
              sequence: sequence++,
              attemptId: options.attemptId,
              kind: "model_end",
              ...event,
            } as NormalizedEvent;
          }
        })();
      },
    },
  };
}

function threeCallsInOneRound(): Partial<NormalizedEvent>[] {
  return [
    { kind: "tool_call_start", toolCallId: "call-1", toolName: "budget_probe" },
    { kind: "tool_call_end", toolCallId: "call-1", input: JSON.stringify({ value: "one" }) },
    { kind: "tool_call_start", toolCallId: "call-2", toolName: "budget_probe" },
    { kind: "tool_call_end", toolCallId: "call-2", input: JSON.stringify({ value: "two" }) },
    { kind: "tool_call_start", toolCallId: "call-3", toolName: "budget_probe" },
    { kind: "tool_call_end", toolCallId: "call-3", input: JSON.stringify({ value: "three" }) },
    { kind: "model_end" },
  ];
}

test("runAgentTurn stops at maxToolCalls inside one provider round and reports a tool-call budget terminal reason", async () => {
  const { provider, requests } = scriptedProvider([
    threeCallsInOneRound(),
    [{ kind: "text_delta", text: "the call cap was ignored" }, { kind: "model_end" }],
  ]);
  const invoked: string[] = [];
  const probe: InteractiveTool = {
    definition: {
      name: "budget_probe",
      description: "records one real tool invocation",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      invoked.push(String(input.value));
      return { output: `invoked:${String(input.value)}`, isError: false };
    },
  };
  let id = 0;
  const deps = {
    provider,
    providerId: "offline-budget-stub",
    modelId: "fixture",
    tools: [probe],
    systemInstruction: "Use the local probe only.",
    idSeq: () => `budget-${id++}`,
    maxRounds: 20,
    maxToolCalls: 2,
    unattended: true,
  } as AgentDeps;

  const result = await runAgentTurn({ write: () => undefined }, deps, [], "run all three probes");

  expect(invoked).toEqual(["one", "two"]);
  expect(requests).toHaveLength(1);
  expect(result.finishReason as string | undefined).toBe("tool-call-budget");
});

test("maxToolCalls counts actual invocations rather than relabeling maxRounds", async () => {
  const { provider } = scriptedProvider([
    threeCallsInOneRound(),
    [{ kind: "text_delta", text: "finished" }, { kind: "model_end" }],
  ]);
  let invocations = 0;
  const probe: InteractiveTool = {
    definition: {
      name: "budget_probe",
      description: "counts invocations",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async () => {
      invocations += 1;
      return { output: "ok", isError: false };
    },
  };
  let id = 0;
  const deps = {
    provider,
    providerId: "offline-budget-stub",
    modelId: "fixture",
    tools: [probe],
    systemInstruction: "Use the local probe only.",
    idSeq: () => `budget-distinct-${id++}`,
    maxRounds: 1,
    maxToolCalls: 2,
    unattended: true,
  } as AgentDeps;

  await runAgentTurn({ write: () => undefined }, deps, [], `inspect ${tmpdir()}`);

  expect(invocations).toBe(2);
});

test("invalid direct round and tool-call limits fail before provider, approval, or tool activity", async () => {
  for (const invalid of [
    { maxToolCalls: -1 },
    { maxToolCalls: 1.5 },
    { maxToolCalls: Number.NaN },
    { maxRounds: -1 },
    { maxRounds: 1.5 },
  ] satisfies Array<Partial<AgentDeps>>) {
    const { provider, requests } = scriptedProvider([threeCallsInOneRound()]);
    let approvals = 0;
    let invocations = 0;
    const probe: InteractiveTool = {
      definition: {
        name: "budget_probe",
        description: "must remain inert for invalid limits",
        inputSchema: { type: "object", properties: {} },
        risk: "read",
      },
      invoke: async () => {
        invocations += 1;
        return { output: "unexpected", isError: false };
      },
    };
    const deps: AgentDeps = {
      provider,
      providerId: "offline-budget-stub",
      modelId: "fixture",
      tools: [probe],
      systemInstruction: "offline",
      idSeq: () => "invalid-budget",
      ...invalid,
    };

    await expect(
      runAgentTurn(
        {
          write: () => undefined,
          requestApproval: async () => {
            approvals += 1;
            return true;
          },
        },
        deps,
        [],
        "run the probe",
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(requests).toHaveLength(0);
    expect(approvals).toBe(0);
    expect(invocations).toBe(0);
  }
});

test("unknown and approval-denied calls do not consume maxToolCalls before a real invocation", async () => {
  const { provider, requests } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "unknown", toolName: "missing_tool" },
      { kind: "tool_call_end", toolCallId: "unknown", input: "{}" },
      { kind: "tool_call_start", toolCallId: "denied", toolName: "guarded_probe" },
      { kind: "tool_call_end", toolCallId: "denied", input: "{}" },
      { kind: "tool_call_start", toolCallId: "allowed", toolName: "budget_probe" },
      { kind: "tool_call_end", toolCallId: "allowed", input: JSON.stringify({ value: "real" }) },
      { kind: "model_end" },
    ],
  ]);
  const invoked: string[] = [];
  const tools: InteractiveTool[] = [
    {
      definition: {
        name: "guarded_probe",
        description: "requires approval",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        risk: "shell",
      },
      invoke: async () => {
        invoked.push("denied");
        return { output: "unexpected", isError: false };
      },
    },
    {
      definition: {
        name: "budget_probe",
        description: "records a real invocation",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        risk: "read",
      },
      invoke: async (input) => {
        invoked.push(String(input.value));
        return { output: "ok", isError: false };
      },
    },
  ];
  let approvals = 0;
  const result = await runAgentTurn(
    {
      write: () => undefined,
      requestApproval: async () => {
        approvals += 1;
        return false;
      },
    },
    {
      provider,
      providerId: "offline-budget-stub",
      modelId: "fixture",
      tools,
      systemInstruction: "offline",
      idSeq: fixedId(),
      maxRounds: 20,
      maxToolCalls: 1,
      unattended: true,
    },
    [],
    "run the allowed probe after rejected calls",
  );

  expect(invoked).toEqual(["real"]);
  expect(approvals).toBe(1);
  expect(requests).toHaveLength(1);
  expect(result.finishReason).toBe("tool-call-budget");
});

test("maxToolCalls accumulates actual invocations across provider rounds", async () => {
  const { provider, requests } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "round-1", toolName: "budget_probe" },
      { kind: "tool_call_end", toolCallId: "round-1", input: JSON.stringify({ value: "one" }) },
      { kind: "model_end" },
    ],
    [
      { kind: "tool_call_start", toolCallId: "round-2", toolName: "budget_probe" },
      { kind: "tool_call_end", toolCallId: "round-2", input: JSON.stringify({ value: "two" }) },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "unexpected third round" }, { kind: "model_end" }],
  ]);
  const invoked: string[] = [];
  const probe: InteractiveTool = {
    definition: {
      name: "budget_probe",
      description: "records invocations across rounds",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      invoked.push(String(input.value));
      return { output: "ok", isError: false };
    },
  };

  const result = await runAgentTurn(
    { write: () => undefined },
    {
      provider,
      providerId: "offline-budget-stub",
      modelId: "fixture",
      tools: [probe],
      systemInstruction: "offline",
      idSeq: fixedId(),
      maxRounds: 20,
      maxToolCalls: 2,
      unattended: true,
    },
    [],
    "run two probes",
  );

  expect(invoked).toEqual(["one", "two"]);
  expect(requests).toHaveLength(2);
  expect(result.finishReason).toBe("tool-call-budget");
});

test("maxRounds is an inclusive provider-round cap with no excess tool or wrap-up request", async () => {
  const { provider, requests } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "allowed", toolName: "budget_probe" },
      { kind: "tool_call_end", toolCallId: "allowed", input: JSON.stringify({ value: "one" }) },
      { kind: "model_end" },
    ],
    [
      { kind: "tool_call_start", toolCallId: "excess", toolName: "budget_probe" },
      { kind: "tool_call_end", toolCallId: "excess", input: JSON.stringify({ value: "two" }) },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "unbudgeted wrap-up" }, { kind: "model_end" }],
  ]);
  const invoked: string[] = [];
  const probe: InteractiveTool = {
    definition: {
      name: "budget_probe",
      description: "records strict round-budget invocations",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      invoked.push(String(input.value));
      return { output: "ok", isError: false };
    },
  };

  const result = await runAgentTurn(
    { write: () => undefined },
    {
      provider,
      providerId: "offline-budget-stub",
      modelId: "fixture",
      tools: [probe],
      systemInstruction: "offline",
      idSeq: fixedId(),
      maxRounds: 1,
      maxToolCalls: 5,
      unattended: true,
    },
    [],
    "run until the strict round cap",
  );

  expect(requests).toHaveLength(1);
  expect(invoked).toEqual(["one"]);
  expect(result.finishReason).toBe("budget");
});

test("zero maxRounds stops before provider or tool activity without relabeling the round-budget reason", async () => {
  const { provider, requests } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "round-budget", toolName: "budget_probe" },
      { kind: "tool_call_end", toolCallId: "round-budget", input: JSON.stringify({ value: "one" }) },
      { kind: "model_end" },
    ],
  ]);
  let invocations = 0;
  const probe: InteractiveTool = {
    definition: {
      name: "budget_probe",
      description: "one invocation below the independent cap",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async () => {
      invocations += 1;
      return { output: "ok", isError: false };
    },
  };

  const result = await runAgentTurn(
    { write: () => undefined },
    {
      provider,
      providerId: "offline-budget-stub",
      modelId: "fixture",
      tools: [probe],
      systemInstruction: "offline",
      idSeq: fixedId(),
      maxRounds: 0,
      maxToolCalls: 5,
      unattended: true,
    },
    [],
    "run one probe",
  );

  expect(requests).toHaveLength(0);
  expect(invocations).toBe(0);
  expect(result.finishReason).toBe("budget");
});

test("T20 F-001: an unattended no-progress stop reports a truthful terminal reason while both budgets still have capacity", async () => {
  const identicalFailingCall = (id: string): Partial<NormalizedEvent>[] => [
    { kind: "tool_call_start", toolCallId: id, toolName: "budget_probe" },
    { kind: "tool_call_end", toolCallId: id, input: JSON.stringify({ value: "same-input" }) },
    { kind: "model_end" },
  ];
  // MAX_ATTEMPTS_PER_HASH (agent.ts) defaults to 3: rounds 1-3 execute the
  // identical call, round 4's identical call is denied by the per-signature
  // guard before it ever reaches `tool.invoke` -> no-progress. Neither
  // maxRounds (20) nor maxToolCalls (50) is anywhere close to exhausted.
  const { provider, requests } = scriptedProvider([
    identicalFailingCall("a1"),
    identicalFailingCall("a2"),
    identicalFailingCall("a3"),
    identicalFailingCall("a4"),
  ]);
  const invoked: string[] = [];
  const probe: InteractiveTool = {
    definition: {
      name: "budget_probe",
      description: "fails identically on every attempt",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      invoked.push(String(input.value));
      return { output: "probe failure: unavailable", isError: true };
    },
  };
  const terminalStates: TerminalState[] = [];
  const io: AgentIO = {
    write: () => undefined,
    onTerminalState: (state) => terminalStates.push(state),
  };
  let id = 0;
  const deps: AgentDeps = {
    provider,
    providerId: "offline-budget-stub",
    modelId: "fixture",
    tools: [probe],
    systemInstruction: "offline",
    idSeq: () => `no-progress-truthful-${id++}`,
    maxRounds: 20,
    maxToolCalls: 50,
    unattended: true,
  };

  const result = await runAgentTurn(io, deps, [], "repeat the same failing call");

  expect(result.finishReason).toBe("no-progress");
  expect(requests).toHaveLength(4);
  expect(invoked).toHaveLength(3);
  // The stop happened with 16 rounds and 47 calls still available — it was
  // never a budget stop, so the reported reason must not claim it was one.
  expect(requests.length).toBeLessThan(20);
  expect(invoked.length).toBeLessThan(50);
  expect(terminalStates).toHaveLength(1);
  expect(terminalStates[0]?.reason).toBe("no_progress");
  expect(terminalStates[0]?.reason).not.toBe("budget_exhausted");
});

function fixedId(): () => string {
  let id = 0;
  return () => `edge-budget-${id++}`;
}
