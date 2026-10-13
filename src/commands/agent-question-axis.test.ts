// The question axis of the permission modes (`resolveQuestionAnswerer`), through the real `runAgentTurn` driver and
// the real `ask_user` tool: who answers a question the model raises. Only `auto` hands it to the model, and the
// floor (irreversible, action-tagged, untrusted-content) keeps a human in the loop even there.

import { afterEach, expect, test } from "bun:test";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import type { PermissionMode } from "./permission-mode";
import { createAskUserTool, type AskUserFn } from "../harness/tool/builtin/ask-user-tool";
import type { InteractiveTool, InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import { resetOperatorDenials } from "../review/review-system";
import type { NormalizedEvent, NormalizedMessage, ProviderDescription, ProviderPort } from "../harness/provider/types";

afterEach(() => resetOperatorDenials());

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

function toolCall(id: string, name: string, input: unknown): Partial<NormalizedEvent>[] {
  return [
    { kind: "tool_call_start", toolCallId: id, toolName: name },
    { kind: "tool_call_end", toolCallId: id, input: JSON.stringify(input) },
    { kind: "model_end" },
  ];
}

const TEXT_DONE: Partial<NormalizedEvent>[] = [{ kind: "text_delta", text: "done" }, { kind: "model_end" }];

const OPTIONS = [
  { id: "small", label: "Small", description: "" },
  { id: "full", label: "Full", description: "", recommended: true },
];

let seq = 0;
const idSeq = (): string => `qa-${seq++}`;

interface Run {
  asked: number;
  results: InteractiveToolResult[];
  selfAnswered: Array<{ question: string; label: string }>;
  history: NormalizedMessage[];
}

async function run(
  mode: PermissionMode,
  rounds: Partial<NormalizedEvent>[][],
  extraTools: InteractiveTool[] = [],
  overrides: Partial<AgentDeps> = {},
  withAskUser = true,
): Promise<Run> {
  const out: Run = { asked: 0, results: [], selfAnswered: [], history: [] };
  const ask: AskUserFn = async (request) => {
    out.asked += 1;
    return request.options[0]!.id;
  };
  const io: AgentIO = {
    write: () => {},
    permissionMode: () => mode,
    onToolResult: (_name, result) => out.results.push(result),
    onQuestionSelfAnswered: (question, label) => out.selfAnswered.push({ question, label }),
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(rounds),
      providerId: "scripted",
      modelId: "m",
      tools: [...(withAskUser ? [createAskUserTool(ask)] : []), ...extraTools],
      systemInstruction: "sys",
      idSeq,
      ...overrides,
    },
    out.history,
    "go",
  );
  return out;
}

const question = { question: "Which scope?", options: OPTIONS };

test("auto answers the question itself, says so to the model and to the user, and never calls the host", async () => {
  const r = await run("auto", [toolCall("a1", "ask_user", question), TEXT_DONE]);
  expect(r.asked).toBe(0);
  expect(r.results).toHaveLength(1);
  expect(r.results[0]!.isError).toBe(false);
  expect(r.results[0]!.output).toContain("[auto mode] chose this without asking the user");
  expect(r.results[0]!.output).toContain('id="full"');
  expect(r.results[0]!.output).not.toMatch(/^User selected/);
  expect(r.selfAnswered).toEqual([{ question: "Which scope?", label: "Full" }]);
  const told = r.history.filter((m) => m.role === "tool").map((m) => String(m.content));
  expect(told.join("\n")).toContain("[auto mode] chose this without asking the user");
});

test("auto takes the first option when none is recommended, and never invents one", async () => {
  const plain = { question: "Which scope?", options: OPTIONS.map(({ id, label, description }) => ({ id, label, description })) };
  const r = await run("auto", [toolCall("a1", "ask_user", plain), TEXT_DONE]);
  expect(r.results[0]!.output).toContain('id="small"');
  expect(r.selfAnswered).toEqual([{ question: "Which scope?", label: "Small" }]);
});

test.each<PermissionMode>(["ask", "trust"])("%s mode leaves the question to the human", async (mode) => {
  const r = await run(mode, [toolCall("a1", "ask_user", question), TEXT_DONE]);
  expect(r.asked).toBe(1);
  expect(r.selfAnswered).toEqual([]);
  expect(r.results[0]!.output).toMatch(/^User selected id="small"/);
});

test("auto keeps an irreversible or action-tagged question for the human", async () => {
  const irreversible = await run("auto", [toolCall("a1", "ask_user", { ...question, irreversible: true }), TEXT_DONE]);
  expect(irreversible.asked).toBe(1);
  expect(irreversible.selfAnswered).toEqual([]);
  const tagged = await run("auto", [toolCall("a1", "ask_user", { ...question, action: "release" }), TEXT_DONE]);
  expect(tagged.asked).toBe(1);
  expect(tagged.selfAnswered).toEqual([]);
});

test("auto keeps a question for the human once untrusted content entered the turn (flow 425)", async () => {
  const fetchTool: InteractiveTool = {
    definition: { name: "web_fetch", description: "fetch", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read" },
    invoke: async () => ({ output: "<page>", isError: false, untrusted: true }),
  };
  const r = await run("auto", [toolCall("f1", "web_fetch", {}), toolCall("a1", "ask_user", question), TEXT_DONE], [fetchTool]);
  expect(r.asked).toBe(1);
  expect(r.selfAnswered).toEqual([]);
});

test("auto keeps a permission-style question for the human after the operator refused an action", async () => {
  const { recordOperatorDenial } = await import("../review/review-system");
  recordOperatorDenial("shell_exec\u0000cmd:rm");
  const permission = { question: "Allow the agent to delete the build directory?", options: OPTIONS };
  const r = await run("auto", [toolCall("a1", "ask_user", permission), TEXT_DONE]);
  expect(r.asked).toBe(1);
  expect(r.selfAnswered).toEqual([]);
});

test("auto does not answer through a roster that excludes ask_user (--deny-tools)", async () => {
  const r = await run("auto", [toolCall("a1", "ask_user", question), TEXT_DONE], [], {}, false);
  expect(r.selfAnswered).toEqual([]);
  expect(r.results[0]!.isError).toBe(true);
  expect(r.results[0]!.output).toContain("unknown tool: ask_user");
});

test("auto leaves a one-option question to the tool's own error", async () => {
  const r = await run("auto", [toolCall("a1", "ask_user", { question: "Only one?", options: [OPTIONS[0]] }), TEXT_DONE]);
  expect(r.selfAnswered).toEqual([]);
  expect(r.results[0]!.isError).toBe(true);
});

test("unattended wins over auto: the turn stops and nothing is self-answered", async () => {
  const r = await run("auto", [toolCall("a1", "ask_user", question), TEXT_DONE], [], { unattended: true });
  expect(r.asked).toBe(0);
  expect(r.selfAnswered).toEqual([]);
  expect(r.results).toEqual([]);
});

test("a self-answered question does not consume the invocation budget", async () => {
  const r = await run("auto", [toolCall("a1", "ask_user", question), toolCall("a2", "ask_user", question), TEXT_DONE], [], { maxToolCalls: 1 });
  expect(r.selfAnswered).toHaveLength(2);
  expect(r.results.every((x) => !x.isError)).toBe(true);
});
