// Flow 392 (review F-001, F-003, F-008): the bridge between keryx's `ask_user` tool and
// the recommendation journal resolves the flow from the checkout, makes a journaling
// failure visible, and remembers the latest answered decision for `/decisions`.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assignArm, reasonSubsample, saltFile } from "../decisions/arms";
import { REASON_SUBSAMPLE_ENV } from "../decisions/journal";
import { createFlowService } from "../flow/service";
import { journaledAskUser, journaledPick, lastAskUserDecisionId, setAskUserHost, setAskUserNotice } from "./ask-user-bridge";

let root: string;
const savedFlow = process.env["KERYX_FLOW"];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-ask-bridge-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  delete process.env["KERYX_FLOW"];
});

afterEach(async () => {
  setAskUserHost(undefined);
  setAskUserNotice(undefined);
  if (savedFlow === undefined) delete process.env["KERYX_FLOW"];
  else process.env["KERYX_FLOW"] = savedFlow;
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "a", label: "Option A", description: "the safe one", recommended: true },
  { id: "b", label: "Option B", description: "the quick one" },
];

async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

test("ask_user on a flow's branch records the flow and a real stage, and writes the journal.md line (F-003)", async () => {
  await git("init", "-q", "-b", "main");
  await git("commit", "-q", "--allow-empty", "-m", "init");
  const flows = createFlowService({ tracker: null, healthGate: async () => ({ status: "pass", reasons: [] }), now: () => new Date("2026-10-02T10:00:00Z") });
  const created = await flows.init({ cwd: root, title: "Bridge flow" });
  await git("checkout", "-q", "-b", `feat/flow-${created.flow.id}-bridge-flow`);

  setAskUserHost(async () => "b");
  expect(await journaledAskUser(root)({ question: "Pick", options: OPTIONS })).toBe("b");

  const lines = (await readFile(path.join(root, ".metaproject", "data", "decisions", "journal.jsonl"), "utf8")).trim().split("\n");
  const open = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(open).toMatchObject({ kind: "open", flow: created.flow.id });
  expect(open["stage"]).not.toBe("ask_user");
  expect(await readFile(path.join(root, created.dir, "journal.md"), "utf8")).toContain("chose b; recommended a");
  expect(lastAskUserDecisionId()).toBe(open["id"] as string);
});

test("a journaling failure shows up as a transcript note, and the question still returns (F-008)", async () => {
  await writeFile(path.join(root, ".metaproject", "data"), "in the way", "utf8");
  const notes: string[] = [];
  setAskUserNotice((text) => notes.push(text));
  setAskUserHost(async () => "a");
  expect(await journaledAskUser(root)({ question: "Pick", options: OPTIONS })).toBe("a");
  expect(notes.some((text) => text.includes("decision journal:"))).toBe(true);
});

test("a deviation asks the human once for a reason, through the same host, and waits for it (F-001)", async () => {
  const questions: string[] = [];
  setAskUserHost(async (request) => {
    questions.push(request.question);
    return questions.length === 1 ? "b" : "B is quicker";
  });
  expect(await journaledAskUser(root)({ question: "Pick", options: OPTIONS })).toBe("b");
  expect(questions).toHaveLength(2);
  expect(questions[0]).toBe("Pick");
  expect(questions[1]).toContain("Why?");
  const lines = (await readFile(path.join(root, ".metaproject", "data", "decisions", "journal.jsonl"), "utf8")).trim().split("\n");
  expect(JSON.parse(lines[lines.length - 1] ?? "{}")).toMatchObject({ kind: "reason", reason: "B is quicker" });
});

test("a followed recommendation asks nothing more", async () => {
  const questions: string[] = [];
  setAskUserHost(async (request) => (questions.push(request.question), "a"));
  await journaledAskUser(root)({ question: "Pick", options: OPTIONS });
  expect(questions).toEqual(["Pick"]);
});

/** Pin the repository salt to one that puts the first decision in (or out of) the reason subsample. */
async function pinSalt(inSample: boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    const salt = `bridge-salt-${i}-0123456789`;
    if (reasonSubsample(assignArm(salt, 1).seed, 1) !== inSample) continue;
    const file = await saltFile(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${salt}\n`, "utf8");
    return;
  }
  throw new Error("no such salt");
}

/** The preload switches the reason subsample off for the suite; these tests turn it back on. */
async function withSubsampleOn(run: () => Promise<void>): Promise<void> {
  const saved = process.env[REASON_SUBSAMPLE_ENV];
  delete process.env[REASON_SUBSAMPLE_ENV];
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env[REASON_SUBSAMPLE_ENV];
    else process.env[REASON_SUBSAMPLE_ENV] = saved;
  }
}

test("F-005: with the subsample switch unset, a followed recommendation in the subsample asks for a reason once, through the host", async () => {
  await withSubsampleOn(async () => {
    await pinSalt(true);
    const questions: string[] = [];
    setAskUserHost(async (request) => (questions.push(request.question), questions.length === 1 ? "a" : "least risk"));
    expect(await journaledAskUser(root)({ question: "Pick", options: OPTIONS })).toBe("a");
    expect(questions).toHaveLength(2);
    expect(questions[1]).toContain("Why this choice?");
    const lines = (await readFile(path.join(root, ".metaproject", "data", "decisions", "journal.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ kind: "open", reasonRequested: true, reasonPrompt: true });
    expect(JSON.parse(lines[lines.length - 1] ?? "{}")).toMatchObject({ kind: "reason", reason: "least risk" });
  });
});

test("F-001: a composer-dock pick records that its surface never prompts, and a followed recommendation in the subsample asks nothing", async () => {
  await withSubsampleOn(async () => {
    await pinSalt(true);
    const shown: string[][] = [];
    const picked = await journaledPick(
      root,
      { source: "tui-wiki-enrich", question: "Mode?", options: [{ id: "a", label: "A", description: "", recommended: true }, { id: "b", label: "B", description: "" }], cancelId: "cancel" },
      async (options) => (shown.push(options.map((option) => option.id)), "a"),
    );
    expect(picked).toBe("a");
    expect(shown).toHaveLength(1);
    const lines = (await readFile(path.join(root, ".metaproject", "data", "decisions", "journal.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ kind: "open", reasonPrompt: false, reasonRequested: false });
  });
});
