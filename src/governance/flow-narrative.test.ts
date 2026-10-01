// Flow 364 (AC1, AC2, AC8): the stated effect and the work summary in the
// governance report — derived from description.md and the task list, no model.

import { describe, expect, test } from "bun:test";
import { OUTCOME_HINT } from "../flow/description-intent";
import { renderDescription } from "../flow/templates";
import type { FlowTask } from "../flow/types";
import { renderEffectLine, renderSummaryLine, summarizeEffect, summarizeWork } from "./flow-narrative";
import { renderGovernanceMarkdown } from "./report";
import type { FlowGovernance, GovernanceReport } from "./types";

function task(id: string, title: string, status: FlowTask["status"]): FlowTask {
  return { id, title, kind: "implement", status, dependsOn: [], attempts: { count: 0, log: [] }, acRefs: [], evidenceRefs: [], budget: {} } as FlowTask;
}

const DESCRIPTION = [
  "# Title",
  "",
  "## Problem",
  "",
  "The modal only reads. Nothing else.",
  "",
  "## Expected Outcome",
  "",
  "The modal manages flows. More detail here.",
  "",
  "## Outcome criteria",
  "",
  "- Эффект (MrCipherSmith): простые механизмы управления фло",
  "  прямо из отчета.",
  "- Observation: the user closes a flow from the modal.",
  "",
  "## Out of Scope",
  "",
  "- Anything else.",
].join("\n");

describe("summarizeEffect", () => {
  test("a stated effect is the first bullet, continuation folded, every bullet kept", () => {
    expect(summarizeEffect(DESCRIPTION)).toEqual({
      stated: true,
      text: "Эффект (MrCipherSmith): простые механизмы управления фло прямо из отчета.",
      bullets: ["Эффект (MrCipherSmith): простые механизмы управления фло прямо из отчета.", "Observation: the user closes a flow from the modal."],
    });
  });

  test("the untouched template hint is not an effect", () => {
    expect(summarizeEffect(renderDescription("t", "user description"))).toEqual({ stated: false, reason: "hint-only" });
    expect(summarizeEffect(`## Outcome criteria\n\n- ${OUTCOME_HINT}\n`)).toEqual({ stated: false, reason: "hint-only" });
  });

  test("review L-002: prose and numbered items are stated effects; an empty section is not called hint-only", () => {
    expect(summarizeEffect("## Outcome criteria\n\nUsers close flows from the report.\n\n## Out of Scope\n")).toEqual({
      stated: true,
      text: "Users close flows from the report.",
      bullets: ["Users close flows from the report."],
    });
    expect(summarizeEffect("## Outcome criteria\n\n1. Fewer manual commands.\n2. Faster closing.\n")).toEqual({
      stated: true,
      text: "Fewer manual commands.",
      bullets: ["Fewer manual commands.", "Faster closing."],
    });
    expect(summarizeEffect("## Outcome criteria\n\n## Out of Scope\n")).toEqual({ stated: false, reason: "empty-section" });
    // Review round 2, defect 1: markers, headings and quotes are not statements; a numbered item's continuation folds in.
    expect(summarizeEffect("## Outcome criteria\n\n- \n")).toEqual({ stated: false, reason: "empty-section" });
    expect(summarizeEffect(`## Outcome criteria\n\n${OUTCOME_HINT}\n- \n`)).toEqual({ stated: false, reason: "hint-only" });
    expect(summarizeEffect(`## Outcome criteria\n\n> ${OUTCOME_HINT}\n`)).toEqual({ stated: false, reason: "hint-only" });
    expect(summarizeEffect("## Outcome criteria\n\n### Metric\n")).toEqual({ stated: false, reason: "empty-section" });
    expect(summarizeEffect("## Outcome criteria\n\n1. p95 under\n   2s on the dashboard\n")).toEqual({
      stated: true,
      text: "p95 under 2s on the dashboard",
      bullets: ["p95 under 2s on the dashboard"],
    });
    expect(renderEffectLine({ stated: false, reason: "empty-section" })).toBe("effect: not stated (the Outcome criteria section is empty)");
  });

  test("a description without the section, and an unreadable one, are distinct states", () => {
    expect(summarizeEffect("## Problem\n\nx.\n")).toEqual({ stated: false, reason: "no-section" });
    expect(summarizeEffect(undefined)).toEqual({ stated: false, reason: "unreadable" });
  });
});

