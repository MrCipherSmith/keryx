// Flow 426: fewer approval prompts in trust and review-auto. The routine table lifts the untrusted-content
// latch (AC1/AC2), the floors stay (AC3), a refusal is remembered across spellings (AC4) and every prompt
// carries its cause (AC5).

import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { runAgentTurn } from "./agent";
import type { AgentIO, ApprovalMeta } from "./agent";
import { callRound, makeDeps, okReply, scriptedProvider } from "./agent.test-helpers";
import type { Script } from "./agent.test-helpers";
import type { ApprovalCause } from "./approval-cause";
import type { PermissionMode } from "./permission-mode";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { TRUST_ROUTINE_KEYRYX } from "../lib/trust-routine-command";
import { REFUSED_EARLIER, resetOperatorDenials, setReviewSystem } from "../review/review-system";

afterEach(() => {
  setReviewSystem("inherit");
  resetOperatorDenials();
});

function fetchTool(): InteractiveTool {
  return {
    definition: { name: "fetch_page", description: "external", inputSchema: { type: "object", properties: {} }, risk: "read" },
    invoke: async () => ({ output: "external text", isError: false, untrusted: true }),
  };
}

function readNamed(name: string, ran: string[]): InteractiveTool {
  return {
    definition: { name, description: "slate", inputSchema: { type: "object", properties: {}, additionalProperties: true }, risk: "read" },
    invoke: async () => {
      ran.push(name);
      return { output: "ok", isError: false };
    },
  };
}

function shellTool(ran: string[]): InteractiveTool {
  return {
    definition: {
      name: "shell_exec",
      description: "test shell",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
      risk: "shell",
    },
    invoke: async (input) => {
      ran.push(String(input.command));
      return { output: "ran", isError: false };
    },
  };
}

type Asked = { tool: string; meta: ApprovalMeta | undefined };

function ioWith(mode: PermissionMode, asked: Asked[], answer: boolean | ((n: number) => boolean) = false): AgentIO {
  return {
    write: () => {},
    onSystem: () => {},
    permissionMode: () => mode,
    requestApproval: async (tool, _raw, meta) => {
      asked.push({ tool, meta });
      return typeof answer === "function" ? answer(asked.length) : answer;
    },
  };
}

function shellRounds(commands: readonly string[], withFetch: boolean): Script[] {
  const rounds: Script[] = withFetch ? [callRound("f1", "fetch_page", "{}")] : [];
  commands.forEach((command, i) => rounds.push(callRound(`s${i}`, "shell_exec", JSON.stringify({ command }))));
  rounds.push([...okReply]);
  return rounds;
}

async function run(
  mode: PermissionMode,
  rounds: Script[],
  tools: InteractiveTool[],
  answer: boolean | ((n: number) => boolean) = false,
  workingMemoryHost = false,
): Promise<{ asked: Asked[]; lastRequest: string }> {
  const asked: Asked[] = [];
  const { provider, requests } = scriptedProvider(rounds);
  const deps = makeDeps(provider, workingMemoryHost ? { tools, onContextCompaction: () => {} } : { tools });
  const options = workingMemoryHost
    ? { pruneArchive: true, slateSession: { dir: tmpdir(), cwd: tmpdir(), opened: true } }
    : undefined;
  await runAgentTurn(ioWith(mode, asked, answer), deps, [], "go", options);
  return { asked, lastRequest: JSON.stringify(requests[requests.length - 1] ?? {}) };
}

const ROUTINE_COMMANDS = TRUST_ROUTINE_KEYRYX.map((entry) => entry.example);

// AC1: the table lifts the latch

test("AC1: every table entry runs after untrusted content with zero prompts in trust", async () => {
  const ran: string[] = [];
  const { asked } = await run("trust", shellRounds(ROUTINE_COMMANDS, true), [fetchTool(), shellTool(ran)]);
  expect(asked).toEqual([]);
  expect(ran).toEqual(ROUTINE_COMMANDS);
});

