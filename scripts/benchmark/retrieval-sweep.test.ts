import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  completedKeys,
  completionKey,
  loadResults,
  runSweep,
  selectModel,
  MODEL_EASY,
  MODEL_HARD,
} from "./retrieval-sweep";
import { LEGACY_HARNESS, type ArmResult } from "./retrieval-scoring";
import type { AgentPort } from "./retrieval-run";
import type { RetrievalTask } from "./retrieval-tasks";

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

function armResult(taskId: string, arm: ArmResult["arm"], recall = 1): ArmResult {
  return {
    taskId,
    arm,
    model: "test",
    harness: "claude",
    score: { recall, precision: recall, f1: recall, matched: [], missed: [], extra: [] },
    toolCalls: 1,
    contextTokens: 100,
    costUsd: 0.01,
    stepsToFirstGold: 1,
    inventory: { wikiPages: 0, hasGraphDb: false, hasRoutingIndex: false },
    inventoryAfter: { wikiPages: 0, hasGraphDb: false, hasRoutingIndex: false },
  };
}

async function fixtureRepo(count: number): Promise<{ root: string; tasks: RetrievalTask[] }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sweep-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "index.md"), "# routing\n", "utf8");
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  const parent = git(root, ["rev-parse", "HEAD"]);

  const tasks: RetrievalTask[] = [];
  for (let i = 0; i < count; i += 1) {
    tasks.push({ id: `t${i}`, sha: `sha${i}`, parent, query: `thing ${i}`, gold: ["src/a.ts"] });
  }
  return { root, tasks };
}

const okAgent: AgentPort = {
  harness: "claude",
  async run() {
    return { text: "src/a.ts", toolCalls: 1, contextTokens: 100, costUsd: 0.01, stepsToFirstGold: 1 };
  },
};

describe("selectModel", () => {
  test("is decided by the task alone, and both arms get the same", () => {
    // Anything derived from an arm's behaviour would let the model be chosen by
    // how the arm performed, which destroys the comparison.
    expect(selectModel({ id: "x", sha: "s", parent: "p", query: "q", gold: ["a.ts"] })).toBe(MODEL_EASY);
    expect(
      selectModel({ id: "x", sha: "s", parent: "p", query: "q", gold: ["a.ts", "b.ts", "c.ts", "d.ts"] }),
    ).toBe(MODEL_HARD);
  });

  test("is deterministic — the same task always gets the same model", () => {
    const task = { id: "x", sha: "s", parent: "p", query: "q", gold: ["a.ts", "b.ts", "c.ts"] };
    expect(selectModel(task)).toBe(selectModel(task));
    expect(selectModel(task)).toBe(MODEL_EASY);
  });
});

describe("completedKeys", () => {
  test("a task counts as done only when BOTH arms are recorded", () => {
    // One arm alone is not a finished task, and keeping the orphan would let it
    // into the mean without a partner.
    const done = completedKeys([
      armResult("t1", "context-on"),
      armResult("t1", "context-off"),
      armResult("t2", "context-on"),
    ]);
    expect([...done]).toEqual(["claude t1"]);
  });
});

describe("loadResults", () => {
  test("a torn line from an interrupted write is skipped, not fatal", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-sweep-results-"));
    const file = path.join(dir, "results.jsonl");
    try {
      await writeFile(
        file,
        `${JSON.stringify(armResult("t1", "context-on"))}\n{"taskId":"t1","ar\n`,
        "utf8",
      );
      const loaded = await loadResults(file);
      expect(loaded).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing results file is an empty sweep, not an error", async () => {
    expect(await loadResults("/nonexistent/results.jsonl")).toEqual([]);
  });
});

