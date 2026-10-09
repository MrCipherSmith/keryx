// Flow 418 T5: a `trust`-mode shell carries a long review orchestration to its end without human nudges.
// Round budget, the untrusted-content latch for routine review commands, bounded plan follow-through,
// remembered ask_user answers, and the subagent concurrency constant.

import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_MAX_SUBAGENT_CONCURRENCY,
  ENV_AGENT_MAX_ROUNDS,
  MAX_PLAN_FOLLOW_THROUGHS,
  MAX_AGENT_MAX_ROUNDS,
  TRUST_MODE_MAX_ROUNDS,
  resolveAgentMaxRounds,
  runAgentTurn,
} from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import { callRound, makeDeps, okReply, scriptedProvider } from "./agent.test-helpers";
import type { Script } from "./agent.test-helpers";
import type { PermissionMode } from "./permission-mode";
import { askAnswerNoteKey } from "../session/ask-answer-notes";
import { createAskUserTool } from "../harness/tool/builtin/ask-user-tool";
import type { AskUserFn } from "../harness/tool/builtin/ask-user-tool";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { getExecutionPlan, setExecutionPlan, updateExecutionPlan } from "../session/execution-plan";
import type { ExecutionPlanItem } from "../session/execution-plan";
import { readSlate, writeSlate } from "../session/slate";
import type { SlateSessionRef } from "../session/slate-lifecycle";
import { isTrustRoutineCommand } from "../lib/trust-routine-command";
import type { NormalizedMessage } from "../harness/provider/types";

function readTool(name: string, run: () => void = () => {}, untrusted = false): InteractiveTool {
  return {
    definition: {
      name,
      description: "test tool",
      inputSchema: { type: "object", properties: { n: { type: "number" } }, additionalProperties: true },
      risk: "read",
    },
    invoke: async () => {
      run();
      return { output: "ok", isError: false, ...(untrusted ? { untrusted: true } : {}) };
    },
  };
}

function shellTool(commands: string[]): InteractiveTool {
  return {
    definition: {
      name: "shell_exec",
      description: "test shell",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
      risk: "shell",
    },
    invoke: async (input) => {
      commands.push(String(input.command));
      return { output: "ran", isError: false };
    },
  };
}

function ioWith(mode: PermissionMode, approvals: string[] = [], system: string[] = []): AgentIO {
  return {
    write: () => {},
    onSystem: (text) => system.push(text),
    permissionMode: () => mode,
    requestApproval: async (_tool, raw) => {
      approvals.push(raw);
      return false;
    },
  };
}

/** `count` rounds, each one a distinct tool call (distinct input, so the repeat guard stays quiet), then a final reply. */
function longScript(count: number): Script[] {
  const rounds: Script[] = [];
  for (let i = 0; i < count; i += 1) rounds.push(callRound(`c${i}`, "probe", JSON.stringify({ n: i })));
  rounds.push(okReply[0] === undefined ? [] : [...okReply]);
  return rounds;
}

// AC1

test("AC1: the trust budget is a named 200-round constant; ask and auto keep 40", () => {
  expect(TRUST_MODE_MAX_ROUNDS).toBe(200);
  expect(DEFAULT_MAX_ROUNDS).toBe(40);
  expect(resolveAgentMaxRounds({}, "trust")).toBe(TRUST_MODE_MAX_ROUNDS);
  expect(resolveAgentMaxRounds({}, "ask")).toBe(DEFAULT_MAX_ROUNDS);
  expect(resolveAgentMaxRounds({}, "auto")).toBe(DEFAULT_MAX_ROUNDS);
  expect(resolveAgentMaxRounds({})).toBe(DEFAULT_MAX_ROUNDS);
});

test("AC1: an explicit env override wins in every mode and stays under the hard ceiling", () => {
  expect(resolveAgentMaxRounds({ [ENV_AGENT_MAX_ROUNDS]: "60" }, "trust")).toBe(60);
  expect(resolveAgentMaxRounds({ [ENV_AGENT_MAX_ROUNDS]: "60" }, "ask")).toBe(60);
  expect(resolveAgentMaxRounds({ [ENV_AGENT_MAX_ROUNDS]: "9999" }, "trust")).toBe(MAX_AGENT_MAX_ROUNDS);
  expect(resolveAgentMaxRounds({ [ENV_AGENT_MAX_ROUNDS]: "nope" }, "trust")).toBe(TRUST_MODE_MAX_ROUNDS);
});

