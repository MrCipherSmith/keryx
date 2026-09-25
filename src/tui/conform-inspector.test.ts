// Flow 308 (AC8): the `/conform` modal, driven by real keypresses. Invented
// content throughout (AC10).

import { expect, test } from "bun:test";
import {
  flattenConformClauses,
  formatConformClauseLines,
  formatConformDetailLines,
  formatConformSetupLines,
  isConformCommand,
  openConform,
  type ConformClauseRow,
  type ConformSetupRead,
  type ConformTargetOption,
} from "./conform-inspector";
import { formatModalFooter } from "./modal-host";
import { CONFORM_FOOTER } from "./conform-inspector";
import { keypressSource, loadOpenTui, mountChrome, settle } from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const TARGETS: readonly ConformTargetOption[] = [
  { id: "pr", kind: "pr", label: "PR #999 (current branch)" },
  { id: "report", kind: "report", label: "most recent review package" },
  { id: "diff", kind: "diff", label: "working diff" },
];

const SETUP: ConformSetupRead = { recents: ["docs/invented-a.md", "docs/invented-b.md"], targets: TARGETS };

const CLAUSES: readonly ConformClauseRow[] = [
  { clause_id: "scope-1", state_kind: "pr", status: "satisfied", probability: 0.91, evidence: ["fact one"] },
  { clause_id: "scope-2", state_kind: "pr", status: "likely-violated", probability: 0.22, evidence: ["fact two"], explanation: "Looks violated because X." },
  { clause_id: "hunks-1", state_kind: "hunk", status: "not-evaluated", evidence: [] },
  { clause_id: "process-1", state_kind: "pr", status: "not-checkable", reason: "no artefact records this", evidence: [] },
];

test("isConformCommand matches only the exact /conform token", () => {
  expect(isConformCommand("/conform")).toBe(true);
  expect(isConformCommand("/conform extra text")).toBe(true);
  expect(isConformCommand("/conformx")).toBe(false);
  expect(isConformCommand("conform")).toBe(false);
});

test("formatConformSetupLines: recent docs then targets, selection marked", () => {
  const lines = formatConformSetupLines(SETUP, undefined, 0);
  expect(lines.some((l) => l.includes("docs/invented-a.md"))).toBe(true);
  expect(lines.some((l) => l.includes("docs/invented-b.md"))).toBe(true);
  expect(lines.some((l) => l.includes("PR #999"))).toBe(true);
  expect(lines.some((l) => l.includes("Pick a reference document above first"))).toBe(true);
});

test("formatConformSetupLines: once a doc is picked, it is named and the prompt changes", () => {
  const lines = formatConformSetupLines(SETUP, 1, 3);
  expect(lines.some((l) => l.includes("Reference document: docs/invented-b.md"))).toBe(true);
  expect(lines.some((l) => l.includes("Press enter on a target to run"))).toBe(true);
});

test("formatConformSetupLines: a no-targets note (e.g. conform disabled) is shown instead of targets", () => {
  const lines = formatConformSetupLines({ recents: [], targets: [], note: "review.jev.conform is not enabled for this project" }, undefined, 0);
  expect(lines.join("\n")).toContain("not enabled for this project");
});

test("formatConformClauseLines: grouped by kind, in pr/report/hunk order, with status summaries", () => {
  const lines = formatConformClauseLines(CLAUSES, 0);
  const prIndex = lines.findIndex((l) => l.includes("-- pr --"));
  const hunkIndex = lines.findIndex((l) => l.includes("-- hunk --"));
  expect(prIndex).toBeGreaterThanOrEqual(0);
  expect(hunkIndex).toBeGreaterThan(prIndex);
  expect(lines.some((l) => l.includes("scope-1") && l.includes("satisfied (91%)"))).toBe(true);
  expect(lines.some((l) => l.includes("scope-2") && l.includes("likely violated (22%)"))).toBe(true);
  expect(lines.some((l) => l.includes("hunks-1") && l.includes("not evaluated"))).toBe(true);
  expect(lines.some((l) => l.includes("process-1") && l.includes("not checkable") && l.includes("no artefact records this"))).toBe(true);
});