describe("runSweep", () => {
  test("writes each task's arms before starting the next", async () => {
    // An interruption must cost one task, not the sweep. Fifty tasks is real
    // money, and "just restart it and don't mention the first attempt" is how a
    // sample quietly becomes the runs that happened to finish.
    const { root, tasks } = await fixtureRepo(3);
    const worktreesDir = await mkdtemp(path.join(tmpdir(), "keryx-sweep-wt-"));
    const resultsPath = path.join(worktreesDir, "results.jsonl");
    try {
      await runSweep({ repoRoot: root, worktreesDir, agent: okAgent, tasks, resultsPath });
      const lines = (await readFile(resultsPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(6); // three tasks, two arms each
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesDir, { recursive: true, force: true });
    }
  });

  test("a resumed sweep does not pay for tasks already recorded", async () => {
    const { root, tasks } = await fixtureRepo(3);
    const worktreesDir = await mkdtemp(path.join(tmpdir(), "keryx-sweep-wt-"));
    const resultsPath = path.join(worktreesDir, "results.jsonl");
    try {
      await runSweep({ repoRoot: root, worktreesDir, agent: okAgent, tasks: tasks.slice(0, 2), resultsPath });

      let calls = 0;
      const counting: AgentPort = {
        harness: okAgent.harness,
        async run(input) {
          calls += 1;
          return okAgent.run(input);
        },
      };
      const report = await runSweep({ repoRoot: root, worktreesDir, agent: counting, tasks, resultsPath });

      expect(report.resumed).toHaveLength(2);
      expect(calls).toBe(2); // only the third task's two arms
      expect(report.verdict.tasks).toBe(3); // and all three are in the verdict
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesDir, { recursive: true, force: true });
    }
  });

  test("a failed task is reported, never silently dropped", async () => {
    // A sweep that quietly skips what it choked on reports the subset it could
    // manage as if it were the sample.
    const { root, tasks } = await fixtureRepo(2);
    const worktreesDir = await mkdtemp(path.join(tmpdir(), "keryx-sweep-wt-"));
    const resultsPath = path.join(worktreesDir, "results.jsonl");
    try {
      let call = 0;
      const flaky: AgentPort = {
        harness: okAgent.harness,
        async run(input) {
          call += 1;
          if (call === 1) throw new Error("model refused");
          return okAgent.run(input);
        },
      };
      const report = await runSweep({ repoRoot: root, worktreesDir, agent: flaky, tasks, resultsPath });
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0]?.reason).toContain("model refused");
      expect(report.verdict.tasks).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesDir, { recursive: true, force: true });
    }
  });

  test("an interrupted task leaves no half-pair in the verdict", async () => {
    const { root, tasks } = await fixtureRepo(1);
    const worktreesDir = await mkdtemp(path.join(tmpdir(), "keryx-sweep-wt-"));
    const resultsPath = path.join(worktreesDir, "results.jsonl");
    try {
      // Only the context-on arm ever got written.
      await writeFile(resultsPath, `${JSON.stringify(armResult("t0", "context-on"))}\n`, "utf8");
      const report = await runSweep({ repoRoot: root, worktreesDir, agent: okAgent, tasks, resultsPath });
      expect(report.resumed).toHaveLength(0);
      const onArms = report.results.filter((r) => r.taskId === "t0" && r.arm === "context-on");
      expect(onArms).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesDir, { recursive: true, force: true });
    }
  });
});

describe("the harness is part of the resume key", () => {
  test("a task finished under one harness is not finished under another", () => {
    // Keyed on the task alone, a sweep that completed under claude would skip
    // every task under grok and report the second harness as done having run
    // none of it — and the results file would look exactly like a finished run.
    const done = completedKeys([
      armResult("t1", "context-on"),
      armResult("t1", "context-off"),
    ]);
    expect(done.has(completionKey("claude", "t1"))).toBe(true);
    expect(done.has(completionKey("grok", "t1"))).toBe(false);
  });

  test("a second harness re-runs every task, and pays for all of them", async () => {
    const { root, tasks } = await fixtureRepo(2);
    const worktreesDir = await mkdtemp(path.join(tmpdir(), "keryx-sweep-wt-"));
    const resultsPath = path.join(worktreesDir, "results.jsonl");
    try {
      await runSweep({ repoRoot: root, worktreesDir, agent: okAgent, tasks, resultsPath });

      let calls = 0;
      const other: AgentPort = {
        harness: "grok",
        async run(input) {
          calls += 1;
          return okAgent.run(input);
        },
      };
      const report = await runSweep({ repoRoot: root, worktreesDir, agent: other, tasks, resultsPath });

      expect(calls).toBe(4); // two tasks, two arms each — nothing skipped
      expect(report.resumed).toHaveLength(0);
      expect(report.verdict.harness).toBe("grok");
      // Both legs are reported, and neither is folded into the other.
      expect(report.verdicts.map((v) => v.harness).sort()).toEqual(["claude", "grok"]);
      expect(report.verdicts.every((v) => v.tasks === 2)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesDir, { recursive: true, force: true });
    }
  });

  test("the writer always records the harness — the guard LEGACY_HARNESS rests on", async () => {
    // `loadResults` reads a line with no harness field as claude, because every
    // such line predates the field. That inference is only safe while new lines
    // cannot lack it, so this runs the real writer and reads the raw file back.
    const { root, tasks } = await fixtureRepo(1);
    const worktreesDir = await mkdtemp(path.join(tmpdir(), "keryx-sweep-wt-"));
    const resultsPath = path.join(worktreesDir, "results.jsonl");
    try {
      await runSweep({ repoRoot: root, worktreesDir, agent: okAgent, tasks, resultsPath });
      const lines = (await readFile(resultsPath, "utf8")).split("\n").filter((line) => line.trim().length > 0);
      expect(lines.length).toBe(2);
      for (const line of lines) {
        expect(JSON.parse(line) as { harness?: string }).toHaveProperty("harness", "claude");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesDir, { recursive: true, force: true });
    }
  });

  test("a line written before the axis existed is read as the harness that wrote it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-sweep-legacy-"));
    const resultsPath = path.join(dir, "results.jsonl");
    try {
      const { harness: _dropped, ...legacy } = armResult("t1", "context-on");
      await writeFile(resultsPath, `${JSON.stringify(legacy)}\n`, "utf8");
      const rows = await loadResults(resultsPath);
      expect(rows[0]?.harness).toBe(LEGACY_HARNESS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
