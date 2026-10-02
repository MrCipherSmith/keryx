// Flow 396: the `/permissions` modal. Pure formatting, then real renders driven by keypresses.

import { expect, test } from "bun:test";
import type { PermissionsView } from "../commands/permissions-command";
import { formatModalFooter } from "./modal-host";
import { keypressSource, loadOpenTui, mountChrome, settle } from "./ops-sidebar.test-helpers";
import { formatPermissionsModal, isPermissionsCommand, openPermissions, PERMISSIONS_COMMAND, PERMISSIONS_FOOTER } from "./permissions-inspector";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const VIEW: PermissionsView = {
  path: "/home/u/.local/share/keryx/permissions.json",
  rows: [
    { n: 1, pattern: "ls -la", kind: "active" },
    { n: 2, pattern: "bun test src/a.test.ts", kind: "active" },
    { n: 3, pattern: "bash *", kind: "inactive", reason: "`bash *` grants arbitrary execution" },
    { n: 4, pattern: "git status", kind: "session" },
  ],
};

test("isPermissionsCommand matches the bare token and its arguments only", () => {
  expect(isPermissionsCommand("/permissions")).toBe(true);
  expect(isPermissionsCommand("/permissions remove 1")).toBe(true);
  expect(isPermissionsCommand("/permission")).toBe(false);
  expect(PERMISSIONS_COMMAND).toBe("/permissions");
});

test("formatPermissionsModal groups honoured, not honoured and session rules, marks the selected one", () => {
  const model = formatPermissionsModal(VIEW, 1);
  const text = model.lines.join("\n");
  expect(text).toContain("Saved shell rules (2)");
  expect(text).toContain("Not honoured");
  expect(text).toContain("arbitrary execution");
  expect(text).toContain("Granted for this session only");
  expect(text).toContain(VIEW.path);
  const marked = model.lines.filter((line) => line.startsWith(">"));
  expect(marked).toHaveLength(1);
  expect(marked[0]).toContain("bun test src/a.test.ts");
  expect(model.rowStart[1]).toBe(model.lines.indexOf(marked[0] as string));
});

test("formatPermissionsModal with no rules says every command asks", () => {
  expect(formatPermissionsModal({ path: "/x", rows: [] }, 0).lines.join("\n")).toContain("every command that is not read-only asks first");
});

otuiTest("lists the rules and the footer names the keys", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const modal = openPermissions(otui.core, h.chrome, {
    load: () => VIEW,
    remove: () => ({ ok: true, text: "" }),
    onKeypress: keypressSource(h.renderer),
    visibleRows: 30,
  });
  try {
    expect(modal).toBeDefined();
    const text = modal!.visibleLines().join("\n");
    expect(text).toContain("ls -la");
    expect(text).toContain("bash *");
    expect(modal!.selected()?.pattern).toBe("ls -la");
    await settle(h);
    expect(h.captureCharFrame()).toContain(formatModalFooter(PERMISSIONS_FOOTER));
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("d then y removes the selected rule; nothing is removed before the confirming key", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let state = VIEW;
  const removed: string[] = [];
  const modal = openPermissions(otui.core, h.chrome, {
    load: () => state,
    remove: (pattern) => {
      removed.push(pattern);
      state = { ...state, rows: state.rows.filter((row) => row.pattern !== pattern).map((row, index) => ({ ...row, n: index + 1 })) };
      return { ok: true, text: `Removed: ${pattern}. It asks again from now on.` };
    },
    onKeypress: keypressSource(h.renderer),
    visibleRows: 30,
  });
  try {
    await h.mockInput.pressKey("d");
    await settle(h);
    expect(removed).toEqual([]);
    expect(modal!.visibleLines().join("\n")).toContain("press y to confirm");
    await h.mockInput.pressKey("y");
    await settle(h);
    expect(removed).toEqual(["ls -la"]);
    const text = modal!.visibleLines().join("\n");
    expect(text).toContain("Removed: ls -la");
    expect(text).toContain("Saved shell rules (1)");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("any key other than y cancels an armed removal", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const removed: string[] = [];
  const modal = openPermissions(otui.core, h.chrome, {
    load: () => VIEW,
    remove: (pattern) => {
      removed.push(pattern);
      return { ok: true, text: "" };
    },
    onKeypress: keypressSource(h.renderer),
    visibleRows: 30,
  });
  try {
    await h.mockInput.pressKey("d");
    await h.mockInput.pressKey("n");
    await h.mockInput.pressKey("y");
    await settle(h);
    expect(removed).toEqual([]);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("input is ignored while the composer owns the keyboard", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const removed: string[] = [];
  const modal = openPermissions(otui.core, h.chrome, {
    load: () => VIEW,
    remove: (pattern) => {
      removed.push(pattern);
      return { ok: true, text: "" };
    },
    onKeypress: keypressSource(h.renderer),
    inputBlocked: () => true,
    visibleRows: 30,
  });
  try {
    await h.mockInput.pressKey("d");
    await h.mockInput.pressKey("y");
    await settle(h);
    expect(removed).toEqual([]);
  } finally {
    modal?.close();
    h.destroy();
  }
});