test("AC1: round 41 runs in trust and is refused in ask", async () => {
  const run = async (mode: PermissionMode): Promise<{ requests: number; system: string }> => {
    const { provider, requests } = scriptedProvider(longScript(60), { exhausted: "empty" });
    const system: string[] = [];
    await runAgentTurn(ioWith(mode, [], system), makeDeps(provider, { tools: [readTool("probe")] }), [], "go");
    return { requests: requests.length, system: system.join("") };
  };
  const ask = await run("ask");
  expect(ask.requests).toBe(DEFAULT_MAX_ROUNDS);
  expect(ask.system).toContain(`Model-round limit reached: ${DEFAULT_MAX_ROUNDS}/${DEFAULT_MAX_ROUNDS}`);

  const trust = await run("trust");
  expect(trust.requests).toBe(61);
  expect(trust.system).not.toContain("Model-round limit reached");
});

test("AC1: trust stops at 200 rounds", async () => {
  const { provider, requests } = scriptedProvider(longScript(TRUST_MODE_MAX_ROUNDS + 10), { exhausted: "empty" });
  const system: string[] = [];
  await runAgentTurn(ioWith("trust", [], system), makeDeps(provider, { tools: [readTool("probe")] }), [], "go");
  expect(requests).toHaveLength(TRUST_MODE_MAX_ROUNDS);
  expect(system.join("")).toContain(`Model-round limit reached: ${TRUST_MODE_MAX_ROUNDS}/${TRUST_MODE_MAX_ROUNDS}`);
});

// AC2

test("AC2: isTrustRoutineCommand allows review/context chains and refuses everything riskier", () => {
  for (const command of [
    "cd ../dir && keryx ctx run -- keryx review scope --help",
    "keryx review scope --base main",
    "keryx review status",
    "keryx ctx run -- bun test src/foo.test.ts",
    "keryx ctx rg foo src",
    "keryx flow status",
    "cd /tmp/x && keryx review complete --round 1",
    "git status",
  ]) {
    expect(isTrustRoutineCommand(command)).toBe(true);
  }
  for (const command of [
    "",
    "rm -rf build",
    "cat ~/.config/keryx/auth.json",
    "keryx workspace confirm-review --workspace ws-1",
    "git push origin main",
    "keryx review reply 12 --body hi",
    "keryx review comments 12",
    "keryx review ci-triage 12",
    "keryx review jev-rules",
    "keryx review",
    "keryx ctx run -- curl https://example.com",
    "keryx review scope; rm -rf build",
    "keryx review scope | tee out.txt",
    "keryx review scope > out.txt",
    "keryx review scope $(whoami)",
    "git log --output=/tmp/x",
    "keryx ctx rg --pre ./evil foo",
    "cd a && cd b && cd c && cd d && cd e",
  ]) {
    expect(isTrustRoutineCommand(command)).toBe(false);
  }
});

async function runAfterUntrusted(
  mode: PermissionMode,
  commands: readonly string[],
): Promise<{ approvals: string[]; ran: string[] }> {
  const approvals: string[] = [];
  const ran: string[] = [];
  const rounds: Script[] = [callRound("f1", "fetch_page", "{}")];
  commands.forEach((command, i) => rounds.push(callRound(`s${i}`, "shell_exec", JSON.stringify({ command }))));
  rounds.push([...okReply]);
  const { provider } = scriptedProvider(rounds);
  await runAgentTurn(
    ioWith(mode, approvals),
    makeDeps(provider, { tools: [readTool("fetch_page", () => {}, true), shellTool(ran)] }),
    [],
    "go",
  );
  return { approvals, ran };
}

