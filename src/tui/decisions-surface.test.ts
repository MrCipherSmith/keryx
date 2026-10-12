// Flow 392 (AC8): the TUI half of the recommendation journal. The sidebar row exists
// only once the journal holds a decision, `/decisions` routes while idle and while
// busy, and the modal shows exactly what `keryx decisions report` prints.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { answerDecision, journalAsk, loadReport, openDecision, reportText } from "../decisions/service";
import { findAgentCommand } from "../commands/agent-commands";
import { classifyBusyDispatch } from "./busy-dispatch";
import {
  armsSummaryText,
  armsText,
  formatDecisionsLines,
  isDecisionsCommand,
  mountDecisionsSidebar,
  parseDecisionsCommand,
  presentDecisions,
  projectArmsPanel,
  projectDecisionsPanel,
  routeDecisionsCommand,
  runDecisionsFollowup,
  summarizeArms,
} from "./decisions-surface";
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

test("projectDecisionsPanel: backfilled decisions are shown apart from the live count", () => {
  expect(projectDecisionsPanel(0, SIDEBAR_TEXT_WIDTH, 0)).toEqual({ visible: false, text: "" });
  const both = projectDecisionsPanel(10, SIDEBAR_TEXT_WIDTH, 60);
  expect(both.visible).toBe(true);
  expect(both.text).toContain("10 decisions + 60 before");
  const onlyBefore = projectDecisionsPanel(0, SIDEBAR_TEXT_WIDTH, 60);
  expect(onlyBefore.visible).toBe(true);
  expect(onlyBefore.text).toContain("60 before");
  expect(onlyBefore.text).not.toContain("0 decisions");
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

// flow 401, AC11: the modal marks and prints in full an own answer and a picked option with a reason
const OWN_TEXT = `neither of them: split it in two, ship the schema first. ${"Long tail. ".repeat(40)}`.trim();
const PICKED_REASON = "the deadline is Friday and B is the quick one";

async function seedOwnAndReason(): Promise<void> {
  const ask = journalAsk(
    async (request) =>
      request.question.includes("Why?")
        ? { kind: "own", text: "no reason worth a line" }
        : request.question.startsWith("Which approach")
          ? { kind: "own", text: OWN_TEXT }
          : { kind: "option", choice: "b", reason: PICKED_REASON },
    { cwd: root, random: () => 0.9 },
  );
  const options = [
    { id: "a", label: "Option A", description: "the safe one", recommended: true },
    { id: "b", label: "Option B", description: "the quick one" },
  ];
  await ask({ question: "Which approach?", options });
  await ask({ question: "Which release train?", options });
}

test("the modal shows an own answer and a picked option with its reason, both in full (AC11)", async () => {
  await seedOwnAndReason();
  const text = await reportText(root);
  let painted: { content: string } | undefined;
  const open: OpenModalFn = (_otui, _chrome, input) => {
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
  expect(presentDecisions(open, { TextRenderable: FakeText }, {}, { text, visibleRows: 200 })).toBeDefined();
  const content = painted?.content ?? "";
  expect(content).toContain("Own answers and reasons: 2");
  expect(content).toContain("own answer: neither of them: split it in two");
  expect(content).toContain(OWN_TEXT.slice(-60));
  expect(content).toContain("    chose b\n    reason: " + PICKED_REASON);
  expect(content).toContain(`reason: ${PICKED_REASON}`);
});

test("projectDecisionsPanel marks decisions with own text or a reason, and stays within the sidebar (AC11)", () => {
  const marked = projectDecisionsPanel(5, SIDEBAR_TEXT_WIDTH, 0, 2);
  expect(marked.text).toContain("5 decisions");
  expect(marked.text).toContain("✍2");
  expect(marked.text.length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
  expect(projectDecisionsPanel(5, SIDEBAR_TEXT_WIDTH, 0, 0).text).not.toContain("✍");
  expect(projectDecisionsPanel(5, 6, 0, 2).text.length).toBeLessThanOrEqual(11);
});

otuiTest("the sidebar row carries the mark when the journal holds an own answer and a reason (AC11)", async () => {
  await seedOwnAndReason();
  const h = await mountChrome(OTUI!);
  const timer = manualInterval();
  const sidebar = mountDecisionsSidebar({
    otui: OTUI!.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    width: SIDEBAR_TEXT_WIDTH,
    cwd: root,
    onKeypress: keypressSource(h.renderer),
    interval: timer.interval,
  });
  try {
    await sidebar.refresh();
    await settle(h);
    expect(textOf(findById(h.chrome.sidebarTop, "sb-decisions-row"))).toContain("✍2");
  } finally {
    sidebar.dispose();
    h.destroy();
  }
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
  for (const text of said) expect(text).toContain("no decision from this session to act on");
  const report = await loadReport(root);
  expect(report.changed).toBe(0);
  expect(report.deviations[0]).not.toHaveProperty("reason");
});

// --- flow 400 (AC16): the arm summary, as a command and as a side-panel section ---

const cell = (decisions: number, answered: number, matched: number, medianMs: number | null = null) => ({ decisions, answered: decisions, tally: { answered, matched }, medianMs });
const ARM_REPORT = {
  byArm: { A: cell(10, 8, 6, 4200), B: cell(5, 4, 2, 65_000), C: cell(5, 5, 2), D: cell(5, 0, 0) },
  armA: { free: cell(7, 6, 5), forced: cell(3, 2, 1) },
};

test("parseDecisionsCommand: /decisions arms is its own command", () => {
  expect(parseDecisionsCommand("/decisions arms")).toEqual({ kind: "arms" });
  expect(parseDecisionsCommand("/decisions  arms ")).toEqual({ kind: "arms" });
  expect(parseDecisionsCommand("/decisions armsx")).toEqual({ kind: "show" });
});

test("summarizeArms reads the report's cells as they are and computes only the share", () => {
  const summary = summarizeArms(ARM_REPORT);
  expect(summary.basis).toBe("arms");
  expect(summary.rows.map((row) => [row.key, row.decisions, row.matched, row.answered, row.share])).toEqual([
    ["A", 10, 6, 8, 0.75],
    ["B", 5, 2, 4, 0.5],
    ["C", 5, 2, 5, 0.4],
    ["D", 5, 0, 0, null],
  ]);
  expect(summary.armA.map((row) => [row.key, row.decisions, row.share])).toEqual([
    ["A-free", 7, 5 / 6],
    ["A-forced", 3, 0.5],
  ]);
});

test("armsSummaryText: the table, the A split, and `-` where no answered decision had a recommendation", () => {
  const text = armsSummaryText(summarizeArms(ARM_REPORT));
  expect(text).toContain("Recommendation arms");
  expect(text).toMatch(/A {2}mark shown, preselected\s+10 {2}\s*6\/8 {2}\s*75% {2}4\.2s/);
  expect(text).toMatch(/D {2}mark hidden, shuffled\s+5\s+0\/0\s+- {2}-/);
  expect(text).toContain("1m");
  expect(text).toContain("Arm A, split:");
  expect(text).toContain("A forced (irreversible)");
});

test("the arms modal is labelled with the one channel its table covers and shows the other channels apart", () => {
  const withChannels = {
    ...ARM_REPORT,
    headlineChannel: "tui",
    byChannel: [
      { channel: "telegram", rows: [{ key: "A+B", label: "A+B (mark, no preselection)", row: cell(4, 4, 3, 60_000) }] },
      { channel: "tui", rows: [{ key: "A-free", label: "A (free)", row: cell(7, 6, 5) }] },
    ],
  };
  const summary = summarizeArms(withChannels);
  expect(summary.channel).toBe("tui");
  expect(summary.channels.map((entry) => entry.channel)).toEqual(["telegram"]);
  const text = armsSummaryText(summary);
  expect(text).toContain("Recommendation arms (randomized decisions, tui channel only)");
  expect(text).toContain("Channel telegram:");
  expect(text).toMatch(/A\+B \(mark, no preselection\)\s+4\s+3\/4\s+75%\s+1m/);
  expect(text).not.toContain("Channel tui:");
});

test("without the new fields the summary falls back to the older modes and says so, never throws", () => {
  const modes = { byMode: { ordinary: { answered: 4, matched: 3 }, partial: { answered: 0, matched: 0 }, blind: { answered: 2, matched: 1 } } };
  const summary = summarizeArms(modes);
  expect(summary.basis).toBe("modes");
  expect(summary.armA).toEqual([]);
  const text = armsSummaryText(summary);
  expect(text).toContain("no per-arm data");
  expect(text).toMatch(/ordinary .*3\/4 +75%/);
  expect(text).not.toContain("Arm A, split:");
  for (const junk of [undefined, null, {}, 7, { byArm: null }, { byArm: { A: "x" } }]) {
    expect(() => armsSummaryText(summarizeArms(junk))).not.toThrow();
  }
  // byArm present, armA split absent: the four arms show and the split block is simply left out
  const noSplit = armsSummaryText(summarizeArms({ byArm: ARM_REPORT.byArm }));
  expect(noSplit).toContain("Recommendation arms");
  expect(noSplit).not.toContain("Arm A, split:");
});

test("flow 400 (AC17-AC21): the arm summary carries reasons, the ineligible line and the progress, and degrades without them", () => {
  const full = {
    ...ARM_REPORT,
    reasons: { agreement: { decisions: 4, named: 1 }, deviation: { decisions: 3, named: 2 }, deviationNotAsked: 2, requested: { answered: 5, medianMs: 12_000 }, notRequested: { answered: 9, medianMs: 4200 } },
    ineligible: { decisions: 3, answered: 2 },
    progress: { ac11: { decisions: 17, decisionsTarget: 20, blind: 4, blindTarget: 5, met: false }, perArm: { threshold: 150, counts: { A: 40, B: 20, C: 21, D: 19 }, met: false } },
  };
  const summary = summarizeArms(full);
  expect(summary.extras.reasons).toEqual({ agreement: { decisions: 4, named: 1 }, deviation: { decisions: 3, named: 2 }, deviationNotAsked: 2, requestedMs: 12_000, notRequestedMs: 4200 });
  const text = armsSummaryText(summary);
  expect(text).toContain("Reasons named: agreement 25% (1/4) (asked on the one-third subsample), deviation 67% (2/3) (asked where the surface can prompt)");
  expect(text).toContain("Deviations never asked (a surface that cannot prompt): 2, not in the share");
  expect(text).toContain("Median time to answer, eligible questions where the surface can prompt: reason requested 12s, not requested 4.2s");
  expect(text).toContain("Not in the comparison (ineligible): 3, 2 answered");
  expect(text).toContain("Progress, flow 392 AC11: 17/20 decisions, 4/5 blind");
  expect(text).toContain("Progress per arm (threshold 150): A 40, B 20, C 21, D 19");
  // an older report has none of it: the modal is the old table, and junk fields never throw
  const old = armsSummaryText(summarizeArms(ARM_REPORT));
  expect(old).not.toContain("Reasons named");
  expect(old).not.toContain("Progress");
  for (const junk of [{ reasons: 5, ineligible: "x", progress: [] }, { reasons: {}, progress: { ac11: {}, perArm: {} } }]) {
    expect(() => armsSummaryText(summarizeArms({ ...ARM_REPORT, ...junk }))).not.toThrow();
  }
});

test("projectArmsPanel: hidden without data or on the old modes, one row that fits the sidebar otherwise", () => {
  expect(projectArmsPanel(summarizeArms({}), SIDEBAR_TEXT_WIDTH)).toEqual({ visible: false, text: "" });
  expect(projectArmsPanel(summarizeArms({ byMode: { ordinary: { answered: 3, matched: 3 } } }), SIDEBAR_TEXT_WIDTH).visible).toBe(false);
  const empty = { byArm: { A: cell(2, 0, 0), B: cell(0, 0, 0), C: cell(0, 0, 0), D: cell(0, 0, 0) } };
  expect(projectArmsPanel(summarizeArms(empty), SIDEBAR_TEXT_WIDTH).visible).toBe(false);
  const row = projectArmsPanel(summarizeArms(ARM_REPORT), SIDEBAR_TEXT_WIDTH);
  expect(row.visible).toBe(true);
  expect(row.text).toContain("A 75%");
  expect(row.text).toContain("D -");
  expect(row.text.length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
  expect(projectArmsPanel(summarizeArms(ARM_REPORT), 12).text.length).toBeLessThanOrEqual(12);
});

test("armsText reads the real journal through loadReport: empty, then one answered arm decision", async () => {
  expect(await armsText(root)).toContain("Recommendation");
  await seed();
  const text = await armsText(root);
  // a journal written by this build carries the arm; the cell for it counts the decision
  const report = (await loadReport(root)) as { byArm?: unknown };
  if (report.byArm !== undefined) expect(text).toContain("Recommendation arms");
  else expect(text).toContain("no per-arm data");
});

test("the arms modal paints the arm summary under its own tab", async () => {
  let tabs: Array<{ label: string }> | undefined;
  let painted: string | undefined;
  const open: OpenModalFn = (_otui, _chrome, input) => {
    tabs = [...input.tabs];
    input.renderTab?.("report", { add: () => undefined } as never, undefined as never);
    return { close: () => undefined } as never;
  };
  class FakeText {
    content: string;
    constructor(_r: unknown, opts: { id: string; content: string }) {
      this.content = opts.content;
      painted = opts.content;
    }
  }
  const text = armsSummaryText(summarizeArms(ARM_REPORT));
  expect(presentDecisions(open, { TextRenderable: FakeText }, {}, { text, tabLabel: "Arms", visibleRows: 40 })).toBeDefined();
  expect(tabs?.[0]?.label).toBe("Arms");
  expect(painted).toContain("Arm A, split:");
});

function mountArms(h: Awaited<ReturnType<typeof mountChrome>>, state: { n: number; report: unknown }) {
  const timer = manualInterval();
  const sidebar = mountDecisionsSidebar({
    otui: OTUI!.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    width: SIDEBAR_TEXT_WIDTH,
    cwd: root,
    onKeypress: keypressSource(h.renderer),
    count: async () => state.n,
    armsReport: async () => {
      if (state.report instanceof Error) throw state.report;
      return state.report;
    },
    interval: timer.interval,
  });
  return { sidebar, timer };
}

otuiTest("the arms row is absent with no decisions and appears with the shares once an arm has answered ones", async () => {
  const h = await mountChrome(OTUI!);
  const state: { n: number; report: unknown } = { n: 0, report: ARM_REPORT };
  const { sidebar, timer } = mountArms(h, state);
  try {
    await settle(h);
    expect(findById(h.chrome.sidebarTop, "sb-decisions-arms-row")).toBeUndefined();
    expect(sidebar.armsProjection().visible).toBe(false);
    state.n = 3;
    await timer.fire();
    await settle(h);
    expect(textOf(findById(h.chrome.sidebarTop, "sb-decisions-arms-row"))).toContain("A 75%");
    const paints = sidebar.paintCount();
    await timer.fire();
    expect(sidebar.paintCount()).toBe(paints);
    // old report shape: the row goes away rather than showing nothing useful
    state.report = { byMode: { ordinary: { answered: 1, matched: 1 } } };
    await timer.fire();
    await settle(h);
    expect(findById(h.chrome.sidebarTop, "sb-decisions-arms-row")).toBeUndefined();
    // an unreadable report hides it too
    state.report = ARM_REPORT;
    await timer.fire();
    await settle(h);
    expect(findById(h.chrome.sidebarTop, "sb-decisions-arms-row")).toBeDefined();
    state.report = new Error("boom");
    await timer.fire();
    await settle(h);
    expect(findById(h.chrome.sidebarTop, "sb-decisions-arms-row")).toBeUndefined();
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("/decisions arms and a click on the arms row open the arm modal; /decisions still opens the report", async () => {
  const h = await mountChrome(OTUI!);
  const state: { n: number; report: unknown } = { n: 2, report: ARM_REPORT };
  const { sidebar } = mountArms(h, state);
  try {
    // Renderer settling does not await the journal reads in the initial refresh.
    // Wait for the sidebar state before querying and clicking its arms row.
    await sidebar.refresh();
    await settle(h);
    expect(sidebar.armsProjection().visible).toBe(true);
    expect(sidebar.handleCommand("/decisions arms")).toBe(true);
    await settle(h);
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-decisions-arms-row"));
    await settle(h);
    expect(sidebar.handleCommand("/decisions")).toBe(true);
    await settle(h);
    const shown = await sidebar.showArms();
    expect(shown).toBeDefined();
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

test("/decisions arms routes through the shell's agent-command registry", () => {
  const taken: string[] = [];
  expect(routeDecisionsCommand("/decisions arms", { handleCommand: (line) => (taken.push(line), true) })).toBe(true);
  expect(taken).toEqual(["/decisions arms"]);
  expect(findAgentCommand("/decisions", "agent")?.description).toContain("/decisions arms");
});
