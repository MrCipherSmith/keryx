import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildAgentSystemInstruction,
  DEFAULT_MAX_TOOL_CALLS,
  ENV_AGENT_MAX_ATTEMPTS_PER_HASH,
  ENV_AGENT_MAX_TOOL_CALLS,
  MAX_AGENT_MAX_ATTEMPTS_PER_HASH,
  MAX_AGENT_MAX_TOOL_CALLS,
  MAX_ATTEMPTS_PER_HASH,
  reserveToolAttempt,
  resolveAgentMaxAttemptsPerHash,
  resolveAgentMaxToolCalls,
  runAgentTurn,
  toolCallHash,
} from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import { builtinReadOnlyTools } from "../harness/tool/builtin/interactive-tools";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type {
  NormalizedEvent,
  NormalizedMessage,
  NormalizedRequest,
  ProviderDescription,
} from "../harness/provider/types";

test("resolveAgentMaxToolCalls: default is generous for multi-step prompts", () => {
  expect(DEFAULT_MAX_TOOL_CALLS).toBeGreaterThanOrEqual(48);
  expect(resolveAgentMaxToolCalls({})).toBe(DEFAULT_MAX_TOOL_CALLS);
  expect(resolveAgentMaxToolCalls({ [ENV_AGENT_MAX_TOOL_CALLS]: "" })).toBe(DEFAULT_MAX_TOOL_CALLS);
  expect(resolveAgentMaxToolCalls({ [ENV_AGENT_MAX_TOOL_CALLS]: "  " })).toBe(DEFAULT_MAX_TOOL_CALLS);
  expect(resolveAgentMaxToolCalls({ [ENV_AGENT_MAX_TOOL_CALLS]: "nope" })).toBe(DEFAULT_MAX_TOOL_CALLS);
  expect(resolveAgentMaxToolCalls({ [ENV_AGENT_MAX_TOOL_CALLS]: "0" })).toBe(DEFAULT_MAX_TOOL_CALLS);
  expect(resolveAgentMaxToolCalls({ [ENV_AGENT_MAX_TOOL_CALLS]: "-3" })).toBe(DEFAULT_MAX_TOOL_CALLS);
});

test("resolveAgentMaxToolCalls: env override clamped to ceiling", () => {
  expect(resolveAgentMaxToolCalls({ [ENV_AGENT_MAX_TOOL_CALLS]: "12" })).toBe(12);
  expect(resolveAgentMaxToolCalls({ [ENV_AGENT_MAX_TOOL_CALLS]: " 96 " })).toBe(96);
  expect(resolveAgentMaxToolCalls({ [ENV_AGENT_MAX_TOOL_CALLS]: String(MAX_AGENT_MAX_TOOL_CALLS + 50) })).toBe(
    MAX_AGENT_MAX_TOOL_CALLS,
  );
});

test("resolveAgentMaxAttemptsPerHash: unset/empty/invalid falls back to the default", () => {
  expect(resolveAgentMaxAttemptsPerHash({})).toBe(MAX_ATTEMPTS_PER_HASH);
  expect(resolveAgentMaxAttemptsPerHash({ [ENV_AGENT_MAX_ATTEMPTS_PER_HASH]: "" })).toBe(MAX_ATTEMPTS_PER_HASH);
  expect(resolveAgentMaxAttemptsPerHash({ [ENV_AGENT_MAX_ATTEMPTS_PER_HASH]: "  " })).toBe(MAX_ATTEMPTS_PER_HASH);
  expect(resolveAgentMaxAttemptsPerHash({ [ENV_AGENT_MAX_ATTEMPTS_PER_HASH]: "nope" })).toBe(MAX_ATTEMPTS_PER_HASH);
  expect(resolveAgentMaxAttemptsPerHash({ [ENV_AGENT_MAX_ATTEMPTS_PER_HASH]: "0" })).toBe(MAX_ATTEMPTS_PER_HASH);
  expect(resolveAgentMaxAttemptsPerHash({ [ENV_AGENT_MAX_ATTEMPTS_PER_HASH]: "-4" })).toBe(MAX_ATTEMPTS_PER_HASH);
});