describe("summarizeWork", () => {
  const tasks = [task("T1", "Context", "done"), task("T2", "Implement", "in-progress"), task("T3", "Test", "todo")];

  test("Expected outcome leads, tasks are counted, open ones named", () => {
    expect(summarizeWork({ tasks }, DESCRIPTION)).toEqual({
      statement: "The modal manages flows.",
      tasksDone: 1,
      tasksTotal: 3,
      openTasks: ["T2 Implement", "T3 Test"],
    });
  });

  test("Problem is the fallback; an unreadable description has no statement", () => {
    expect(summarizeWork({ tasks: [] }, "## Problem\n\nThe modal only reads.\n").statement).toBe("The modal only reads.");
    expect(summarizeWork({ tasks: [] }, undefined).statement).toBeNull();
    expect(summarizeWork({ tasks: [] }, renderDescription("t", "s")).statement).toBeNull();
  });
});

describe("rendered lines", () => {
  test("effect and summary lines, including the not-recorded case of a stored report", () => {
    expect(renderEffectLine(summarizeEffect(DESCRIPTION))).toBe(
      "effect: Эффект (MrCipherSmith): простые механизмы управления фло прямо из отчета. (+1 more)",
    );
    expect(renderEffectLine({ stated: false, reason: "hint-only" })).toBe("effect: not stated (only the template hint)");
    expect(renderEffectLine(undefined)).toStartWith("effect: not recorded");
    expect(renderSummaryLine({ statement: "S.", tasksDone: 1, tasksTotal: 2, openTasks: ["T2 Implement"] })).toBe(
      "summary: S. — tasks 1/2; open: T2 Implement",
    );
    expect(renderSummaryLine(undefined)).toStartWith("summary: not recorded");
  });

  test("AC2: the markdown report carries both lines; a flow from a stored report without them still renders", () => {
    const base = {
      id: "364",
      dir: "364-x",
      slug: "x",
      title: "T",
      status: "in-progress",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      owner: undefined,
      spend: { roundsTotal: 0, roundsWithCost: 0, spentUsd: undefined, roundsWithSpentUsd: 0, inputTokens: undefined, roundsWithInputTokens: 0, outputTokens: undefined, roundsWithOutputTokens: 0 },
      confirmations: { recorded: false },
      gateOutcomes: { recorded: false },
      acceptance: { recorded: false, frozen: true, total: 0, counts: { exec: 0, invariant: 0, judged: 0, none: 0, unclassified: 0 }, runnable: 0 },
      dispatch: { state: "absent" },
    } as FlowGovernance;
    const report: GovernanceReport = {
      schemaVersion: 1,
      generatedAt: "2026-10-01T00:00:00.000Z",
      filters: {},
      allProjects: false,
      projects: [
        {
          root: "/r",
          displayName: undefined,
          state: "ok",
          reason: undefined,
          flows: [{ ...base, effect: summarizeEffect(DESCRIPTION), summary: summarizeWork({ tasks: [] }, DESCRIPTION) }, { ...base, id: "001" }],
          triggerSpend: { state: "absent" },
          policyDecisions: { recorded: false, reason: "n/a" },
        },
      ],
    };
    const markdown = renderGovernanceMarkdown(report);
    expect(markdown).toContain("summary: The modal manages flows. — tasks 0/0");
    expect(markdown).toContain("effect: Эффект (MrCipherSmith)");
    expect(markdown).toContain("effect: not recorded");
    expect(markdown).toContain("summary: not recorded");
  });
});