test("formatConformClauseLines: an empty clause list says so", () => {
  expect(formatConformClauseLines([], 0)).toEqual(["No clauses in this reference document."]);
});

test("flattenConformClauses matches formatConformClauseLines's own row order", () => {
  const flat = flattenConformClauses(CLAUSES);
  expect(flat.map((c) => c.clause_id)).toEqual(["scope-1", "scope-2", "process-1", "hunks-1"]);
});

test("formatConformDetailLines: no selection, evidence, and a labelled advisory explanation", () => {
  expect(formatConformDetailLines(undefined)[0]).toBe("No clause selected.");
  const withEvidence = formatConformDetailLines(CLAUSES[0]).join("\n");
  expect(withEvidence).toContain("fact one");
  const withExplanation = formatConformDetailLines(CLAUSES[1]).join("\n");
  expect(withExplanation).toContain("ADVISORY");
  expect(withExplanation).toContain("Looks violated because X.");
});

otuiTest("AC8: pick a doc, pick a target, run, and view clauses grouped by kind with a detail", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let ranWith: { refPath: string; target: ConformTargetOption } | undefined;
  const modal = openConform(otui.core, h.chrome, {
    cwd: "/tmp/does-not-matter",
    onKeypress: keypressSource(h.renderer),
    loadSetup: async () => SETUP,
    run: async (_cwd, refPath, target) => {
      ranWith = { refPath, target };
      return { ok: true, refPath, target, clauses: CLAUSES };
    },
    visibleRows: 12,
  });
  try {
    expect(modal).toBeDefined();
    await modal!.ready;
    expect(modal!.visibleLines().join("\n")).toContain("docs/invented-a.md");

    // Pick the second recent doc.
    await h.mockInput.pressArrow("down");
    await settle(h);
    await h.mockInput.pressEnter();
    await settle(h);
    expect(modal!.visibleLines().join("\n")).toContain("Reference document: docs/invented-b.md");

    // Move onto the target rows and pick "PR" (first target, right after the two doc rows).
    await h.mockInput.pressArrow("down");
    await settle(h);
    await h.mockInput.pressEnter();
    await settle(h);
    await modal!.settled();

    expect(ranWith?.refPath).toBe("docs/invented-b.md");
    expect(ranWith?.target.kind).toBe("pr");

    const clausesText = modal!.visibleLines().join("\n");
    expect(clausesText).toContain("-- pr --");
    expect(clausesText).toContain("scope-1");

    await h.mockInput.pressEnter();
    await settle(h);
    const detail = modal!.visibleLines().join("\n");
    expect(detail).toContain("scope-1");
    expect(detail).toContain("fact one");

    expect(h.captureCharFrame()).toContain(formatModalFooter(CONFORM_FOOTER));
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("AC8: a run failure is shown, not swallowed", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const modal = openConform(otui.core, h.chrome, {
    cwd: "/tmp/does-not-matter",
    onKeypress: keypressSource(h.renderer),
    loadSetup: async () => SETUP,
    run: async () => ({ ok: false, reason: "review.jev.conform is not enabled for this project" }),
    visibleRows: 12,
  });
  try {
    await modal!.ready;
    // Pick the first recent doc (cursor starts at row 0), then move down twice
    // (past the second doc row) onto the first target row and run it.
    await h.mockInput.pressEnter();
    await settle(h);
    await h.mockInput.pressArrow("down");
    await settle(h);
    await h.mockInput.pressArrow("down");
    await settle(h);
    await h.mockInput.pressEnter();
    await settle(h);
    await modal!.settled();
    expect(modal!.visibleLines().join("\n")).toContain("Could not run: review.jev.conform is not enabled");
  } finally {
    modal?.close();
    h.destroy();
  }
});
