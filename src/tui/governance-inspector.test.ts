// Flow 300 T6 — AC3: the governance report modal, driven by real keypresses
// over a stored report at least three body-heights long.

import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { GovernanceReport } from "../governance/service";
import { GOVERNANCE_FOOTER, GOVERNANCE_HEADER_ROWS, governanceMarkdownPath, openGovernanceReport } from "./governance-inspector";
import { createGovernanceRunner } from "./governance-panel";
import { formatModalFooter } from "./modal-host";
import { applyThemeId, getThemeId, roleColor } from "./theme";
import { chunkColors, findById, keypressSource, loadOpenTui, makeProject, mountChrome, settle, writeReport } from "./ops-sidebar.test-helpers";
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
    for (let i = 0; i < 20; i += 1) h.mockInput.pressKey(PAGE_DOWN);
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

otuiTest("AC10: a /theme switch recolours the open report modal", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const cwd = await projectWithLongReport();
  const before = getThemeId();
  applyThemeId("groknight");
  const modal = openGovernanceReport(otui.core, h.chrome, { cwd, runner: createGovernanceRunner({ cwd }), onKeypress: keypressSource(h.renderer) });
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