test("AC2: routine review commands raise zero approval prompts in trust, even after an untrusted tool result", async () => {
  const commands = [
    "cd ../dir && keryx ctx run -- keryx review scope --help",
    "keryx review status",
    "keryx ctx run -- bun test src/foo.test.ts",
  ];
  const { approvals, ran } = await runAfterUntrusted("trust", commands);
  expect(approvals).toEqual([]);
  expect(ran).toEqual(commands);
});

test("AC2: control, the same routine command in ask mode still prompts", async () => {
  const { approvals, ran } = await runAfterUntrusted("ask", ["keryx review verify --run"]);
  expect(approvals).toHaveLength(1);
  expect(ran).toEqual([]);
});

test("AC2: destructive, credential, SAC and non-routine commands still prompt in trust after untrusted content", async () => {
  const commands = [
    "rm -rf build",
    "cat ~/.config/keryx/auth.json",
    "keryx workspace confirm-review --workspace ws-1",
    "echo hi > notes.txt",
  ];
  const { approvals, ran } = await runAfterUntrusted("trust", commands);
  expect(approvals).toHaveLength(commands.length);
  expect(ran).toEqual([]);
});

test("AC2: without untrusted content a routine command is never prompted in trust either", async () => {
  const approvals: string[] = [];
  const ran: string[] = [];
  const { provider } = scriptedProvider([callRound("s0", "shell_exec", '{"command":"keryx review scope"}'), [...okReply]]);
  await runAgentTurn(ioWith("trust", approvals), makeDeps(provider, { tools: [shellTool(ran)] }), [], "go");
  expect(approvals).toEqual([]);
  expect(ran).toEqual(["keryx review scope"]);
});

// AC3

async function planFixture(items: readonly ExecutionPlanItem[]): Promise<{ dir: string; slateSession: SlateSessionRef }> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-trust-plan-"));
  await writeSlate(dir, () => ({ anchors: { root: dir, touched: [] }, course: {}, seeds: [] }));
  await setExecutionPlan(dir, { expectedRevision: 0, items });
  return { dir, slateSession: { dir, cwd: dir, opened: true } };
}

const FOUR_ITEMS: readonly ExecutionPlanItem[] = ["a", "b", "c", "d"].map((id) => ({
  id,
  title: `Step ${id}`,
  status: "pending" as const,
}));

/** A tool that completes the next open plan item, standing in for the model's plan-update call. */
function advancePlanTool(dir: string, calls: { n: number }): InteractiveTool {
  return {
    definition: {
      name: "advance",
      description: "complete the next plan item",
      inputSchema: { type: "object", properties: { n: { type: "number" } }, additionalProperties: true },
      risk: "read",
    },
    invoke: async () => {
      calls.n += 1;
      const plan = await getExecutionPlan(dir);
      const next = plan?.items.find((item) => item.status === "pending" || item.status === "in_progress");
      if (plan !== undefined && next !== undefined) {
        await updateExecutionPlan(dir, { expectedRevision: plan.revision, itemId: next.id, status: "completed" });
      }
      return { output: "advanced", isError: false };
    },
  };
}

/** Every item takes one tool round, and the model tries to stop with a text reply before each one. */
function proseThenAdvance(items: number): Script[] {
  const rounds: Script[] = [];
  for (let i = 0; i < items; i += 1) {
    rounds.push([{ kind: "text_delta", text: `working on step ${i}` }, { kind: "model_end" }]);
    rounds.push(callRound(`adv${i}`, "advance", JSON.stringify({ n: i })));
  }
  rounds.push([{ kind: "text_delta", text: "all done" }, { kind: "model_end" }]);
  return rounds;
}

test("AC3: in trust a four-item plan finishes with no operator message", async () => {
  const { dir, slateSession } = await planFixture(FOUR_ITEMS);
  const calls = { n: 0 };
  const { provider, requests } = scriptedProvider(proseThenAdvance(4), { exhausted: "empty" });
  const history: NormalizedMessage[] = [];
  await runAgentTurn(
    ioWith("trust"),
    makeDeps(provider, { tools: [advancePlanTool(dir, calls)] }),
    history,
    "run the plan",
    { slateSession },
  );
  expect(calls.n).toBe(4);
  expect(requests).toHaveLength(9);
  expect((await getExecutionPlan(dir))?.items.every((item) => item.status === "completed")).toBe(true);
  expect(history.filter((m) => m.role === "user" && m.content === "run the plan")).toHaveLength(1);
  const nudges = history.filter((m) => m.provenance === "harness" && m.content.includes("actionable items remaining"));
  expect(nudges).toHaveLength(4);
});

