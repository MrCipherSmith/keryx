import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { buildAgentSystemInstruction, runAgentTurn } from "./agent";
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
