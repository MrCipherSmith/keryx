// Flow 295 T9 — the Schedules section and modals, on a real shell chrome:
//   AC10: the section over a fixture ledger + schedule store — compact rows, hidden when
//         nothing is scheduled, fits the sidebar, theme-role colours, a click opens detail.
//   AC11: the 4-tab detail modal and its actions (pause/resume one step; run-now and
//         delete arm + y; any other key cancels; the CLI's own service functions).
//   AC12: keyboard only — composer `/schedules` → ↓ → Enter → p reaches a paused schedule.
//   AC13: a run finished by ANOTHER process repaints the row and the Runs tab on the next
//         injected tick, and announces its report exactly once.
//   AC14: a budget-refused run shows in the row and in the Runs tab.
// No test waits on the wall clock: ticks are fired by hand, renders are flushed.

import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { scheduleStorePath } from "../trigger/config";
import type { CommandResult, ScheduleHost } from "../trigger/install";
import type { TriggerRunRecord } from "../trigger/record";
import { mountOpsSidebar } from "./ops-sidebar";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import { defaultScheduleActions, DETAIL_KEYS, DETAIL_TABS, LIST_KEYS, SCHEDULES_COMMAND } from "./schedules-inspector";
import { projectSchedulesPanel } from "./schedules-panel";
import { isSchedulesCommand, mountSchedulesSidebar, type SchedulesSidebar } from "./schedules-sidebar";
import { applyThemeId, getThemeId, roleColor } from "./theme";
import { loadTriggerLedgerView } from "./trigger-ledger";
import type { TriggerRunNow, TriggerRunNowResult } from "./trigger-run-now";
import {
  appendRuns,
  chunkColors,
  clickNode,
  findById,
  keypressSource,
  loadOpenTui,
  makeProject,
  manualInterval,
  mountChrome,
  settle,
  textOf,
  type MountedChrome,
} from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const NOW = new Date("2026-09-23T12:00:00.000Z");
const RATES = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };

function schedule(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    on: { kind: "schedule", cron: "0 */4 * * *" },
    action: {
      kind: "agent-task",
      prompt: `Check open PRs for ${name}.`,
      dispatch: { provider: "anthropic", model: "claude-x", permissionMode: "ask", rates: RATES, ceilingUsd: 0.5 },
      grants: { network: "off", tools: ["gh.pr.list"], repos: ["o/r"], bins: { gh: "/usr/bin/gh" }, account: "gh: me" },
    },
    confirmedHash: "0".repeat(64),
    ...extra,
  };
}

async function fixture(): Promise<string> {
  const root = await makeProject("keryx-schedules-");
  roots.push(root);
  await mkdir(path.dirname(scheduleStorePath(root)), { recursive: true });
  await writeFile(
    scheduleStorePath(root),
    JSON.stringify({ schemaVersion: 1, triggers: [schedule("check-github"), schedule("nightly-pr-sweep", { enabled: false })] }),
    "utf8",
  );
  const reportDir = path.join(root, ".metaproject", "data", "trigger", "reports", "check-github");
  await mkdir(reportDir, { recursive: true });
  const findings = Array.from({ length: 40 }, (_, i) => `- finding ${i + 1}`).join("\n");
  await writeFile(path.join(reportDir, "sch-1.md"), `# check-github — scheduled report\n\n## Report\n\nTwo PRs need review: #12, #15.\n${findings}\n`, "utf8");
  await appendRuns(root, [
    record("check-github", "2026-09-23T09:00:00.000Z", "ok", { recorded: true, usd: 0.0042 }, { runId: "sch-1", reportPath: ".metaproject/data/trigger/reports/check-github/sch-1.md" }),
    record("nightly-pr-sweep", "2026-09-22T12:00:00.000Z", "budget-refused", { recorded: false, reason: "over the ceiling" }),
  ]);
  return root;
}

function record(
  trigger: string,
  at: string,
  outcome: TriggerRunRecord["outcome"],
  cost: TriggerRunRecord["cost"],
  agentTask?: TriggerRunRecord["agentTask"],
): Omit<TriggerRunRecord, "v"> {
  return {
    at,
    trigger,
    firedBy: { kind: "schedule", cron: "0 */4 * * *" },
    action: { kind: "reconcile" },
    outcome,
    detail: outcome === "ok" ? "report written" : "refused on the spend ceiling",
    cost,
    ...(agentTask !== undefined ? { agentTask } : {}),
  };
}

