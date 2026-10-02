// Flow 300 T6 — AC3: the governance report modal, driven by real keypresses
// over a stored report at least three body-heights long.

import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { GovernanceReport } from "../governance/service";
import { GOVERNANCE_FOOTER, GOVERNANCE_HEADER_ROWS, governanceMarkdownPath, openGovernanceReport } from "./governance-inspector";
import type { GovernanceFlowActions } from "./governance-flow-actions";
import { createGovernanceRunner } from "./governance-panel";
import { formatModalFooter } from "./modal-host";
import { applyThemeId, getThemeId, roleColor } from "./theme";
import { chunkColors, clickNode, findById, keypressSource, loadOpenTui, makeProject, mountChrome, settle, writeReport } from "./ops-sidebar.test-helpers";
import { flowsRoot } from "../flow/store";
import { mkdir, writeFile } from "node:fs/promises";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A project whose governance report is long: many flows, each several lines. */
async function projectWithLongReport(): Promise<string> {
  const root = await makeProject("keryx-govmodal-");
  roots.push(root);
  for (let i = 1; i <= 12; i += 1) {
    const id = String(i).padStart(3, "0");
    const dir = path.join(flowsRoot(root), `${id}-2026-09-01-fixture-${i}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "flow.json"),
      JSON.stringify({
        schemaVersion: 1,
        id,
        slug: `fixture-${i}`,
        title: `Fixture flow ${i}`,
        status: "done",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        tasks: [],
      }),
      "utf8",
    );
  }
  await writeReport(root, "2026-09-23T05:40:00.000Z");
  return root;
}

const VISIBLE = 10;
// OpenTUI's mock key table has no page keys; these are the terminal's own sequences.
const PAGE_DOWN = "\u001b[6~";
const PAGE_UP = "\u001b[5~";

otuiTest("AC3: header shows generated_at/filters/all_projects; ↑/↓/j/k scroll a line, PgUp/PgDn a page, clamped to the last line", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await projectWithLongReport();
  const markdown = await readFile(governanceMarkdownPath(cwd), "utf8");
  const runner = createGovernanceRunner({ cwd });
  const modal = openGovernanceReport(otui.core, h.chrome, {
    cwd,
    runner,
    onKeypress: keypressSource(h.renderer),
    visibleRows: VISIBLE,
    // Flow 364: the modal opens on Flows; this test drives the Report tab.
    initialTab: "report",
  });
  try {
    expect(modal).toBeDefined();
    await modal!.ready;
    const bodyRows = VISIBLE - GOVERNANCE_HEADER_ROWS;
    const allLines = modal!.allLines();
    // The body IS latest.md, wrapped to the panel width.
    expect(allLines.join("").replace(/\s+/g, "")).toBe(markdown.trimEnd().replace(/\s+/g, ""));
    // At least three body-heights long, as the criterion requires.
    expect(allLines.length).toBeGreaterThanOrEqual(3 * bodyRows);

    expect(modal!.header()).toBe("generated_at 2026-09-23 05:40 · filters none · all_projects false");
    expect(modal!.visibleLines()[0]).toBe("# Governance report");

    h.mockInput.pressArrow("down");
    h.mockInput.pressKey("j");
    await settle(h);
    expect(modal!.visibleLines()[0]).toBe(allLines[2]);
    h.mockInput.pressKey("k");
    await settle(h);
    expect(modal!.visibleLines()[0]).toBe(allLines[1]);

    h.mockInput.pressKey(PAGE_DOWN);
    await settle(h);
    expect(modal!.visibleLines()[0]).toBe(allLines[1 + bodyRows]);
    // Far past the end: clamped so the LAST line is visible on the last row.
    // (The report gained an acceptance-coverage line per flow, so 20 pages no
    // longer reach the end; press enough to be far past it whatever its length.)
    for (let i = 0; i < 60; i += 1) h.mockInput.pressKey(PAGE_DOWN);
    await settle(h);
    expect(modal!.visibleLines().at(-1)).toBe(allLines.at(-1));
    expect(modal!.visibleLines()).toHaveLength(bodyRows);
    h.mockInput.pressKey(PAGE_UP);
    await settle(h);
    expect(modal!.visibleLines().at(-1)).toBe(allLines.at(-1 - bodyRows));

    // The footer lists the keys.
    expect(h.captureCharFrame()).toContain(formatModalFooter(GOVERNANCE_FOOTER));
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("AC3: `r` re-runs in the background and the open modal refreshes when it finishes; Esc closes", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { kittyKeyboard: true });
  const cwd = await projectWithLongReport();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = createGovernanceRunner({
    cwd,
    now: () => new Date("2026-09-24T09:15:00.000Z"),
    build: async (options) => {
      await gate;
      const { buildGovernanceReport } = await import("../governance/service");
      return buildGovernanceReport(options);
    },
  });
  const modal = openGovernanceReport(otui.core, h.chrome, { cwd, runner, onKeypress: keypressSource(h.renderer), visibleRows: VISIBLE });
  try {
    await modal!.ready;
    expect(modal!.header()).toContain("2026-09-23 05:40");
    h.mockInput.pressKey("r");
    await settle(h);
    expect(runner.state().kind).toBe("running");
    expect(modal!.header()).toContain("running…");
    release();
    while (runner.state().kind === "running") await new Promise((r) => setImmediate(r));
    await modal!.reload(); // the runner's "finished" already triggered one; this awaits a settled read
    expect(modal!.header()).toBe("generated_at 2026-09-24 09:15 · filters none · all_projects false");
    const stored = JSON.parse(
      await readFile(path.join(cwd, ".metaproject", "data", "governance", "artifacts", "latest.json"), "utf8"),
    ) as GovernanceReport;
    expect(stored.generatedAt).toBe("2026-09-24T09:15:00.000Z");

    expect(h.chrome.overlayActive()).toBe(true);
    h.mockInput.pressEscape();
    // Waits on the state, not the clock: the ESC parser resolves a lone ESC itself.
    await h.waitFor(() => !h.chrome.overlayActive());
    expect(h.chrome.overlayActive()).toBe(false);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("AC3/AC1: a malformed stored report gives its reason in the modal", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await makeProject("keryx-govmodal-");
  roots.push(cwd);
  const runner = createGovernanceRunner({ cwd });
  const modal = openGovernanceReport(otui.core, h.chrome, {
    cwd,
    runner,
    onKeypress: keypressSource(h.renderer),
    readLatest: async () => ({ state: "malformed", reason: "latest.json is missing schemaVersion/generatedAt/projects" }),
  });
  try {
    await modal!.ready;
    expect(modal!.visibleLines()[0]).toBe(
      "Stored governance report is unreadable (latest.json is missing schemaVersion/generatedAt/projects).",
    );
  } finally {
    modal?.close();
    h.destroy();
  }
});

// --- Flow 364: the Flows tab, check and close ---------------------------------

async function projectWithOpenFlow(openId = "364"): Promise<string> {
  const root = await makeProject("keryx-govflows-");
  roots.push(root);
  const flows: Array<[string, string]> = [
    ["003", "done"],
    [openId, "implemented"],
  ];
  for (const [id, status] of flows) {
    const dir = path.join(flowsRoot(root), `${id}-2026-10-01-fixture-${id}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "flow.json"),
      JSON.stringify({ schemaVersion: 2, id, slug: `fixture-${id}`, title: `Fixture ${id}`, status, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T09:00:00.000Z", tasks: [{ id: "T1", title: "Build", kind: "implement", status: "done" }] }),
      "utf8",
    );
    await writeFile(
      path.join(dir, "description.md"),
      `# Fixture ${id}\n\n## Expected Outcome\n\nFlow ${id} ships.\n\n## Outcome criteria\n\n- Effect (MrCipherSmith): flow ${id} closes from the report.\n`,
      "utf8",
    );
  }
  await writeReport(root, "2026-10-01T09:30:00.000Z");
  return root;
}

function fakeActions(over: { passed?: boolean; merged?: boolean; updatedAt?: () => string } = {}) {
  const calls: string[] = [];
  const actions: GovernanceFlowActions = {
    check: async (id) => {
      calls.push(`check ${id}`);
      return {
        id,
        status: "implemented",
        updatedAt: over.updatedAt?.() ?? "2026-10-01T09:00:00.000Z",
        checkedAt: "2026-10-01T10:00:00.000Z",
        transition: { allowed: true, detail: "implemented → completing" },
        merge: over.merged === false ? { state: "open", detail: "PR open, not merged" } : { state: "merged", detail: "PR merged" },
        gates: [{ name: "acceptance-criteria", status: over.passed === false ? "fail" : "pass", detail: over.passed === false ? "unconfirmed: AC1" : "1 confirmed" }],
        passed: over.passed !== false,
        confirmationRequired: false,
      };
    },
    close: async (id) => {
      calls.push(`close ${id}`);
      return { passed: true, gates: [], flow: {} as never, issueComment: null, commented: false };
    },
    branch: async () => "main",
  };
  return { actions, calls };
}

otuiTest("flow 364 AC3: the modal opens on Flows — open flows first, each with its summary and stated effect", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await projectWithOpenFlow();
  const { actions, calls } = fakeActions();
  const modal = openGovernanceReport(otui.core, h.chrome, { cwd, runner: createGovernanceRunner({ cwd }), onKeypress: keypressSource(h.renderer), flowActions: actions });
  try {
    await modal!.ready;
    const lines = modal!.allFlowLines();
    expect(lines[0]).toBe("▸ 364 implemented  Fixture 364");
    expect(lines).toContain("    summary: Flow 364 ships. — tasks 1/1");
    expect(lines).toContain("    effect: Effect (MrCipherSmith): flow 364 closes from the report.");
    expect(modal!.actionLine()).toBe("[c] check 364   close: press c to check first");
    h.mockInput.pressArrow("down");
    await settle(h);
    expect(modal!.selectedFlowId()).toBe("003");
    expect(modal!.actionLine()).toBe("003 is done — nothing to check or close");
    // Review T-006: `c` on a done flow does nothing.
    h.mockInput.pressKey("c");
    await settle(h);
    await modal!.settled();
    expect(calls).toEqual([]);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("flow 384 AC7: a flow whose number a remote branch also uses, or whose folder is not committed, carries a tag, and the selected entry the check's own line", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await projectWithOpenFlow();
  const { actions } = fakeActions();
  let asked = 0;
  const dupMessage = "flow id 364 is also used on origin/main by a different flow (364-2026-09-30-other) — repair with: keryx flow renumber 364-2026-10-01-fixture-364 --to <free id> --reason \"<why>\"";
  actions.hygiene = async () => {
    asked += 1;
    return new Map([
      ["364-2026-10-01-fixture-364", { tags: ["dup id" as const], notes: [dupMessage] }],
      ["003-2026-10-01-fixture-003", { tags: ["not committed" as const], notes: ["flow folder 003-2026-10-01-fixture-003 is not committed: commit it in the same PR as the code"] }],
    ]);
  };
  const modal = openGovernanceReport(otui.core, h.chrome, { cwd, runner: createGovernanceRunner({ cwd }), onKeypress: keypressSource(h.renderer), flowActions: actions });
  try {
    await modal!.ready;
    const lines = modal!.allFlowLines();
    expect(lines[0]).toBe("▸ 364 implemented  Fixture 364  [dup id]");
    expect(lines.some((line) => line.includes("003 done") && line.endsWith("[not committed]"))).toBe(true);
    // Selected entry: the check's own message, so the tag is explained where it is read.
    expect(lines.join("\n").replace(/\s+/g, " ")).toContain("flow id 364 is also used on origin/main by a different flow");
    expect(lines.join("\n")).not.toContain("is not committed: commit it");
    h.mockInput.pressArrow("down");
    await settle(h);
    expect(modal!.allFlowLines().join("\n").replace(/\s+/g, " ")).toContain("is not committed: commit it in the same PR as the code");
    // Computed once for the list, not once per paint or per keypress.
    expect(asked).toBe(1);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("flow 364 AC5-AC7: c checks, d asks for the id typed back, Enter closes and re-runs the report", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await projectWithOpenFlow();
  const { actions, calls } = fakeActions();
  const runner = createGovernanceRunner({ cwd });
  const modal = openGovernanceReport(otui.core, h.chrome, { cwd, runner, onKeypress: keypressSource(h.renderer), flowActions: actions });
  try {
    await modal!.ready;
    // Close is not offered before a check: `d` does nothing.
    h.mockInput.pressKey("d");
    await settle(h);
    expect(calls).toEqual([]);

    h.mockInput.pressKey("c");
    await settle(h);
    await modal!.settled();
    expect(calls).toEqual(["check 364"]);
    expect(modal!.selectedCloseOffer()).toEqual({ kind: "close" });
    expect(modal!.allFlowLines()).toContain("    check at 2026-10-01 10:00: complete would pass");

    // A wrong id cancels; nothing is closed.
    h.mockInput.pressKey("d");
    await settle(h);
    expect(modal!.actionLine()).toContain("Close flow 364 on branch main");
    for (const key of ["3", "6", "5"]) h.mockInput.pressKey(key);
    h.mockInput.pressEnter();
    await settle(h);
    expect(calls).toEqual(["check 364"]);

    // Review T-002: any other key cancels — the digits typed after it never complete anything.
    h.mockInput.pressKey("d");
    await settle(h);
    h.mockInput.pressKey("3");
    h.mockInput.pressKey("c");
    await settle(h);
    expect(modal!.actionLine()).not.toContain("Close flow");
    // `x` during a confirmation cancels it rather than closing the modal (review L-001).
    h.mockInput.pressKey("d");
    await settle(h);
    h.mockInput.pressKey("x");
    await settle(h);
    expect(h.chrome.overlayActive()).toBe(true);
    expect(modal!.actionLine()).not.toContain("Close flow");
    await modal!.settled();
    for (const key of ["6", "4"]) h.mockInput.pressKey(key);
    h.mockInput.pressEnter();
    await settle(h);
    await modal!.settled();
    expect(calls.filter((call) => call.startsWith("close"))).toEqual([]);

    // The right id re-checks against the live flow, completes, then the report re-runs.
    const before = calls.length;
    h.mockInput.pressKey("d");
    await settle(h);
    for (const key of ["3", "6", "4"]) h.mockInput.pressKey(key);
    h.mockInput.pressEnter();
    await settle(h);
    await modal!.settled();
    expect(calls.slice(before)).toEqual(["check 364", "close 364"]);
    expect(modal!.allFlowLines()).toContain("    closed: flow complete passed — the flow is done");
    expect(["running", "done"]).toContain(runner.state().kind);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("flow 364 AC6: no close on an unmerged PR; AC8: a blocked keyboard neither checks nor closes", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await projectWithOpenFlow();
  const { actions, calls } = fakeActions({ merged: false });
  let blocked = true;
  const modal = openGovernanceReport(otui.core, h.chrome, {
    cwd,
    runner: createGovernanceRunner({ cwd }),
    onKeypress: keypressSource(h.renderer),
    flowActions: actions,
    inputBlocked: () => blocked,
  });
  try {
    await modal!.ready;
    h.mockInput.pressKey("c");
    h.mockInput.pressKey("d");
    await settle(h);
    expect(calls).toEqual([]);

    blocked = false;
    h.mockInput.pressKey("c");
    await settle(h);
    await modal!.settled();
    expect(calls).toEqual(["check 364"]);
    expect(modal!.selectedCloseOffer()).toEqual({ kind: "none", reason: "PR not merged (open)" });
    h.mockInput.pressKey("d");
    await settle(h);
    expect(modal!.actionLine()).not.toContain("Close flow");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("review L-001: a flow id with 1 and 2 can be typed back — digits do not jump tabs during a confirmation", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await projectWithOpenFlow("312");
  const { actions, calls } = fakeActions();
  const modal = openGovernanceReport(otui.core, h.chrome, { cwd, runner: createGovernanceRunner({ cwd }), onKeypress: keypressSource(h.renderer), flowActions: actions });
  try {
    await modal!.ready;
    h.mockInput.pressKey("c");
    await settle(h);
    await modal!.settled();
    h.mockInput.pressKey("d");
    await settle(h);
    for (const key of ["3", "1", "2"]) h.mockInput.pressKey(key);
    await settle(h);
    expect(modal!.activeTab()).toBe("flows");
    expect(modal!.actionLine()).toContain("— 312 (any other key cancels)");
    h.mockInput.pressEnter();
    await settle(h);
    await modal!.settled();
    expect(calls).toEqual(["check 312", "check 312", "close 312"]);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("review T-001: while a confirmation is open, a blocked keyboard's Enter neither completes nor cancels it", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await projectWithOpenFlow();
  const { actions, calls } = fakeActions();
  let blocked = false;
  const modal = openGovernanceReport(otui.core, h.chrome, {
    cwd,
    runner: createGovernanceRunner({ cwd }),
    onKeypress: keypressSource(h.renderer),
    flowActions: actions,
    inputBlocked: () => blocked,
  });
  try {
    await modal!.ready;
    h.mockInput.pressKey("c");
    await settle(h);
    await modal!.settled();
    h.mockInput.pressKey("d");
    await settle(h);
    for (const key of ["3", "6", "4"]) h.mockInput.pressKey(key);
    await settle(h);
    blocked = true;
    h.mockInput.pressEnter();
    await settle(h);
    await modal!.settled();
    expect(calls).toEqual(["check 364"]);
    expect(modal!.actionLine()).toContain("— 364 (any other key cancels)");
    blocked = false;
    h.mockInput.pressEnter();
    await settle(h);
    await modal!.settled();
    expect(calls).toEqual(["check 364", "check 364", "close 364"]);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("review L-003: Enter re-checks the live flow and does not complete one that changed since the check", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await projectWithOpenFlow();
  let updatedAt = "2026-10-01T09:00:00.000Z";
  const { actions, calls } = fakeActions({ updatedAt: () => updatedAt });
  const modal = openGovernanceReport(otui.core, h.chrome, { cwd, runner: createGovernanceRunner({ cwd }), onKeypress: keypressSource(h.renderer), flowActions: actions });
  try {
    await modal!.ready;
    h.mockInput.pressKey("c");
    await settle(h);
    await modal!.settled();
    h.mockInput.pressKey("d");
    await settle(h);
    for (const key of ["3", "6", "4"]) h.mockInput.pressKey(key);
    // Another session changes the flow before Enter.
    updatedAt = "2026-10-01T09:45:00.000Z";
    h.mockInput.pressEnter();
    await settle(h);
    await modal!.settled();
    expect(calls).toEqual(["check 364", "check 364"]);
    expect(modal!.allFlowLines().join(" ")).toContain("not completed: the flow changed or no longer passes");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("review T-005: the action row is clickable — check, then confirm — and a blocked keyboard makes the click do nothing", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await projectWithOpenFlow();
  const { actions, calls } = fakeActions();
  let blocked = true;
  const modal = openGovernanceReport(otui.core, h.chrome, {
    cwd,
    runner: createGovernanceRunner({ cwd }),
    onKeypress: keypressSource(h.renderer),
    flowActions: actions,
    inputBlocked: () => blocked,
  });
  try {
    await modal!.ready;
    const row = findById(h.renderer.root, "gov-actions");
    await clickNode(h, row);
    await modal!.settled();
    expect(calls).toEqual([]);
    blocked = false;
    await clickNode(h, row);
    await settle(h);
    await modal!.settled();
    expect(calls).toEqual(["check 364"]);
    await clickNode(h, row);
    await settle(h);
    expect(modal!.actionLine()).toContain("Close flow 364");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("review round 2: a theme change keeps a pending confirmation; leaving the Flows tab cancels it", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await projectWithOpenFlow();
  const { actions, calls } = fakeActions();
  const before = getThemeId();
  const modal = openGovernanceReport(otui.core, h.chrome, { cwd, runner: createGovernanceRunner({ cwd }), onKeypress: keypressSource(h.renderer), flowActions: actions });
  try {
    await modal!.ready;
    h.mockInput.pressKey("c");
    await settle(h);
    await modal!.settled();
    h.mockInput.pressKey("d");
    await settle(h);
    h.mockInput.pressKey("3");
    applyThemeId(before === "groknight" ? "grokday" : "groknight");
    await settle(h);
    expect(modal!.actionLine()).toContain("— 3 (any other key cancels)");
    for (const key of ["6", "4"]) h.mockInput.pressKey(key);
    h.mockInput.pressEnter();
    await settle(h);
    await modal!.settled();
    expect(calls).toEqual(["check 364", "check 364", "close 364"]);
    h.mockInput.pressKey("c");
    await settle(h);
    await modal!.settled();
    h.mockInput.pressKey("d");
    await settle(h);
    modal!.setTab("report");
    modal!.setTab("flows");
    await settle(h);
    expect(modal!.actionLine()).not.toContain("Close flow");
  } finally {
    applyThemeId(before);
    modal?.close();
    h.destroy();
  }
});

otuiTest("AC10: a /theme switch recolours the open report modal", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await projectWithLongReport();
  const before = getThemeId();
  applyThemeId("groknight");
  const modal = openGovernanceReport(otui.core, h.chrome, {
    cwd,
    runner: createGovernanceRunner({ cwd }),
    onKeypress: keypressSource(h.renderer),
    initialTab: "report",
  });
  try {
    await modal!.ready;
    const dark = chunkColors(findById(h.renderer.root, "gov-body"));
    expect(dark[0]).toBe(roleColor("text").toLowerCase());
    applyThemeId("grokday");
    const light = chunkColors(findById(h.renderer.root, "gov-body"));
    expect(light[0]).toBe(roleColor("text").toLowerCase());
    expect(light[0]).not.toBe(dark[0]);
  } finally {
    applyThemeId(before);
    modal?.close();
    h.destroy();
  }
});
