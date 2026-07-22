// Flow 115 / finding 4 (part a): approval must be bound to the exact action.
//
// The interactive gate answers with a bare `boolean`. Nothing ties that answer
// to the call it was asked about, so "the user said yes" and "this is what runs"
// are two independent facts that happen to line up. This pins them together:
// the approver is told the action fingerprint, and the driver refuses to invoke
// anything whose fingerprint differs from the approved one.
//
// The full policy-engine integration (`decide`, single-use consumption, headless
// fail-closed) is deliberately NOT done here — see the flow-115 report.

import { expect, test } from "bun:test";
import { runAgentTurn, toolCallHash } from "./agent";
import type { AgentIO, ApprovalMeta } from "./agent";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedEvent, ProviderDescription, ProviderPort } from "../harness/provider/types";

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
    stream: (_r, opts) => {
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

function shellRound(input: string): Partial<NormalizedEvent>[] {
  return [
    { kind: "tool_call_start", toolCallId: "c1", toolName: "shell_exec" },
    { kind: "tool_call_end", toolCallId: "c1", input },
    { kind: "model_end" },
  ];
}

function recordingTool(): { tool: InteractiveTool; executed: () => string[] } {
  const ran: string[] = [];
  return {
    executed: () => ran,
    tool: {
      definition: {
        name: "shell_exec",
        description: "run",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
        risk: "shell",
      },
      invoke: async (input) => {
        ran.push(String(input.command));
        return { output: "ran", isError: false };
      },
    },
  };
}

let seq = 0;
const idSeq = (): string => `id-${seq++}`;

test("the approver is given the fingerprint of the exact action it is approving", async () => {
  const { tool } = recordingTool();
  const input = '{"command":"git status"}';
  const seen: (ApprovalMeta | undefined)[] = [];
  const io: AgentIO = {
    write: () => {},
    requestApproval: async (_t, _i, meta) => {
      seen.push(meta);
      return true;
    },
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider([shellRound(input)]),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(seen[0]?.fingerprint).toBe(toolCallHash("shell_exec", input));
});

test("what the approver sees is exactly what the tool receives", async () => {
  const { tool, executed } = recordingTool();
  // Whitespace and newlines must survive intact: a UI that shows a trimmed
  // command while an untrimmed one runs is a (small) approve/execute mismatch.
  const command = "  echo 'a  b'  \n";
  const input = JSON.stringify({ command });
  let approvedInput = "";
  const io: AgentIO = {
    write: () => {},
    requestApproval: async (_t, i) => {
      approvedInput = i;
      return true;
    },
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider([shellRound(input)]),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(JSON.parse(approvedInput).command).toBe(executed()[0]);
});

test("an approval carrying a different fingerprint does not authorise the call", async () => {
  const { tool, executed } = recordingTool();
  const io: AgentIO = {
    write: () => {},
    // An approver that answers for the WRONG action: it says yes, but reports a
    // fingerprint that is not the one it was asked about. The driver must not
    // treat that as authorisation for the call it is holding.
    requestApproval: async () => ({ approved: true, fingerprint: "not-the-call-you-are-holding" }),
  };
  const history: import("../harness/provider/types").NormalizedMessage[] = [];
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider([shellRound('{"command":"git status"}')]),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    history,
    "go",
  );
  expect(executed()).toEqual([]);
  expect(history.find((m) => m.role === "tool")?.content).toMatch(/not approved/);
});

test("a plain boolean approval still works (existing approvers are unchanged)", async () => {
  const { tool, executed } = recordingTool();
  const io: AgentIO = { write: () => {}, requestApproval: async () => true };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider([shellRound('{"command":"git status"}')]),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(executed()).toEqual(["git status"]);
});