test("resolveAgentMaxAttemptsPerHash: valid env override clamped to ceiling", () => {
  expect(resolveAgentMaxAttemptsPerHash({ [ENV_AGENT_MAX_ATTEMPTS_PER_HASH]: "6" })).toBe(6);
  expect(resolveAgentMaxAttemptsPerHash({ [ENV_AGENT_MAX_ATTEMPTS_PER_HASH]: " 8 " })).toBe(8);
  expect(
    resolveAgentMaxAttemptsPerHash({ [ENV_AGENT_MAX_ATTEMPTS_PER_HASH]: String(MAX_AGENT_MAX_ATTEMPTS_PER_HASH + 5) }),
  ).toBe(MAX_AGENT_MAX_ATTEMPTS_PER_HASH);
});

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

test("F6: a delegate (spawn) tool is fail-closed when no approver is present", async () => {
  const { provider } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "spawn_subagent" },
      { kind: "tool_call_end", toolCallId: "c1", input: JSON.stringify({ task: "do it" }) },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ]);
  let invoked = false;
  const delegateTool: InteractiveTool = {
    definition: {
      name: "spawn_subagent",
      description: "spawn a subagent",
      inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      risk: "delegate",
    },
    invoke: async () => {
      invoked = true;
      return { output: "spawned", isError: false };
    },
  };
  // collectingIo provides NO requestApproval → no approver present.
  const { io, toolResults } = collectingIo();
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [delegateTool],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const history: NormalizedMessage[] = [];

  await runAgentTurn(io, deps, history, "spawn something");

  // The spawn never ran, and the model saw an explicit not-approved result.
  expect(invoked).toBe(false);
  expect(toolResults).toContain("spawn_subagent:err");
  const toolMsg = history.find((m) => m.role === "tool");
  expect(toolMsg?.content).toContain("not approved");
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

test("reserveToolAttempt: state.maxAttempts overrides the per-signature cap and refusal message", () => {
  const state = { charged: new Set<string>(), attempts: new Map<string, number>(), maxUnique: 4, maxAttempts: 2 };
  const a1 = reserveToolAttempt(state, "search_code", '{"pattern":"x"}');
  const a2 = reserveToolAttempt(state, "search_code", '{"pattern":"x"}');
  const a3 = reserveToolAttempt(state, "search_code", '{"pattern":"x"}');
  expect(a1.ok).toBe(true);
  expect(a2.ok).toBe(true);
  expect(a3.ok).toBe(false);
  expect(!a3.ok && a3.reason).toContain("already tried 2×");
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

test("runAgentTurn injects a switch-approach hint after a tool fails identically N× in a row", async () => {
  // The same failing call three times, then a text finish. The tool always fails
  // with the SAME error → the driver should nudge the model to switch after the
  // second identical failure, ONCE, before the hard hash-budget skip.
  const round: Partial<NormalizedEvent>[] = [
    { kind: "tool_call_start", toolCallId: "c", toolName: "flaky_search" },
    { kind: "tool_call_end", toolCallId: "c", input: '{"pattern":"x"}' },
    { kind: "model_end" },
  ];
  const done: Partial<NormalizedEvent>[] = [{ kind: "text_delta", text: "switching" }, { kind: "model_end" }];
  const { provider } = scriptedProvider([round, round, round, done]);
  const flaky: import("../harness/tool/builtin/interactive-tools").InteractiveTool = {
    definition: {
      name: "flaky_search",
      description: "always fails the same way",
      inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false },
      risk: "read",
    },
    invoke: async () => ({ output: 'Executable not found in $PATH: "rg"', isError: true }),
  };
  const systemMsgs: string[] = [];
  const io: AgentIO = { write: () => {}, onSystem: (t) => systemMsgs.push(t) };
  const history: NormalizedMessage[] = [];
  await runAgentTurn(
    io,
    { provider, providerId: "s", modelId: "m", tools: [flaky], systemInstruction: "sys", idSeq: fixedIdSeq() },
    history,
    "find x",
  );

  const hints = systemMsgs.filter((m) => /is failing repeatedly with the same error/.test(m));
  expect(hints).toHaveLength(1); // fires once per signature, not on every attempt
  expect(hints[0]).toContain('tool "flaky_search"');
  expect(hints[0]).toContain("Switch to a different tool or ask the user");
  // The hint is also fed back to the model as a project-provenance message.
  const hintMsg = history.find((m) => m.role === "user" && /is failing repeatedly/.test(m.content));
  expect(hintMsg?.provenance).toBe("project");
});

test("runAgentTurn does not hint after a single tool failure", async () => {
  // One failing call, then a text finish → below the threshold, no hint.
  const round: Partial<NormalizedEvent>[] = [
    { kind: "tool_call_start", toolCallId: "c", toolName: "flaky_search" },
    { kind: "tool_call_end", toolCallId: "c", input: '{"pattern":"x"}' },
    { kind: "model_end" },
  ];
  const done: Partial<NormalizedEvent>[] = [{ kind: "text_delta", text: "ok" }, { kind: "model_end" }];
  const { provider } = scriptedProvider([round, done]);
  const flaky: import("../harness/tool/builtin/interactive-tools").InteractiveTool = {
    definition: {
      name: "flaky_search",
      description: "fails once",
      inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false },
      risk: "read",
    },
    invoke: async () => ({ output: "boom", isError: true }),
  };
  const systemMsgs: string[] = [];
  const io: AgentIO = { write: () => {}, onSystem: (t) => systemMsgs.push(t) };
  await runAgentTurn(
    io,
    { provider, providerId: "s", modelId: "m", tools: [flaky], systemInstruction: "sys", idSeq: fixedIdSeq() },
    [],
    "find x",
  );
  expect(systemMsgs.some((m) => /is failing repeatedly/.test(m))).toBe(false);
});

