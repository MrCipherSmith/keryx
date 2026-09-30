// Flow 369 (R4d): the `/approvals` modal — pending and recently resolved remote
// approvals with summary, scope, consequence, expiry and state, and an allow/deny
// that needs a confirming key. Pure formatting first, then real renders driven by
// keypresses (the harness `turn-guard-inspector.test.ts` uses).

import { expect, test } from "bun:test";
import type { ApprovalView } from "../lib/serve-approvals-store";
import { APPROVALS_COMMAND, APPROVALS_FOOTER, formatApprovalsModal, isApprovalsCommand, openApprovals } from "./approvals-inspector";
import { formatModalFooter } from "./modal-host";
import { keypressSource, loadOpenTui, mountChrome, settle } from "./ops-sidebar.test-helpers";

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

const resolved = (id: string, state: "allowed" | "denied" | "expired"): ApprovalView =>
  view(id, { state, resolvedAt: "2026-09-29T11:58:00.000Z", reason: state === "expired" ? "expired before an answer" : "answered by local-cli" });

test("isApprovalsCommand: matches only the bare /approvals token", () => {
  expect(isApprovalsCommand("/approvals")).toBe(true);
  expect(isApprovalsCommand("  /approvals  ")).toBe(true);
  expect(isApprovalsCommand("/approvals allow x")).toBe(true);
  expect(isApprovalsCommand("/approval")).toBe(false);
  expect(isApprovalsCommand("/schedules")).toBe(false);
  expect(APPROVALS_COMMAND).toBe("/approvals");
});

test("formatApprovalsModal: nothing pending says so", () => {
  const model = formatApprovalsModal([], 0, NOW);
  expect(model.items).toEqual([]);
  expect(model.lines.join("\n")).toContain("No pending approvals.");
});

test("formatApprovalsModal: summary, scope, consequence, expires in and state for every entry; the selected one is marked", () => {
  const model = formatApprovalsModal([view("write_note"), view("edit_file", { createdAt: "2026-09-29T11:56:00.000Z" }), resolved("old_call", "denied")], 1, NOW);
  const text = model.lines.join("\n");
  expect(text).toContain("Pending approvals (2)");
  expect(text).toContain("Recently resolved (1)");
  expect(text).toContain('Run tool "write_note"');
  expect(text).toContain('Scope: This one call to "write_note" only.');
  expect(text).toContain("Consequence: Changes files in the project.");
  expect(text).toContain("expires in 4m 30s");
  expect(text).toContain("denied");
  expect(model.items.map((item) => item.approvalId)).toEqual(["write_note", "edit_file", "old_call"]);
  const marked = model.lines.filter((line) => line.startsWith(">"));
  expect(marked).toHaveLength(1);
  expect(marked[0]).toContain("edit_file");
  expect(model.itemStart[1]).toBe(model.lines.indexOf(marked[0] as string));
});

test("formatApprovalsModal: an approval past its expiry is shown as expired, not as pending", () => {
  const due = view("late", { expiresAt: "2026-09-29T11:59:00.000Z" });
  const text = formatApprovalsModal([due], 0, NOW).lines.join("\n");
  expect(text).toContain("No pending approvals.");
  expect(text).toContain("expired");
});

test("formatApprovalsModal: a notice is appended under the list", () => {
  expect(formatApprovalsModal([], 0, NOW, "Approval x allowed.").lines.join("\n")).toContain("Approval x allowed.");
});

