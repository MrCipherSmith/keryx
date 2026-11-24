import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "bun:test";
import { ReviewPlanSummary, type ReviewPlanSummaryData } from "./ReviewPlanSummary";

const data: ReviewPlanSummaryData = {
  title: "Fix cache invalidation",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  changeStats: { files: 2, additions: 8, deletions: 3 },
  files: [{ path: "src/cache.ts", additions: 7, deletions: 2 }, { path: "src/cache.test.ts", additions: 1, deletions: 1 }],
  filesComplete: true,
  checks: [{ name: "review-logic", category: "baseline", slices: ["S-1"] }],
  checksComplete: true,
  sliceReasons: [{ id: "S-1", depth: "deep", reasons: ["risk class: security-sensitive code"] }],
  depth: "full",
  depthReason: "auto: a file hits the project reviewer code-boss-reviewer path gate (risk class)",
  stage: "Review plan paused",
  operatorStep: "Choose whether to continue with the expanded plan.",
};

test("ReviewPlanSummary names the pinned PR scope, planned checks and immediate operator step", () => {
  const html = renderToStaticMarkup(createElement(ReviewPlanSummary, { data }));
  expect(html).toContain("Fix cache invalidation");
  expect(html).toContain("Reviewing <code>0123456789ab</code>");
  expect(html).toContain("2 files changed");
  expect(html).toContain("src/cache.ts");
  expect(html).toContain("1 planned reviewer checks · 1 baseline · 0 project");
  expect(html).toContain("Show reviewer assignments");
  expect(html).toContain("Show slice selection reasons");
  expect(html).toContain("risk class: security-sensitive code");
  expect(html).toContain("Review depth: full</strong> · auto: a file hits the project reviewer code-boss-reviewer path gate (risk class)");
  expect(html).toContain("Current stage: Review plan paused");
  expect(html).toContain("Choose whether to continue with the expanded plan.");
});

test("ReviewPlanSummary marks unavailable or incomplete plan/file data without inventing a reason", () => {
  const html = renderToStaticMarkup(createElement(ReviewPlanSummary, { data: { ...data, filesComplete: false, checks: [] } }));
  expect(html).toContain("File list is partial or unavailable.");
  expect(html).toContain("No reviewer assignments are recorded in this plan.");
  expect(html).not.toContain("review-security-code");
});

test("ReviewPlanSummary labels missing preparation facts and never substitutes a stale percentage", () => {
  const html = renderToStaticMarkup(createElement(ReviewPlanSummary, { data: { title: "Review #18", headSha: "b".repeat(40), stage: "shell_task_output" } }));
  expect(html).toContain("File list is not available yet.");
  expect(html).toContain("Waiting for the verified review plan.");
  expect(html).toContain("Current stage: Waiting for review progress");
  expect(html).not.toContain("shell_task_output");
  expect(html).not.toContain("%");
});

test("ReviewPlanSummary separates completed assignments from a finished review", () => {
  const preparing = renderToStaticMarkup(createElement(ReviewPlanSummary, { data: {
    ...data,
    stage: "shell_task_output",
    assignmentProgress: { planned: 15, finished: 15, completed: 15 },
  } }));
  expect(preparing).toContain("Current stage: All reviewer assignments finished · preparing final checks and report");
  expect(preparing).not.toContain("Current stage: Review finished");

  const finished = renderToStaticMarkup(createElement(ReviewPlanSummary, { data: {
    ...data,
    runState: "completed",
    assignmentProgress: { planned: 15, finished: 15, completed: 15 },
  } }));
  expect(finished).toContain("Current stage: Review finished");
});

test("ReviewPlanSummary names the final-check stage when available", () => {
  const html = renderToStaticMarkup(createElement(ReviewPlanSummary, { data: {
    ...data,
    stage: "review complete",
    assignmentProgress: { planned: 15, finished: 15, completed: 15 },
  } }));
  expect(html).toContain("Current stage: Running final review checks");
});

test("ReviewPlanSummary shows each dispatched assignment's tier, provider/model, and selection reason", () => {
  const html = renderToStaticMarkup(createElement(ReviewPlanSummary, { data: {
    ...data,
    checks: [{ name: "review-security-code", category: "project", slices: ["S-1"], assignments: [
      { wave: 2, slices: ["S-1"], tier: "strong", tierReason: "security-sensitive project reviewer", provider: "anthropic", model: "claude-sonnet" },
    ] }],
  } }));
  expect(html).toContain("Wave 2 · Selected tier: strong");
  expect(html).toContain("Dispatch model: anthropic / claude-sonnet");
  expect(html).toContain("security-sensitive project reviewer");
  expect(html).toContain("Show reviewer assignments");
});
