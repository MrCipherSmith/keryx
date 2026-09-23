// Flow 300 — the shipped composition (`mountOpsSidebar`, what `tui-shell.ts`
// mounts after the Jobs section) on a real shell chrome:
//   AC7: work finished by ANOTHER process reaches both sections on the next
//        injected tick; an unchanged tick repaints nothing; runs started
//        elsewhere are silent, a run the TUI started ends in exactly one toast.
//   AC8: keyboard only — composer `/triggers` → ↓ → Enter → r → y to a
//        recorded run (a real `keryx trigger run` child), and `/governance` → r
//        to a new report. No mouse event anywhere in these tests.

import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { readLatestGovernanceReport, type GovernanceReportRead } from "../governance/service";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import { mountOpsSidebar, type OpsSidebar } from "./ops-sidebar";
import { loadTriggerLedgerView, type TriggerLedgerView } from "./trigger-ledger";
import { createTriggerRunNow } from "./trigger-run-now";
import {
  appendRuns,
  CLI,
  findById,
  keypressSource,
  loadOpenTui,
  makeProject,
  manualInterval,
  mountChrome,
  settle,
  textOf,
  writeReport,
  writeTriggers,
  type MountedChrome,
} from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function project(): Promise<string> {
  const root = await makeProject("keryx-opsbar-");
  roots.push(root);
  return root;
}

const NOW = new Date("2026-09-23T12:00:00.000Z");

function counting(): {
  loadTriggers: (cwd: string) => Promise<TriggerLedgerView>;
  readLatestGovernance: (cwd: string) => Promise<GovernanceReportRead>;
  counts: { triggers: number; governance: number };
} {
  const counts = { triggers: 0, governance: 0 };
  return {
    counts,
    loadTriggers: (cwd) => {
      counts.triggers += 1;
      return loadTriggerLedgerView(cwd);
    },
    readLatestGovernance: (cwd) => {
      counts.governance += 1;
      return readLatestGovernanceReport(cwd);
    },
  };
}

otuiTest("AC7: another process's record and report reach both sections on the next tick; an unchanged tick repaints nothing; no toast for work done elsewhere", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await project();
  await writeTriggers(cwd, [{ name: "sync", on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } }]);
  const timer = manualInterval();
  const seams = counting();
  const ops = mountOpsSidebar({
    otui: otui.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    cwd,
    width: SIDEBAR_TEXT_WIDTH,
    onKeypress: keypressSource(h.renderer),
    interval: timer.interval,
    now: () => NOW,
    loadTriggers: seams.loadTriggers,
    readLatestGovernance: seams.readLatestGovernance,
  });
  try {
    await ops.watcher.ready;
    await ops.governancePanel.refresh();
    await ops.triggersPanel.refresh();
    const gov = () => textOf(findById(h.chrome.sidebarTop, "sb-governance-v"));
    const row = () => textOf(findById(h.chrome.sidebarTop, "sb-triggers-sync"));
    expect(gov()).toBe("no report — click to run");
    expect(row()).toBe("sync · enabled · never fired");

    // An unchanged tick: nothing is re-read, nothing repainted.
    const before = { ...seams.counts };
    await timer.fire();
    await settle(h);
    expect(seams.counts).toEqual(before);

    // Another process (the CLI, a git hook): a ledger record and a new report.
    await appendRuns(cwd, [
      {
        at: "2026-09-23T11:00:00.000Z",
        trigger: "sync",
        firedBy: { kind: "event", event: "post-merge" },
        action: { kind: "rebuild" },
        outcome: "ok",
        detail: "done",
        cost: { recorded: false, reason: "no model" },
      },
    ]);
    execFileSync(process.execPath, [CLI, "governance", "report", "--json"], { cwd, stdio: "ignore" });
    await timer.fire();
    await ops.repainted();
    await settle(h);
    expect(row()).toBe("sync · enabled · ok 1h");
    expect(gov()).toMatch(/^last report \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(seams.counts.triggers).toBe(before.triggers + 1);
    expect(seams.counts.governance).toBe(before.governance + 1);
    // Work done elsewhere repaints silently.
    expect(h.toasts).toEqual([]);

    // And again unchanged: nothing.
    const after = { ...seams.counts };
    await timer.fire();
    expect(seams.counts).toEqual(after);
  } finally {
    ops.dispose();
    h.destroy();
  }
});