test("AC3: the same plan stops after the first reply in ask mode (follow-through is off)", async () => {
  const { dir, slateSession } = await planFixture(FOUR_ITEMS);
  const calls = { n: 0 };
  const { provider, requests } = scriptedProvider(proseThenAdvance(4), { exhausted: "empty" });
  await runAgentTurn(ioWith("ask"), makeDeps(provider, { tools: [advancePlanTool(dir, calls)] }), [], "run the plan", {
    slateSession,
  });
  expect(requests).toHaveLength(1);
  expect(calls.n).toBe(0);
});

test("AC3: follow-through is capped at MAX_PLAN_FOLLOW_THROUGHS per turn", async () => {
  expect(MAX_PLAN_FOLLOW_THROUGHS).toBe(8);
  const items: ExecutionPlanItem[] = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, title: `Item ${i}`, status: "pending" }));
  const { dir, slateSession } = await planFixture(items);
  const calls = { n: 0 };
  const { provider, requests } = scriptedProvider(proseThenAdvance(12), { exhausted: "empty" });
  const system: string[] = [];
  await runAgentTurn(ioWith("trust", [], system), makeDeps(provider, { tools: [advancePlanTool(dir, calls)] }), [], "go", {
    slateSession,
  });
  expect(calls.n).toBe(MAX_PLAN_FOLLOW_THROUGHS);
  expect(requests).toHaveLength(MAX_PLAN_FOLLOW_THROUGHS * 2 + 1);
  expect(system.join("")).toContain(`Actionable items remain after ${MAX_PLAN_FOLLOW_THROUGHS} follow-throughs`);
});

test("AC3: a blocked item ends the turn at once", async () => {
  const { dir, slateSession } = await planFixture([
    { id: "a", title: "Step a", status: "blocked" },
    { id: "b", title: "Step b", status: "pending" },
  ]);
  const { provider, requests } = scriptedProvider(proseThenAdvance(2), { exhausted: "empty" });
  await runAgentTurn(ioWith("trust"), makeDeps(provider, { tools: [advancePlanTool(dir, { n: 0 })] }), [], "go", {
    slateSession,
  });
  expect(requests).toHaveLength(1);
});

test("AC3: a nudge that moves nothing ends the turn instead of looping", async () => {
  const { slateSession } = await planFixture(FOUR_ITEMS);
  const text: Script = [{ kind: "text_delta", text: "thinking" }, { kind: "model_end" }];
  const { provider, requests } = scriptedProvider([text, text, text, text], { exhausted: "repeat-last" });
  await runAgentTurn(ioWith("trust"), makeDeps(provider), [], "go", { slateSession });
  expect(requests).toHaveLength(2);
});

test("AC3: an explicit planFollowThrough false keeps follow-through off in trust, true turns it on in ask", async () => {
  const off = await planFixture(FOUR_ITEMS);
  const offRun = scriptedProvider(proseThenAdvance(4), { exhausted: "empty" });
  await runAgentTurn(
    ioWith("trust"),
    makeDeps(offRun.provider, { tools: [advancePlanTool(off.dir, { n: 0 })], planFollowThrough: false }),
    [],
    "go",
    { slateSession: off.slateSession },
  );
  expect(offRun.requests).toHaveLength(1);

  const on = await planFixture(FOUR_ITEMS);
  const onRun = scriptedProvider(proseThenAdvance(4), { exhausted: "empty" });
  await runAgentTurn(
    ioWith("ask"),
    makeDeps(onRun.provider, { tools: [advancePlanTool(on.dir, { n: 0 })], planFollowThrough: true }),
    [],
    "go",
    { slateSession: on.slateSession },
  );
  expect(onRun.requests.length).toBeGreaterThan(1);
});

// AC4

