import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendJsonl,
  comparableRows,
  loadArenaFailures,
  loadArenaResults,
  runArenaSweep,
  settledKeys,
  type ArenaFailure,
} from "./arena-sweep";
import type { Arm, ArenaArmResult } from "./arena-run";

function row(taskId: string, arm: Arm, harness = "keryx-shell"): ArenaArmResult {
  return {
    taskId,
    taskType: "research",
    arm,
    harness,
    model: "grok-4.6",
    base: "p",
    armOrder: "context-on",
    score: { kind: "research", retrieval: { recall: 1, precision: 1, f1: 1, matched: [], missed: [], extra: [] } },
    toolCalls: 1,
    contextTokens: 100,
    costUsd: null,
    stepsToFirstGold: 1,
    wallClockMs: 10,
    inventory: { wikiPages: 0, hasGraphDb: false, hasRoutingIndex: false, hasNodeModules: false, provisionCommit: undefined },
    inventoryAfter: { wikiPages: 0, hasGraphDb: false, hasRoutingIndex: false, hasNodeModules: false, provisionCommit: undefined },
  };
}

function failure(taskId: string, arm: Arm, harness = "keryx-shell"): ArenaFailure {
  return { taskId, arm, harness, reason: "killed: silence", killReason: "silence", at: "2026-09-10T00:00:00Z" };
}

function workspace(): { results: string; failures: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-sweep-"));
  return { results: path.join(dir, "results.jsonl"), failures: path.join(dir, "failures.jsonl") };
}

describe("settledKeys", () => {
  test("both arms recorded is settled", () => {
    expect(settledKeys([row("a", "context-on"), row("a", "context-off")], []).has("keryx-shell a")).toBe(true);
  });

  test("one arm alone is NOT settled", () => {
    expect(settledKeys([row("a", "context-on")], []).size).toBe(0);
  });

  test("a result plus a recorded failure IS settled — the bug this module closes", () => {
    // Under "no retries", a killed arm leaves the pair permanently incomplete on
    // the pilot's rule. Every resume then re-runs the SURVIVING arm, paying twice
    // and writing a duplicate, while the original survivor is filtered out of the
    // mean it was already paid for.
    const settled = settledKeys([row("a", "context-on")], [failure("a", "context-off")]);
    expect(settled.has("keryx-shell a")).toBe(true);
  });

  test("two recorded failures are settled too — a cell that failed stays failed", () => {
    const settled = settledKeys([], [failure("a", "context-on"), failure("a", "context-off")]);
    expect(settled.has("keryx-shell a")).toBe(true);
  });

  test("settling is per harness, so one leg finishing does not complete another", () => {
    const settled = settledKeys([row("a", "context-on", "grok-build"), row("a", "context-off", "grok-build")], []);
    expect(settled.has("grok-build a")).toBe(true);
    expect(settled.has("keryx-shell a")).toBe(false);
  });
});

describe("comparableRows", () => {
  test("a complete pair of results is comparable", () => {
    expect(comparableRows([row("a", "context-on"), row("a", "context-off")], [])).toHaveLength(2);
  });

  test("a pair where one arm failed is settled but NOT comparable", () => {
    // Including the survivor would compare a context arm against nothing. Settled
    // and comparable are different questions, which is the distinction the pilot's
    // single rule could not express.
    const rows = comparableRows([row("a", "context-on")], [failure("a", "context-off")]);
    expect(rows).toHaveLength(0);
  });

  test("an unrelated failed task does not poison a good pair", () => {
    const rows = comparableRows(
      [row("a", "context-on"), row("a", "context-off"), row("b", "context-on")],
      [failure("b", "context-off")],
    );
    expect(rows.map((r) => r.taskId)).toEqual(["a", "a"]);
  });
});