otuiTest("AC7: afterTurn() — what the shell calls when a turn settles — picks up a change with no timer at all", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await project();
  await writeTriggers(cwd, [{ name: "sync", on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } }]);
  const ops = mountOpsSidebar({
    otui: otui.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    cwd,
    width: SIDEBAR_TEXT_WIDTH,
    onKeypress: keypressSource(h.renderer),
    interval: () => () => {},
    now: () => NOW,
  });
  try {
    await ops.watcher.ready;
    await ops.triggersPanel.refresh();
    await appendRuns(cwd, [
      {
        at: "2026-09-23T11:59:00.000Z",
        trigger: "sync",
        firedBy: { kind: "event", event: "post-merge" },
        action: { kind: "rebuild" },
        outcome: "failed",
        detail: "x",
        cost: { recorded: false, reason: "no model" },
      },
    ]);
    await ops.afterTurn();
    await settle(h);
    expect(textOf(findById(h.chrome.sidebarTop, "sb-triggers-sync"))).toBe("sync · enabled · failed 1m");
  } finally {
    ops.dispose();
    h.destroy();
  }
});

async function typeCommand(h: MountedChrome, command: string): Promise<void> {
  h.chrome.input.focus();
  await h.mockInput.typeText(command);
  await settle(h);
  h.mockInput.pressEnter();
  await settle(h);
}

function wire(h: MountedChrome, ops: OpsSidebar): void {
  // The shell's own route for these two commands: `ops.handleCommand(line)`.
  h.chrome.onSubmit((line) => {
    ops.handleCommand(line);
  });
}

otuiTest(
  "AC8: keyboard only — composer `/triggers` → ↓ → Enter → r → y reaches a recorded run (a real `keryx trigger run` child); one toast",
  async () => {
    const otui = OTUI!;
    const h = await mountChrome(otui);
    const cwd = await project();
    execFileSync("git", ["init", "-q"], { cwd });
    await writeTriggers(cwd, [
      { name: "a-disabled", on: { kind: "event", event: "post-commit" }, action: { kind: "reconcile" }, enabled: false },
      { name: "open-weekly", on: { kind: "event", event: "ci" }, action: { kind: "open-flow", template: "Weekly" } },
    ]);
    // Over the project spend ceiling: the run records `budget-refused` and opens nothing.
    await appendRuns(cwd, [
      {
        at: "2026-09-20T00:00:00.000Z",
        trigger: "open-weekly",
        firedBy: { kind: "event", event: "ci" },
        action: { kind: "open-flow", template: "Weekly" },
        outcome: "ok",
        detail: "past",
        cost: { recorded: true, usd: 50 },
      },
    ]);
    const ops = mountOpsSidebar({
      otui: otui.core,
      chrome: h.chrome,
      parent: h.chrome.sidebarTop,
      cwd,
      width: SIDEBAR_TEXT_WIDTH,
      onKeypress: keypressSource(h.renderer),
      interval: () => () => {},
      runNow: createTriggerRunNow({ root: cwd, invocation: { execPath: process.execPath, scriptPath: CLI } }),
    });
    wire(h, ops);
    try {
      await typeCommand(h, "/triggers");
      const modal = ops.openModals().triggers;
      expect(modal).toBeDefined();
      await modal!.ready;
      expect(modal!.selectedName()).toBe("a-disabled");
      h.mockInput.pressArrow("down");
      await settle(h);
      expect(modal!.selectedName()).toBe("open-weekly");
      h.mockInput.pressEnter();
      await settle(h);
      expect(modal!.activeTab()).toBe("detail");
      h.mockInput.pressKey("r");
      h.mockInput.pressKey("y");
      await settle(h);
      expect(modal!.status()).toContain("running open-weekly…");
      await modal!.settled();
      expect(modal!.status()).toMatch(/^open-weekly: budget-refused — /);
      const ledger = (await readFile(path.join(cwd, ".metaproject", "data", "trigger", "runs.jsonl"), "utf8")).trim().split("\n");
      expect(ledger).toHaveLength(2);
      expect(JSON.parse(ledger[1]!)).toMatchObject({ trigger: "open-weekly", outcome: "budget-refused" });
      expect(h.toasts).toEqual(["trigger open-weekly: budget-refused"]);
    } finally {
      ops.dispose();
      h.destroy();
    }
  },
  60_000,
);

