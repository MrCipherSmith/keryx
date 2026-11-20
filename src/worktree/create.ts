// `keryx worktree create` (spec §6): `git worktree add` on a new branch, then
// `prepare`. When prepare fails the worktree is kept and the failure reported:
// the owner can fix the cause and run `keryx worktree prepare` again.

import { realpath } from "node:fs/promises";
import path from "node:path";
import { assertGitRevision } from "../lib/git-revision";
import { resolveWorktreeContext } from "./context";
import { runGit } from "./git";
import { prepareWorktree, type PrepareOptions, type PrepareReport } from "./prepare";

export const DEFAULT_BASE = "origin/main";

export interface CreateOptions extends Omit<PrepareOptions, "cwd"> {
  cwd: string;
  name: string;
  /** Start point of the new branch; default `origin/main`. */
  base?: string;
  /** Branch to create; default is `name`. */
  branch?: string;
  /** Where to put the worktree; default `<main-root>/.claude/worktrees/<name>`. */
  path?: string;
  /** Check out the already existing local `branch` instead of creating it from `base` (`base` is then ignored). */
  existingBranch?: boolean;
}

export interface CreateResult {
  path: string;
  branch: string;
  base: string;
  /** Present when the worktree was created; `prepare.ok === false` means it was kept but not fully prepared. */
  prepare: PrepareReport;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateName(name: string): void {
  if (!NAME.test(name) || name.includes("..")) {
    throw new Error(`invalid worktree name "${name}": use letters, digits, '.', '_' and '-', starting with a letter or digit`);
  }
}

async function validateBranch(cwd: string, branch: string): Promise<void> {
  assertGitRevision(branch);
  const check = await runGit(cwd, ["check-ref-format", "--branch", branch]);
  if (check.code !== 0) {
    throw new Error(`invalid branch name "${branch}"`);
  }
}

/** Create the worktree and prepare it. Throws only before the worktree exists; a prepare failure is in `result.prepare`. */
export async function createWorktree(opts: CreateOptions): Promise<CreateResult> {
  validateName(opts.name);
  const context = await resolveWorktreeContext(opts.cwd);
  const branch = opts.branch ?? opts.name;
  const base = assertGitRevision(opts.existingBranch === true ? branch : (opts.base ?? DEFAULT_BASE));
  await validateBranch(context.root, branch);

  const target = path.resolve(opts.path ?? path.join(context.mainRoot, ".claude", "worktrees", opts.name));
  const resolved = await runGit(context.root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    opts.existingBranch === true ? `refs/heads/${branch}` : `${base}^{commit}`,
  ]);
  if (resolved.code !== 0) {
    throw new Error(opts.existingBranch === true ? `branch not found: ${branch}` : `base ref not found: ${base} (pass --base <ref>)`);
  }

  const added = await runGit(
    context.root,
    opts.existingBranch === true
      ? ["worktree", "add", "--quiet", "--", target, branch]
      : ["worktree", "add", "--no-track", "-b", branch, "--", target, base],
  );
  if (added.code !== 0) {
    throw new Error(`git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`);
  }
  const created = await realpath(target).catch(() => target);

  const prepare = await prepareWorktree({
    cwd: created,
    ...(opts.only !== undefined && { only: opts.only }),
    ...(opts.force !== undefined && { force: opts.force }),
    ...(opts.runInstall !== undefined && { runInstall: opts.runInstall }),
    ...(opts.isPortFree !== undefined && { isPortFree: opts.isPortFree }),
    ...(opts.now !== undefined && { now: opts.now }),
  }).catch(
    (cause): PrepareReport => ({
      worktree: created,
      checkoutId: "",
      at: (opts.now?.() ?? new Date()).toISOString(),
      steps: [],
      errors: [cause instanceof Error ? cause.message : String(cause)],
      ok: false,
    }),
  );
  return { path: created, branch, base, prepare };
}
