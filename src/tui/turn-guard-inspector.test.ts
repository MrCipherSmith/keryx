// Flow 329 (AC4/AC7): the `/guard` modal — pure formatting helpers, plus one
// real-render test driven by keypresses (the same harness `ci-triage-
// inspector.test.ts` uses).

import { afterEach, expect, test } from "bun:test";
import { computeTurnGuardVerdict, extractTurnGuardFacts } from "../review/turn-guard";
import { formatTurnGuardDetailLines, formatTurnGuardListLines, isTurnGuardCommand, openTurnGuard, TURN_GUARD_COMMAND, TURN_GUARD_FOOTER } from "./turn-guard-inspector";
import type { TurnGuardResult } from "./turn-guard-source";
import { formatModalFooter } from "./modal-host";
import { keypressSource, loadOpenTui, mountChrome, settle } from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function result(input: Partial<TurnGuardResult>): TurnGuardResult {
  const facts = extractTurnGuardFacts({ userRequest: input.userRequest ?? "", finalMessage: input.finalMessage ?? "", toolCalls: [] });
  return {
    at: 1_700_000_000_000,
    userRequest: "add a feature",
    finalMessage: "done",
    facts,
    verdict: computeTurnGuardVerdict({}),
    skipped: true,
    skipReason: "off",
    ...input,
  };
}

test("isTurnGuardCommand: matches only the bare /guard token", () => {
  expect(isTurnGuardCommand("/guard")).toBe(true);
  expect(isTurnGuardCommand("/guard on")).toBe(true);
  expect(isTurnGuardCommand("  /guard  ")).toBe(true);
  expect(isTurnGuardCommand("/guardian")).toBe(false);
  expect(isTurnGuardCommand("/ci")).toBe(false);
  expect(TURN_GUARD_COMMAND).toBe("/guard");
});

test("formatTurnGuardListLines: an empty history says so", () => {
  expect(formatTurnGuardListLines([], 0)).toEqual(["No turns guarded yet this session."]);
});

test("formatTurnGuardListLines: marks the selected row and summarizes flagged/looks-done/skipped distinctly", () => {
  const flagged = result({ userRequest: "fix the bug", verdict: computeTurnGuardVerdict({ jevAnswers: { done: 0.2 } }), skipped: false });
  const done = result({ userRequest: "add docs", verdict: computeTurnGuardVerdict({ jevAnswers: { done: 0.9 } }), skipped: false });
  const skipped = result({ userRequest: "hi", skipped: true, skipReason: "trivial" });
  const lines = formatTurnGuardListLines([flagged, done, skipped], 1);
  expect(lines[0]).toContain("fix the bug");
  expect(lines[0]).toContain("FLAGGED");
  expect(lines[0]?.startsWith(">")).toBe(false);
  expect(lines[1]?.startsWith(">")).toBe(true);
  expect(lines[1]).toContain("looks done");
  expect(lines[2]).toContain("skipped (trivial)");
});

test("formatTurnGuardDetailLines: no selection says so; a selected result renders the advisory (facts + ADVISORY ONLY)", () => {
  expect(formatTurnGuardDetailLines(undefined)).toEqual(["No turn selected."]);
  const r = result({ verdict: computeTurnGuardVerdict({ jevAnswers: { done: 0.3 } }), skipped: false });
  const detail = formatTurnGuardDetailLines(r).join("\n");
  expect(detail).toContain("FLAGGED");
  expect(detail).toContain("ADVISORY ONLY");
  expect(detail).toContain("facts:");
});

afterEach(() => {
  // mirrors ci-triage-inspector.test.ts's own cleanup discipline: nothing
  // persistent is written by this modal, so there is nothing to reset here
  // beyond what `h.destroy()` (per-test, below) already tears down.
});

otuiTest("AC4: lists history newest-first, shows the on/off header, and enter opens the flagged detail", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const flagged = result({
    userRequest: "fix the build",
    verdict: computeTurnGuardVerdict({ contradiction: { kind: "unmentioned-failure", reason: "shell_exec failed and was not mentioned." } }),
    skipped: false,
  });
  let enabled = true;
  const modal = openTurnGuard(otui.core, h.chrome, {
    history: () => [flagged],
    enabled: () => enabled,
    onKeypress: keypressSource(h.renderer),
    visibleRows: 24,
  });
  try {
    expect(modal).toBeDefined();
    expect(modal!.visibleLines().join("\n")).toContain("guard: on");
    expect(modal!.visibleLines().join("\n")).toContain("fix the build");
    expect(modal!.selected()?.userRequest).toBe("fix the build");

    await h.mockInput.pressEnter();
    await settle(h);
    const detail = modal!.visibleLines().join("\n");
    expect(detail).toContain("FLAGGED");
    expect(detail).toContain("shell_exec failed");
    expect(detail).toContain("ADVISORY ONLY");

    expect(h.captureCharFrame()).toContain(formatModalFooter(TURN_GUARD_FOOTER));

    enabled = false;
    modal!.setTab("list");
    // A live re-read of `enabled()` on the next paint (triggered by a
    // keypress here) — not a snapshot taken once at open — mirrors the
    // guard's own live `/guard on|off` toggle taking effect immediately.
    await h.mockInput.pressKey("down");
    await settle(h);
    expect(modal!.visibleLines().join("\n")).toContain("guard: off");
  } finally {
    modal?.close();
    h.destroy();
  }
});
