// An isolated tree at the parent commit, with the answer genuinely out of reach.
//
// The harness used `git worktree add --detach <parent>`, which looks isolated
// and is not. A worktree shares the object database and every ref of the
// repository it came from, so from a tree checked out at the parent:
//
//     git show <the commit being asked about>     -> the full diff. The answer.
//     git log --all --grep "<words from the prompt>"  -> finds it, because the
//                                                        prompt IS the subject.
//
// Verified, not theorised. Both arms could do it, so it would not have biased
// the comparison — it would have destroyed it, by letting either arm score 100%
// through a channel that has nothing to do with project context.
//
// A shallow standalone fetch of the parent has none of that: fetching a commit
// brings its ancestors, never its descendants. History stays deep enough to be
// realistic, and the commit under test is simply not in the object store.
//
// The remote is removed afterwards. Leaving it would leave `git fetch origin
// main` as a one-command route to the same answer.

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

/** Ancestors kept. Deep enough for history to be usable, and descendants never come. */
export const DEFAULT_DEPTH = 50;

export interface CheckoutRequest {
  readonly repoRoot: string;
  readonly path: string;
  /** The parent commit. Never the commit under test. */
  readonly ref: string;
  readonly depth?: number;
}

/**
 * Git LFS pointers are checked out as pointers, not as content.
 *
 * The target repository keeps screenshot baselines in LFS. A checkout in this
 * isolated tree runs the smudge filter, which tries to download those objects from
 * a remote the tree is about to drop — and the local clone does not hold the objects
 * for older commits, so the checkout fails with "remote missing object" and takes
 * the whole arm with it. Found on a dry run: the task whose base happened to be the
 * clone's own HEAD worked, and an older base did not.
 *
 * Skipping the smudge is correct rather than merely expedient. An arm reads
 * TypeScript; no task asks about a PNG, and no gate runs a screenshot test. What the
 * tree gets is a pointer file where a binary would be, which is a faithful
 * representation of a file whose content the measurement does not use.
 */
const GIT_LFS_SKIP_SMUDGE = "1";

function run(cwd: string, args: readonly string[]): { code: number; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE },
  });
  return { code: proc.exitCode, stderr: proc.stderr.toString() };
}

/**
 * Build a standalone shallow checkout at `ref`.
 *
 * Not a worktree and not a clone of the whole repository: `git init` plus a
 * depth-limited fetch of one commit, then the remote is dropped.
 */
export async function createIsolatedCheckout(request: CheckoutRequest): Promise<void> {
  const depth = request.depth ?? DEFAULT_DEPTH;
  await rm(request.path, { recursive: true, force: true });
  await mkdir(request.path, { recursive: true });

  const steps: readonly (readonly string[])[] = [
    ["init", "-q"],
    ["remote", "add", "origin", request.repoRoot],
    ["fetch", "-q", "--depth", String(depth), "origin", request.ref],
    ["checkout", "-q", "FETCH_HEAD"],
    // Without this, `git fetch origin main` reaches the answer in one command.
    ["remote", "remove", "origin"],
  ];

  for (const args of steps) {
    const result = run(request.path, args);
    if (result.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed in ${request.path}: ${result.stderr.trim()}`);
    }
  }
}

/** Whether a commit object exists in this tree's store — the leakage question. */
export function commitReachable(treePath: string, sha: string): boolean {
  if (!existsSync(path.join(treePath, ".git"))) return false;
  return run(treePath, ["cat-file", "-e", `${sha}^{commit}`]).code === 0;
}

/**
 * Refuse a tree that can still see the answer.
 *
 * The check the harness had asserted that the gold FILES were absent, which is
 * backwards twice over. Their presence is not leakage — they are the search
 * space, and the task is to say which of them changed. It rejected 51 of 60
 * vantage-frontend tasks on that basis, which would have left a sample made
 * only of pull requests that add brand-new files: a different task, quietly
 * substituted for the intended one.
 *
 * Meanwhile the leak that was real — the whole of git history, including the
 * commit under test — it did not look at.
 */
export function assertAnswerUnreachable(treePath: string, sha: string): void {
  if (commitReachable(treePath, sha)) {
    throw new Error(
      `the commit under test (${sha.slice(0, 8)}) is reachable from ${treePath} — ` +
        `\`git show ${sha.slice(0, 8)}\` would hand the agent the answer, and ` +
        `\`git log --all --grep\` would find it from the prompt's own words`,
    );
  }
  const names = remotesOf(treePath);
  if (names.length > 0) {
    throw new Error(
      `${treePath} still has remote(s) ${names.join(", ")} — ` +
        `\`git fetch origin main\` reaches the answer in one command`,
    );
  }
}

/** Configured remote names. Empty for a correctly isolated tree. */
export function remotesOf(treePath: string): string[] {
  if (!existsSync(path.join(treePath, ".git"))) return [];
  const proc = Bun.spawnSync(["git", "remote"], { cwd: treePath });
  if (proc.exitCode !== 0) return [];
  return proc.stdout.toString().trim().split("\n").filter(Boolean);
}
