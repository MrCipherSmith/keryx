// Flow 392 (AC8): the TUI half of the recommendation journal. The sidebar row exists
// only once the journal holds a decision, `/decisions` routes while idle and while
// busy, and the modal shows exactly what `keryx decisions report` prints.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { answerDecision, loadReport, openDecision, reportText } from "../decisions/service";
import { findAgentCommand } from "../commands/agent-commands";
import { classifyBusyDispatch } from "./busy-dispatch";
import { formatDecisionsLines, isDecisionsCommand, mountDecisionsSidebar, parseDecisionsCommand, presentDecisions, projectDecisionsPanel, routeDecisionsCommand, runDecisionsFollowup } from "./decisions-surface";
import type { OpenModalFn } from "./flow-inspector";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import { clickNode, findById, keypressSource, loadOpenTui, manualInterval, mountChrome, settle, textOf } from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-decisions-tui-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(): Promise<void> {
  await openDecision({
    cwd: root,
    question: "Which approach?",
    options: [
      { id: "a", label: "Option A" },
      { id: "b", label: "Option B" },
    ],
    recommendation: { optionId: "a", reason: "least risk" },
    stage: "design",
    random: () => 0.9,
    id: "d-1",
  });
  await answerDecision({ cwd: root, id: "d-1", choice: "a" });
}

