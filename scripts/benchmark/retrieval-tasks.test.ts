import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { answerStems, extractRetrievalTasks, leaksAnswer } from "./retrieval-tasks";

// The extractor is the part of the measurement most able to fake a good result,
// so its filters are tested against a real repository built for the purpose
// rather than against a stub. A stub would only prove the stub.

function git(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  }
}

async function commit(root: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content, "utf8");
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-retrieval-tasks-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  await commit(root, { "README.md": "seed\n" }, "seed");
  return root;
}

describe("answer-leak filter", () => {
  test("a query naming the file's basename leaks", () => {
    expect(leaksAnswer("fix the retry policy in scheduler", ["src/core/scheduler.ts"])).toBe(true);
  });

  test("a query naming a directory segment leaks", () => {
    // Naming the directory is nearly as much of a giveaway as naming the file.
    expect(leaksAnswer("something in the billing area is wrong", ["src/billing/retry.ts"])).toBe(true);
  });

  test("a query describing the symptom does not leak", () => {
    expect(leaksAnswer("refunds are charged twice on retry", ["src/billing/charge.ts"])).toBe(false);
  });

  test("short path segments are ignored, or nothing would survive", () => {
    // "src" and "ui" occur in ordinary prose. If they counted, every task with a
    // path under src/ would be rejected and the benchmark would be empty.
    expect(answerStems(["src/ui/x.ts"]).has("src")).toBe(false);
    expect(answerStems(["src/ui/x.ts"]).has("ui")).toBe(false);
  });
});

describe("extractRetrievalTasks", () => {
  test("keeps a PR-shaped commit and records the PARENT, not the commit itself", async () => {
    const root = await repo();
    try {
      await commit(root, { "src/a.ts": "export const a = 1;\n" }, "seed source");
      const parentSha = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim();
      await commit(
        root,
        { "src/a.ts": "export const a = 2;\n" },
        "fix(core): refunds are charged twice on retry (#12)\n\nThe second attempt re-runs the capture.",
      );

      const { tasks } = extractRetrievalTasks({ repoRoot: root });
      expect(tasks).toHaveLength(1);
      const task = tasks[0];
      expect(task?.gold).toEqual(["src/a.ts"]);
      // The whole isolation argument rests on this line.
      expect(task?.parent).toBe(parentSha);
      expect(task?.sha).not.toBe(parentSha);
      expect(task?.query).toContain("refunds are charged twice");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drops a commit whose description names the file it changed", async () => {
    const root = await repo();
    try {
      await commit(root, { "src/scheduler.ts": "export const s = 1;\n" }, "seed source");
      await commit(
        root,
        { "src/scheduler.ts": "export const s = 2;\n" },
        "fix(core): the scheduler retries too eagerly (#13)",
      );

      const result = extractRetrievalTasks({ repoRoot: root });
      expect(result.tasks).toHaveLength(0);
      expect(result.dropped.answerLeak).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drops chore and docs, and counts them separately", async () => {
    const root = await repo();
    try {
      await commit(root, { "src/a.ts": "export const a = 1;\n" }, "seed source");
      await commit(root, { "src/a.ts": "export const a = 2;\n" }, "chore(release): 1.2.3 (#14)");

      const result = extractRetrievalTasks({ repoRoot: root });
      expect(result.tasks).toHaveLength(0);
      expect(result.dropped.choreOrDocs).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drops a gold set larger than the cap, and counts it", async () => {
    const root = await repo();
    try {
      const many: Record<string, string> = {};
      for (let i = 0; i < 10; i += 1) many[`src/m${i}.ts`] = `export const m${i} = 0;\n`;
      await commit(root, many, "seed source");
      const changed: Record<string, string> = {};
      for (let i = 0; i < 10; i += 1) changed[`src/m${i}.ts`] = `export const m${i} = 1;\n`;
      await commit(root, changed, "fix(core): a wide sweep nobody can localise (#15)");

      const result = extractRetrievalTasks({ repoRoot: root, maxGold: 8 });
      expect(result.tasks).toHaveLength(0);
      expect(result.dropped.goldSetSize).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("test files are not gold — they are where the answer often is", async () => {
    const root = await repo();
    try {
      await commit(root, { "src/a.ts": "export const a = 1;\n" }, "seed source");
      await commit(
        root,
        { "src/a.ts": "export const a = 2;\n", "src/a.test.ts": "// covers the fix\n" },
        "fix(core): refunds are charged twice on retry (#16)",
      );

      const { tasks } = extractRetrievalTasks({ repoRoot: root });
      expect(tasks[0]?.gold).toEqual(["src/a.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
