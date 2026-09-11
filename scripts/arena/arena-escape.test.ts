// The arena's isolation hole, 2026-09-11: an arm's checkout kept `.git/FETCH_HEAD`,
// which names the source clone by absolute path. The grok CLI read it, ran
// `git -C <source> show <answer sha>`, and scored 4/4 on an answer it took from
// outside its tree. Two guards now: the tree carries no pointer (checked before the
// agent runs), and a transcript that names the source clone is not scored.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertNoSourcePointer, sourcePointersIn } from "../benchmark/retrieval-checkout";
import type { AgentPort } from "../benchmark/retrieval-run";
import { createBaseTreeCache } from "./arena-checkout";
import { arenaFixtureRepo } from "./arena-fake-agent";
import { runArenaArm, transcriptNamingSource } from "./arena-run";
import type { ArenaTask } from "./arena-tasks";

async function setup() {
  const fixture = await arenaFixtureRepo();
  const workspace = mkdtempSync(path.join(tmpdir(), "arena-escape-"));
  const task: ArenaTask = {
    id: `t1-${fixture.task.id}`,
    type: "research",
    base: fixture.task.parent,
    answerSha: fixture.task.sha,
    query: fixture.task.query,
    gold: fixture.task.gold,
    answerNeedles: [],
  };
  const cache = createBaseTreeCache({ repoRoot: fixture.root, cacheDir: path.join(workspace, "cache"), depth: 5 });
  return { fixture, workspace, task, cache };
}

/** An agent that writes the transcript it is given, with whatever text the test chooses. */
function scriptedAgent(transcript: (root: string) => string, root: string): AgentPort {
  return {
    harness: "scripted",
    async run({ transcriptFile }) {
      if (transcriptFile !== undefined) {
        mkdirSync(path.dirname(transcriptFile), { recursive: true });
        writeFileSync(transcriptFile, transcript(root));
      }
      return { text: "src/pipelines/iterator-dnd.ts", toolCalls: 1, contextTokens: 1, costUsd: null, stepsToFirstGold: null };
    },
  };
}

describe("the arm's tree carries no pointer to the source clone", () => {
  test("a materialized tree has no FETCH_HEAD and nothing under .git names the source", async () => {
    const { fixture, workspace, task, cache } = await setup();
    const arm = path.join(workspace, "arm");
    await cache.materialize(task.base, arm);
    expect(existsSync(path.join(arm, ".git", "FETCH_HEAD"))).toBe(false);
    expect(sourcePointersIn(arm, fixture.root)).toEqual([]);
    expect(() => assertNoSourcePointer(arm, fixture.root)).not.toThrow();
  });

  test("a pointer planted back is found, and refused", async () => {
    const { fixture, workspace, task, cache } = await setup();
    const arm = path.join(workspace, "arm");
    await cache.materialize(task.base, arm);
    writeFileSync(path.join(arm, ".git", "FETCH_HEAD"), `${task.base}\t\t'${task.base}' of ${fixture.root}\n`);
    expect(sourcePointersIn(arm, fixture.root)).toEqual([path.join(".git", "FETCH_HEAD")]);
    expect(() => assertNoSourcePointer(arm, fixture.root)).toThrow(/names the source clone/);
  });
});

describe("an arm whose transcript names the source clone is not scored", () => {
  test("the arm fails with the reason, instead of recording a result", async () => {
    const { fixture, workspace, task, cache } = await setup();
    const agent = scriptedAgent((root) => `{"type":"tool_call","input":"git -C ${root} show ${task.answerSha}"}\n`, fixture.root);
    await expect(
      runArenaArm(task, "context-off", {
        repoRoot: fixture.root,
        worktreesDir: path.join(workspace, "arms"),
        agent,
        model: "grok-4.6",
        cache,
        transcriptsDir: path.join(workspace, "transcripts"),
      }),
    ).rejects.toThrow(/reached the source clone .* its answer cannot be scored/);
  });

  test("an arm that stayed inside its tree is scored as before", async () => {
    const { fixture, workspace, task, cache } = await setup();
    const agent = scriptedAgent(() => `{"type":"tool_call","input":"rg iterator src"}\n`, fixture.root);
    const result = await runArenaArm(task, "context-off", {
      repoRoot: fixture.root,
      worktreesDir: path.join(workspace, "arms"),
      agent,
      model: "grok-4.6",
      cache,
      transcriptsDir: path.join(workspace, "transcripts"),
    });
    expect(result.arm).toBe("context-off");
  });

  test("stderr counts too, and a transcript that was never written names nothing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "arena-escape-t-"));
    const file = path.join(dir, "arm.jsonl");
    writeFileSync(file, "{}\n");
    writeFileSync(`${file}.stderr`, "fatal: not a git repository: /src/clone/.git\n");
    expect(transcriptNamingSource(file, "/src/clone")).toBe(`${file}.stderr`);
    expect(transcriptNamingSource(path.join(dir, "missing.jsonl"), "/src/clone")).toBeUndefined();
    expect(transcriptNamingSource(undefined, "/src/clone")).toBeUndefined();
  });
});
