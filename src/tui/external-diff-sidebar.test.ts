// Flow 370 (AC6): the sidebar's External diffs row and the `/external-diff` composition.
// The row is ONE line and exists only while a write run awaits review: the Model / Context /
// Tools / Status / Ready labels must stay on screen at 80x24.

import { expect, test } from "bun:test";
import type { ExternalWriteRunRecord } from "../harness/external/write-run";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import { mountExternalDiffSidebar, projectExternalDiffPanel, routeExternalDiffCommand } from "./external-diff-sidebar";
import type { ExternalDiffDeps } from "./external-diff-modal";
import { clickNode, findById, keypressSource, loadOpenTui, manualInterval, mountChrome, settle, textOf } from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const HASH = "fedcba9876543210".repeat(4);

function record(runId: string): ExternalWriteRunRecord {
  return {
    runId,
    agentId: "claude",
    baseCommit: "b".repeat(40),
    patchHash: HASH,
    files: [{ path: "src/a.ts", status: "modified" }],
    flaggedPaths: [],
    refusedPaths: [],
    state: "pending-review",
    redacted: false,
    runStatus: "Completed",
    projectRoot: "/repo",
    createdAt: "2026-09-30T10:00:00.000Z",
  };
}

interface State {
  runs: ExternalWriteRunRecord[];
  throws: boolean;
  discards: string[];
}

function depsOf(state: State): ExternalDiffDeps {
  return {
    list: () => {
      if (state.throws) throw new Error("not implemented");
      return state.runs;
    },
    view: (runId) => {
      const found = state.runs.find((run) => run.runId === runId);
      return found === undefined ? undefined : { record: found, patch: "+a line\n" };
    },
    land: async () => ({ kind: "refused", reason: "apply-failed", detail: "unused" }),
    discard: (runId) => {
      state.discards.push(runId);
      state.runs = state.runs.filter((run) => run.runId !== runId);
      return { kind: "discarded" };
    },
  };
}

function mount(h: Awaited<ReturnType<typeof mountChrome>>, state: State) {
  const timer = manualInterval();
  const sidebar = mountExternalDiffSidebar({
    otui: OTUI!.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    width: SIDEBAR_TEXT_WIDTH,
    cwd: "/repo",
    onKeypress: keypressSource(h.renderer),
    deps: depsOf(state),
    interval: timer.interval,
  });
  return { sidebar, timer };
}

