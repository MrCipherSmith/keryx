// The question axis of the permission modes (`resolveQuestionAnswerer`), through the real `runAgentTurn` driver and
// the real `ask_user` tool: who answers a question the model raises. Only `auto` hands it to the model, and the
// floor (irreversible, action-tagged, untrusted-content) keeps a human in the loop even there.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentTurn, toolCallHash } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import { AutomaticReviewRun } from "./automatic-review";
import type { PermissionMode } from "./permission-mode";
import { readSlate, writeSlate } from "../session/slate";
import type { SlateSessionRef } from "../session/slate-lifecycle";
import { createAskUserTool, type AskUserFn } from "../harness/tool/builtin/ask-user-tool";
import type { InteractiveTool, InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import { ENV_AUTONOMOUS_ANSWERS_FILE } from "../review/autonomous-answers";
import {
  ENV_REVIEW_SYSTEM,
  REFUSED_EARLIER,
  operatorDenied,
  recordOperatorDenial,
  refusalFingerprint,
  resetOperatorDenials,
  reviewAutoMayAnswer,
  setReviewSystem,
} from "../review/review-system";
import type { NormalizedEvent, NormalizedMessage, ProviderDescription, ProviderPort } from "../harness/provider/types";

// The review system is process state and three environment variables decide it; every test starts from "not review-auto".
const AMBIENT_ENV = [ENV_REVIEW_SYSTEM, "KERYX_REVIEW_AUTO_ANSWER", ENV_AUTONOMOUS_ANSWERS_FILE] as const;
const savedEnv: Partial<Record<(typeof AMBIENT_ENV)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of AMBIENT_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  setReviewSystem("inherit");
});

