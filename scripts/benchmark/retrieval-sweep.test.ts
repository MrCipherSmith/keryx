import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  completedTaskIds,
  loadResults,
  runSweep,
  selectModel,
  MODEL_EASY,
  MODEL_HARD,
} from "./retrieval-sweep";
import type { ArmResult } from "./retrieval-scoring";
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
    score: { recall, precision: recall, f1: recall, matched: [], missed: [], extra: [] },
    toolCalls: 1,
    contextTokens: 100,
    costUsd: 0.01,
    stepsToFirstGold: 1,
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

describe("completedTaskIds", () => {
  test("a task counts as done only when BOTH arms are recorded", () => {
    // One arm alone is not a finished task, and keeping the orphan would let it
    // into the mean without a partner.
    const done = completedTaskIds([
      armResult("t1", "context-on"),
      armResult("t1", "context-off"),
      armResult("t2", "context-on"),
    ]);
    expect([...done]).toEqual(["t1"]);
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
