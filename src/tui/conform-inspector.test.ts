// Flow 308 (AC8): the `/conform` modal, driven by real keypresses. Invented
// content throughout (AC10).

import { describe, expect, test } from "bun:test";
import {
  flattenConformClauses,
  formatConformClauseLines,
  formatConformDetailLines,
  formatConformSetupLines,
  isConformCommand,
  openConform,
  type ConformClauseRow,
  type ConformHunkBudget,
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

// Flow 326, AC4: an aggregated hunk-kind row — one per clause, carrying how
// many hunks were judged/below threshold, the worst hunk, and further
// violations, never one row per hunk.
const HUNK_AGGREGATE_ROW: ConformClauseRow = {
  clause_id: "hunks-2",
  state_kind: "hunk",
  status: "likely-violated",
  evidence: [],
  hunksJudged: 5,
  hunksBelowThreshold: 2,
  worst: { location: { path: "src/invented/example.ts", startLine: 10, endLine: 14 }, probability: 0.12 },
  furtherViolations: [{ location: { path: "src/invented/other.ts", startLine: 3, endLine: 6 }, probability: 0.31 }],
};

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

// Flow 326, AC3/item 2: the TUI surfaces the same budget info the CLI's
// text/JSON report does — a header line, and a per-clause "judged on K of N"
// marker — not just the aggregated hunksJudged/hunksBelowThreshold counts.
describe("Flow 326, AC3/item 2: the TUI surfaces --max-hunk-calls budget info same as the CLI", () => {
  const HUNK_BUDGET: ConformHunkBudget = {
    maxHunkCalls: 6,
    totalHunks: 12,
    hunksJudged: 3,
    hunksSkipped: 9,
    truncatedClauses: ["hunks-1", "hunks-2"],
  };

  const TRUNCATED_ROW: ConformClauseRow = {
    clause_id: "hunks-1",
    state_kind: "hunk",
    status: "likely-violated",
    evidence: [],
    hunksJudged: 3,
    hunksBelowThreshold: 2,
    hunksTotal: 12,
  };

  const SKIPPED_ROW: ConformClauseRow = {
    clause_id: "hunks-2",
    state_kind: "hunk",
    status: "not-evaluated",
    evidence: [],
    reason: "skipped by --max-hunk-calls (0 of 12 hunks judged)",
  };

  test("a hunk budget line renders above the grouped clause rows, same shape as the CLI's report", () => {
    const lines = formatConformClauseLines([TRUNCATED_ROW], 0, HUNK_BUDGET);
    expect(lines[0]).toBe("hunk budget: judged 3/12 hunk(s) (--max-hunk-calls 6); 9 hunk(s) skipped for clause(s): hunks-1, hunks-2");
  });

  test("no budget line when nothing was skipped", () => {
    const lines = formatConformClauseLines([TRUNCATED_ROW], 0);
    expect(lines.some((l) => l.startsWith("hunk budget:"))).toBe(false);
  });

  test("a clause judged on a subset of hunks carries a 'judged K of N' marker on its own row", () => {
    const lines = formatConformClauseLines([TRUNCATED_ROW], 0, HUNK_BUDGET);
    expect(lines.some((l) => l.includes("hunks-1") && l.includes("(judged 3 of 12 hunks)"))).toBe(true);
  });

  test("a clause the budget skipped entirely shows the not-evaluated reason, not a generic fallback", () => {
    const lines = formatConformClauseLines([SKIPPED_ROW], 0, HUNK_BUDGET);
    expect(lines.some((l) => l.includes("hunks-2") && l.includes("skipped by --max-hunk-calls (0 of 12 hunks judged)"))).toBe(true);
  });

  test("a not-evaluated row with no budget reason still falls back to the generic text", () => {
    const lines = formatConformClauseLines([{ clause_id: "hunks-3", state_kind: "hunk", status: "not-evaluated", evidence: [] }], 0);
    expect(lines.some((l) => l.includes("hunks-3") && l.includes("no state supplied this run"))).toBe(true);
  });

  otuiTest("AC8/item 2: a run outcome's hunkBudget renders in the Clauses tab", async () => {
    const otui = OTUI!;
    const h = await mountChrome(otui);
    const modal = openConform(otui.core, h.chrome, {
      cwd: "/tmp/does-not-matter",
      onKeypress: keypressSource(h.renderer),
      loadSetup: async () => SETUP,
      run: async (_cwd, refPath, target) => ({ ok: true, refPath, target, clauses: [TRUNCATED_ROW, SKIPPED_ROW], hunkBudget: HUNK_BUDGET }),
      visibleRows: 12,
    });
    try {
      expect(modal).toBeDefined();
      await modal!.ready;
      // Pick the first recent doc (cursor starts at row 0), then move down
      // twice (past the second doc row) onto the first target row and run it
      // — the same sequence the AC8 "pick a doc, pick a target" test above
      // uses.
      await h.mockInput.pressEnter();
      await settle(h);
      await h.mockInput.pressArrow("down");
      await settle(h);
      await h.mockInput.pressArrow("down");
      await settle(h);
      await h.mockInput.pressEnter();
      await settle(h);
      await modal!.settled();

      const text = modal!.visibleLines().join("\n");
      expect(text).toContain("hunk budget: judged 3/12 hunk(s)");
      expect(text).toContain("(judged 3 of 12 hunks)");
      expect(text).toContain("skipped by --max-hunk-calls");
    } finally {
      modal?.close();
      h.destroy();
    }
  });
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

// Flow 326, AC4: the aggregated clause list shows one row per clause — a
// hunk-kind clause's row names hunks judged/below threshold, never a
// separate row per hunk.
test("formatConformClauseLines: a hunk-kind aggregate row shows hunks judged/below threshold, not a per-hunk row", () => {
  const lines = formatConformClauseLines([HUNK_AGGREGATE_ROW], 0);
  expect(lines.some((l) => l.includes("hunks-2") && l.includes("likely violated") && l.includes("2/5 hunks below threshold"))).toBe(
    true,
  );
});

// Flow 326, AC4: the detail view lists the worst hunk (with evidence/location
// + probability) and further violating hunks.
test("formatConformDetailLines: a hunk-kind row's detail names the worst hunk and further violations", () => {
  const detail = formatConformDetailLines(HUNK_AGGREGATE_ROW).join("\n");
  expect(detail).toContain("worst hunk: src/invented/example.ts:10-14 (12%)");
  expect(detail).toContain("further violating hunks:");
  expect(detail).toContain("src/invented/other.ts:3-6 (31%)");
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

otuiTest("stale-run race: a first run that resolves AFTER a second run never overwrites the second's result", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let resolveFirst: (outcome: { ok: true; refPath: string; target: ConformTargetOption; clauses: readonly ConformClauseRow[] }) => void =
    () => {};
  let resolveSecond: (outcome: { ok: true; refPath: string; target: ConformTargetOption; clauses: readonly ConformClauseRow[] }) => void =
    () => {};
  let calls = 0;
  const modal = openConform(otui.core, h.chrome, {
    cwd: "/tmp/does-not-matter",
    onKeypress: keypressSource(h.renderer),
    loadSetup: async () => SETUP,
    run: async (_cwd, _refPath, _target) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve as never;
        });
      }
      return new Promise((resolve) => {
        resolveSecond = resolve as never;
      });
    },
    visibleRows: 12,
  });
  try {
    expect(modal).toBeDefined();
    await modal!.ready;

    // Pick the first recent doc, land on the first target row (pr), and run it — call #1, never resolved yet.
    await h.mockInput.pressEnter();
    await settle(h);
    await h.mockInput.pressArrow("down");
    await settle(h);
    await h.mockInput.pressArrow("down");
    await settle(h);
    await h.mockInput.pressEnter();
    await settle(h);
    expect(calls).toBe(1);
    expect(modal!.visibleLines().join("\n")).toContain("Running conformance check");

    // Back to Setup, move onto the SECOND target row (report), and run it — call #2.
    // `setTab` directly (rather than emulating the tab keypress, which this
    // renderer's raw input pipeline does not surface through the low-level
    // "keypress" event `onKeypress` listens on) — `openConform`'s handle
    // spreads the underlying `ModalHandle`, so this is the same call the
    // modal's own `tab`-key handler makes.
    modal!.setTab("setup");
    await settle(h);
    await h.mockInput.pressArrow("down");
    await settle(h);
    await h.mockInput.pressEnter();
    await settle(h);
    expect(calls).toBe(2);

    // The SECOND (later-started) run resolves first — the realistic case, and
    // the one that matters: its result must win.
    resolveSecond({ ok: true, refPath: "docs/invented-a.md", target: TARGETS[1]!, clauses: [
      { clause_id: "second-run-fresh", state_kind: "report", status: "satisfied", probability: 0.9, evidence: [] },
    ] });
    await modal!.settled();
    let text = modal!.visibleLines().join("\n");
    expect(text).toContain("second-run-fresh");

    // The FIRST (stale) run resolves late. Without the run-token guard this
    // overwrites the fresh result from call #2 with call #1's stale clauses.
    resolveFirst({ ok: true, refPath: "docs/invented-a.md", target: TARGETS[0]!, clauses: [
      { clause_id: "first-run-STALE", state_kind: "pr", status: "satisfied", probability: 0.9, evidence: [] },
    ] });
    await settle(h);
    text = modal!.visibleLines().join("\n");
    expect(text).toContain("second-run-fresh");
    expect(text).not.toContain("first-run-STALE");
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
