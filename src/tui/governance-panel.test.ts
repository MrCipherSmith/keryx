// Flow 300 T6 — AC1 (the Governance section's four states over fixture
// projects), AC2 (click / `/governance` runs the CLI's report in the
// background: state sequence, single-flight, one toast, failure never stuck,
// artifacts identical to the CLI's rendering, no JobRegistry) and the AC10
// theme half for this section.

import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildGovernanceReport, renderGovernanceMarkdown, writeGovernanceArtifacts, type GovernanceReport } from "../governance/service";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import {
  createGovernanceRunner,
  GOVERNANCE_FAILED,
  GOVERNANCE_NO_REPORT,
  GOVERNANCE_RUNNING,
  mountGovernancePanel,
  projectGovernanceRow,
  type GovernanceRunState,
} from "./governance-panel";
import { applyThemeId, getThemeId, roleColor } from "./theme";
import { chunkColors, clickNode, findById, loadOpenTui, makeProject, mountChrome, settle, textOf, writeReport } from "./ops-sidebar.test-helpers";
import { mountOpsSidebar } from "./ops-sidebar";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function project(): Promise<string> {
  const root = await makeProject("keryx-gov-");
  roots.push(root);
  return root;
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("AC1: projection — exactly four states, each within SIDEBAR_TEXT_WIDTH", () => {
  const idle: GovernanceRunState = { kind: "idle" };
  const present = { state: "present", report: { generatedAt: "2026-09-23T05:40:12.000Z" } as GovernanceReport } as const;
  const rows = [
    projectGovernanceRow({ state: "absent" }, idle, SIDEBAR_TEXT_WIDTH),
    projectGovernanceRow({ state: "malformed", reason: "x" }, idle, SIDEBAR_TEXT_WIDTH),
    projectGovernanceRow(present, { kind: "running", startedAt: "t" }, SIDEBAR_TEXT_WIDTH),
    projectGovernanceRow(present, idle, SIDEBAR_TEXT_WIDTH),
    projectGovernanceRow(present, { kind: "failed", reason: "boom", at: "2026-09-23T06:00:00.000Z" }, SIDEBAR_TEXT_WIDTH),
  ];
  expect(rows.map((r) => r.text)).toEqual([
    GOVERNANCE_NO_REPORT,
    GOVERNANCE_NO_REPORT,
    GOVERNANCE_RUNNING,
    "last report 2026-09-23 05:40",
    GOVERNANCE_FAILED,
  ]);
  // A malformed report is never rebuilt on a click (review F15): it opens the modal with the reason.
  expect(rows.map((r) => r.action)).toEqual(["run", "open", "none", "open", "run"]);
  for (const row of rows) expect(row.text.length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
});

otuiTest("AC1: the mounted section reads each fixture project's state (absent, malformed, present)", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  try {
    const absent = await project();
    const malformed = await project();
    await mkdir(path.join(malformed, ".metaproject", "data", "governance", "artifacts"), { recursive: true });
    await writeFile(path.join(malformed, ".metaproject", "data", "governance", "artifacts", "latest.json"), "[]", "utf8");
    const present = await project();
    await writeReport(present, "2026-09-23T05:40:00.000Z");

    const texts: string[] = [];
    for (const cwd of [absent, malformed, present]) {
      const parent = new otui.core.BoxRenderable(h.renderer, { id: `host-${texts.length}`, flexDirection: "column" });
      h.chrome.sidebarTop.add(parent);
      const panel = mountGovernancePanel(otui.core, h.renderer, parent, {
        cwd,
        runner: createGovernanceRunner({ cwd }),
        width: SIDEBAR_TEXT_WIDTH,
        onOpen: () => {},
      });
      await panel.refresh();
      texts.push(textOf(findById(parent, "sb-governance-v")));
      expect(textOf(findById(parent, "sb-governance-k"))).toBe("Governance");
      panel.dispose();
      parent.destroy();
    }
    expect(texts).toEqual([GOVERNANCE_NO_REPORT, GOVERNANCE_NO_REPORT, "last report 2026-09-23 05:40"]);
  } finally {
    h.destroy();
  }
});

otuiTest("AC2: a click with no report runs the CLI's report in the background — running, then last report, one toast; a second click starts nothing", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await project();
  const gate = deferred<void>();
  let builds = 0;
  const ops = mountOpsSidebar({
    otui: otui.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    cwd,
    width: SIDEBAR_TEXT_WIDTH,
    onKeypress: () => () => {},
    interval: () => () => {},
    governance: {
      // The CLI's own builder, held open until the test says so.
      build: async (options) => {
        builds += 1;
        await gate.promise;
        return buildGovernanceReport(options);
      },
      now: () => new Date("2026-09-23T06:00:00.000Z"),
    },
  });
  try {
    await ops.governancePanel.refresh();
    const value = () => textOf(findById(h.chrome.sidebarTop, "sb-governance-v"));
    const sequence = [value()];

    await clickNode(h, findById(h.chrome.sidebarTop, "sb-governance-v"));
    sequence.push(value());
    // The composer is not blurred or locked by a background run.
    expect(h.chrome.overlayActive()).toBe(false);
    // Second click during the run: nothing new starts.
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-governance-v"));
    expect(builds).toBe(1);

    gate.resolve();
    while (ops.runner.state().kind === "running") await new Promise((r) => setImmediate(r));
    await ops.governancePanel.refresh();
    await settle(h);
    sequence.push(value());

    expect(sequence).toEqual([GOVERNANCE_NO_REPORT, GOVERNANCE_RUNNING, "last report 2026-09-23 06:00"]);
    expect(h.toasts.filter((t) => t.startsWith("Governance"))).toEqual(["Governance report ready"]);

    // Written exactly as `keryx governance report` writes it.
    const dir = path.join(cwd, ".metaproject", "data", "governance", "artifacts");
    const json = JSON.parse(await readFile(path.join(dir, "latest.json"), "utf8")) as GovernanceReport;
    expect(json.schemaVersion).toBe(1);
    expect(json.allProjects).toBe(false);
    expect(json.filters).toEqual({});
    expect(await readFile(path.join(dir, "latest.md"), "utf8")).toBe(renderGovernanceMarkdown(json));
  } finally {
    ops.dispose();
    h.destroy();
  }
});