otuiTest("lists pending and resolved entries with every column, and the footer names the keys", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const modal = openApprovals(otui.core, h.chrome, {
    load: () => [view("write_note"), resolved("old_call", "allowed")],
    answer: () => ({ ok: true, text: "" }),
    now: () => NOW,
    onKeypress: keypressSource(h.renderer),
    visibleRows: 30,
  });
  try {
    expect(modal).toBeDefined();
    const text = modal!.visibleLines().join("\n");
    expect(text).toContain("write_note");
    expect(text).toContain("Scope:");
    expect(text).toContain("Consequence:");
    expect(text).toContain("expires in 4m 30s");
    expect(text).toContain("allowed");
    expect(modal!.selected()?.approvalId).toBe("write_note");
    await settle(h);
    expect(h.captureCharFrame()).toContain(formatModalFooter(APPROVALS_FOOTER));
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("a then y allows that one call and the list reloads; nothing is answered before the confirming key", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let state: ApprovalView[] = [view("write_note"), view("edit_file", { createdAt: "2026-09-29T11:56:00.000Z" })];
  const answers: Array<[string, string]> = [];
  const modal = openApprovals(otui.core, h.chrome, {
    load: () => state,
    answer: (id, decision) => {
      answers.push([id, decision]);
      state = state.map((item) => (item.approvalId === id ? resolved(id, decision === "allow" ? "allowed" : "denied") : item));
      return { ok: true, text: `Approval ${id} allowed. The waiting call may run once.` };
    },
    now: () => NOW,
    onKeypress: keypressSource(h.renderer),
    visibleRows: 30,
  });
  try {
    await h.mockInput.pressKey("a");
    await settle(h);
    expect(answers).toEqual([]);
    expect(modal!.visibleLines().join("\n")).toContain("press y to confirm");
    await h.mockInput.pressKey("y");
    await settle(h);
    expect(answers).toEqual([["write_note", "allow"]]);
    const text = modal!.visibleLines().join("\n");
    expect(text).toContain("Pending approvals (1)");
    expect(text).toContain("Recently resolved (1)");
    expect(text).toContain("may run once");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("any key other than y cancels an armed answer", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const answers: string[] = [];
  const modal = openApprovals(otui.core, h.chrome, {
    load: () => [view("write_note")],
    answer: (id) => {
      answers.push(id);
      return { ok: true, text: "" };
    },
    now: () => NOW,
    onKeypress: keypressSource(h.renderer),
    visibleRows: 30,
  });
  try {
    await h.mockInput.pressKey("d");
    await settle(h);
    expect(modal!.visibleLines().join("\n")).toContain("press y to confirm");
    await h.mockInput.pressKey("n");
    await settle(h);
    expect(modal!.visibleLines().join("\n")).not.toContain("press y to confirm");
    await h.mockInput.pressKey("y");
    await settle(h);
    expect(answers).toEqual([]);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("d then y denies; a resolved entry cannot be answered", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let state: ApprovalView[] = [view("write_note"), resolved("old_call", "allowed")];
  const answers: Array<[string, string]> = [];
  const modal = openApprovals(otui.core, h.chrome, {
    load: () => state,
    answer: (id, decision) => {
      answers.push([id, decision]);
      state = state.map((item) => (item.approvalId === id ? resolved(id, "denied") : item));
      return { ok: true, text: `Approval ${id} denied. The waiting call will not run.` };
    },
    now: () => NOW,
    onKeypress: keypressSource(h.renderer),
    visibleRows: 30,
  });
  try {
    await h.mockInput.pressKey("d");
    await h.mockInput.pressKey("y");
    await settle(h);
    expect(answers).toEqual([["write_note", "deny"]]);
    // Only the resolved entries remain, and none of them can be armed.
    await h.mockInput.pressKey("a");
    await settle(h);
    expect(modal!.visibleLines().join("\n")).toContain("no longer pending");
    await h.mockInput.pressKey("y");
    await settle(h);
    expect(answers).toHaveLength(1);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("a refused answer (expired, unknown) shows the reason and reloads", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const modal = openApprovals(otui.core, h.chrome, {
    load: () => [view("write_note")],
    answer: (id) => ({ ok: false, text: `Approval ${id} is expired (window elapsed); it can no longer be answered.` }),
    now: () => NOW,
    onKeypress: keypressSource(h.renderer),
    visibleRows: 30,
  });
  try {
    await h.mockInput.pressKey("a");
    await h.mockInput.pressKey("y");
    await settle(h);
    expect(modal!.visibleLines().join("\n")).toContain("can no longer be answered");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("reload() re-reads the store: an approval that arrives while the modal is open appears", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let state: ApprovalView[] = [];
  const modal = openApprovals(otui.core, h.chrome, {
    load: () => state,
    answer: () => ({ ok: true, text: "" }),
    now: () => NOW,
    onKeypress: keypressSource(h.renderer),
    visibleRows: 30,
  });
  try {
    expect(modal!.visibleLines().join("\n")).toContain("No pending approvals.");
    state = [view("write_note")];
    modal!.reload();
    expect(modal!.visibleLines().join("\n")).toContain("write_note");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("input is ignored while the composer owns the keyboard", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const answers: string[] = [];
  const modal = openApprovals(otui.core, h.chrome, {
    load: () => [view("write_note")],
    answer: (id) => {
      answers.push(id);
      return { ok: true, text: "" };
    },
    now: () => NOW,
    onKeypress: keypressSource(h.renderer),
    inputBlocked: () => true,
    visibleRows: 30,
  });
  try {
    await h.mockInput.pressKey("a");
    await h.mockInput.pressKey("y");
    await settle(h);
    expect(answers).toEqual([]);
  } finally {
    modal?.close();
    h.destroy();
  }
});
