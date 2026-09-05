import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPrompt, runTask, stripContext, CONTEXT_PATHS, type AgentPort } from "./retrieval-run";
import type { RetrievalTask } from "./retrieval-tasks";

// The agent is a fake here on purpose. What needs proving is the wiring — that
// the two arms really receive DIFFERENT trees, that both are checked out at the
// parent rather than the commit, and that a leaked answer stops the run. None of
// that needs a model, and a harness only testable by spending money does not get
// tested.

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

async function fixtureRepo(): Promise<{ root: string; task: RetrievalTask }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-retrieval-run-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);

  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, "src", "charge.ts"), "export const rate = 1;\n", "utf8");
  await writeFile(path.join(root, ".metaproject", "index.md"), "# routing index\n", "utf8");
  await writeFile(path.join(root, "CLAUDE.md"), "# rules\n", "utf8");
  await writeFile(path.join(root, "AGENTS.md"), "# rules\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "before"]);
  const parent = git(root, ["rev-parse", "HEAD"]);

  // The change itself. Its content must never be visible to the agent.
  await writeFile(path.join(root, "src", "charge.ts"), "export const rate = 2;\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fix(core): refunds double on retry (#1)"]);
  const sha = git(root, ["rev-parse", "HEAD"]);

  return {
    root,
    task: { id: sha.slice(0, 8), sha, parent, query: "refunds double on retry", gold: ["src/charge.ts"] },
  };
}

function fakeAgent(seen: { cwd: string; arm: string }[], answer: string): AgentPort {
  let call = 0;
  return {
    async run({ cwd }) {
      seen.push({ cwd, arm: call === 0 ? "context-on" : "context-off" });
      call += 1;
      return { text: answer, toolCalls: 3, contextTokens: 1000, costUsd: 0.01, stepsToFirstGold: 2 };
    },
  };
}

