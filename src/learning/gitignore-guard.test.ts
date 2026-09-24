// AC10 (W3-AC9) guard: `git check-ignore` matches the two per-machine W3
// learning paths after `keryx init`'s managed ignore block is applied
// (`syncMetaprojectGitignore`, the same function `commands/init.ts` calls),
// and this worktree's own root `.gitignore` carries the same coverage.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncMetaprojectGitignore } from "../lib/metaproject-gitignore";

const OBSERVATION_PATH = ".metaproject/data/learning/observations/2026-09-24.jsonl";
const CANDIDATE_PATH = ".metaproject/data/learning/candidates/workflow.x-12345678.json";

function gitCheckIgnoreExitCode(cwd: string, target: string): number | null {
  const result = Bun.spawnSync(["git", "check-ignore", "-q", "--", target], { cwd, stdout: "ignore", stderr: "ignore" });
  return result.exitCode;
}

test("keryx init's managed ignore block ignores the W3 observation/candidate paths (AC10)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-learning-gitignore-"));
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });

    await syncMetaprojectGitignore(root);

    expect(gitCheckIgnoreExitCode(root, OBSERVATION_PATH)).toBe(0);
    expect(gitCheckIgnoreExitCode(root, CANDIDATE_PATH)).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("this worktree's own root .gitignore ignores the same two paths", () => {
  const worktreeRoot = path.resolve(import.meta.dir, "..", "..");
  expect(gitCheckIgnoreExitCode(worktreeRoot, OBSERVATION_PATH)).toBe(0);
  expect(gitCheckIgnoreExitCode(worktreeRoot, CANDIDATE_PATH)).toBe(0);
});
