// Where a command is running: which checkout, which clone. Every `keryx worktree`
// command starts here, so "not a git repository" and "this is the main checkout"
// are decided once and worded once.

import { realpath } from "node:fs/promises";
import path from "node:path";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import { gitDirOf, runGit } from "./git";

export interface WorktreeContext {
  /** Absolute root of the checkout `cwd` is in (the working copy's top level). */
  root: string;
  /** Root of the clone's main checkout: where `.env` files and dependencies are copied from. */
  mainRoot: string;
  /** The shared git directory of the clone. */
  commonDir: string;
  /** This checkout's own git directory: `<common>/worktrees/<name>` for a linked worktree. */
  gitDir: string;
  /** True when `root` is the main checkout. */
  isMain: boolean;
}

async function canonical(target: string): Promise<string> {
  return realpath(target).catch(() => target);
}

/** The checkout and clone `cwd` belongs to. Throws a clear error outside a git repository. */
export async function resolveWorktreeContext(cwd: string): Promise<WorktreeContext> {
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
  const topLevel = top?.code === 0 ? top.stdout.trim() : "";
  if (topLevel.length === 0) {
    throw new Error(`not a git repository: ${cwd}`);
  }
  const [commonDir, gitDir, root] = await Promise.all([resolveGitCommonDir(cwd), gitDirOf(cwd), canonical(topLevel)]);
  if (commonDir === undefined) {
    throw new Error(`not a git repository: ${cwd}`);
  }
  return {
    root,
    mainRoot: path.dirname(commonDir),
    commonDir,
    gitDir,
    isMain: (await canonical(gitDir)) === (await canonical(commonDir)),
  };
}
