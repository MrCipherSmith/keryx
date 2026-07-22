// Flow 115 / finding 3: the `destructive` risk class must be WIRED, not merely
// declared. Before this flow `executeCall` rejected every risk that was not
// `read`/`shell`/`delegate`, so a tool declaring `destructive` was unusable, and
// a destructive COMMAND was indistinguishable from `ls` at the approval gate.
//
// The contract these tests pin:
//   - a `destructive` tool is NOT auto-rejected — it requires approval,
//   - a destructive command escalates: the approver is told so,
//   - default-deny is preserved (no approver ⇒ never runs),
//   - a benign command does not escalate (no confirmation fatigue).

import { expect, test } from "bun:test";
import { runAgentTurn } from "./agent";
import type { AgentIO } from "./agent";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { ToolRisk } from "../harness/tool/types";
import type {
  NormalizedEvent,
  NormalizedMessage,
  ProviderDescription,
  ProviderPort,
} from "../harness/provider/types";

const DESCRIPTION: ProviderDescription = {
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

function scriptedProvider(rounds: Partial<NormalizedEvent>[][]): ProviderPort {
  let call = 0;
  return {
    describe: () => DESCRIPTION,
    stream: (_request, opts) => {
      const events = rounds[call] ?? [{ kind: "text_delta", text: "done" }, { kind: "model_end" }];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of events) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        }
      })();
    },
  };
}

function callScript(tool: string, input: string): Partial<NormalizedEvent>[][] {
  return [
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: tool },
      { kind: "tool_call_end", toolCallId: "c1", input },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ];
}

function fakeTool(name: string, risk: ToolRisk): {
  tool: InteractiveTool;
  ran: () => boolean;
} {
  let invoked = false;
  return {
    ran: () => invoked,
    tool: {
      definition: {
        name,
        description: "test tool",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
        risk,
      },
      invoke: async () => {
        invoked = true;
        return { output: "ran", isError: false };
      },
    },
  };
}

let seq = 0;
const idSeq = (): string => `id-${seq++}`;

test("a tool declaring risk 'destructive' is gated by approval, not rejected outright", async () => {
  const { tool, ran } = fakeTool("dangerous_tool", "destructive");
  const history: NormalizedMessage[] = [];
  const io: AgentIO = { write: () => {}, requestApproval: async () => true };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("dangerous_tool", '{"command":"anything"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    history,
    "go",
  );
  expect(history.find((m) => m.role === "tool")?.content).not.toMatch(/not permitted/);
  expect(ran()).toBe(true);
});

test("a 'destructive' tool is still DEFAULT-DENIED without an approver", async () => {
  const { tool, ran } = fakeTool("dangerous_tool", "destructive");
  const history: NormalizedMessage[] = [];
  const io: AgentIO = { write: () => {} };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("dangerous_tool", '{"command":"anything"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    history,
    "go",
  );
  expect(ran()).toBe(false);
  expect(history.find((m) => m.role === "tool")?.content).toMatch(/not approved/);
});

test("a destructive COMMAND on a shell-risk tool escalates: the approver is told", async () => {
  const { tool } = fakeTool("shell_exec", "shell");
  const seen: { destructive: boolean }[] = [];
  const io: AgentIO = {
    write: () => {},
    requestApproval: async (_t, _i, meta) => {
      seen.push({ destructive: meta?.destructive === true });
      return false; // deny: this test is about the SIGNAL, nothing must run
    },
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"rm -rf /"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(seen).toEqual([{ destructive: true }]);
});

test("a benign command does NOT escalate", async () => {
  const { tool } = fakeTool("shell_exec", "shell");
  const seen: { destructive: boolean }[] = [];
  const io: AgentIO = {
    write: () => {},
    requestApproval: async (_t, _i, meta) => {
      seen.push({ destructive: meta?.destructive === true });
      return true;
    },
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git status"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(seen).toEqual([{ destructive: false }]);
});

test("an escalated command that is denied never runs", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  const history: NormalizedMessage[] = [];
  const io: AgentIO = { write: () => {}, requestApproval: async () => false };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"sudo rm -rf /"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    history,
    "go",
  );
  expect(ran()).toBe(false);
  expect(history.find((m) => m.role === "tool")?.content).toMatch(/not approved/);
});
