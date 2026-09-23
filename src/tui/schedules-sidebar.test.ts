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
import { chmodSync, copyFileSync, mkdtempSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scheduleStorePath } from "../trigger/config";
import { pinGrantedBinary } from "../trigger/granted-binary";
import type { CommandResult, ScheduleHost } from "../trigger/install";
import type { TriggerRunRecord } from "../trigger/record";
import { projectScheduleHash } from "../trigger/schedule";
import { addConfirmedSchedule, removeStoredSchedule, setScheduleEnabled } from "../trigger/store";
import { mountOpsSidebar } from "./ops-sidebar";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import {
  defaultDescribeInstall,
  defaultScheduleActions,
  DETAIL_KEYS,
  DETAIL_TABS,
  grantsLines,
  LIST_KEYS,
  reportText,
  SCHEDULES_COMMAND,
  type InstallDescription,
} from "./schedules-inspector";
import { formatLocalDateTime, projectSchedulesPanel } from "./schedules-panel";
import { mountSchedulesSidebar, routeSchedulesCommand, type SchedulesSidebar } from "./schedules-sidebar";
import { triggerRunArgv } from "./trigger-run-now";
import { applyThemeId, getThemeId, roleColor } from "./theme";
import { loadTriggerLedgerView, scheduledEntries } from "./trigger-ledger";
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
const TRUE_BIN = Bun.which("true") ?? "/usr/bin/true";
/** The keryx the operator confirmed (M1). A test host's own invocation is deliberately different. */
const CONFIRMED_ARGV = [TRUE_BIN];
/** The granted `gh` of the current fixture: a real executable outside the project, pinned. */
let GH = "";

function fakeGh(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-schedules-bin-"));
  roots.push(dir);
  const file = path.join(dir, "gh");
  copyFileSync(TRUE_BIN, file);
  chmodSync(file, 0o755);
  return file;
}

function schedule(root: string, name: string): Record<string, unknown> {
  const pin = pinGrantedBinary("gh", GH, root);
  if (!pin.ok) throw new Error(pin.reason);
  return {
    name,
    on: { kind: "schedule", cron: "0 */4 * * *" },
    action: {
      kind: "agent-task",
      prompt: `Check open PRs for ${name}.`,
      dispatch: { provider: "anthropic", model: "claude-x", permissionMode: "ask", rates: RATES, ceilingUsd: 0.5 },
      grants: { network: "off", tools: ["gh.pr.list"], repos: ["o/r"], bins: { gh: GH }, binDigests: { gh: pin.pin }, account: "gh: me" },
    },
    install: { argv: CONFIRMED_ARGV, env: {} },
  };
}