afterEach(() => {
  resetOperatorDenials();
  setReviewSystem("inherit");
  for (const key of AMBIENT_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

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

interface RunExtras {
  review?: AutomaticReviewRun;
  slateSession?: SlateSessionRef;
  requestApproval?: AgentIO["requestApproval"];
  /** The shell passes no `permissionMode` at all (an embedder, a test double): the default mode applies. */
  noPermissionMode?: boolean;
  /** A turn that started in Telegram answers `false` here (flow 396). */
  mcpGrantsApply?: () => boolean;
}

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
  extras: RunExtras = {},
): Promise<Run> {
  const out: Run = { asked: 0, results: [], selfAnswered: [], history: [] };
  const ask: AskUserFn = async (request) => {
    out.asked += 1;
    return request.options[0]!.id;
  };
  const io: AgentIO = {
    write: () => {},
    ...(extras.noPermissionMode === true ? {} : { permissionMode: () => mode }),
    ...(extras.requestApproval === undefined ? {} : { requestApproval: extras.requestApproval }),
    ...(extras.mcpGrantsApply === undefined ? {} : { mcpGrantsApply: extras.mcpGrantsApply }),
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
    {
      ...(extras.review === undefined ? {} : { automaticReview: true, automaticReviewRun: extras.review }),
      ...(extras.slateSession === undefined ? {} : { slateSession: extras.slateSession }),
    },
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
  expect(r.results[0]!.output).toContain('id="full" label="Full" (recommended)');
  expect(r.results[0]!.output).not.toMatch(/^User selected/);
  expect(r.selfAnswered).toEqual([{ question: "Which scope?", label: "Full" }]);
  const told = r.history.filter((m) => m.role === "tool").map((m) => String(m.content));
  expect(told.join("\n")).toContain("[auto mode] chose this without asking the user");
});

test("auto takes the first option when none is recommended, and never invents one", async () => {
  const plain = { question: "Which scope?", options: OPTIONS.map(({ id, label, description }) => ({ id, label, description })) };
  const r = await run("auto", [toolCall("a1", "ask_user", plain), TEXT_DONE]);
  expect(r.results[0]!.output).toContain('id="small"');
  expect(r.results[0]!.output).not.toContain("(recommended)");
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

const shellTool: InteractiveTool = {
  definition: {
    name: "shell_exec",
    description: "sh",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    risk: "shell",
  },
  invoke: async () => ({ output: "ran", isError: false }),
};

test("auto keeps a permission-style question for the human after the operator refused an approval", async () => {
  const permission = { question: "Allow the agent to read the credentials file?", options: OPTIONS };
  let approvals = 0;
  const r = await run(
    "auto",
    [toolCall("s1", "shell_exec", { command: "cat ~/.config/keryx/auth.json" }), toolCall("a1", "ask_user", permission), TEXT_DONE],
    [shellTool],
    {},
    true,
    {
      requestApproval: async () => {
        approvals += 1;
        return false;
      },
    },
  );
  expect(approvals).toBe(1);
  expect(r.results[0]!.output).toContain("not approved");
  expect(r.asked).toBe(1);
  expect(r.selfAnswered).toEqual([]);
});

test("auto answers the same permission-style question itself when nothing was refused", async () => {
  const permission = { question: "Allow the agent to read the credentials file?", options: OPTIONS };
  const r = await run("auto", [toolCall("a1", "ask_user", permission), TEXT_DONE]);
  expect(r.asked).toBe(0);
  expect(r.selfAnswered).toHaveLength(1);
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

test("an embedder that passes no permission mode gets the default mode, not auto", async () => {
  const r = await run("auto", [toolCall("a1", "ask_user", question), TEXT_DONE], [], {}, true, { noPermissionMode: true });
  expect(r.asked).toBe(1);
  expect(r.selfAnswered).toEqual([]);
});

test("a self-answered question is not stored as an answer of the operator's", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-axis-slate-"));
  await writeSlate(dir, () => ({ anchors: { root: dir, touched: [] }, course: {}, seeds: [] }));
  const slateSession: SlateSessionRef = { dir, cwd: dir, opened: true };
  const r = await run("auto", [toolCall("a1", "ask_user", question), toolCall("a2", "ask_user", question), TEXT_DONE], [], {}, true, { slateSession });
  expect(r.selfAnswered).toHaveLength(2);
  expect(r.results.map((x) => x.output).join("\n")).not.toContain("Already answered by the operator");
  expect((await readSlate(dir))?.notes).toBeUndefined();
});

test("auto leaves a question with two recommended options to the tool's own error", async () => {
  const twice = { question: "Which scope?", options: OPTIONS.map((o) => ({ ...o, recommended: true })) };
  const r = await run("auto", [toolCall("a1", "ask_user", twice), TEXT_DONE]);
  expect(r.selfAnswered).toEqual([]);
  expect(r.asked).toBe(0);
  expect(r.results[0]!.isError).toBe(true);
  expect(r.results[0]!.output).toContain("2 options are marked recommended");
});

const MANY_OPTIONS = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `O${i}`, description: "" }));

test.each<[string, Record<string, unknown>]>([
  ["irreversible as a string", { ...question, irreversible: "true" }],
  ["irreversible as a number", { ...question, irreversible: 1 }],
  ["action as an array", { ...question, action: ["release"] }],
  ["more than eight options", { question: "Pick", options: MANY_OPTIONS }],
  ["an unknown property", { ...question, bogus: 1 }],
])("auto does not answer a call the tool schema rejects (%s)", async (_name, input) => {
  const r = await run("auto", [toolCall("a1", "ask_user", input), TEXT_DONE]);
  expect(r.selfAnswered).toEqual([]);
  expect(r.asked).toBe(0);
  expect(r.results[0]!.isError).toBe(true);
  expect(r.results[0]!.output).toContain("invalid input for ask_user");
});

const POLICY = { kind: "scope", facts: { filesInScope: 9, widensScope: true } };

test("auto in an automatic review: a policy-tagged question goes to the host and is counted as manual", async () => {
  const review = new AutomaticReviewRun(process.cwd());
  const r = await run("auto", [toolCall("a1", "ask_user", { ...question, policy: POLICY }), TEXT_DONE], [], {}, true, { review });
  expect(r.asked).toBe(1);
  expect(r.selfAnswered).toEqual([]);
  expect(review.disclosure().manual).toBe(1);
});

test.each(["gate-waiver", "reduced-reviewer-set"])("auto in an automatic review: the %s emergency goes to the host once the gate has refused", async (emergency) => {
  const review = new AutomaticReviewRun(process.cwd());
  review.observe("keryx review complete --id x", { isError: true, output: "" });
  const r = await run("auto", [toolCall("a1", "ask_user", { ...question, emergency }), TEXT_DONE], [], {}, true, { review });
  expect(r.asked).toBe(1);
  expect(r.selfAnswered).toEqual([]);
  expect(review.disclosure().manual).toBe(1);
});

test("auto in an automatic review: an ordinary question is answered by the run, not by the auto-mode self-answer", async () => {
  const review = new AutomaticReviewRun(process.cwd());
  const r = await run("auto", [toolCall("a1", "ask_user", question), TEXT_DONE], [], {}, true, { review });
  expect(r.asked).toBe(0);
  expect(r.selfAnswered).toEqual([]);
  expect(r.results[0]!.output).toContain("Automatic review");
  expect(review.disclosure().automatic).toBe(1);
});

// Review-auto with no AutomaticReviewRun (a plain shell in review-auto): a policy-tagged question is the human's, not the model's.
test("auto under review-auto without a review run: a policy-tagged question goes to the host once (F-008, F-010)", async () => {
  setReviewSystem("review-auto");
  const r = await run("auto", [toolCall("a1", "ask_user", { ...question, policy: POLICY }), TEXT_DONE]);
  expect(r.asked).toBe(1);
  expect(r.selfAnswered).toEqual([]);
  expect(r.results[0]!.output).toMatch(/^User selected id="small"/);
});

test.each<[string, () => void]>([
  ["KERYX_REVIEW_AUTO_ANSWER=1", () => (process.env.KERYX_REVIEW_AUTO_ANSWER = "1")],
  [`${ENV_AUTONOMOUS_ANSWERS_FILE} set`, () => (process.env[ENV_AUTONOMOUS_ANSWERS_FILE] = "/nonexistent/answers.json")],
])("auto with %s: a policy-tagged question is not self-answered", async (_name, arm) => {
  arm();
  const r = await run("auto", [toolCall("a1", "ask_user", { ...question, policy: POLICY }), TEXT_DONE]);
  expect(r.selfAnswered).toEqual([]);
});

test("auto under review-auto answers an untagged question itself, as plain auto does", async () => {
  setReviewSystem("review-auto");
  const r = await run("auto", [toolCall("a1", "ask_user", question), TEXT_DONE]);
  expect(r.asked).toBe(0);
  expect(r.selfAnswered).toHaveLength(1);
});

test("a turn started in Telegram keeps the question on the human under /mode auto (poll 153)", async () => {
  const r = await run("auto", [toolCall("a1", "ask_user", question), TEXT_DONE], [], {}, true, { mcpGrantsApply: () => false });
  expect(r.asked).toBe(1);
  expect(r.selfAnswered).toEqual([]);
  expect(r.results[0]!.output).toMatch(/^User selected id="small"/);
});

test("a turn started in the terminal (mcpGrantsApply true) is still self-answered under auto", async () => {
  const r = await run("auto", [toolCall("a1", "ask_user", question), TEXT_DONE], [], {}, true, { mcpGrantsApply: () => true });
  expect(r.asked).toBe(0);
  expect(r.selfAnswered).toHaveLength(1);
});

const CREDENTIALS = { command: "cat ~/.config/keryx/auth.json" };
const PERMISSION_QUESTION = { question: "Allow the agent to read the credentials file?", options: OPTIONS };

// F-007: a refusal outside review-auto must not become a standing "no" for the identical call.
test.each<PermissionMode>(["ask", "trust", "auto"])("%s: an identical call is asked again after the operator refused it (F-007)", async (mode) => {
  let approvals = 0;
  const requestApproval: AgentIO["requestApproval"] = async () => {
    approvals += 1;
    return false;
  };
  const rounds = [toolCall("s1", "shell_exec", CREDENTIALS), TEXT_DONE];
  const first = await run(mode, rounds, [shellTool], {}, true, { requestApproval });
  const second = await run(mode, rounds, [shellTool], {}, true, { requestApproval });
  expect(approvals).toBe(2);
  expect(first.results[0]!.output).toContain("not approved");
  expect(second.results[0]!.output).toContain("not approved");
  expect(second.results[0]!.output).not.toContain(REFUSED_EARLIER);
});

test("a refusal in any mode still keeps a permission-style question for the human", async () => {
  const requestApproval: AgentIO["requestApproval"] = async () => false;
  await run("trust", [toolCall("s1", "shell_exec", CREDENTIALS), TEXT_DONE], [shellTool], {}, true, { requestApproval });
  expect(reviewAutoMayAnswer(PERMISSION_QUESTION)).toBe(false);
  const r = await run("auto", [toolCall("a1", "ask_user", PERMISSION_QUESTION), TEXT_DONE]);
  expect(r.asked).toBe(1);
  expect(r.selfAnswered).toEqual([]);
});

test.each<[string, AgentIO["requestApproval"]]>([
  ["an unattended approver", Object.assign(async () => false, { attended: false })],
  ["a stale turn", Object.assign(async () => false, { current: () => false })],
])("%s saying no is not a person's refusal: nothing is remembered", async (_name, requestApproval) => {
  await run("ask", [toolCall("s1", "shell_exec", CREDENTIALS), TEXT_DONE], [shellTool], {}, true, { requestApproval });
  expect(reviewAutoMayAnswer(PERMISSION_QUESTION)).toBe(true);
  const raw = JSON.stringify(CREDENTIALS);
  expect(operatorDenied(toolCallHash("shell_exec", raw))).toBe(false);
});

test("outside review-auto a remembered fingerprint is never read: the approver is still asked", async () => {
  const raw = JSON.stringify(CREDENTIALS);
  recordOperatorDenial(toolCallHash("shell_exec", raw));
  let approvals = 0;
  const requestApproval: AgentIO["requestApproval"] = async () => {
    approvals += 1;
    return false;
  };
  const r = await run("ask", [toolCall("s1", "shell_exec", CREDENTIALS), TEXT_DONE], [shellTool], {}, true, { requestApproval });
  expect(approvals).toBe(1);
  expect(r.results[0]!.output).not.toContain(REFUSED_EARLIER);
});

// F-012: under review-auto both the exact call and its normalised spelling are remembered.
test("review-auto: a refused command stays refused, in another spelling too, without asking again", async () => {
  setReviewSystem("review-auto");
  let approvals = 0;
  const requestApproval: AgentIO["requestApproval"] = async () => {
    approvals += 1;
    return false;
  };
  await run("auto", [toolCall("s1", "shell_exec", CREDENTIALS), TEXT_DONE], [shellTool], {}, true, { requestApproval });
  const raw = JSON.stringify(CREDENTIALS);
  expect(operatorDenied(toolCallHash("shell_exec", raw))).toBe(true);
  expect(operatorDenied(refusalFingerprint("shell_exec", raw, toolCallHash("shell_exec", raw)))).toBe(true);
  const again = await run("auto", [toolCall("s2", "shell_exec", { command: "cat   ~/.config/keryx/auth.json" }), TEXT_DONE], [shellTool], {}, true, { requestApproval });
  expect(again.results[0]!.output).toBe(REFUSED_EARLIER);
  expect(approvals).toBe(1);
});