test("AC1: every table entry runs after untrusted content with zero prompts in review-auto", async () => {
  setReviewSystem("review-auto");
  const ran: string[] = [];
  const asked: Asked[] = [];
  // One turn is capped at DEFAULT_MAX_ROUNDS tool rounds, so the table runs in turns of 20.
  for (let i = 0; i < ROUTINE_COMMANDS.length; i += 20) {
    const turn = await run("ask", shellRounds(ROUTINE_COMMANDS.slice(i, i + 20), true), [fetchTool(), shellTool(ran)]);
    asked.push(...turn.asked);
  }
  expect(asked).toEqual([]);
  expect(ran).toEqual(ROUTINE_COMMANDS);
});

test("AC1: the slate note and trail tools run after untrusted content with zero prompts in trust and review-auto", async () => {
  const rounds = (): Script[] => [
    callRound("f1", "fetch_page", "{}"),
    callRound("n1", "slate_note", JSON.stringify({ key: "state", text: "wave 2" })),
    callRound("t1", "slate_trail", "{}"),
    [...okReply],
  ];
  const trustRan: string[] = [];
  const trust = await run("trust", rounds(), [fetchTool(), readNamed("slate_note", trustRan), readNamed("slate_trail", trustRan)], false, true);
  expect(trust.asked).toEqual([]);
  expect(trustRan).toEqual(["slate_note", "slate_trail"]);

  setReviewSystem("review-auto");
  const autoRan: string[] = [];
  const auto = await run("ask", rounds(), [fetchTool(), readNamed("slate_note", autoRan), readNamed("slate_trail", autoRan)], false, true);
  expect(auto.asked).toEqual([]);
  expect(autoRan).toEqual(["slate_note", "slate_trail"]);
});

test("AC1 control: the slate seed writer and ask mode still prompt after untrusted content", async () => {
  const ran: string[] = [];
  const seed = await run(
    "trust",
    [callRound("f1", "fetch_page", "{}"), callRound("w1", "slate_write_seed", "{}"), [...okReply]],
    [fetchTool(), readNamed("slate_write_seed", ran)],
    false,
    true,
  );
  expect(seed.asked).toHaveLength(1);
  expect(ran).toEqual([]);

  const askRan: string[] = [];
  const ask = await run(
    "ask",
    [callRound("f1", "fetch_page", "{}"), callRound("n1", "slate_note", "{}"), [...okReply]],
    [fetchTool(), readNamed("slate_note", askRan)],
    false,
    true,
  );
  expect(ask.asked).toHaveLength(1);
  expect(askRan).toEqual([]);
});

// AC2 / AC3: outside the table, and the floors, the call still asks

test("AC2/AC3: commands outside the table or chained to risk still prompt after untrusted content", async () => {
  const commands = [
    "keryx harness wave --spec tier.json",
    "keryx flow status; echo hi",
    "keryx flow status | tee out.txt",
    "keryx flow status > /etc/out",
    "(keryx flow status)",
    "rm -rf ~",
  ];
  const ran: string[] = [];
  const { asked } = await run("trust", shellRounds(commands, true), [fetchTool(), shellTool(ran)]);
  expect(asked).toHaveLength(commands.length);
  expect(ran).toEqual([]);
});

test("AC3: in review-auto a floor call after untrusted content still reaches the human", async () => {
  setReviewSystem("review-auto");
  const commands = ["rm -rf ~", "cat ~/.config/keryx/auth.json", "keryx harness wave --spec tier.json"];
  const ran: string[] = [];
  const { asked } = await run("ask", shellRounds(commands, true), [fetchTool(), shellTool(ran)]);
  expect(asked).toHaveLength(commands.length);
  expect(ran).toEqual([]);
});

// AC4: a refusal is remembered across spellings

const WAVE_SPELLINGS = [
  "keryx harness wave --spec tier.json",
  "keryx   harness wave --spec=tier.json --json",
  'keryx harness wave "--spec" \'tier.json\' --help',
];

test("AC4: three spellings of a refused call raise one modal; the others are refused earlier", async () => {
  setReviewSystem("review-auto");
  const ran: string[] = [];
  const { asked, lastRequest } = await run("trust", shellRounds(WAVE_SPELLINGS, true), [fetchTool(), shellTool(ran)], false);
  expect(asked).toHaveLength(1);
  expect(ran).toEqual([]);
  expect(lastRequest.split(REFUSED_EARLIER).length - 1).toBe(2);
});