test("KERYX_AGENT_MAX_ATTEMPTS_PER_HASH changes the per-signature cap end to end", async () => {
  const prev = process.env[ENV_AGENT_MAX_ATTEMPTS_PER_HASH];
  process.env[ENV_AGENT_MAX_ATTEMPTS_PER_HASH] = "2";
  try {
    const round: Partial<NormalizedEvent>[] = [
      { kind: "tool_call_start", toolCallId: "c", toolName: "always_fails" },
      { kind: "tool_call_end", toolCallId: "c", input: "{}" },
      { kind: "model_end" },
    ];
    const done: Partial<NormalizedEvent>[] = [{ kind: "text_delta", text: "stopping" }, { kind: "model_end" }];
    // With cap 2: attempts 1 & 2 execute, the 3rd identical call is skipped.
    const { provider } = scriptedProvider([round, round, round, done]);
    const alwaysFails: import("../harness/tool/builtin/interactive-tools").InteractiveTool = {
      definition: {
        name: "always_fails",
        description: "always errors",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        risk: "read",
      },
      invoke: async () => ({ output: "boom", isError: true }),
    };
    const results: string[] = [];
    const io: AgentIO = { write: () => {}, onToolResult: (_n, r) => results.push(r.output) };
    await runAgentTurn(io, baseDeps(provider, 8), [], "x");
    expect(results.some((r) => /already tried 2×/.test(r))).toBe(true);
    expect(results.some((r) => /already tried 3×/.test(r))).toBe(false);
  } finally {
    if (prev === undefined) {
      delete process.env[ENV_AGENT_MAX_ATTEMPTS_PER_HASH];
    } else {
      process.env[ENV_AGENT_MAX_ATTEMPTS_PER_HASH] = prev;
    }
  }
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
  // Same claim, new wording: the tool block is now grouped, and the read-only
  // filesystem group is the line that used to read "read-only tools".
  expect(withoutOrient).toContain("filesystem (read-only)");

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
  expect(instr).toMatch(/ask_user/);
  expect(instr).toMatch(/recommended/);
  expect(instr).toMatch(/spawn_subagent/);
});

// --- flow 139 (P3): a regression fixture reproducing the A3 condition — a
// first-party tool returns cycles that include a dynamic-import edge — and
// pinning that the agent's answer QUALIFIES that result instead of restating
// it unchecked. AC4/AC5 (frozen): .metaproject/flows/
// 139-2026-08-07-shell-prompt-verification-tradeoff/acceptance-criteria.md
//
// The fake `graph_query` tool below is DELIBERATELY wrong: it folds all 8
// cycles into the count, the way the pre-flow-140 gdgraph engine did — a
// hardcoded stub, not the real gdgraph, so this fixture is decoupled from
// whatever the real engine reports post-P1 (`src/gdgraph/query.ts:69` already
// excludes `dynamic-import` edges there). It still forces the unchecked-trust
// path even though the underlying graph data got better (AC5).

/** True when text qualifies a raw cycle count instead of only repeating it. */
function qualifiesCycleCount(text: string): boolean {
  return /dynamic import|await import/i.test(text) && /not\s+(a\s+)?load-order/i.test(text);
}