test("projectDecisionsPanel: hidden at zero, one row that fits the sidebar otherwise", () => {
  expect(projectDecisionsPanel(0, SIDEBAR_TEXT_WIDTH)).toEqual({ visible: false, text: "" });
  const one = projectDecisionsPanel(1, SIDEBAR_TEXT_WIDTH);
  expect(one.visible).toBe(true);
  expect(one.text).toContain("1 decision");
  expect(one.text).not.toContain("1 decisions");
  const many = projectDecisionsPanel(12, SIDEBAR_TEXT_WIDTH);
  expect(many.text).toContain("12 decisions");
  expect(many.text).toContain("/decisions");
  expect(many.text.length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
  expect(projectDecisionsPanel(5, 6).text.length).toBeLessThanOrEqual(11);
});

test("/decisions is a registered agent command and is allowed while busy", () => {
  expect(findAgentCommand("/decisions", "agent")?.name).toBe("/decisions");
  expect(isDecisionsCommand("/decisions")).toBe(true);
  expect(isDecisionsCommand("/decisionsx")).toBe(false);
  expect(
    classifyBusyDispatch({
      line: "/decisions",
      commandName: "/decisions",
      isSessionInfo: false,
      isFlows: false,
      isWorkspace: false,
      isReview: false,
      isMcp: false,
      isMcpConsumer: false,
    }),
  ).toBe("decisions");
});

test("routeDecisionsCommand: reaches the handler for /decisions only", () => {
  const taken: string[] = [];
  const fake = { handleCommand: (line: string) => (taken.push(line), true) };
  expect(routeDecisionsCommand("/decisions", fake)).toBe(true);
  expect(routeDecisionsCommand("decisions", fake)).toBe(false);
  expect(routeDecisionsCommand("/approvals", fake)).toBe(false);
  expect(taken).toEqual(["/decisions"]);
});

test("the report modal shows the same lines the CLI report prints", async () => {
  await seed();
  const text = await reportText(root);
  expect(formatDecisionsLines(text).join("\n")).toBe(text);

  let painted: { content: string } | undefined;
  let title: string | undefined;
  const open: OpenModalFn = (_otui, _chrome, input) => {
    title = input.title;
    input.renderTab?.("report", { add: () => undefined } as never, undefined as never);
    return { close: () => undefined } as never;
  };
  class FakeText {
    content: string;
    constructor(_r: unknown, opts: { id: string; content: string }) {
      this.content = opts.content;
      painted = { content: opts.content };
    }
  }
  const handle = presentDecisions(open, { TextRenderable: FakeText }, {}, { text, visibleRows: 40 });
  expect(handle).toBeDefined();
  expect(title).toBe("/decisions");
  expect(painted?.content).toContain("By stage:");
  expect(painted?.content).toContain("ordinary");
});

function mount(h: Awaited<ReturnType<typeof mountChrome>>, state: { n: number }) {
  const timer = manualInterval();
  const sidebar = mountDecisionsSidebar({
    otui: OTUI!.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    width: SIDEBAR_TEXT_WIDTH,
    cwd: root,
    onKeypress: keypressSource(h.renderer),
    count: async () => state.n,
    interval: timer.interval,
  });
  return { sidebar, timer };
}

otuiTest("zero decisions: the section has no rows at all", async () => {
  const h = await mountChrome(OTUI!);
  const { sidebar } = mount(h, { n: 0 });
  try {
    await settle(h);
    expect(findById(h.chrome.sidebarTop, "sb-decisions-row")).toBeUndefined();
    expect(sidebar.projection().visible).toBe(false);
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("the row appears with the count once the journal holds a decision, and a click or /decisions opens the modal", async () => {
  const h = await mountChrome(OTUI!);
  const state = { n: 0 };
  const { sidebar, timer } = mount(h, state);
  try {
    await settle(h);
    state.n = 3;
    await timer.fire();
    await settle(h);
    expect(textOf(findById(h.chrome.sidebarTop, "sb-decisions-row"))).toContain("3 decisions");
    const paints = sidebar.paintCount();
    await timer.fire();
    expect(sidebar.paintCount()).toBe(paints);
    expect(sidebar.handleCommand("/approvals")).toBe(false);
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-decisions-row"));
    await settle(h);
    expect(sidebar.handleCommand("/decisions")).toBe(true);
    await settle(h);
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

test("parseDecisionsCommand: the report, the reason and the change (F-002, F-011)", () => {
  expect(parseDecisionsCommand("/decisions")).toEqual({ kind: "show" });
  expect(parseDecisionsCommand("/decisions reason B is quicker for us")).toEqual({ kind: "reason", text: "B is quicker for us" });
  expect(parseDecisionsCommand("/decisions change  Option A ")).toEqual({ kind: "change", choice: "Option A" });
});

test("/decisions reason and /decisions change work from the TUI path and tell the outcome (F-002, F-011)", async () => {
  await openDecision({ cwd: root, question: "Pick", options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }], recommendation: { optionId: "a", reason: "" }, random: () => 0.9, id: "d-9" });
  await answerDecision({ cwd: root, id: "d-9", choice: "b" });
  const said: string[] = [];
  const deps = { cwd: root, lastDecisionId: () => "d-9", notice: (text: string) => said.push(text) };

  await runDecisionsFollowup({ kind: "reason", text: "B fits the deadline" }, deps);
  expect(said.at(-1)).toContain("d-9");
  expect((await loadReport(root)).deviations[0]?.reason).toBe("B fits the deadline");

  await runDecisionsFollowup({ kind: "change", choice: "Option A" }, deps);
  expect((await loadReport(root)).changed).toBe(1);

  await runDecisionsFollowup({ kind: "change", choice: "nope" }, deps);
  expect(said.at(-1)).toContain("not one of the options");
});

test("/decisions change says the agent already got the first answer and names the decision (round 2)", async () => {
  await openDecision({ cwd: root, question: "Which cache?", options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }], recommendation: { optionId: "a", reason: "" }, random: () => 0.9, id: "d-7" });
  await answerDecision({ cwd: root, id: "d-7", choice: "b" });
  const said: string[] = [];
  await runDecisionsFollowup({ kind: "change", choice: "a" }, { cwd: root, lastDecisionId: () => "d-7", notice: (text) => said.push(text) });
  expect(said[0]).toContain("d-7");
  expect(said[0]).toContain("Which cache?");
  expect(said[0]).toContain("already received the first answer (b)");
  expect(said[0]).toContain("may not reach the agent");
});

test("/decisions reason|change with no session decision and no flow touches nothing and says so (round 2)", async () => {
  await openDecision({ cwd: root, question: "Someone else's", options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }], recommendation: { optionId: "a", reason: "" }, random: () => 0.9, id: "d-else" });
  await answerDecision({ cwd: root, id: "d-else", choice: "b" });
  const said: string[] = [];
  const deps = { cwd: root, lastDecisionId: () => undefined, notice: (text: string) => said.push(text) };
  await runDecisionsFollowup({ kind: "reason", text: "because" }, deps);
  await runDecisionsFollowup({ kind: "change", choice: "a" }, deps);
  expect(said).toHaveLength(2);
  for (const text of said) expect(text).toContain("no decision from this session or this flow");
  const report = await loadReport(root);
  expect(report.changed).toBe(0);
  expect(report.deviations[0]).not.toHaveProperty("reason");
});
