import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DeskRun } from "../../../../src/review/desk-run-types";
import { registerDom, unregisterDom } from "../test/dom";

// ReviewRuns pulls in the Markdown renderer, which needs a DOM to load.
let latestAttempt: typeof import("./ReviewRuns").latestAttempt;
beforeAll(async () => {
  registerDom();
  ({ latestAttempt } = await import("./ReviewRuns"));
});
afterAll(async () => { await unregisterDom(); });

const A = "a".repeat(40), B = "b".repeat(40);
const range = { baseSha: A, headSha: B };
const run = (id: string, extra: Partial<DeskRun> = {}): DeskRun => ({
  id, source: "manual", scope: "pr", ...range, state: "completed", phase: "Done", reason: "",
  createdAt: "2026-11-27T16:00:00Z", startedAt: null, finishedAt: null, result: { reviewed: range }, ...extra,
} as DeskRun);

test("Latest review shows the attempt an imported package copies, whether it finished completed, partial or budget", () => {
  const copy = run("copy", { source: "existing", state: "partial" });
  for (const state of ["completed", "partial", "budget"] as const) {
    expect(latestAttempt([copy, run("own", { source: "session", state })], range)?.id).toBe("own");
  }
});

test("an import stays the Latest review when no own attempt reviewed its range", () => {
  const copy = run("copy", { source: "existing", state: "partial" });
  expect(latestAttempt([copy, run("own", { source: "session", state: "failed", result: null })], range)?.id).toBe("copy");
  expect(latestAttempt([copy, run("own", { decision: { action: "archive", reason: "x", at: "t" } })], range)?.id).toBe("copy");
});