test("projectExternalDiffPanel: hidden at zero, one line that fits the sidebar otherwise", () => {
  expect(projectExternalDiffPanel(0, SIDEBAR_TEXT_WIDTH)).toEqual({ visible: false, text: "" });
  for (const count of [1, 3, 12, 250]) {
    const panel = projectExternalDiffPanel(count, SIDEBAR_TEXT_WIDTH);
    expect(panel.visible).toBe(true);
    expect(panel.text).toContain(`${count} pending`);
    expect(panel.text.length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
    expect(panel.text).not.toContain("\n");
  }
  expect(projectExternalDiffPanel(2, 60).text).toContain("/external-diff");
  expect(projectExternalDiffPanel(5, 8).text.length).toBeLessThanOrEqual(8);
});

test("routeExternalDiffCommand: reaches the handler for /external-diff only", () => {
  const taken: string[] = [];
  const fake = { handleCommand: (line: string) => (taken.push(line), true) };
  expect(routeExternalDiffCommand("/external-diff", fake)).toBe(true);
  expect(routeExternalDiffCommand("external-diff", fake)).toBe(false);
  expect(routeExternalDiffCommand("/external", fake)).toBe(false);
  expect(routeExternalDiffCommand("/approvals", fake)).toBe(false);
  expect(taken).toEqual(["/external-diff"]);
});

otuiTest("nothing pending: the section has no rows at all", async () => {
  const h = await mountChrome(OTUI!);
  const { sidebar } = mount(h, { runs: [], throws: false, discards: [] });
  try {
    await settle(h);
    expect(findById(h.chrome.sidebarTop, "sb-external-diff-row")).toBeUndefined();
    expect(findById(h.chrome.sidebarTop, "sb-external-diff")?.getChildren()).toHaveLength(0);
    expect(sidebar.projection().visible).toBe(false);
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("pending runs show as exactly one row with the count", async () => {
  const h = await mountChrome(OTUI!);
  const { sidebar } = mount(h, { runs: [record("run-1"), record("run-2"), record("run-3")], throws: false, discards: [] });
  try {
    await settle(h);
    expect(findById(h.chrome.sidebarTop, "sb-external-diff")?.getChildren()).toHaveLength(1);
    const row = textOf(findById(h.chrome.sidebarTop, "sb-external-diff-row"));
    expect(row).toContain("External diffs: 3 pending");
    expect(row).not.toContain("\n");
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("a throwing list hides the row instead of breaking the sidebar", async () => {
  const h = await mountChrome(OTUI!);
  const state: State = { runs: [record("run-1")], throws: false, discards: [] };
  const { sidebar, timer } = mount(h, state);
  try {
    await settle(h);
    expect(findById(h.chrome.sidebarTop, "sb-external-diff-row")).toBeDefined();
    state.throws = true;
    await timer.fire();
    await settle(h);
    expect(findById(h.chrome.sidebarTop, "sb-external-diff-row")).toBeUndefined();
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("the poll shows a new run, keeps the paint count steady, and drops the row when none is left", async () => {
  const h = await mountChrome(OTUI!);
  const state: State = { runs: [], throws: false, discards: [] };
  const { sidebar, timer } = mount(h, state);
  try {
    await settle(h);
    state.runs = [record("run-1")];
    await timer.fire();
    await settle(h);
    expect(textOf(findById(h.chrome.sidebarTop, "sb-external-diff-row"))).toContain("1 pending");
    const paints = sidebar.paintCount();
    await timer.fire();
    expect(sidebar.paintCount()).toBe(paints);
    state.runs = [];
    await timer.fire();
    await settle(h);
    expect(findById(h.chrome.sidebarTop, "sb-external-diff-row")).toBeUndefined();
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("/external-diff and a click on the row open the modal; another command is left alone", async () => {
  const h = await mountChrome(OTUI!);
  const { sidebar } = mount(h, { runs: [record("run-1")], throws: false, discards: [] });
  try {
    await settle(h);
    expect(sidebar.handleCommand("/approvals")).toBe(false);
    expect(sidebar.openModal()).toBeUndefined();
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-external-diff-row"));
    await settle(h);
    expect(sidebar.openModal()?.visibleLines().join("\n")).toContain("run-1");
    sidebar.openModal()?.close();
    expect(sidebar.handleCommand("/external-diff")).toBe(true);
    expect(sidebar.openModal()).toBeDefined();
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("the modal opens even with nothing pending and says so", async () => {
  const h = await mountChrome(OTUI!);
  const { sidebar } = mount(h, { runs: [], throws: false, discards: [] });
  try {
    expect(sidebar.handleCommand("/external-diff")).toBe(true);
    expect(sidebar.openModal()?.visibleLines().join("\n")).toContain("No write runs are waiting for review.");
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("an open modal follows the poll", async () => {
  const h = await mountChrome(OTUI!);
  const state: State = { runs: [], throws: false, discards: [] };
  const { sidebar, timer } = mount(h, state);
  try {
    sidebar.show();
    state.runs = [record("late-arrival")];
    await timer.fire();
    expect(sidebar.openModal()?.visibleLines().join("\n")).toContain("late-arriv");
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("discarding in the modal refreshes the row at once", async () => {
  const h = await mountChrome(OTUI!);
  const state: State = { runs: [record("run-1")], throws: false, discards: [] };
  const { sidebar } = mount(h, state);
  try {
    await settle(h);
    sidebar.show();
    await h.mockInput.pressKey("d");
    await h.mockInput.pressKey("y");
    await settle(h);
    expect(state.discards).toEqual(["run-1"]);
    expect(findById(h.chrome.sidebarTop, "sb-external-diff-row")).toBeUndefined();
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});