test("AC4: a refused call stays refused in a later turn, with no modal, even where trust would run it", async () => {
  setReviewSystem("review-auto");
  const asked: Asked[] = [];
  const ran: string[] = [];
  const first = scriptedProvider(shellRounds([WAVE_SPELLINGS[0]!], true));
  await runAgentTurn(ioWith("trust", asked, false), makeDeps(first.provider, { tools: [fetchTool(), shellTool(ran)] }), [], "go");
  expect(asked).toHaveLength(1);

  const second = scriptedProvider(shellRounds([WAVE_SPELLINGS[1]!], false));
  await runAgentTurn(ioWith("trust", asked, false), makeDeps(second.provider, { tools: [shellTool(ran)] }), [], "again");
  expect(asked).toHaveLength(1);
  expect(ran).toEqual([]);
  expect(JSON.stringify(second.requests[second.requests.length - 1])).toContain(REFUSED_EARLIER);
});

test("AC4: an approved call is not remembered as refused", async () => {
  setReviewSystem("review-auto");
  const ran: string[] = [];
  const { asked } = await run("trust", shellRounds(WAVE_SPELLINGS, true), [fetchTool(), shellTool(ran)], true);
  expect(asked).toHaveLength(WAVE_SPELLINGS.length);
  expect(ran).toHaveLength(WAVE_SPELLINGS.length);
});

test("AC4: a different command is still asked after a refusal", async () => {
  setReviewSystem("review-auto");
  const ran: string[] = [];
  const { asked } = await run(
    "trust",
    shellRounds([WAVE_SPELLINGS[0]!, "keryx harness wave --spec other.json"], true),
    [fetchTool(), shellTool(ran)],
    false,
  );
  expect(asked).toHaveLength(2);
});

// AC5: the agent sets the cause on every approval

test("AC5: the agent names the cause of each prompt", async () => {
  const seen = async (mode: PermissionMode, commands: string[], withFetch: boolean): Promise<(string | undefined)[]> => {
    const { asked } = await run(mode, shellRounds(commands, withFetch), [fetchTool(), shellTool([])]);
    return asked.map((a) => a.meta?.cause);
  };
  expect(await seen("trust", ["rm -rf ~"], false)).toEqual(["destructive"]);
  expect(await seen("trust", ["cat ~/.config/keryx/auth.json"], false)).toEqual(["credentials"]);
  expect(await seen("trust", ["keryx harness wave --spec tier.json"], true)).toEqual(["not-in-routine-list"]);
  expect(await seen("ask", ["keryx harness wave --spec tier.json"], false)).toEqual(["mode-ask"]);

  const web = await run("trust", [callRound("f1", "fetch_page", "{}"), callRound("f2", "slate_write_seed", "{}"), [...okReply]], [
    fetchTool(),
    readNamed("slate_write_seed", []),
  ]);
  expect(web.asked.map((a) => a.meta?.cause)).toEqual(["untrusted-content"]);
});

// AC7: the tool calls of ~/notes/evidence/run17/approvals.log (runs 17-19) replayed through the new rules.
// Worst case: external content entered the turn first, so the latch is armed for every call. The log
// elides some command tails and paths; those are filled in and do not change how a call classifies.
// The run-19 ask_user (log line 18) is a question to the operator, not an approval call, and is not replayed.

type ReplayCall = {
  logLine: number;
  tool: "shell_exec" | "slate_note" | "slate_write_seed";
  command?: string;
  /** The cause of the prompt that remains, or undefined when the call no longer prompts. */
  remains: ApprovalCause | undefined;
};

