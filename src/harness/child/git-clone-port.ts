// A real, FULLY INDEPENDENT `WorktreePort` backed by `git clone`, not `git worktree
// add`. Exists specifically because a linked worktree (git-worktree-port.ts) shares
// its `.git` with the main checkout — a plain file pointing back into the main
// repo's `.git/worktrees/<name>` metadata — and at least one third-party CLI agent
// (opencode, confirmed live 2026-08-14; see docs/requirements/keryx-benchmark-suite/
// plan.md's mutating-ablation section) resolves "project root" by walking up to the
// nearest `.git` and does not stop at that pointer, ending up operating on the MAIN
// checkout's real files while the agent process's own reported `cwd` stayed exactly
// the isolated worktree the whole time — a genuine, reproducible container escape for
// that one tool, confirmed and reverted, not hypothetical. A real independent clone
// has its own full `.git` directory with no pointer to walk past, closing that
// specific escape route structurally rather than trusting a given CLI's own cwd
// handling.
//
// `git clone <repoRoot> <path>` on the same filesystem hardlinks the (read-only,
// content-addressed) object store — this is NOT a full copy in disk-cost terms, only
// in "does it have its own .git identity" terms, which is exactly what closes the
// escape route.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CreatedWorktree, WorktreeMergeResult, WorktreePort } from "./worktree";

const execFileAsync = promisify(execFile);

export interface GitClonePortOptions {
  /** The repository to clone from. */
  readonly repoRoot: string;
  /** Directory new clones are created under; `worktreeId` is appended as the dirname. */
  readonly worktreesDir: string;
}

/**
 * A `WorktreePort` backed by `git clone` instead of `git worktree add` — see the
 * module doc for why. `create` clones `repoRoot`'s current `HEAD` into a fresh
 * directory (an independent repo, own `.git`); `remove` is a plain `rm -rf` (nothing
 * to `git worktree remove`/`prune` — this was never registered as a worktree of the
 * main repo).
 */
export function createGitClonePort(options: GitClonePortOptions): WorktreePort {
  const { repoRoot, worktreesDir } = options;
  const paths = new Map<string, string>();

  return {
    async create(worktreeId: string): Promise<CreatedWorktree> {
      const path = `${worktreesDir}/${worktreeId}`;
      await execFileAsync("git", ["clone", "--quiet", "--no-tags", repoRoot, path]);
      paths.set(worktreeId, path);
      return { worktreeId, path };
    },

    async remove(worktreeId: string): Promise<void> {
      const path = paths.get(worktreeId);
      if (path === undefined) return; // never created (or already removed) — nothing to do
      await execFileAsync("rm", ["-rf", path]);
      paths.delete(worktreeId);
    },

    async merge(worktreeId: string, into: string): Promise<WorktreeMergeResult> {
      const path = paths.get(worktreeId);
      if (path === undefined) {
        return { worktreeId, ok: false, conflicts: [`clone "${worktreeId}" was not created by this port`] };
      }
      const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: path });
      if (status.stdout.trim().length === 0) {
        return { worktreeId, ok: true }; // nothing to merge — a read-only clone's expected state
      }
      return {
        worktreeId,
        ok: false,
        conflicts: [`clone "${worktreeId}" has uncommitted changes; merge into "${into}" was not attempted`],
      };
    },
  };
}