function askRound(id: string, question: string, extra: Record<string, unknown> = {}): Script {
  return callRound(
    id,
    "ask_user",
    JSON.stringify({
      question,
      options: [
        { id: "yes", label: "Yes", description: "" },
        { id: "no", label: "No", description: "" },
      ],
      ...extra,
    }),
  );
}

async function askFixture(opened = true): Promise<{ dir: string; slateSession: SlateSessionRef }> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-trust-ask-"));
  await writeSlate(dir, () => ({ anchors: { root: dir, touched: [] }, course: {}, seeds: [] }));
  return { dir, slateSession: { dir, cwd: dir, opened } };
}

async function runAsks(
  rounds: Script[],
  slateSession: SlateSessionRef,
): Promise<{ prompts: string[]; history: NormalizedMessage[] }> {
  const prompts: string[] = [];
  const ask: AskUserFn = async (request) => {
    prompts.push(request.question);
    return "yes";
  };
  const history: NormalizedMessage[] = [];
  const deps: AgentDeps = makeDeps(scriptedProvider([...rounds, [...okReply]]).provider, { tools: [createAskUserTool(ask)] });
  await runAgentTurn(ioWith("trust"), deps, history, "go", { slateSession });
  return { prompts, history };
}

test("AC4: the same question asked twice is prompted once and the second answer comes from the note", async () => {
  const { dir, slateSession } = await askFixture();
  const { prompts, history } = await runAsks(
    [askRound("q1", "Which branch should I review?"), askRound("q2", "  which BRANCH should I review ")],
    slateSession,
  );
  expect(prompts).toEqual(["Which branch should I review?"]);
  const key = askAnswerNoteKey("Which branch should I review?");
  expect(key).toBeDefined();
  expect((await readSlate(dir))?.notes?.[key as string]?.text).toContain('User selected id="yes"');
  const results = history.filter((m) => m.role === "tool").map((m) => m.content);
  expect(results).toHaveLength(2);
  expect(results[1]).toContain("Already answered by the operator");
  expect(results[1]).toContain('id="yes"');
});

test("AC4: a different question is prompted again", async () => {
  const { slateSession } = await askFixture();
  const { prompts } = await runAsks([askRound("q1", "Which branch?"), askRound("q2", "Which base?")], slateSession);
  expect(prompts).toEqual(["Which branch?", "Which base?"]);
});

test("AC4: with the slate not opened nothing is stored or reused", async () => {
  const { dir, slateSession } = await askFixture(false);
  const { prompts } = await runAsks([askRound("q1", "Which branch?"), askRound("q2", "Which branch?")], slateSession);
  expect(prompts).toEqual(["Which branch?", "Which branch?"]);
  expect((await readSlate(dir))?.notes).toBeUndefined();
});

test("AC4: an irreversible or action question is asked every time and never stored", async () => {
  const { dir, slateSession } = await askFixture();
  const { prompts } = await runAsks(
    [
      askRound("q1", "Publish the release?", { irreversible: true }),
      askRound("q2", "Publish the release?", { irreversible: true }),
      askRound("q3", "Delete the branch?", { action: "delete" }),
      askRound("q4", "Delete the branch?", { action: "delete" }),
    ],
    slateSession,
  );
  expect(prompts).toHaveLength(4);
  expect((await readSlate(dir))?.notes).toBeUndefined();
});

test("AC4: a cancelled question is not stored, so it can be asked again", async () => {
  const { dir, slateSession } = await askFixture();
  const prompts: string[] = [];
  const ask: AskUserFn = async (request) => {
    prompts.push(request.question);
    return prompts.length === 1 ? "__cancel__" : "yes";
  };
  const deps = makeDeps(
    scriptedProvider([askRound("q1", "Which branch?"), askRound("q2", "Which branch?"), [...okReply]]).provider,
    { tools: [createAskUserTool(ask)] },
  );
  await runAgentTurn(ioWith("trust"), deps, [], "go", { slateSession });
  expect(prompts).toHaveLength(2);
  expect(Object.keys((await readSlate(dir))?.notes ?? {})).toHaveLength(1);
});

// AC10

test("AC10: the default concurrent-subagent cap is the named constant 10", () => {
  expect(DEFAULT_MAX_SUBAGENT_CONCURRENCY).toBe(10);
});