test("qualifiesCycleCount sanity: a bare restatement does not qualify, a checked answer does", () => {
  expect(qualifiesCycleCount("graph_query reports 8 import cycles.")).toBe(false);
  expect(
    qualifiesCycleCount(
      "5 of 8 cycles run through await import() in bot/callbacks.ts and are not load-order cycles; 3 are genuine.",
    ),
  ).toBe(true);
});

test("AC4/AC5: agent qualifies a graph_query cycle count that wrongly folds in dynamic-import edges", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-p3-a3-"));
  mkdirSync(path.join(root, "bot"), { recursive: true });
  writeFileSync(
    path.join(root, "bot", "callbacks.ts"),
    'const { handleMenuCallback } = await import("./commands/menu.ts");\n',
  );

  const graphQueryTool: InteractiveTool = {
    definition: {
      name: "graph_query",
      description: "Query the project's dependency graph (cycles, orphans).",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async () => ({
      // Deliberately wrong/incomplete: reports all 8 as load-order cycles,
      // 5 of which actually run through the dynamic import above.
      output:
        "8 import cycles found, including 5 through bot/callbacks.ts -> bot/commands/menu.ts " +
        "and 3 elsewhere.",
      isError: false,
    }),
  };
  const readFileTool = builtinReadOnlyTools(root)[2] as InteractiveTool; // reuse the real read_file tool

  const { provider, requests } = scriptedProvider([
    // Round 1: the model asks graph_query for cycles.
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "graph_query" },
      { kind: "tool_call_end", toolCallId: "c1", input: '{"query":"cycles"}' },
      { kind: "model_end" },
    ],
    // Round 2: the graph result IS the deliverable it is about to report, so
    // it checks it against source before answering.
    [
      { kind: "tool_call_start", toolCallId: "c2", toolName: "read_file" },
      { kind: "tool_call_end", toolCallId: "c2", input: '{"path":"bot/callbacks.ts"}' },
      { kind: "model_end" },
    ],
    // Round 3: the qualified final answer.
    [
      {
        kind: "text_delta",
        text:
          "5 of 8 cycles run through await import() in bot/callbacks.ts and are not load-order " +
          "cycles; 3 are genuine.",
      },
      { kind: "model_end" },
    ],
  ]);

  const { io, text } = collectingIo();
  const systemInstruction = buildAgentSystemInstruction(undefined, {
    toolNames: ["graph_query", "read_file"],
  });
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [graphQueryTool, readFileTool],
    systemInstruction,
    idSeq: fixedIdSeq(),
  };

  await runAgentTurn(io, deps, [], "how many import cycles does this project have?");

  // The multi-tool verification trajectory completed — economy did not cap
  // the turn at the FIRST tool call (AC1/X1: brevity governs length, not
  // tool-call budget).
  expect(requests.length).toBe(3);
  // The final answer qualifies the tool's raw count instead of restating it
  // unchecked.
  expect(qualifiesCycleCount(text.join(""))).toBe(true);

  // Tied directly to the disposition text: if the "check it against source
  // when the result IS the deliverable" clause is ever removed from
  // `buildAgentSystemInstruction`, this assertion breaks independently of the
  // scripted trajectory above — the fixture forces the unchecked-trust path
  // rather than passing because the underlying graph data got better (AC5).
  expect(systemInstruction).toMatch(/deliverable/i);
  expect(systemInstruction).toMatch(/check it against source/i);
});

// agent.ts carries its own "be economical" clause (line ~308), independent of
// `SYSTEM_INSTRUCTION` in shell.ts. It governs the ONLY mode with tools
// (agent mode; `runShell`'s plain chat mode never registers a `tools` field),
// so it is in scope for flow 139 even though the frozen ACs name shell.ts —
// see the journal for the full call. Pinned here so the two instructions
// cannot drift back into the same conflated clause.
test("flow 139 (P3, agent.ts scope): the agent instruction also decouples prose economy from tool-call budget", () => {
  const instr = buildAgentSystemInstruction(undefined);
  expect(instr).toMatch(/economy governs prose only/i);
  expect(instr).toMatch(/never\s+how many tools you call/i);
  expect(instr).toMatch(/check it against source/i);
  expect(instr).toMatch(/deliverable/i);
});
