import { realpath } from "node:fs/promises";
import path from "node:path";

// Clone scope: the two git lookups that tell which CLONE a directory belongs to.
//
// Extracted from `src/flow/allocation.ts` (agent bus P1, specification §2.1)
// with no behaviour change, so flow-id allocation and the agent bus agree on
// what "one clone" means. Each caller keeps its own key and its own non-git
// fallback: allocation keys on the raw cwd, the bus on the resolved project
// root.

// `git rev-parse --git-common-dir` is the one path shared by all worktrees of a
// clone. Absent git (or a non-repository directory) callers keep their own
// fallback behaviour.
export async function gitCommonDir(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--git-common-dir"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0 || output.length === 0) {
      return null;
    }
    return path.isAbsolute(output) ? output : path.resolve(cwd, output);
  } catch {
    return null; // git not installed / not executable
  }
}

export async function gitToplevel(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

/**
 * `target` with symlinks resolved, or `path.resolve(target)` when it cannot be
 * resolved (it does not exist, or is unreadable).
 *
 * Git prints real paths (`/private/var/...` on macOS) while a caller's cwd may
 * go through a symlink (`/var/...`). Comparing or joining the two raw gives a
 * different answer per worktree, so the bus canonicalises both sides first.
 * Allocation does not use this: its behaviour is unchanged by the extraction.
 */
export async function canonicalPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}
