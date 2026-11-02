// Repository control paths a contained command must not be able to write.
//
// `workspace-write` makes the whole cwd writable, `.git` included. A hook in
// `.git/hooks/` or a `core.fsmonitor` / `core.hooksPath` line in `.git/config` is
// code the HOST runs on its next git command, outside any sandbox — so one
// contained write would become uncontained execution. Both launchers therefore
// re-protect these paths read-only after the writable-root rules.
//
// Only the execution-bearing paths are protected, not all of `.git`: a contained
// `git add` / `git commit` still needs the index, objects and refs.
//
// Covers a normal checkout (`.git` is a directory) and a linked worktree or
// submodule (`.git` is a FILE `gitdir: <path>`): the file itself is protected so
// it cannot be repointed, and when the gitdir it names lives inside a writable
// root the hooks/config there are protected too (the common dir via `commondir`).
// A gitdir outside every writable root is already read-only.
//
// Impure by design (reads the host filesystem), so it sits in its own module and
// the launcher builders take the result as an injectable parameter.

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Entries of a git dir that make the host execute attacker-chosen code. */
const GIT_CONTROL_ENTRIES = ["hooks", "config", "config.worktree"] as const;

export interface GitProtectFs {
  kind(p: string): "dir" | "file" | "missing";
  readText(p: string): string | undefined;
  real(p: string): string;
}

const realFs: GitProtectFs = {
  kind(p) {
    try {
      return statSync(p).isDirectory() ? "dir" : "file";
    } catch {
      return "missing";
    }
  },
  readText(p) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  },
  real(p) {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  },
};

function within(root: string, p: string): boolean {
  return p === root || p.startsWith(`${root}${path.sep}`);
}

/**
 * Existing paths under `writableRoots` that must be read-only. Sorted, deduped,
 * deterministic for a given filesystem.
 */
export function resolveGitProtectedPaths(
  writableRoots: readonly string[],
  fs: GitProtectFs = realFs,
): string[] {
  const out = new Set<string>();
  const roots = writableRoots.map((r) => fs.real(r));

  const protectGitDir = (gitDir: string): void => {
    for (const entry of GIT_CONTROL_ENTRIES) {
      const p = path.join(gitDir, entry);
      if (fs.kind(p) !== "missing") out.add(fs.real(p));
    }
  };

  for (const root of roots) {
    const dotGit = path.join(root, ".git");
    const kind = fs.kind(dotGit);
    if (kind === "dir") {
      protectGitDir(fs.real(dotGit));
    } else if (kind === "file") {
      out.add(dotGit);
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readText(dotGit) ?? "");
      if (match?.[1] === undefined) continue;
      const gitDir = fs.real(path.resolve(root, match[1]));
      if (!roots.some((r) => within(r, gitDir))) continue;
      protectGitDir(gitDir);
      const common = fs.readText(path.join(gitDir, "commondir"))?.trim();
      if (common) {
        const commonDir = fs.real(path.resolve(gitDir, common));
        if (roots.some((r) => within(r, commonDir))) protectGitDir(commonDir);
      }
    }
  }
  return [...out].sort();
}

/**
 * The git dirs that hold the protected paths. Seatbelt needs these denied by
 * name: renaming `.git` away and creating a fresh one would otherwise sidestep a
 * deny on `.git/hooks`. (A `.git` gitdir FILE is protected itself, so it has no
 * anchor.)
 */
export function gitProtectAnchors(protectedPaths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of protectedPaths) {
    if (path.basename(p) !== ".git") out.add(path.dirname(p));
  }
  return [...out].sort();
}
