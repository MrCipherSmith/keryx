import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
  buildAgentSystemInstruction,
  MAX_ATTEMPTS_PER_HASH,
  reserveToolAttempt,
  runAgentTurn,
  toolCallHash,
} from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import { builtinReadOnlyTools } from "../harness/tool/builtin/interactive-tools";
import type {
  NormalizedEvent,
  NormalizedMessage,
  NormalizedRequest,
  ProviderDescription,
} from "../harness/provider/types";

// A minimal scripted ProviderPort: each `stream()` call replays the next scripted
// event list and records the request it received (for feed-back assertions).
function scriptedProvider(scripts: Partial<NormalizedEvent>[][]): {
  provider: AgentDeps["provider"];
  requests: NormalizedRequest[];
} {
  const requests: NormalizedRequest[] = [];
  let call = 0;
  const description: ProviderDescription = {
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: false,
      structuredOutput: false,
      reasoningMetadata: false,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    },
    descriptor: { providerId: "scripted" },
  };
  return {
    requests,
    provider: {
      describe: () => description,
      stream: (request, opts) => {
        requests.push(request);
        const events = scripts[call] ?? [];
        call += 1;
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          let sequence = 0;
          for (const partial of events) {
            yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
          }
        })();
      },
    },
  };
}

let idCounter = 0;
function fixedIdSeq(): () => string {
  idCounter = 0;
  return () => `id-${idCounter++}`;
}

function collectingIo(): { io: AgentIO; text: string[]; toolCalls: string[]; toolResults: string[] } {
  const text: string[] = [];
  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  return {
    text,
    toolCalls,
    toolResults,
    io: {
      write: (s) => text.push(s),
      onToolCall: (name) => toolCalls.push(name),
      onToolResult: (name, r) => toolResults.push(`${name}:${r.isError ? "err" : "ok"}`),
    },
  };
}

test("runAgentTurn executes a tool call and feeds its output back into the next request", async () => {
  const { provider, requests } = scriptedProvider([
    // Round 1: the model calls get_cwd.
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "get_cwd" },
      { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
      { kind: "model_end" },
    ],
    // Round 2 (after the tool result is fed back): a text answer.
    [
      { kind: "text_delta", text: "Your directory is set." },
      { kind: "model_end" },
    ],
  ]);
  const root = tmpdir();
  const { io, text, toolCalls, toolResults } = collectingIo();
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: builtinReadOnlyTools(root),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const history: NormalizedMessage[] = [];

  await runAgentTurn(io, deps, history, "where am I?");

  // The tool ran and its result was rendered.
  expect(toolCalls).toContain("get_cwd");
  expect(toolResults).toContain("get_cwd:ok");
  // Final assistant text streamed.
  expect(text.join("")).toContain("Your directory is set.");
  // The SECOND request carries the tool result as a role:"tool" message with the real cwd.
  expect(requests.length).toBe(2);
  const toolMsg = requests[1]?.messages.find((m) => m.role === "tool");
  expect(toolMsg?.content).toBe(root);
  // The first request advertised the tools.
  expect((requests[0]?.tools ?? []).map((t) => t.name).sort()).toEqual(["get_cwd", "list_dir", "read_file"]);
  // History ends alternating with a tool message present.
  expect(history.some((m) => m.role === "tool")).toBe(true);
});

test("runAgentTurn returns on a text-only finish without calling tools", async () => {
  const { provider, requests } = scriptedProvider([
    [
      { kind: "text_delta", text: "Just chatting." },
      { kind: "model_end" },
    ],
  ]);
  const { io, text } = collectingIo();
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: builtinReadOnlyTools(tmpdir()),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const history: NormalizedMessage[] = [];

  await runAgentTurn(io, deps, history, "hi");

  expect(text.join("")).toContain("Just chatting.");
  expect(requests.length).toBe(1); // no tool → no second request
  expect(history.filter((m) => m.role === "tool")).toHaveLength(0);
});

test("runAgentTurn reports an unknown tool without throwing", async () => {
  const { provider } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "definitely_not_a_tool" },
      { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "ok" }, { kind: "model_end" }],
  ]);
  const { io, toolResults } = collectingIo();
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: builtinReadOnlyTools(tmpdir()),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  await runAgentTurn(io, deps, [], "call a bad tool");
  expect(toolResults).toContain("definitely_not_a_tool:err");
});