describe("runTask wiring", () => {
  test("context-on keeps the project's context; context-off does not", async () => {
    const { root, task } = await fixtureRepo();
    const worktreesDir = await mkdtemp(path.join(tmpdir(), "keryx-retrieval-wt-"));
    try {
      const contents: Record<string, string[]> = {};
      const agent: AgentPort = {
        async run({ cwd }) {
          contents[(await readdir(cwd)).includes(".metaproject") ? "with" : "without"] =
            await readdir(cwd);
          return { text: "src/charge.ts", toolCalls: 1, contextTokens: 100, costUsd: 0, stepsToFirstGold: 0 };
        },
      };

      await runTask(task, { repoRoot: root, worktreesDir, agent, modelFor: () => "fake" });

      expect(contents.with).toContain(".metaproject");
      expect(contents.with).toContain("CLAUDE.md");
      expect(contents.without).not.toContain(".metaproject");
      expect(contents.without).not.toContain("CLAUDE.md");
      expect(contents.without).not.toContain("AGENTS.md");
      // Both must still be real checkouts of the same code.
      expect(contents.without).toContain("src");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesDir, { recursive: true, force: true });
    }
  });

  test("both arms are checked out at the PARENT, so the answer is not in the tree", async () => {
    const { root, task } = await fixtureRepo();
    const worktreesDir = await mkdtemp(path.join(tmpdir(), "keryx-retrieval-wt-"));
    try {
      const rates: string[] = [];
      const agent: AgentPort = {
        async run({ cwd }) {
          rates.push(await Bun.file(path.join(cwd, "src", "charge.ts")).text());
          return { text: "src/charge.ts", toolCalls: 1, contextTokens: 100, costUsd: 0, stepsToFirstGold: 0 };
        },
      };

      await runTask(task, { repoRoot: root, worktreesDir, agent, modelFor: () => "fake" });

      // `rate = 2` is the change. Seeing it would mean the agent was handed the
      // answer, and the whole measurement would be worthless.
      expect(rates).toHaveLength(2);
      for (const content of rates) {
        expect(content).toContain("rate = 1");
        expect(content).not.toContain("rate = 2");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesDir, { recursive: true, force: true });
    }
  });

  test("both arms get the same model, chosen once per task", async () => {
    const { root, task } = await fixtureRepo();
    const worktreesDir = await mkdtemp(path.join(tmpdir(), "keryx-retrieval-wt-"));
    try {
      const seen: { cwd: string; arm: string }[] = [];
      const results = await runTask(task, {
        repoRoot: root,
        worktreesDir,
        agent: fakeAgent(seen, "src/charge.ts"),
        modelFor: () => "chosen-model",
      });
      expect(results.map((r) => r.model)).toEqual(["chosen-model", "chosen-model"]);
      // And each arm ran in its own directory, not the same one twice.
      expect(seen[0]?.cwd).not.toBe(seen[1]?.cwd);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesDir, { recursive: true, force: true });
    }
  });

  test("scores the answer against the gold set", async () => {
    const { root, task } = await fixtureRepo();
    const worktreesDir = await mkdtemp(path.join(tmpdir(), "keryx-retrieval-wt-"));
    try {
      const results = await runTask(task, {
        repoRoot: root,
        worktreesDir,
        agent: fakeAgent([], "I would look at src/charge.ts"),
        modelFor: () => "fake",
      });
      expect(results[0]?.score.recall).toBe(1);
      expect(results[1]?.score.recall).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesDir, { recursive: true, force: true });
    }
  });

  test("carries the agent's dollar cost through to the result", async () => {
    // It did not, for as long as the pre-registration claimed it did: the
    // adapter parsed `total_cost_usd` and this runner dropped it.
    const { root, task } = await fixtureRepo();
    const worktreesDir = await mkdtemp(path.join(tmpdir(), "keryx-retrieval-wt-"));
    try {
      const results = await runTask(task, {
        repoRoot: root,
        worktreesDir,
        agent: fakeAgent([], "src/charge.ts"),
        modelFor: () => "fake",
      });
      expect(results.map((r) => r.costUsd)).toEqual([0.01, 0.01]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesDir, { recursive: true, force: true });
    }
  });

  test("a wrong answer scores zero rather than erroring", async () => {
    const { root, task } = await fixtureRepo();
    const worktreesDir = await mkdtemp(path.join(tmpdir(), "keryx-retrieval-wt-"));
    try {
      const results = await runTask(task, {
        repoRoot: root,
        worktreesDir,
        agent: fakeAgent([], "no idea, maybe src/elsewhere.ts"),
        modelFor: () => "fake",
      });
      expect(results[0]?.score.recall).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesDir, { recursive: true, force: true });
    }
  });

  test("the prompt does not mention the graph, the wiki, or how to search", async () => {
    // Naming the tooling would instruct one arm and leave the other guessing,
    // measuring the instruction instead of the context.
    const prompt = buildPrompt({
      id: "x",
      sha: "x",
      parent: "y",
      query: "refunds double on retry",
      gold: ["src/charge.ts"],
    });
    for (const word of ["gdgraph", "graph", "wiki", "keryx", "grep"]) {
      expect(prompt.toLowerCase()).not.toContain(word);
    }
    expect(prompt).toContain("refunds double on retry");
  });
});

describe("stripContext", () => {
  test("removes every context path and leaves the source alone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-strip-"));
    try {
      await mkdir(path.join(root, ".metaproject", "wiki"), { recursive: true });
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(path.join(root, ".metaproject", "wiki", "a.md"), "x", "utf8");
      await writeFile(path.join(root, "CLAUDE.md"), "x", "utf8");
      await writeFile(path.join(root, "AGENTS.md"), "x", "utf8");
      await writeFile(path.join(root, "src", "a.ts"), "x", "utf8");

      await stripContext(root);

      const left = await readdir(root);
      for (const entry of CONTEXT_PATHS) expect(left).not.toContain(entry);
      expect(left).toContain("src");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("is idempotent — a missing path is not an error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-strip-empty-"));
    try {
      await expect(stripContext(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