describe("loading", () => {
  test("a torn line is skipped rather than fatal", () => {
    const paths = workspace();
    writeFileSync(paths.results, `${JSON.stringify(row("a", "context-on"))}\n{"taskId":"b","ar\n`, "utf8");
    expect(loadArenaResults(paths.results)).toHaveLength(1);
  });

  test("a missing file is empty, not an error", () => {
    const paths = workspace();
    expect(loadArenaResults(paths.results)).toEqual([]);
    expect(loadArenaFailures(paths.failures)).toEqual([]);
  });
});

describe("runArenaSweep", () => {
  test("runs a task, appends both arms, and records it as ran", async () => {
    const paths = workspace();
    const report = await runArenaSweep({
      harness: "keryx-shell",
      tasks: [{ id: "a" }],
      resultsPath: paths.results,
      failuresPath: paths.failures,
      runTask: async (task) => [row(task.id, "context-on"), row(task.id, "context-off")],
    });
    expect(report.ran).toEqual(["a"]);
    expect(loadArenaResults(paths.results)).toHaveLength(2);
  });

  test("a settled task is skipped on the second pass, and not paid for twice", async () => {
    const paths = workspace();
    let calls = 0;
    const options = {
      harness: "keryx-shell",
      tasks: [{ id: "a" }],
      resultsPath: paths.results,
      failuresPath: paths.failures,
      runTask: async (task: { id: string }) => {
        calls += 1;
        return [row(task.id, "context-on"), row(task.id, "context-off")];
      },
    };
    await runArenaSweep(options);
    const second = await runArenaSweep(options);
    expect(calls).toBe(1);
    expect(second.skipped).toEqual(["a"]);
  });

  test("a throwing task is recorded as a failure for both arms, never dropped", async () => {
    const paths = workspace();
    const report = await runArenaSweep({
      harness: "keryx-shell",
      tasks: [{ id: "a" }],
      resultsPath: paths.results,
      failuresPath: paths.failures,
      runTask: async () => {
        throw new Error("killed: silence");
      },
    });
    expect(report.failed).toHaveLength(2);
    expect(loadArenaFailures(paths.failures)).toHaveLength(2);
  });

  test("a failed task is NOT retried on resume — a retry masks a leg that systematically hangs", async () => {
    const paths = workspace();
    let calls = 0;
    const options = {
      harness: "keryx-shell",
      tasks: [{ id: "a" }],
      resultsPath: paths.results,
      failuresPath: paths.failures,
      runTask: async () => {
        calls += 1;
        throw new Error("killed: silence");
      },
    };
    await runArenaSweep(options);
    const second = await runArenaSweep(options);
    expect(calls).toBe(1);
    expect(second.skipped).toEqual(["a"]);
  });

  test("a half-recorded pair left by an interrupted write IS re-run", async () => {
    // The one case that must still re-run: one arm on disk and no failure recorded
    // means the process died between the two appends, and nothing settled the pair.
    const paths = workspace();
    appendJsonl(paths.results, row("a", "context-on"));
    let calls = 0;
    const report = await runArenaSweep({
      harness: "keryx-shell",
      tasks: [{ id: "a" }],
      resultsPath: paths.results,
      failuresPath: paths.failures,
      runTask: async (task) => {
        calls += 1;
        return [row(task.id, "context-on"), row(task.id, "context-off")];
      },
    });
    expect(calls).toBe(1);
    expect(report.ran).toEqual(["a"]);
  });

  test("one task failing does not stop the leg", async () => {
    const paths = workspace();
    const report = await runArenaSweep({
      harness: "keryx-shell",
      tasks: [{ id: "a" }, { id: "b" }],
      resultsPath: paths.results,
      failuresPath: paths.failures,
      runTask: async (task) => {
        if (task.id === "a") throw new Error("killed: ceiling");
        return [row(task.id, "context-on"), row(task.id, "context-off")];
      },
    });
    expect(report.ran).toEqual(["b"]);
    expect(report.failed.map((f) => f.taskId)).toEqual(["a", "a"]);
  });
});
