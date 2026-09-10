import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBaseTreeCache } from "./arena-checkout";
import { arenaFixtureRepo, createFakeAgent } from "./arena-fake-agent";
import { firstArmFor, runArenaArm, runArenaTask, type ArenaRunOptions } from "./arena-run";
import type { ArenaTask } from "./arena-tasks";

async function setup(): Promise<{
  readonly task: ArenaTask;
  readonly options: (agent: ReturnType<typeof createFakeAgent>) => ArenaRunOptions;
  readonly repoRoot: string;
}> {
  const fixture = await arenaFixtureRepo();
  const workspace = mkdtempSync(path.join(tmpdir(), "arena-run-"));
  const task: ArenaTask = {
    id: `t1-${fixture.task.id}`,
    type: "research",
    base: fixture.task.parent,
    answerSha: fixture.task.sha,
    query: fixture.task.query,
    gold: fixture.task.gold,
    answerNeedles: [],
  };
  const cache = createBaseTreeCache({
    repoRoot: fixture.root,
    cacheDir: path.join(workspace, "cache"),
    depth: 5,
  });
  return {
    task,
    repoRoot: fixture.root,
    options: (agent) => ({
      repoRoot: fixture.root,
      worktreesDir: path.join(workspace, "arms"),
      agent,
      model: "grok-4.6",
      cache,
    }),
  };
}

describe("runArenaArm", () => {
  test("the control arm loses .metaproject and KEEPS the project's own instructions", async () => {
    // The pilot strips AGENTS.md and CLAUDE.md too, which is right on its own
    // repository and wrong on a target where those files are the team's own
    // conventions. Stripping them would measure what happens when you take a
    // codebase's documentation away.
    const { task, options } = await setup();
    const agent = createFakeAgent({ harnessId: "fake", answer: "src/pipelines/iterator-dnd.ts" });
    const result = await runArenaArm(task, "context-off", options(agent));
    expect(result.arm).toBe("context-off");
    // `.metaproject` gone …
    expect(result.inventory.hasRoutingIndex).toBe(false);
    // … and the project's own instruction files still there. The fixture commits
    // both, and `assertArenaArmContext` would have refused the arm if the narrower
    // path list had not been used.
    expect(result.inventory.wikiPages).toBe(0);
  });

  test("the context arm keeps .metaproject", async () => {
    const { task, options } = await setup();
    const agent = createFakeAgent({ harnessId: "fake", answer: "src/pipelines/iterator-dnd.ts" });
    const result = await runArenaArm(task, "context-on", options(agent));
    expect(result.inventory.hasRoutingIndex).toBe(true);
  });

  test("both arms are checked out at the PARENT, so the answer commit is unreachable", async () => {
    // `assertAnswerUnreachable` would throw otherwise, and the test would fail
    // rather than quietly scoring an arm that could `git show` the diff.
    const { task, options } = await setup();
    const agent = createFakeAgent({ harnessId: "fake" });
    await expect(runArenaArm(task, "context-on", options(agent))).resolves.toBeDefined();
    await expect(runArenaArm(task, "context-off", options(agent))).resolves.toBeDefined();
  });

  test("the arm's tree is removed afterwards", async () => {
    // 78 arms of an 8,632-file repository with a 1.5 GB node_modules each; leaving
    // them behind fills the disk before the sweep finishes.
    const { task, options } = await setup();
    const agent = createFakeAgent({ harnessId: "fake" });
    await runArenaArm(task, "context-on", options(agent));
    const armTree = agent.seen[0]?.cwd;
    expect(armTree).toBeDefined();
    expect(existsSync(armTree ?? "")).toBe(false);
  });

  test("the tree is removed even when the agent throws", async () => {
    const { task, options } = await setup();
    const agent = createFakeAgent({ harnessId: "fake", throwAfterMs: 1 });
    await expect(runArenaArm(task, "context-on", options(agent))).rejects.toThrow();
    expect(existsSync(agent.seen[0]?.cwd ?? "")).toBe(false);
  });

  test("a scored research arm carries recall, not an implement score", async () => {
    const { task, options } = await setup();
    const agent = createFakeAgent({ harnessId: "fake", answer: "src/pipelines/iterator-dnd.ts" });
    const result = await runArenaArm(task, "context-on", options(agent));
    expect(result.score.kind).toBe("research");
    if (result.score.kind !== "research") throw new Error("unreachable");
    expect(result.score.retrieval.recall).toBe(1);
  });

  test("an agent that throws propagates, so a crashed arm is never scored", async () => {
    // A crash and an honest zero look identical in a results file, and scoring the
    // crash would credit whichever arm failed less often.
    const { task, options } = await setup();
    const agent = createFakeAgent({ harnessId: "fake", throwAfterMs: 1 });
    await expect(runArenaArm(task, "context-on", options(agent))).rejects.toThrow(/told to die/);
  });

  test("wall clock is recorded as a diagnostic", async () => {
    const { task, options } = await setup();
    const agent = createFakeAgent({ harnessId: "fake", runsForMs: 30 });
    const result = await runArenaArm(task, "context-on", options(agent));
    expect(result.wallClockMs).toBeGreaterThanOrEqual(25);
  });
});