otuiTest("AC2: a thrown build leaves `failed — click to retry`, never a stuck `running…`, and toasts the failure once", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await project();
  const ops = mountOpsSidebar({
    otui: otui.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    cwd,
    width: SIDEBAR_TEXT_WIDTH,
    onKeypress: () => () => {},
    interval: () => () => {},
    governance: {
      build: async () => {
        throw new Error("disk on fire");
      },
    },
  });
  try {
    await ops.governancePanel.refresh();
    const done = ops.runner.start();
    await done;
    await settle(h);
    expect(ops.runner.state()).toMatchObject({ kind: "failed", reason: "disk on fire" });
    expect(textOf(findById(h.chrome.sidebarTop, "sb-governance-v"))).toBe(GOVERNANCE_FAILED);
    expect(h.toasts).toEqual(["Governance report failed: disk on fire"]);
    // Retry is the row's action.
    expect(ops.governancePanel.row().action).toBe("run");
  } finally {
    ops.dispose();
    h.destroy();
  }
});

test("AC2: the runner is the CLI's own pair — same filters, current project, not all projects — and never a JobRegistry task", async () => {
  const cwd = await project();
  const calls: unknown[] = [];
  const runner = createGovernanceRunner({
    cwd,
    build: async (options) => {
      calls.push({ filters: options.filters, allProjects: options.allProjects, cwd: options.cwd });
      return buildGovernanceReport(options);
    },
    write: async (dir, report) => {
      calls.push({ write: dir });
      return writeGovernanceArtifacts(dir, report);
    },
  });
  await runner.start();
  expect(calls).toEqual([
    { filters: { flow: undefined, owner: undefined, since: undefined, until: undefined }, allProjects: false, cwd },
    { write: cwd },
  ]);
  // Structural: nothing in the governance surface reaches the model's task
  // registry or its task-notification path.
  for (const file of ["governance-panel.ts", "governance-inspector.ts", "ops-sidebar.ts"]) {
    const source = await readFile(path.join(import.meta.dir, file), "utf8");
    expect(source).not.toMatch(/import[^;]*background-job-registry/);
    expect(source).not.toMatch(/jobRegistry|buildTaskNotification/);
  }
});

