// Flow 364 (AC3, AC5, AC6, AC8): the governance modal's Flows tab rules,
// without a renderer — which flows are listed, and when close is offered.

import { describe, expect, test } from "bun:test";
import type { FlowCompletionCheck } from "../flow/types";
import type { FlowGovernance, GovernanceReport } from "../governance/service";
import { closeOffer, flowEntriesFrom, formatActionLine, formatCheckLines, formatFlowEntryLines, wrapHanging } from "./governance-flows";

function flow(id: string, status: string, updatedAt = "2026-10-01T10:00:00.000Z"): FlowGovernance {
  return {
    id,
    dir: `${id}-x`,
    slug: "x",
    title: `Flow ${id}`,
    status,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt,
    owner: undefined,
    spend: { roundsTotal: 0, roundsWithCost: 0, spentUsd: undefined, roundsWithSpentUsd: 0, inputTokens: undefined, roundsWithInputTokens: 0, outputTokens: undefined, roundsWithOutputTokens: 0 },
    confirmations: { recorded: false },
    gateOutcomes: { recorded: false },
    acceptance: { recorded: true, total: 1, counts: { exec: 0, invariant: 0, judged: 0, none: 0, unclassified: 1 }, runnable: 0 },
    dispatch: { state: "absent" },
    effect: { stated: true, text: "Effect (MrCipherSmith): close flows from the report.", bullets: ["Effect (MrCipherSmith): close flows from the report."] },
    summary: { statement: "The modal manages flows.", tasksDone: 1, tasksTotal: 2, openTasks: ["T2 Build"] },
  };
}

function check(over: Partial<FlowCompletionCheck> = {}): FlowCompletionCheck {
  return {
    id: "364",
    status: "implemented",
    updatedAt: "2026-10-01T10:00:00.000Z",
    checkedAt: "2026-10-01T10:05:00.000Z",
    transition: { allowed: true, detail: "implemented → completing" },
    merge: { state: "merged", detail: "PR merged" },
    gates: [{ name: "acceptance-criteria", status: "pass", detail: "8 confirmed" }],
    passed: true,
    confirmationRequired: false,
    ...over,
  };
}

function report(cwd: string, flows: FlowGovernance[]): GovernanceReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-01T10:00:00.000Z",
    filters: {},
    allProjects: false,
    projects: [{ root: cwd, displayName: undefined, state: "ok", reason: undefined, flows, triggerSpend: { state: "absent" }, policyDecisions: { recorded: false, reason: "n/a" } }],
  };
}

describe("flowEntriesFrom", () => {
  test("AC3: open flows first, newest first within each group; only the current project", () => {
    const entries = flowEntriesFrom(report("/repo", [flow("001", "done"), flow("010", "in-progress"), flow("364", "implemented"), flow("200", "done")]), "/repo");
    expect(entries.flows.map((f) => f.id)).toEqual(["364", "010", "200", "001"]);
    expect(flowEntriesFrom(report("/other", [flow("1", "done")]), "/repo").note).toContain("does not cover the current project");
    expect(flowEntriesFrom(report("/repo", []), "/repo").note).toBe("No flows in this project yet.");
  });
});