describe("runArenaTask", () => {
  test("runs both arms and gives them the SAME prompt, byte for byte", async () => {
    // The one thing a two-arm comparison must never vary.
    const { task, options } = await setup();
    const agent = createFakeAgent({ harnessId: "fake", answer: "src/pipelines/iterator-dnd.ts" });
    const results = await runArenaTask(task, options(agent));
    expect(results).toHaveLength(2);
    expect(agent.seen).toHaveLength(2);
    expect(agent.seen[0]?.prompt).toBe(agent.seen[1]?.prompt ?? "");
  });

  test("the two arms run in different trees", async () => {
    const { task, options } = await setup();
    const agent = createFakeAgent({ harnessId: "fake" });
    await runArenaTask(task, options(agent));
    expect(agent.seen[0]?.cwd).not.toBe(agent.seen[1]?.cwd);
  });

  test("the arms are both present and the recorded order matches the one actually used", async () => {
    const { task, options } = await setup();
    const agent = createFakeAgent({ harnessId: "fake" });
    const results = await runArenaTask(task, options(agent));
    const arms = results.map((result) => result.arm);
    expect(new Set(arms).size).toBe(2);
    expect(arms[0]).toBe(firstArmFor("fake", task.id));
    for (const result of results) expect(result.armOrder).toBe(firstArmFor("fake", task.id));
  });
});

describe("firstArmFor", () => {
  test("is deterministic, so a resumed cell is the same cell", () => {
    expect(firstArmFor("keryx-shell", "t1-abc")).toBe(firstArmFor("keryx-shell", "t1-abc"));
  });

  test("does not put the same arm first for every task", () => {
    // The defect it replaces: the pilot runs context-on first for every task in
    // every leg, so the control arm is systematically second behind model
    // rollouts, throttling, a warmed page cache and prompt-cache hits.
    const arms = new Set(
      Array.from({ length: 40 }, (_unused, index) => firstArmFor("keryx-shell", `t1-task${index}`)),
    );
    expect(arms.size).toBe(2);
  });

  test("differs between harnesses for the same task, so order is not a property of the task", () => {
    const perHarness = new Set(
      ["keryx-shell", "grok-build", "claude-sonnet", "claude-opus"].map((harness) => firstArmFor(harness, "t1-fixed")),
    );
    expect(perHarness.size).toBe(2);
  });
});

describe("leakage by content", () => {
  test("a needle planted in the provisioned workspace refuses the arm", async () => {
    // A commit being unreachable says nothing about whether provisioning wrote the
    // answer into the workspace as prose — which is exactly what an authored wiki
    // would do, and why the check is by content as well as by reachability.
    const { task, options } = await setup();
    const agent = createFakeAgent({ harnessId: "fake" });
    const withNeedle: ArenaTask = { ...task, answerNeedles: ["the clamp runs before the escape test"] };
    await expect(
      runArenaArm(withNeedle, "context-on", {
        ...options(agent),
        provisioner: {
          async provision(treePath) {
            await mkdir(path.join(treePath, ".metaproject", "wiki"), { recursive: true });
            writeFileSync(
              path.join(treePath, ".metaproject", "wiki", "leak.md"),
              "the clamp runs before the escape test\n",
              "utf8",
            );
            return { provisionCommit: task.base };
          },
          async release() {},
        },
        checkLeakage(treePath, needles) {
          const page = path.join(treePath, ".metaproject", "wiki", "leak.md");
          if (!existsSync(page)) return;
          const contents = readFileSync(page, "utf8");
          for (const needle of needles) {
            if (contents.includes(needle)) throw new Error(`wiki leak: ${needle}`);
          }
        },
      }),
    ).rejects.toThrow(/wiki leak/);
  });
});