const RUN_17_19: readonly ReplayCall[] = [
  { logLine: 5, tool: "shell_exec", command: `python3 -c "import json; json.load(open('research-ledger.json'))"`, remains: "not-in-routine-list" },
  { logLine: 6, tool: "shell_exec", command: "curl -s http://127.0.0.1:8080/", remains: "not-in-routine-list" },
  { logLine: 7, tool: "slate_note", remains: undefined },
  { logLine: 8, tool: "slate_write_seed", remains: "untrusted-content" },
  { logLine: 15, tool: "shell_exec", command: "keryx help harness && keryx agents external list --json --no-probe && command -v keryx", remains: "credentials" },
  { logLine: 16, tool: "shell_exec", command: "keryx harness wave --spec tier.json", remains: "not-in-routine-list" },
  { logLine: 17, tool: "slate_note", remains: undefined },
  { logLine: 19, tool: "shell_exec", command: "keryx harness wave --spec tier.json", remains: undefined },
  { logLine: 20, tool: "shell_exec", command: "keryx review --help", remains: undefined },
  { logLine: 21, tool: "shell_exec", command: "keryx harness wave --help && keryx review ledger build --base main", remains: undefined },
  { logLine: 22, tool: "shell_exec", command: "keryx   harness wave --spec=tier.json", remains: undefined },
  { logLine: 23, tool: "slate_note", remains: undefined },
];

test("AC7: the approval log of runs 17-19 replayed in review-auto leaves 5 of 12 prompts, each a floor or an unlisted command with its cause", async () => {
  setReviewSystem("review-auto");
  const ran: string[] = [];
  const rounds: Script[] = [callRound("f1", "fetch_page", "{}")];
  RUN_17_19.forEach((call, i) => {
    const input = call.tool === "shell_exec" ? JSON.stringify({ command: call.command }) : "{}";
    rounds.push(callRound(`r${i}`, call.tool, input));
  });
  rounds.push([...okReply]);
  const asked: Asked[] = [];
  const denied = (tool: string, raw: string): boolean => tool === "shell_exec" && (raw.includes("127.0.0.1") || raw.includes("harness wave --spec"));
  const { provider } = scriptedProvider(rounds);
  const io = ioWith("trust", asked, false);
  io.requestApproval = async (tool, raw, meta) => {
    asked.push({ tool, meta });
    return !denied(tool, raw);
  };
  await runAgentTurn(
    io,
    makeDeps(provider, {
      tools: [fetchTool(), shellTool(ran), readNamed("slate_note", ran), readNamed("slate_write_seed", ran)],
      onContextCompaction: () => {},
    }),
    [],
    "go",
    { pruneArchive: true, slateSession: { dir: tmpdir(), cwd: tmpdir(), opened: true } },
  );

  const remaining = RUN_17_19.filter((call) => call.remains !== undefined);
  expect(asked.map((a) => a.meta?.cause)).toEqual(remaining.map((call) => call.remains));
  expect(RUN_17_19).toHaveLength(12);
  expect(asked).toHaveLength(5);
  // Line 15 still asks because `command -v keryx` trips the existing human-confirmation floor (a bare `keryx` reads as an interactive start); AC3 keeps that floor.
  // The probe and the wave spec the operator denied in the log stay denied.
  expect(ran.filter((entry) => entry.includes("127.0.0.1") || entry.includes("harness wave --spec"))).toEqual([]);
});

for (const risk of ["write", "delegate"] as const) {
  test(`hardening: refused ${risk} is checked before autoapproval`, async () => {
    setReviewSystem("review-auto");
    const ran: string[] = [];
    const tool: InteractiveTool = {
      definition: { name: `test_${risk}`, description: "test", risk, inputSchema: { type: "object", properties: {} } },
      invoke: async () => { ran.push(risk); return { output: "ran", isError: false }; },
    };
    const asked: Asked[] = [];
    const first = scriptedProvider([callRound("f", "fetch_page", "{}"), callRound("w", tool.definition.name, "{}"), [...okReply]]);
    await runAgentTurn(ioWith("trust", asked, false), makeDeps(first.provider, { tools: [fetchTool(), tool] }), [], "first");
    expect(asked).toHaveLength(1);
    const second = scriptedProvider([callRound("w2", tool.definition.name, "{}"), [...okReply]]);
    await runAgentTurn(ioWith("trust", asked, false), makeDeps(second.provider, { tools: [tool] }), [], "retry");
    expect(ran).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(JSON.stringify(second.requests.at(-1))).toContain(REFUSED_EARLIER);
  });
}
