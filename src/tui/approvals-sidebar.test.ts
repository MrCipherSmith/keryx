// Flow 369 (R4d): the sidebar's Approvals row and the `/approvals` composition.
// The row is ONE line and exists only while something is pending: the Model /
// Context / Tools / Status / Ready labels must stay on screen at 80x24.

import { expect, test } from "bun:test";
import type { ApprovalView } from "../lib/serve-approvals-store";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import { mountApprovalsSidebar, projectApprovalsPanel, routeApprovalsCommand } from "./approvals-sidebar";
import { clickNode, findById, keypressSource, loadOpenTui, manualInterval, mountChrome, settle, textOf } from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const NOW = new Date("2026-09-29T12:00:00.000Z");

function view(id: string, overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    approvalId: id,
    turnId: "turn-1",
    sessionId: "session-1",
    summary: `Run tool "${id}" (risk: write)`,
    scope: `This one call to "${id}" only.`,
    consequence: "Changes files in the project.",
    createdAt: "2026-09-29T11:55:00.000Z",
    expiresAt: "2026-09-29T12:04:30.000Z",
    correlationId: "corr-1",
    callFingerprint: "a".repeat(64),
    floors: [],
    consumed: false,
    state: "pending",
    ...overrides,
  };
}

test("projectApprovalsPanel: hidden at zero, one row that fits the sidebar otherwise", () => {
  expect(projectApprovalsPanel(0, SIDEBAR_TEXT_WIDTH)).toEqual({ visible: false, text: "" });
  const one = projectApprovalsPanel(1, SIDEBAR_TEXT_WIDTH);
  expect(one.visible).toBe(true);
  expect(one.text).toContain("1 pending");
  const many = projectApprovalsPanel(12, SIDEBAR_TEXT_WIDTH);
  expect(many.text).toContain("12 pending");
  expect(many.text).toContain("/approvals");
  expect(many.text.length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
  expect(many.text).not.toContain("\n");
  expect(projectApprovalsPanel(5, 12).text.length).toBeLessThanOrEqual(12);
});

test("routeApprovalsCommand: idle and busy both reach the handler; other lines do not", () => {
  const taken: string[] = [];
  const fake = { handleCommand: (line: string) => (taken.push(line), true) };
  expect(routeApprovalsCommand("/approvals", false, fake)).toBe(true);
  expect(routeApprovalsCommand("/approvals", true, fake)).toBe(true);
  expect(routeApprovalsCommand("approvals", false, fake)).toBe(false);
  expect(routeApprovalsCommand("/schedules", false, fake)).toBe(false);
  expect(taken).toEqual(["/approvals", "/approvals"]);
});

function mount(h: Awaited<ReturnType<typeof mountChrome>>, state: { views: ApprovalView[]; notices: string[]; answers?: string[]; afterAnswer?: () => void }) {
  const timer = manualInterval();
  const sidebar = mountApprovalsSidebar({
    otui: OTUI!.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    width: SIDEBAR_TEXT_WIDTH,
    onKeypress: keypressSource(h.renderer),
    notice: (text) => state.notices.push(text),
    load: () => state.views,
    answer: (id) => {
      state.answers?.push(id);
      state.afterAnswer?.();
      return { ok: true, text: "" };
    },
    now: () => NOW,
    interval: timer.interval,
  });
  return { sidebar, timer };
}

otuiTest("zero pending: the section has no rows at all", async () => {
  const h = await mountChrome(OTUI!);
  const { sidebar } = mount(h, { views: [], notices: [] });
  try {
    await settle(h);
    expect(findById(h.chrome.sidebarTop, "sb-approvals-row")).toBeUndefined();
    expect(sidebar.projection().visible).toBe(false);
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("pending approvals show as exactly one row with the count", async () => {
  const h = await mountChrome(OTUI!);
  const { sidebar } = mount(h, { views: [view("a"), view("b")], notices: [] });
  try {
    await settle(h);
    const box = findById(h.chrome.sidebarTop, "sb-approvals");
    expect(box?.getChildren()).toHaveLength(1);
    expect(textOf(findById(h.chrome.sidebarTop, "sb-approvals-row"))).toContain("2 pending");
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("the poll shows a new approval, announces it once, and drops the row when it is answered", async () => {
  const h = await mountChrome(OTUI!);
  const state = { views: [] as ApprovalView[], notices: [] as string[] };
  const { sidebar, timer } = mount(h, state);
  try {
    await settle(h);
    state.views = [view("write_note")];
    await timer.fire();
    await settle(h);
    expect(textOf(findById(h.chrome.sidebarTop, "sb-approvals-row"))).toContain("1 pending");
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]).toContain("write_note");
    expect(state.notices[0]).toContain("/approvals");
    const paints = sidebar.paintCount();
    await timer.fire();
    expect(state.notices).toHaveLength(1);
    expect(sidebar.paintCount()).toBe(paints);
    state.views = [view("write_note", { state: "allowed", resolvedAt: "2026-09-29T11:59:00.000Z" })];
    await timer.fire();
    await settle(h);
    expect(findById(h.chrome.sidebarTop, "sb-approvals-row")).toBeUndefined();
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("approvals already pending when the shell opens are shown but not announced", async () => {
  const h = await mountChrome(OTUI!);
  const state = { views: [view("old")], notices: [] as string[] };
  const { sidebar, timer } = mount(h, state);
  try {
    await settle(h);
    await timer.fire();
    expect(state.notices).toEqual([]);
    expect(textOf(findById(h.chrome.sidebarTop, "sb-approvals-row"))).toContain("1 pending");
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("/approvals and a click on the row open the modal; another command is left alone", async () => {
  const h = await mountChrome(OTUI!);
  const { sidebar } = mount(h, { views: [view("write_note")], notices: [] });
  try {
    await settle(h);
    expect(sidebar.handleCommand("/schedules")).toBe(false);
    expect(sidebar.openModal()).toBeUndefined();
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-approvals-row"));
    await settle(h);
    expect(sidebar.openModal()?.visibleLines().join("\n")).toContain("write_note");
    sidebar.openModal()?.close();
    expect(sidebar.handleCommand("/approvals")).toBe(true);
    expect(sidebar.openModal()).toBeDefined();
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("an open modal follows the poll", async () => {
  const h = await mountChrome(OTUI!);
  const state = { views: [] as ApprovalView[], notices: [] as string[] };
  const { sidebar, timer } = mount(h, state);
  try {
    sidebar.show();
    expect(sidebar.openModal()?.visibleLines().join("\n")).toContain("No pending approvals.");
    state.views = [view("late_arrival")];
    await timer.fire();
    expect(sidebar.openModal()?.visibleLines().join("\n")).toContain("late_arrival");
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("answering in the modal refreshes the row at once", async () => {
  const h = await mountChrome(OTUI!);
  const state = {
    views: [view("write_note")],
    notices: [] as string[],
    answers: [] as string[],
    afterAnswer: () => {
      state.views = [view("write_note", { state: "allowed", resolvedAt: "2026-09-29T11:59:00.000Z" })];
    },
  };
  const { sidebar } = mount(h, state);
  try {
    sidebar.show();
    await h.mockInput.pressKey("a");
    await h.mockInput.pressKey("y");
    await settle(h);
    expect(state.answers).toEqual(["write_note"]);
    expect(findById(h.chrome.sidebarTop, "sb-approvals-row")).toBeUndefined();
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});