describe("closeOffer (AC6)", () => {
  const open = flow("364", "implemented");

  test("offered only on a fresh, passing check of a merged PR", () => {
    expect(closeOffer(open, check())).toEqual({ kind: "close" });
  });

  test("never for a done flow, nor before a check", () => {
    expect(closeOffer(flow("364", "done"), check())).toEqual({ kind: "none", reason: "already done" });
    expect(closeOffer(open, undefined).kind).toBe("none");
  });

  test("not when the PR is not merged, or the check failed, or the flow changed since", () => {
    expect(closeOffer(open, check({ merge: { state: "open", detail: "PR open, not merged" } }))).toEqual({ kind: "none", reason: "PR not merged (open)" });
    expect(closeOffer(open, check({ passed: false })).kind).toBe("none");
    expect(closeOffer(flow("364", "implemented", "2026-10-01T11:00:00.000Z"), check())).toEqual({
      kind: "none",
      reason: "the flow changed since the check — press c again",
    });
  });

  test("review T-003: never offered when complete could not start from the flow's status", () => {
    const blocked = { allowed: false, detail: "in-progress: record the PR first" };
    expect(closeOffer(open, check({ transition: blocked, passed: false })).kind).toBe("none");
    const tokenless = check({
      transition: blocked,
      passed: false,
      confirmationRequired: true,
      gates: [{ name: "confirmation", status: "fail", detail: "missing" }],
    });
    expect(closeOffer(open, tokenless).kind).toBe("none");
  });

  test("review L-005: an in-progress flow with no PR is pointed at a direct-merge completion in the terminal", () => {
    const offer = closeOffer(flow("364", "in-progress"), check({ merge: { state: "no-pr", detail: "no PR recorded on the flow" }, passed: false }));
    expect(offer).toEqual({ kind: "none", reason: "no PR recorded — for a direct merge, run `keryx flow complete 364 --merged <sha>` in a terminal" });
  });

  test("a flow that requires a confirmation token is sent to the terminal, only when every other gate passes", () => {
    const tokenless = check({
      passed: false,
      confirmationRequired: true,
      gates: [
        { name: "acceptance-criteria", status: "pass", detail: "8 confirmed" },
        { name: "confirmation", status: "fail", detail: "missing" },
      ],
    });
    expect(closeOffer(open, tokenless)).toEqual({ kind: "confirm-in-terminal" });
    expect(formatActionLine(open, closeOffer(open, tokenless), undefined)).toContain("keryx flow confirm 364");
    const alsoFailing = check({ ...tokenless, gates: [...tokenless.gates, { name: "tasks", status: "fail", detail: "not done: T2" }] });
    expect(closeOffer(open, alsoFailing).kind).toBe("none");
  });
});

describe("lines", () => {
  test("AC3/AC5: an entry shows summary and effect; the selected one shows its check with the fix per failing gate", () => {
    const failing = check({
      passed: false,
      gates: [{ name: "acceptance-criteria", status: "fail", detail: "unconfirmed: AC2" }],
    });
    const lines = formatFlowEntryLines(flow("364", "implemented"), { selected: true, check: failing, checking: false, closing: false, closeResult: undefined, error: undefined });
    expect(lines[0]).toBe("▸ 364 implemented  Flow 364  [check: would not pass]");
    expect(lines[1]).toBe("    summary: The modal manages flows. — tasks 1/2; open: T2 Build");
    expect(lines[2]).toBe("    effect: Effect (MrCipherSmith): close flows from the report.");
    expect(lines).toContain("      ✗ acceptance-criteria (unconfirmed: AC2)");
    expect(lines).toContain('          → keryx flow ac confirm 364 AC2 --note "<evidence>"');
    const other = formatFlowEntryLines(flow("010", "in-progress"), { selected: false, check: undefined, checking: false, closing: false, closeResult: undefined, error: undefined });
    expect(other).toHaveLength(3);
  });

  test("wrapHanging wraps on words, indents continuations, and cuts a word longer than the row", () => {
    expect(wrapHanging("    effect: one two three four", 20)).toEqual(["    effect: one two", "      three four"]);
    expect(wrapHanging("short", 20)).toEqual(["short"]);
    expect(wrapHanging(`  ${"x".repeat(30)}`, 20)).toEqual([`  ${"x".repeat(18)}`, `    ${"x".repeat(12)}`]);
  });

  test("the check names the merge state and the status transition", () => {
    const lines = formatCheckLines(check({ merge: { state: "unknown", detail: "tracker unavailable" } }));
    expect(lines).toContain("  · merge: unknown (tracker unavailable)");
    expect(lines).toContain("  ✓ status (implemented → completing)");
  });

  test("the action row: check for an open flow, close once offered, the typed confirmation names the branch", () => {
    const open = flow("364", "implemented");
    expect(formatActionLine(open, closeOffer(open, undefined), undefined)).toBe("[c] check 364   close: press c to check first");
    expect(formatActionLine(open, { kind: "close" }, undefined)).toBe("[c] check 364   [d] complete 364");
    expect(formatActionLine(flow("1", "done"), undefined, undefined)).toBe("1 is done — nothing to check or close");
    expect(formatActionLine(open, { kind: "close" }, { id: "364", typed: "36", branch: "main" })).toBe(
      "Close flow 364 on branch main: type 364 and press Enter — 36 (any other key cancels)",
    );
  });
});
