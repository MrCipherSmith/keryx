// Real git-backed WorktreePort (flow 096 documented this seam but shipped only a
// test fake — see worktree.ts line 103: "a thin real adapter (`git worktree
// add/remove` + merge) drives it at runtime"). This is that adapter.
//
// Used first by the M1 ablation runner (docs/requirements/keryx-benchmark-suite/plan.md):
// context-on and context-off each get their own isolated worktree so neither run can
// see the other's filesystem state, while both share the same base commit.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CreatedWorktree, WorktreeMergeResult, WorktreePort } from "./worktree";

const execFileAsync = promisify(execFile);

export interface GitWorktreePortOptions {
  /** The repository root `git worktree` runs from (its main working tree). */
  readonly repoRoot: string;
  /** Directory new worktrees are created under; `worktreeId` is appended as the dirname. */
  readonly worktreesDir: string;
  /** Commit-ish to check out into each new worktree. Defaults to `HEAD`. */
  readonly ref?: string;
}

/**
 * A real `WorktreePort`: `create` runs `git worktree add --detach <path> <ref>` (no
 * new branch — this is throwaway isolation, not a mutation to merge back);
 * `remove` runs `git worktree remove --force <path>` then prunes stale metadata.
 *
 * `merge` is UNUSED by the ablation runner (its tasks are read-only investigations,
 * nothing is ever written in a worktree to merge back) but is implemented for
 * interface completeness: it reports `ok: true` with no git operation when the
 * worktree has no uncommitted changes, and `ok: false` otherwise — never silently
 * discards or force-merges real changes it wasn't asked to.
 */
export function createGitWorktreePort(options: GitWorktreePortOptions): WorktreePort {
  const { repoRoot, worktreesDir } = options;
  const ref = options.ref ?? "HEAD";
  const paths = new Map<string, string>();

  return {
    async create(worktreeId: string): Promise<CreatedWorktree> {
      const path = `${worktreesDir}/${worktreeId}`;
      await execFileAsync("git", ["worktree", "add", "--detach", path, ref], { cwd: repoRoot });
      paths.set(worktreeId, path);
      return { worktreeId, path };
    },

    async remove(worktreeId: string): Promise<void> {
      const path = paths.get(worktreeId);
      if (path === undefined) return; // never created (or already removed) — nothing to do
      await execFileAsync("git", ["worktree", "remove", "--force", path], { cwd: repoRoot });
      paths.delete(worktreeId);
      // Best-effort: clear any stale administrative metadata git worktree remove
      // sometimes leaves behind. Never fails the removal on prune's own failure.
      await execFileAsync("git", ["worktree", "prune"], { cwd: repoRoot }).catch(() => undefined);
    },

    async merge(worktreeId: string, into: string): Promise<WorktreeMergeResult> {
      const path = paths.get(worktreeId);
      if (path === undefined) {
        return { worktreeId, ok: false, conflicts: [`worktree "${worktreeId}" was not created by this port`] };
      }
      const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: path });
      if (status.stdout.trim().length === 0) {
        return { worktreeId, ok: true }; // nothing to merge — a read-only worktree's expected state
      }
      return {
        worktreeId,
        ok: false,
        conflicts: [`worktree "${worktreeId}" has uncommitted changes; merge into "${into}" was not attempted`],
      };
    },
  };
}