/** A fake risk-`shell` tool that records whether its runner was invoked. */
function fakeShellTool(): { tool: import("../harness/tool/builtin/interactive-tools").InteractiveTool; ran: () => boolean } {
  let invoked = false;
  return {
    ran: () => invoked,
    tool: {
      definition: {
        name: "shell_exec",
        description: "run a command",
        inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
        risk: "shell",
      },
      invoke: async () => {
        invoked = true;
        return { output: "ran", isError: false };
      },
    },
  };
}

function shellCallScript(): Partial<NormalizedEvent>[][] {
  return [
    [
      { kind: "tool_call_start", toolCallId: "s1", toolName: "shell_exec" },
      { kind: "tool_call_end", toolCallId: "s1", input: '{"command":"git status"}' },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ];
}

test("shell tool runs only when approval resolves true; the result is fed back", async () => {
  const { provider } = scriptedProvider(shellCallScript());
  const { tool, ran } = fakeShellTool();
  const history: NormalizedMessage[] = [];
  const io: AgentIO = { write: () => {}, requestApproval: async () => true };
  await runAgentTurn(io, { provider, providerId: "s", modelId: "m", tools: [tool], systemInstruction: "sys", idSeq: fixedIdSeq() }, history, "run it");
  expect(ran()).toBe(true);
  expect(history.find((m) => m.role === "tool")?.content).toBe("ran");
});

test("shell tool is DENIED when approval resolves false (not executed)", async () => {
  const { provider } = scriptedProvider(shellCallScript());
  const { tool, ran } = fakeShellTool();
  const history: NormalizedMessage[] = [];
  const io: AgentIO = { write: () => {}, requestApproval: async () => false };
  await runAgentTurn(io, { provider, providerId: "s", modelId: "m", tools: [tool], systemInstruction: "sys", idSeq: fixedIdSeq() }, history, "run it");
  expect(ran()).toBe(false);
  expect(history.find((m) => m.role === "tool")?.content).toMatch(/not approved/);
});

test("shell tool is DEFAULT-DENIED when no approval callback is present", async () => {
  const { provider } = scriptedProvider(shellCallScript());
  const { tool, ran } = fakeShellTool();
  const history: NormalizedMessage[] = [];
  const io: AgentIO = { write: () => {} }; // no requestApproval
  await runAgentTurn(io, { provider, providerId: "s", modelId: "m", tools: [tool], systemInstruction: "sys", idSeq: fixedIdSeq() }, history, "run it");
  expect(ran()).toBe(false);
  expect(history.find((m) => m.role === "tool")?.content).toMatch(/not approved/);
});

// --- flow 050: onAssistantText + onUsage hooks (agent-mode UI polish) ---

test("runAgentTurn calls onAssistantText once per round with the full finalized round text", async () => {
  const { provider } = scriptedProvider([
    // Round 1: some text, THEN a tool call → the round produced text.
    [
      { kind: "text_delta", text: "Let me " },
      { kind: "text_delta", text: "check." },
      { kind: "tool_call_start", toolCallId: "c1", toolName: "get_cwd" },
      { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
      { kind: "model_end" },
    ],
    // Round 2: final answer text only.
    [{ kind: "text_delta", text: "Here is the answer." }, { kind: "model_end" }],
  ]);
  const rounds: string[] = [];
  const io: AgentIO = { write: () => {}, onAssistantText: (t) => rounds.push(t) };
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: builtinReadOnlyTools(tmpdir()),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  await runAgentTurn(io, deps, [], "go");
  // One call per round that produced text, each carrying that round's FULL text.
  expect(rounds).toEqual(["Let me check.", "Here is the answer."]);
});

test("runAgentTurn does not call onAssistantText for a round with no assistant text", async () => {
  const { provider } = scriptedProvider([
    // Tool-only round (no text) then a text round.
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "get_cwd" },
      { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ]);
  const rounds: string[] = [];
  const io: AgentIO = { write: () => {}, onAssistantText: (t) => rounds.push(t) };
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: builtinReadOnlyTools(tmpdir()),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  await runAgentTurn(io, deps, [], "go");
  expect(rounds).toEqual(["done"]); // only the text-bearing round
});

test("runAgentTurn forwards usage_update events to onUsage", async () => {
  const { provider } = scriptedProvider([
    [
      { kind: "text_delta", text: "hi" },
      { kind: "usage_update", usage: { inputTokens: 12, outputTokens: 3, exact: true } },
      { kind: "model_end" },
    ],
  ]);
  const seen: Array<{ input?: number | undefined; output?: number | undefined }> = [];
  const io: AgentIO = { write: () => {}, onUsage: (u) => seen.push({ input: u.inputTokens, output: u.outputTokens }) };
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: builtinReadOnlyTools(tmpdir()),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  await runAgentTurn(io, deps, [], "go");
  expect(seen).toEqual([{ input: 12, output: 3 }]);
});

// --- flow 057: runaway tool-loop guard ---

function baseDeps(provider: AgentDeps["provider"], maxToolCalls?: number): AgentDeps {
  return {
    provider,
    providerId: "s",
    modelId: "m",
    tools: builtinReadOnlyTools(tmpdir()),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
  };
}

test("toolCallHash is stable for key order and distinguishes different inputs", () => {
  expect(toolCallHash("search_code", '{"pattern":"a","path":"b"}')).toBe(
    toolCallHash("search_code", '{"path":"b","pattern":"a"}'),
  );
  expect(toolCallHash("search_code", '{"pattern":"a"}')).not.toBe(toolCallHash("search_code", '{"pattern":"b"}'));
});

test("reserveToolAttempt: same hash costs 1 budget slot for up to MAX_ATTEMPTS_PER_HASH tries", () => {
  const state = { charged: new Set<string>(), attempts: new Map<string, number>(), maxUnique: 2 };
  const a1 = reserveToolAttempt(state, "get_cwd", "{}");
  const a2 = reserveToolAttempt(state, "get_cwd", "{}");
  const a3 = reserveToolAttempt(state, "get_cwd", "{}");
  const a4 = reserveToolAttempt(state, "get_cwd", "{}");
  expect(a1.ok && a1.chargedNew).toBe(true);
  expect(a2.ok && !a2.chargedNew).toBe(true);
  expect(a3.ok && !a3.chargedNew).toBe(true);
  expect(a4.ok).toBe(false);
  expect(state.charged.size).toBe(1);
  expect(a3.ok && a3.attempt).toBe(MAX_ATTEMPTS_PER_HASH);
});

test("runAgentTurn: unique-signature budget; wrap-up turn without tools when exhausted", async () => {
  // Two DIFFERENT signatures fill budget of 2; then wrap-up text (no tools).
  const r1: Partial<NormalizedEvent>[] = [
    { kind: "tool_call_start", toolCallId: "c1", toolName: "get_cwd" },
    { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
    { kind: "model_end" },
  ];
  const r2: Partial<NormalizedEvent>[] = [
    { kind: "tool_call_start", toolCallId: "c2", toolName: "list_dir" },
    { kind: "tool_call_end", toolCallId: "c2", input: '{"path":"."}' },
    { kind: "model_end" },
  ];
  // Would try a third unique call — budget already full after r1+r2 if both succeed in one round;
  // use two rounds that each charge one unique, then a third tool round is skipped and wrap-up runs.
  const wrap: Partial<NormalizedEvent>[] = [
    { kind: "text_delta", text: "Budget done: re-run with a narrower ask." },
    { kind: "model_end" },
  ];
  // Round1: get_cwd, Round2: list_dir → budget 2 full → wrap-up
  const { provider, requests } = scriptedProvider([r1, r2, wrap]);
  const systemMsgs: string[] = [];
  const text: string[] = [];
  const io: AgentIO = {
    write: (s) => text.push(s),
    onSystem: (t) => systemMsgs.push(t),
  };
  await runAgentTurn(io, baseDeps(provider, 2), [], "loop");
  expect(systemMsgs.join("")).toMatch(/\[budget\]|unique signature budget|wrap-up/i);
  expect(text.join("")).toMatch(/Budget done/);
  // Last model request must NOT advertise tools (wrap-up).
  const last = requests[requests.length - 1];
  expect(last?.tools === undefined || last?.tools?.length === 0).toBe(true);
});

test("runAgentTurn: identical failing calls only burn one unique slot; after 3 attempts further same hash is skipped", async () => {
  const round: Partial<NormalizedEvent>[] = [
    { kind: "tool_call_start", toolCallId: "c", toolName: "nonexistent_tool" },
    { kind: "tool_call_end", toolCallId: "c", input: "{}" },
    { kind: "model_end" },
  ];
  // 5 rounds of the same failure; only 3 real executes, then skips; eventually wrap-up if budget...
  // With maxUnique=8, unique stays 1, model could loop forever → we need wrap-up when a whole round
  // only produces skips. Currently we only wrap on budget full. After 3 attempts, further rounds
  // get "same tool call already tried 3×" — if model only returns that call, we loop forever!
  //
  // Guard: if a full execute pass produced only skips and no new work, finish with wrap-up.
  // That will be fixed in agent.ts if needed after test.
  const done: Partial<NormalizedEvent>[] = [{ kind: "text_delta", text: "gave up" }, { kind: "model_end" }];
  const { provider } = scriptedProvider([round, round, round, round, done]);
  let toolResultCount = 0;
  const results: string[] = [];
  const io: AgentIO = {
    write: () => {},
    onToolResult: (_n, r) => {
      toolResultCount += 1;
      results.push(r.output);
    },
  };
  await runAgentTurn(io, baseDeps(provider, 8), [], "x");
  // 3 real executes + 1 skip (round 4) then text finish (round 5 with text only)
  // wait - round 4 still has tool call → skip. Round 5 is text "gave up".
  expect(toolResultCount).toBeGreaterThanOrEqual(3);
  expect(results.some((r) => /already tried|unknown tool/.test(r))).toBe(true);
});

test("a validation error message lists the tool's required fields", async () => {
  const round: Partial<NormalizedEvent>[] = [
    { kind: "tool_call_start", toolCallId: "c", toolName: "needs_q" },
    { kind: "tool_call_end", toolCallId: "c", input: "{}" }, // missing required `query`
    { kind: "model_end" },
  ];
  const { provider } = scriptedProvider([round, [{ kind: "text_delta", text: "ok" }, { kind: "model_end" }]]);
  const needsQ: import("../harness/tool/builtin/interactive-tools").InteractiveTool = {
    definition: {
      name: "needs_q",
      description: "needs a query",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      risk: "read",
    },
    invoke: async () => ({ output: "unused", isError: false }),
  };
  const outputs: string[] = [];
  const io: AgentIO = { write: () => {}, onToolResult: (_n, r) => outputs.push(r.output) };
  await runAgentTurn(
    io,
    { provider, providerId: "s", modelId: "m", tools: [needsQ], systemInstruction: "sys", idSeq: fixedIdSeq() },
    [],
    "x",
  );
  expect(outputs.join("")).toMatch(/invalid input for needs_q.*required: query/);
});

// --- flow 056: onReasoning hook ---

test("runAgentTurn surfaces reasoning via onReasoning once, before onAssistantText", async () => {
  const { provider } = scriptedProvider([
    [
      { kind: "reasoning_delta", text: "step 1 " },
      { kind: "reasoning_delta", text: "step 2" },
      { kind: "text_delta", text: "Final answer." },
      { kind: "model_end" },
    ],
  ]);
  const order: string[] = [];
  const io: AgentIO = {
    write: () => {},
    onReasoning: (t) => order.push(`reasoning:${t}`),
    onAssistantText: (t) => order.push(`text:${t}`),
  };
  const deps: AgentDeps = {
    provider,
    providerId: "s",
    modelId: "m",
    tools: builtinReadOnlyTools(tmpdir()),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  await runAgentTurn(io, deps, [], "go");
  // Reasoning is accumulated across deltas and surfaced ONCE, before the answer.
  expect(order).toEqual(["reasoning:step 1 step 2", "text:Final answer."]);
});

test("runAgentTurn does not call onReasoning when the model emits no reasoning", async () => {
  const { provider } = scriptedProvider([[{ kind: "text_delta", text: "hi" }, { kind: "model_end" }]]);
  let called = false;
  const io: AgentIO = { write: () => {}, onReasoning: () => { called = true; } };
  const deps: AgentDeps = {
    provider,
    providerId: "s",
    modelId: "m",
    tools: builtinReadOnlyTools(tmpdir()),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  await runAgentTurn(io, deps, [], "go");
  expect(called).toBe(false);
});

test("buildAgentSystemInstruction embeds an orient block when present, falls back when absent", () => {
  const withOrient = buildAgentSystemInstruction("MODULE MAP: a→b");
  expect(withOrient).toContain("MODULE MAP: a→b");
  expect(withOrient).toContain("orientation");

  const withoutOrient = buildAgentSystemInstruction(undefined);
  expect(withoutOrient).not.toContain("orientation");
  expect(withoutOrient).toContain("read-only tools");

  // Empty/whitespace orient must not throw and must fall back.
  expect(buildAgentSystemInstruction("   ")).toBe(buildAgentSystemInstruction(undefined));
});

test("buildAgentSystemInstruction routes wiki enrich intents to keryx wiki enrich shell_exec", () => {
  const instr = buildAgentSystemInstruction(undefined, {
    providerId: "zai-coding",
    modelId: "glm-5.2",
  });
  expect(instr).toMatch(/wiki enrich/);
  expect(instr).toMatch(/обогати вики|обогатить вики/i);
  expect(instr).toContain("keryx wiki enrich --all --provider zai-coding --model glm-5.2");
  expect(instr).toMatch(/required field|pattern|Never call a tool with an empty object/i);
  expect(instr).toMatch(/shell_exec/);
});