/** A run-now that records what it was asked, and never spawns. */
function fakeRunNow(): TriggerRunNow & { calls: Array<{ name: string; schedule: boolean }> } {
  const calls: Array<{ name: string; schedule: boolean }> = [];
  return {
    calls,
    run(name, options = {}) {
      calls.push({ name, schedule: options.schedule === true });
      const result: TriggerRunNowResult = { name, argv: [], exitCode: 0, output: "", logPath: "/dev/null", startedAt: NOW.toISOString(), endedAt: NOW.toISOString() };
      return Promise.resolve(result);
    },
    running: () => new Set<string>(),
    inFlightRuns: () => [],
    dispose: () => [],
  };
}

/** The real schedule service, with a fake crontab host (nothing is installed on this machine). */
function crontabHost(): ScheduleHost & { calls: string[] } {
  const calls: string[] = [];
  let crontab = "";
  return {
    calls,
    backend: "cron",
    invocation: { execPath: "/bin/true", scriptPath: "/bin/true" },
    run: async (command, args, input): Promise<CommandResult> => {
      calls.push([command, ...args].join(" "));
      if (command === "crontab" && args[0] === "-l") return { code: 0, stdout: crontab, stderr: "" };
      if (command === "crontab" && args[0] === "-") crontab = input ?? "";
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function mountBoth(h: MountedChrome, root: string, extra: { runNow?: TriggerRunNow; host?: ScheduleHost; notices?: string[] } = {}) {
  const timer = manualInterval();
  const ops = mountOpsSidebar({
    otui: OTUI!.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    cwd: root,
    width: SIDEBAR_TEXT_WIDTH,
    onKeypress: keypressSource(h.renderer),
    interval: timer.interval,
    now: () => NOW,
    ...(extra.runNow !== undefined ? { runNow: extra.runNow } : {}),
  });
  const schedules = mountSchedulesSidebar({
    otui: OTUI!.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    cwd: root,
    width: SIDEBAR_TEXT_WIDTH,
    ops,
    onKeypress: keypressSource(h.renderer),
    notice: (text) => extra.notices?.push(text),
    actions: defaultScheduleActions(extra.host ?? crontabHost()),
    describeInstall: async () => "yes (test)",
    now: () => NOW,
  });
  return { timer, ops, schedules };
}

/** Render-and-microtask rounds until `cond` holds (bounded; never a wall-clock sleep). */
async function until(h: MountedChrome, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) await settle(h, 1);
  expect(cond()).toBe(true);
}

async function typeCommand(h: MountedChrome, command: string): Promise<void> {
  h.chrome.input.focus();
  await h.mockInput.typeText(command);
  await settle(h);
  h.mockInput.pressEnter();
  await settle(h);
}

/** The shell's routing for `/schedules`, on the composer's submit (idle and busy branches call the same handler). */
function wire(h: MountedChrome, schedules: SchedulesSidebar): string[] {
  const handled: string[] = [];
  h.chrome.onSubmit((line) => {
    if (isSchedulesCommand(line) && schedules.handleCommand(line)) handled.push(line);
  });
  return handled;
}

// --- AC10 -----------------------------------------------------------------------------

test("AC10: one compact row per schedule — name, next run or paused, last outcome with cost — within the sidebar width; hidden with none", async () => {
  const root = await fixture();
  const p = projectSchedulesPanel(await loadTriggerLedgerView(root), { width: SIDEBAR_TEXT_WIDTH, now: NOW });
  const text = (id: string) => p.rows.find((r) => r.id === id)?.chunks.map((c) => c.text).join("") ?? "";
  expect(text("sb-schedules-check-github")).toMatch(/^check-github \d{2}:\d{2} ok \$0\.004$/);
  // The name is shortened first; the state and outcome stay whole.
  expect(text("sb-schedules-nightly-pr-sweep")).toMatch(/^nightly-pr-sw\S*… paused refused$/);
  for (const row of p.rows) expect(row.chunks.map((c) => c.text).join("").length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
  const empty = await makeProject("keryx-schedules-empty-");
  roots.push(empty);
  expect(projectSchedulesPanel(await loadTriggerLedgerView(empty), { width: SIDEBAR_TEXT_WIDTH, now: NOW })).toEqual({ visible: false, rows: [] });
});

otuiTest("AC10: mounted after Triggers; a /theme switch recolours it; a click on a row opens that schedule's detail", async () => {
  const h = await mountChrome(OTUI!);
  const root = await fixture();
  const before = getThemeId();
  applyThemeId("groknight");
  const { ops, schedules } = mountBoth(h, root);
  try {
    await schedules.panel.refresh();
    await settle(h);
    const children = (h.chrome.sidebarTop as unknown as { getChildren(): Array<{ id: string }> }).getChildren().map((c) => c.id);
    expect(children.indexOf("sb-schedules")).toBeGreaterThan(children.indexOf("sb-triggers"));
    expect(textOf(findById(h.chrome.sidebarTop, "sb-schedules-k"))).toBe("Schedules");
    const dark = chunkColors(findById(h.chrome.sidebarTop, "sb-schedules-nightly-pr-sweep"));
    expect(dark[1]).toBe(roleColor("attention").toLowerCase());
    applyThemeId("grokday");
    const light = chunkColors(findById(h.chrome.sidebarTop, "sb-schedules-nightly-pr-sweep"));
    expect(light[1]).toBe(roleColor("attention").toLowerCase());
    expect(light[1]).not.toBe(dark[1]);
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-schedules-check-github"));
    const detail = schedules.openModals().detail;
    expect(detail).toBeDefined();
    await detail!.ready;
    expect(detail!.visibleLines().join("\n")).toContain("check-github  [active]  local schedule");
  } finally {
    applyThemeId(before);
    schedules.dispose();
    ops.dispose();
    h.destroy();
  }
});

// --- AC11 -----------------------------------------------------------------------------

otuiTest("AC11: four tabs — Overview, Grants, Runs, Report — each led by its keys; the report scrolls", async () => {
  const h = await mountChrome(OTUI!, { height: 24 });
  const root = await fixture();
  const { ops, schedules } = mountBoth(h, root);
  try {
    const detail = schedules.show("check-github") as NonNullable<ReturnType<SchedulesSidebar["openModals"]>["detail"]>;
    await detail.ready;
    expect(DETAIL_TABS.map((t) => t.label)).toEqual(["Overview", "Grants", "Runs", "Report"]);
    const overview = detail.visibleLines().join("\n");
    expect(detail.visibleLines()[0]).toBe(DETAIL_KEYS);
    expect(overview).toContain('cadence    schedule:"0 */4 * * *"');
    expect(overview).toContain("next runs  ");
    expect(overview).toContain("installed  yes (test)");
    detail.setTab("grants");
    await settle(h);
    expect(detail.visibleLines()[0]).toBe(DETAIL_KEYS);
    expect(detail.visibleLines().join("\n")).toContain("network   off");
    expect(detail.visibleLines().join("\n")).toContain("  - gh.pr.list: /usr/bin/gh");
    detail.setTab("runs");
    await settle(h);
    expect(detail.visibleLines().join("\n")).toContain("ok — report written  [cost: $0.0042]");
    detail.setTab("report");
    await settle(h);
    expect(detail.visibleLines().join("\n")).toContain("Two PRs need review: #12, #15.");
    h.mockInput.pressArrow("down");
    await settle(h);
    expect(detail.visibleLines()[0]).not.toBe(DETAIL_KEYS); // scrolled one line
  } finally {
    schedules.dispose();
    ops.dispose();
    h.destroy();
  }
});

otuiTest("AC11: p pauses in one step (the CLI's service); r and d arm and need y — any other key cancels; confirmed run-now is `trigger run --schedule`; d deletes", async () => {
  const h = await mountChrome(OTUI!);
  const root = await fixture();
  const runNow = fakeRunNow();
  const host = crontabHost();
  const { ops, schedules } = mountBoth(h, root, { runNow, host });
  try {
    const detail = schedules.show("check-github") as NonNullable<ReturnType<SchedulesSidebar["openModals"]>["detail"]>;
    await detail.ready;

    h.mockInput.pressKey("p");
    await settle(h);
    await detail.settled();
    expect(detail.status()).toContain("paused check-github");
    const stored = JSON.parse(await readFile(scheduleStorePath(root), "utf8")) as { triggers: Array<{ name: string; enabled?: boolean }> };
    expect(stored.triggers.find((t) => t.name === "check-github")?.enabled).toBe(false);
    expect(detail.visibleLines().join("\n")).toContain("check-github  [paused]");

    h.mockInput.pressKey("p");
    await settle(h);
    await detail.settled();
    expect(detail.status()).toContain("resumed check-github");

    h.mockInput.pressKey("r");
    await settle(h);
    expect(detail.status()).toContain("y to confirm");
    h.mockInput.pressKey("n");
    await settle(h);
    expect(detail.status()).toBe("run-now of check-github cancelled");
    expect(runNow.calls).toEqual([]);

    h.mockInput.pressKey("r");
    h.mockInput.pressKey("y");
    await until(h, () => runNow.calls.length === 1);
    await detail.settled();
    await until(h, () => detail.status().includes("run-now exited 0"));
    expect(runNow.calls).toEqual([{ name: "check-github", schedule: true }]);

    h.mockInput.pressKey("d");
    h.mockInput.pressKey("n");
    await until(h, () => detail.status() === "delete of check-github cancelled");
    h.mockInput.pressKey("d");
    h.mockInput.pressKey("y");
    await until(h, () => detail.status().includes("deleted check-github"));
    await detail.settled();
    const after = JSON.parse(await readFile(scheduleStorePath(root), "utf8")) as { triggers: Array<{ name: string }> };
    expect(after.triggers.map((t) => t.name)).toEqual(["nightly-pr-sweep"]);
  } finally {
    schedules.dispose();
    ops.dispose();
    h.destroy();
  }
});

// --- AC12 -----------------------------------------------------------------------------

otuiTest("AC12: keyboard only — composer `/schedules` → ↓ → Enter → p reaches a paused schedule; no mouse event", async () => {
  const h = await mountChrome(OTUI!);
  const root = await fixture();
  const { ops, schedules } = mountBoth(h, root);
  const handled = wire(h, schedules);
  try {
    await typeCommand(h, SCHEDULES_COMMAND);
    expect(handled).toEqual([SCHEDULES_COMMAND]);
    const list = schedules.openModals().list;
    expect(list).toBeDefined();
    await list!.ready;
    expect(list!.visibleLines()[0]).toBe(LIST_KEYS);
    // The paused one is first in file order? No: check-github is first. Move to it explicitly.
    expect(list!.selectedName()).toBe("check-github");
    h.mockInput.pressArrow("down");
    await settle(h);
    expect(list!.selectedName()).toBe("nightly-pr-sweep");
    h.mockInput.pressArrow("up");
    await settle(h);
    h.mockInput.pressEnter();
    await settle(h);
    const detail = schedules.openModals().detail;
    expect(detail).toBeDefined();
    await detail!.ready;
    h.mockInput.pressKey("p");
    await settle(h);
    await detail!.settled();
    expect(detail!.visibleLines().join("\n")).toContain("check-github  [paused]");
  } finally {
    schedules.dispose();
    ops.dispose();
    h.destroy();
  }
});

// --- AC13 / AC14 ----------------------------------------------------------------------

otuiTest("AC13: a run finished by another process repaints the row and the Runs tab on the next tick; its report is announced once; an unchanged tick repaints nothing", async () => {
  const h = await mountChrome(OTUI!);
  const root = await fixture();
  const notices: string[] = [];
  const { timer, ops, schedules } = mountBoth(h, root, { notices });
  try {
    await ops.watcher.ready;
    await schedules.panel.refresh();
    const row = () => textOf(findById(h.chrome.sidebarTop, "sb-schedules-check-github"));
    expect(row()).toMatch(/ ok \$0\.004$/);
    expect(notices).toEqual([]); // reports already on record are the baseline
    const detail = schedules.show("check-github") as NonNullable<ReturnType<SchedulesSidebar["openModals"]>["detail"]>;
    await detail.ready;
    detail.setTab("runs");
    await settle(h);

    // Another process (the systemd timer) finishes a run and writes its report.
    const reportDir = path.join(root, ".metaproject", "data", "trigger", "reports", "check-github");
    await writeFile(path.join(reportDir, "sch-2.md"), "# check-github\n\n## Report\n\nNothing needs you.\n", "utf8");
    await appendFile(
      path.join(root, ".metaproject", "data", "trigger", "runs.jsonl"),
      `${JSON.stringify({ v: 1, ...record("check-github", "2026-09-23T11:58:00.000Z", "failed", { recorded: true, usd: 0.001 }, { runId: "sch-2", reportPath: ".metaproject/data/trigger/reports/check-github/sch-2.md" }) })}\n`,
      "utf8",
    );
    await timer.fire();
    await schedules.repainted();
    await settle(h);
    expect(row()).toMatch(/ failed \$0\.001$/);
    expect(detail.visibleLines().join("\n")).toContain("failed — refused on the spend ceiling");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Schedule check-github: new report (failed, $0.001)");

    // Unchanged tick: nothing re-announced.
    await timer.fire();
    await schedules.repainted();
    expect(notices).toHaveLength(1);
  } finally {
    schedules.dispose();
    ops.dispose();
    h.destroy();
  }
});

otuiTest("AC14: a budget-refused run shows in the row and in the Runs tab", async () => {
  const h = await mountChrome(OTUI!);
  const root = await fixture();
  const { ops, schedules } = mountBoth(h, root);
  try {
    await schedules.panel.refresh();
    const row = findById(h.chrome.sidebarTop, "sb-schedules-nightly-pr-sweep");
    expect(textOf(row)).toMatch(/ refused$/);
    expect(chunkColors(row)[2]).toBe(roleColor("attention").toLowerCase());
    const detail = schedules.show("nightly-pr-sweep") as NonNullable<ReturnType<SchedulesSidebar["openModals"]>["detail"]>;
    await detail.ready;
    detail.setTab("runs");
    await settle(h);
    // The tab wraps long lines at the modal width; join without breaks to read the record.
    expect(detail.visibleLines().join("")).toContain("budget-refused — refused on the spend ceiling  [cost: not recorded (over the ceiling)]");
  } finally {
    schedules.dispose();
    ops.dispose();
    h.destroy();
  }
});
