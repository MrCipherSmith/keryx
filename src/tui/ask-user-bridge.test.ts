// Flow 392 (review F-001, F-003, F-008): the bridge between keryx's `ask_user` tool and
// the recommendation journal resolves the flow from the checkout, makes a journaling
// failure visible, and remembers the latest answered decision for `/decisions`.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import { journaledAskUser, lastAskUserDecisionId, setAskUserHost, setAskUserNotice } from "./ask-user-bridge";

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

test("a deviation points the transcript at /decisions reason, without a second question (F-001)", async () => {
  const notes: string[] = [];
  const questions: string[] = [];
  setAskUserNotice((text) => notes.push(text));
  setAskUserHost(async (request) => {
    questions.push(request.question);
    return "b";
  });
  await journaledAskUser(root)({ question: "Pick", options: OPTIONS });
  expect(questions).toEqual(["Pick"]);
  expect(notes.join("\n")).toContain("/decisions reason");
});