/** Two schedules, stored the way the confirmed paths store them: signed with this machine's key (L1). */
async function fixture(): Promise<string> {
  const root = await makeProject("keryx-schedules-");
  roots.push(root);
  GH = fakeGh();
  await addConfirmedSchedule(root, schedule(root, "check-github"));
  await addConfirmedSchedule(root, schedule(root, "nightly-pr-sweep"));
  await setScheduleEnabled(root, "nightly-pr-sweep", false);
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
function crontabHost(): ScheduleHost & { calls: string[]; crontab(): string } {
  const calls: string[] = [];
  let crontab = "";
  return {
    calls,
    crontab: () => crontab,
    backend: "cron",
    // M1: NOT the confirmed runner — resume must still install CONFIRMED_ARGV.
    invocation: { execPath: "/opt/other/bun", scriptPath: "/work/checkout/src/cli.ts" },
    run: async (command, args, input): Promise<CommandResult> => {
      calls.push([command, ...args].join(" "));
      if (command === "crontab" && args[0] === "-l") return { code: 0, stdout: crontab, stderr: "" };
      if (command === "crontab" && args[0] === "-") crontab = input ?? "";
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

const DESCRIBED: InstallDescription = { installed: "yes (test)", unit: "keryx-test.timer", linger: "no", verified: "yes (test)" };

function mountBoth(
  h: MountedChrome,
  root: string,
  extra: {
    runNow?: TriggerRunNow;
    host?: ScheduleHost;
    notices?: string[];
    env?: Record<string, string>;
    isInstalled?: (cwd: string, item: { entry: { name: string } }) => Promise<boolean>;
  } = {},
) {
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
    describeInstall: async () => DESCRIBED,
    isInstalled: extra.isInstalled ?? (async () => true),
    env: extra.env ?? {},
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

/**
 * The composer's submit reaches the SHIPPED routing (`routeSchedulesCommand`, which both of
 * `tui-shell.ts`'s `runLine` branches call), not a hand-wired `handleCommand` (L2/AC12).
 */
function wire(h: MountedChrome, schedules: SchedulesSidebar): string[] {
  const handled: string[] = [];
  h.chrome.onSubmit((line) => {
    if (routeSchedulesCommand(line, h.chrome.isBusy(), schedules)) handled.push(line);
  });
  return handled;
}

/** The next time the fixture's cadence (minute 0 of every fourth hour) fires after `from`, in LOCAL time, found by walking minutes (independent of the cron code). */
function nextFourHourly(from: Date): Date {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  do d.setMinutes(d.getMinutes() + 1);
  while (!(d.getMinutes() === 0 && d.getHours() % 4 === 0));
  return d;
}

// --- AC10 -----------------------------------------------------------------------------

test("AC10: one compact row per schedule — name, next run or paused, last outcome with cost — within the sidebar width; hidden with none", async () => {
  const root = await fixture();
  const p = projectSchedulesPanel(await loadTriggerLedgerView(root), { width: SIDEBAR_TEXT_WIDTH, now: NOW });
  const text = (id: string) => p.rows.find((r) => r.id === id)?.chunks.map((c) => c.text).join("") ?? "";
  // L2: the actual next run, computed independently of the cron code, in local time.
  const next = nextFourHourly(NOW);
  const hhmm = `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
  const sameDay = next.toDateString() === NOW.toDateString();
  const when = sameDay ? hhmm : `${next.toLocaleDateString("en-US", { weekday: "short" })} ${hhmm}`;
  expect(text("sb-schedules-check-github")).toBe(`check-github ${when} ok $0.004`);
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
    // L4: next runs in local time, as the row shows them; M4: the unit and linger; L1: verified.
    expect(overview).toContain(`next runs  ${formatLocalDateTime(nextFourHourly(NOW))}, `);
    expect(overview).toContain("installed  yes (test)");
    expect(overview).toContain("unit       keryx-test.timer");
    expect(overview).toContain("linger     no (the timer runs only while you are logged in)");
    expect(overview).toContain("verified   yes (test)");
    detail.setTab("grants");
    await settle(h);
    expect(detail.visibleLines()[0]).toBe(DETAIL_KEYS);
    expect(detail.visibleLines().join("\n")).toContain("network   off");
    expect(detail.visibleLines().join("\n")).toContain(`  - gh.pr.list: ${GH}`);
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

    const marker = `# >>> keryx-managed ${projectScheduleHash(root)} check-github >>>`;
    h.mockInput.pressKey("p");
    await settle(h);
    await detail.settled();
    expect(detail.status()).toContain("paused check-github");
    const stored = JSON.parse(await readFile(scheduleStorePath(root), "utf8")) as { triggers: Array<{ name: string; enabled?: boolean }> };
    expect(stored.triggers.find((t) => t.name === "check-github")?.enabled).toBe(false);
    expect(detail.visibleLines().join("\n")).toContain("check-github  [paused]");
    // L2: pause reads the crontab and (nothing installed yet) writes nothing.
    expect(host.calls).toEqual(["crontab -l"]);

    host.calls.length = 0;
    h.mockInput.pressKey("p");
    await settle(h);
    await detail.settled();
    expect(detail.status()).toContain("resumed check-github");
    // Resume installs the block, with the CONFIRMED keryx, not this host's own (M1).
    expect(host.calls).toEqual(["crontab -l", "crontab -"]);
    expect(host.crontab()).toContain(marker);
    expect(host.crontab()).toContain(`'${TRUE_BIN}' trigger run --schedule 'check-github'`);
    expect(host.crontab()).not.toContain("/work/checkout/src/cli.ts");

    h.mockInput.pressKey("r");
    await settle(h);
    expect(detail.status()).toContain("y to confirm");
    // L2: a key that is neither y nor n cancels too.
    h.mockInput.pressKey("z");
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
    h.mockInput.pressKey("m");
    await until(h, () => detail.status() === "delete of check-github cancelled");
    expect(host.crontab()).toContain(marker);
    host.calls.length = 0;
    h.mockInput.pressKey("d");
    h.mockInput.pressKey("y");
    await until(h, () => detail.status().includes("deleted check-github"));
    await detail.settled();
    const after = JSON.parse(await readFile(scheduleStorePath(root), "utf8")) as { triggers: Array<{ name: string }> };
    expect(after.triggers.map((t) => t.name)).toEqual(["nightly-pr-sweep"]);
    // Delete removes the block from the crontab.
    expect(host.calls).toEqual(["crontab -l", "crontab -"]);
    expect(host.crontab()).not.toContain(marker);
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

    // Unchanged tick: nothing re-announced, and nothing repainted — the row is the same node.
    const node = findById(h.chrome.sidebarTop, "sb-schedules-check-github");
    const paints = schedules.panel.paintCount();
    await timer.fire();
    await schedules.repainted();
    await settle(h);
    expect(notices).toHaveLength(1);
    expect(schedules.panel.paintCount()).toBe(paints);
    expect(findById(h.chrome.sidebarTop, "sb-schedules-check-github")).toBe(node);
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

// --- review of T9 (122b25be): L2, L3, L4, M2, M3a, M4 --------------------------------

function detailOf(schedules: SchedulesSidebar, name: string): NonNullable<ReturnType<SchedulesSidebar["openModals"]>["detail"]> {
  return schedules.show(name) as NonNullable<ReturnType<SchedulesSidebar["openModals"]>["detail"]>;
}

otuiTest("L2: keyboardOwnedElsewhere — while another overlay owns the keyboard the detail takes no key, and an armed action is dropped (L3)", async () => {
  const h = await mountChrome(OTUI!);
  const root = await fixture();
  const runNow = fakeRunNow();
  const { ops, schedules } = mountBoth(h, root, { runNow });
  try {
    const detail = detailOf(schedules, "check-github");
    await detail.ready;
    expect(h.chrome.keyboardOwnedElsewhere()).toBe(false);
    h.mockInput.pressKey("r");
    await settle(h);
    expect(detail.status()).toContain("y to confirm");

    // Queue navigation (a registered, non-modal source) takes the keyboard.
    let owned = true;
    const release = h.chrome.addOverlaySource(() => owned);
    expect(h.chrome.keyboardOwnedElsewhere()).toBe(true);
    h.mockInput.pressKey("y");
    await settle(h);
    expect(detail.status()).toBe("run-now of check-github cancelled (another prompt took the keyboard)");
    h.mockInput.pressKey("p");
    await settle(h);
    await detail.settled();
    expect(detail.visibleLines().join("\n")).toContain("check-github  [active]");
    owned = false;
    release();

    // Back with the modal: a lone `y` confirms nothing, because nothing is armed.
    h.mockInput.pressKey("y");
    await settle(h);
    expect(runNow.calls).toEqual([]);
  } finally {
    schedules.dispose();
    ops.dispose();
    h.destroy();
  }
});

otuiTest("L3: a schedule removed by another process while run-now is armed — y runs nothing and says so", async () => {
  const h = await mountChrome(OTUI!);
  const root = await fixture();
  const runNow = fakeRunNow();
  const { ops, schedules } = mountBoth(h, root, { runNow });
  try {
    const detail = detailOf(schedules, "check-github");
    await detail.ready;
    h.mockInput.pressKey("r");
    await settle(h);
    expect(detail.status()).toContain("y to confirm");
    await removeStoredSchedule(root, "check-github");
    await detail.reload(); // the watcher's repaint of the open modal
    h.mockInput.pressKey("y");
    await settle(h);
    expect(detail.status()).toBe('no schedule named "check-github" any more — nothing was run');
    expect(runNow.calls).toEqual([]);
  } finally {
    schedules.dispose();
    ops.dispose();
    h.destroy();
  }
});

otuiTest("M3a: inside a keryx an agent started (KERYX_TOOL_CALL=1), p, r and d refuse and change nothing", async () => {
  const h = await mountChrome(OTUI!);
  const root = await fixture();
  const runNow = fakeRunNow();
  const host = crontabHost();
  const { ops, schedules } = mountBoth(h, root, { runNow, host, env: { KERYX_TOOL_CALL: "1" } });
  try {
    const detail = detailOf(schedules, "check-github");
    await detail.ready;
    for (const key of ["p", "r", "d"]) {
      h.mockInput.pressKey(key);
      await settle(h);
      await detail.settled();
      expect(detail.status()).toContain("KERYX_TOOL_CALL=1");
      h.mockInput.pressKey("y");
      await settle(h);
      await detail.settled();
    }
    expect(runNow.calls).toEqual([]);
    expect(host.calls).toEqual([]);
    const stored = JSON.parse(await readFile(scheduleStorePath(root), "utf8")) as { triggers: Array<{ name: string; enabled?: boolean }> };
    expect(stored.triggers.map((t) => [t.name, t.enabled ?? true])).toEqual([
      ["check-github", true],
      ["nightly-pr-sweep", false],
    ]);
  } finally {
    schedules.dispose();
    ops.dispose();
    h.destroy();
  }
});

otuiTest("L4: the list keeps its selection by NAME when a reload reorders the rows", async () => {
  const h = await mountChrome(OTUI!);
  const root = await fixture();
  const { ops, schedules } = mountBoth(h, root);
  try {
    const list = schedules.show() as NonNullable<ReturnType<SchedulesSidebar["openModals"]>["list"]>;
    await list.ready;
    h.mockInput.pressArrow("down");
    await settle(h);
    expect(list.selectedName()).toBe("nightly-pr-sweep");
    // Another process adds a schedule that sorts FIRST in the store.
    const stored = JSON.parse(await readFile(scheduleStorePath(root), "utf8")) as { schemaVersion: number; triggers: Array<Record<string, unknown>> };
    const extra = { ...stored.triggers[0]!, name: "aaa-first" };
    await writeFile(scheduleStorePath(root), JSON.stringify({ ...stored, triggers: [extra, ...stored.triggers] }), "utf8");
    await list.reload();
    expect(list.selectedName()).toBe("nightly-pr-sweep");
  } finally {
    schedules.dispose();
    ops.dispose();
    h.destroy();
  }
});

test("L4: an active schedule whose timer is missing shows 'not installed'; a hand-resolved (killed) run is attention, never ok", async () => {
  const root = await fixture();
  await appendRuns(root, [
    { ...record("check-github", "2026-09-23T10:00:00.000Z", "reservation-resolved", { recorded: true, usd: 0.01 }) },
  ]);
  const view = await loadTriggerLedgerView(root);
  const p = projectSchedulesPanel(view, { width: SIDEBAR_TEXT_WIDTH, now: NOW, notInstalled: new Set(["check-github", "nightly-pr-sweep"]) });
  const row = p.rows.find((r) => r.name === "check-github")!;
  // The name is shortened first (the row fits the sidebar); the state and outcome stay whole.
  expect(row.chunks.map((c) => c.text).join("")).toMatch(/ not installed resolved \$0\.01$/);
  expect(row.chunks[1]!.role).toBe("attention");
  expect(row.chunks[2]!.role).toBe("attention");
  // A paused schedule has no timer by design (cron removes its block): it stays "paused".
  expect(p.rows.find((r) => r.name === "nightly-pr-sweep")!.chunks.map((c) => c.text).join("")).toMatch(/ paused /);
});

test("L4: the Runs cap counts closing records; a ledger full of reservations still shows 20 outcomes", async () => {
  const root = await fixture();
  const many: Array<Omit<TriggerRunRecord, "v">> = [];
  for (let i = 0; i < 30; i += 1) {
    const at = new Date(Date.UTC(2026, 8, 20, 0, i)).toISOString();
    many.push({ ...record("check-github", at, "reserved", { recorded: false, reason: "held" }) });
    many.push(record("check-github", at, "ok", { recorded: true, usd: 0.001 }));
  }
  await appendRuns(root, many);
  const item = scheduledEntries(await loadTriggerLedgerView(root)).find((e) => e.entry.name === "check-github")!;
  expect(item.records.filter((r) => r.outcome !== "reserved")).toHaveLength(20);
});

test("L4: the Grants tab names the pinned realpath and short sha of each program, and a wrapper's interpreter", async () => {
  const root = await fixture();
  const item = scheduledEntries(await loadTriggerLedgerView(root)).find((e) => e.entry.name === "check-github")!;
  const text = grantsLines(item).join("\n");
  const pin = item.entry.action.kind === "agent-task" ? item.entry.action.grants.binDigests["gh"]! : undefined;
  expect(text).toContain(`  gh: pinned ${pin!.realpath}  sha256 ${pin!.sha256.slice(0, 12)}`);
  const wrapped = {
    ...item,
    entry: {
      ...item.entry,
      action: {
        ...(item.entry.action as Extract<typeof item.entry.action, { kind: "agent-task" }>),
        grants: {
          ...(item.entry.action as Extract<typeof item.entry.action, { kind: "agent-task" }>).grants,
          binDigests: { gh: { ...pin!, interpreter: { command: "python3", realpath: "/usr/bin/python3.12", sha256: "ab".repeat(32) } } },
        },
      },
    },
  };
  expect(grantsLines(wrapped).join("\n")).toContain("    script wrapper — interpreter python3 → /usr/bin/python3.12  sha256 abababababab, pinned");
});

test("M4 + L1: the default Overview facts name the unit, the linger state and whether the entry still verifies", async () => {
  const root = await fixture();
  const unitDir = mkdtempSync(path.join(tmpdir(), "keryx-schedules-units-"));
  roots.push(unitDir);
  const host: ScheduleHost = {
    backend: "systemd",
    unitDir,
    user: "someone",
    run: async (command) => ({ code: 0, stdout: command === "loginctl" ? "Linger=no\n" : "", stderr: "" }),
  };
  const describe = defaultDescribeInstall(host);
  const item = () => loadTriggerLedgerView(root).then((v) => scheduledEntries(v).find((e) => e.entry.name === "check-github")!);
  const facts = await describe(root, await item());
  expect(facts.unit).toBe(`keryx-${projectScheduleHash(root)}-check-github.timer`);
  expect(facts.linger).toBe("no");
  expect(facts.installed).toMatch(/^NO — the timer files are missing \(systemd\)/);
  expect(facts.verified).toBe("yes — signature and binary pins match what you confirmed");
  // A granted binary swapped behind the schedule: the Overview says NO, with the reason.
  await writeFile(GH, "#!/bin/sh\necho swapped\n", "utf8");
  expect((await describe(root, await item())).verified).toMatch(/^NO — .*gh/);
});

test("M2: the Report tab never follows a planted path, and strips control characters from a real report", async () => {
  const root = await fixture();
  await appendRuns(root, [
    record("check-github", "2026-09-23T11:00:00.000Z", "ok", { recorded: true, usd: 0.001 }, { runId: "sch-9", reportPath: "../../../../etc/hostname" } as TriggerRunRecord["agentTask"]),
  ]);
  const reportDir = path.join(root, ".metaproject", "data", "trigger", "reports", "check-github");
  await writeFile(path.join(reportDir, "sch-1.md"), "# check-github\n\u001b[2J\u001b]0;pwned\u0007Two PRs‮ need review.\n", "utf8");
  const item = scheduledEntries(await loadTriggerLedgerView(root)).find((e) => e.entry.name === "check-github")!;
  const text = await reportText(root, item);
  expect(text).toContain("Two PRs need review.");
  // eslint-disable-next-line no-control-regex -- asserting no control characters survive
  expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‮]/);
});

test("L2: run-now's argv for a local schedule is `trigger run --schedule <name>`, exactly what the timer runs", () => {
  expect(triggerRunArgv("check-github", { execPath: "/usr/local/bin/keryx" }, { schedule: true })).toEqual([
    "/usr/local/bin/keryx",
    "trigger",
    "run",
    "--schedule",
    "check-github",
  ]);
  expect(triggerRunArgv("check-github", { execPath: "/usr/local/bin/keryx" })).toEqual(["/usr/local/bin/keryx", "trigger", "run", "check-github"]);
});

test("L2/AC12: routeSchedulesCommand is the shell's routing — idle via the registry, busy via classifyBusyDispatch; other lines are not taken", () => {
  const taken: string[] = [];
  const fake = { handleCommand: (line: string) => (taken.push(line), true) };
  expect(routeSchedulesCommand("/schedules", false, fake)).toBe(true);
  expect(routeSchedulesCommand("/schedules check-github", true, fake)).toBe(true);
  expect(routeSchedulesCommand("/schedule", false, fake)).toBe(false);
  expect(routeSchedulesCommand("/triggers", true, fake)).toBe(false);
  expect(routeSchedulesCommand("schedules", false, fake)).toBe(false);
  expect(taken).toEqual(["/schedules", "/schedules check-github"]);
});