otuiTest("AC8: keyboard only — composer `/governance` → r reaches a new report", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await project();
  await writeReport(cwd, "2026-09-01T00:00:00.000Z");
  const ops = mountOpsSidebar({
    otui: otui.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    cwd,
    width: SIDEBAR_TEXT_WIDTH,
    onKeypress: keypressSource(h.renderer),
    interval: () => () => {},
    governance: { now: () => new Date("2026-09-23T07:07:00.000Z") },
  });
  wire(h, ops);
  try {
    await typeCommand(h, "/governance");
    for (let i = 0; i < 20 && ops.openModals().governance === undefined; i += 1) await settle(h, 1);
    const modal = ops.openModals().governance;
    expect(modal).toBeDefined();
    await modal!.ready;
    expect(modal!.header()).toContain("2026-09-01 00:00");
    h.mockInput.pressKey("r");
    await settle(h);
    while (ops.runner.state().kind === "running") await new Promise((r) => setImmediate(r));
    await modal!.reload();
    expect(modal!.header()).toContain("2026-09-23 07:07");
    const read = await readLatestGovernanceReport(cwd);
    expect(read.state === "present" ? read.report.generatedAt : "").toBe("2026-09-23T07:07:00.000Z");
    expect(h.toasts).toEqual(["Governance report ready"]);
  } finally {
    ops.dispose();
    h.destroy();
  }
});

otuiTest("AC2: `/governance` with no report starts the run in the background and says so (no modal to wait on)", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await project();
  const notices: string[] = [];
  const ops = mountOpsSidebar({
    otui: otui.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    cwd,
    width: SIDEBAR_TEXT_WIDTH,
    onKeypress: keypressSource(h.renderer),
    interval: () => () => {},
    notice: (text) => notices.push(text),
  });
  try {
    const modal = await ops.showGovernance();
    expect(modal).toBeUndefined();
    expect(notices[0]).toContain("running `keryx governance report` in the background");
    expect(h.chrome.overlayActive()).toBe(false); // the composer stays usable
    while (ops.runner.state().kind === "running") await new Promise((r) => setImmediate(r));
    expect(ops.runner.state().kind).toBe("done");
    expect(h.toasts).toEqual(["Governance report ready"]);
  } finally {
    ops.dispose();
    h.destroy();
  }
});

otuiTest("AC10: on 80x24 the new sections mount AFTER everything above them — no earlier sidebar row moves or leaves the screen", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { width: 80, height: 24 });
  const cwd = await project();
  await writeReport(cwd, "2026-09-23T05:40:00.000Z");
  await writeTriggers(cwd, [
    { name: "rebuild", on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } },
    { name: "sync", on: { kind: "event", event: "post-commit" }, action: { kind: "reconcile" } },
    { name: "open", on: { kind: "event", event: "ci" }, action: { kind: "open-flow", template: "Weekly" } },
  ]);
  // Stand-ins for the rows the shell mounts before Jobs, in its order and spacing.
  const labels = ["Model", "Context", "Tools", "Status"];
  for (const label of labels) {
    h.chrome.sidebarTop.add(new otui.core.TextRenderable(h.renderer, { id: `sb-${label}`, content: label, marginTop: 1 }));
  }
  await h.flush();
  const yOf = (id: string): number => (findById(h.chrome.sidebarTop, id) as unknown as { y: number }).y;
  const before = labels.map((l) => yOf(`sb-${l}`));
  const ops = mountOpsSidebar({
    otui: otui.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    cwd,
    width: SIDEBAR_TEXT_WIDTH,
    onKeypress: keypressSource(h.renderer),
    interval: () => () => {},
  });
  try {
    await ops.governancePanel.refresh();
    await ops.triggersPanel.refresh();
    await settle(h);
    const after = labels.map((l) => yOf(`sb-${l}`));
    expect(after).toEqual(before);
    for (const y of after) expect(y).toBeLessThan(24);
    const frame = h.captureCharFrame();
    for (const label of labels) expect(frame).toContain(label);
    expect(yOf("sb-governance")).toBeGreaterThan(Math.max(...after));
    expect(yOf("sb-triggers")).toBeGreaterThan(yOf("sb-governance"));
  } finally {
    ops.dispose();
    h.destroy();
  }
});