otuiTest("AC10: a /theme switch recolours the Governance section", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await project();
  const before = getThemeId();
  const panel = mountGovernancePanel(otui.core, h.renderer, h.chrome.sidebarTop, {
    cwd,
    runner: createGovernanceRunner({ cwd }),
    width: SIDEBAR_TEXT_WIDTH,
    onOpen: () => {},
  });
  try {
    applyThemeId("groknight");
    await panel.refresh();
    const dark = chunkColors(findById(h.chrome.sidebarTop, "sb-governance-v"));
    expect(dark).toEqual([roleColor("attention").toLowerCase()]);
    applyThemeId("grokday");
    const light = chunkColors(findById(h.chrome.sidebarTop, "sb-governance-v"));
    expect(light).toEqual([roleColor("attention").toLowerCase()]);
    expect(light).not.toEqual(dark);
  } finally {
    applyThemeId(before);
    panel.dispose();
    h.destroy();
  }
});

test("review F7: a stored report NEWER than the failure clears `failed`; an older one does not", () => {
  const failed: GovernanceRunState = { kind: "failed", reason: "boom", at: "2026-09-23T06:00:00.000Z" };
  const report = (generatedAt: string) => ({ state: "present", report: { generatedAt } as GovernanceReport }) as const;
  expect(projectGovernanceRow(report("2026-09-23T07:00:00.000Z"), failed, SIDEBAR_TEXT_WIDTH).text).toBe("last report 2026-09-23 07:00");
  expect(projectGovernanceRow(report("2026-09-23T05:00:00.000Z"), failed, SIDEBAR_TEXT_WIDTH).text).toBe(GOVERNANCE_FAILED);
});

test("review F7: after the re-read the STORED report wins over the run's own date; a deleted report reads as no report", () => {
  const done: GovernanceRunState = { kind: "done", generatedAt: "2026-09-23T08:00:00.000Z" };
  // In the gap before the re-read, the run's own date shows.
  expect(projectGovernanceRow({ state: "absent" }, done, SIDEBAR_TEXT_WIDTH, { readIsStale: true }).text).toBe("last report 2026-09-23 08:00");
  // Re-read: the report was deleted since — no report.
  expect(projectGovernanceRow({ state: "absent" }, done, SIDEBAR_TEXT_WIDTH).text).toBe(GOVERNANCE_NO_REPORT);
  // Re-read: an OLDER stored report (another process rewrote it) is what there is.
  const older = { state: "present", report: { generatedAt: "2026-09-23T07:30:00.000Z" } as GovernanceReport } as const;
  expect(projectGovernanceRow(older, done, SIDEBAR_TEXT_WIDTH).text).toBe("last report 2026-09-23 07:30");
});

otuiTest("review F15: a click on a malformed report opens the modal with its reason and does NOT rebuild it", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await project();
  let builds = 0;
  let opened = 0;
  const runner = createGovernanceRunner({
    cwd,
    build: async (o) => {
      builds += 1;
      return buildGovernanceReport(o);
    },
  });
  const panel = mountGovernancePanel(otui.core, h.renderer, h.chrome.sidebarTop, {
    cwd,
    runner,
    width: SIDEBAR_TEXT_WIDTH,
    onOpen: () => {
      opened += 1;
    },
    readLatest: async () => ({ state: "malformed", reason: "latest.json is missing schemaVersion" }),
  });
  try {
    await panel.refresh();
    expect(textOf(findById(h.chrome.sidebarTop, "sb-governance-v"))).toBe(GOVERNANCE_NO_REPORT);
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-governance-v"));
    expect(opened).toBe(1);
    expect(builds).toBe(0);
  } finally {
    panel.dispose();
    h.destroy();
  }
});
