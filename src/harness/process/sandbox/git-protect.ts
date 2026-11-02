// Repository control paths a contained command must not be able to write.
//
// `workspace-write` makes the whole cwd writable, `.git` included. A hook in
// `.git/hooks/`, a `core.fsmonitor` / `core.hooksPath` line in `.git/config`, or a
// `.git/commondir` that points git at a config somewhere else is code the HOST
// runs on its next git command, outside any sandbox — so one contained write
// would become uncontained execution. Both launchers therefore re-protect these
// paths read-only after the writable-root rules.
//
// The set is every place git reads repository config or hooks from, WHETHER OR
// NOT IT EXISTS YET: creating `.git/hooks/post-checkout` in a repo that has no
// hooks dir, or a `.git/commondir` in an ordinary checkout, is as good as editing
// an existing one. `info/` is deliberately absent: `info/attributes` can only
// name a filter or diff driver, and the driver's command comes from config — a
// working-tree `.gitattributes` (always writable) can name the same drivers.
//
// Only the execution-bearing paths are protected, not all of `.git`: a contained
// `git add` / `git commit` still needs the index, objects, refs and the lock
// files git creates beside them.
//
// Covers a normal checkout (`.git` is a directory), its linked worktrees
// (`.git/worktrees/<name>`), and a linked worktree or submodule root (`.git` is a
// FILE `gitdir: <path>`): the file itself is protected so it cannot be repointed,
// and when the gitdir it names lives inside a writable root its control paths
// are protected too, then those of the common dir it names via `commondir`. A
// gitdir outside every writable root is already read-only.
//
// Anchors: each protected git dir, and every directory between it and the
// writable root, must also stay where it is — renaming `.git` (or a parent of a
// worktree's gitdir) away and creating a fresh one would otherwise sidestep every
// rule on the old path.
//
// Impure by design (reads the host filesystem), so it sits in its own module and
// the launcher builders take the result as an injectable parameter.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Read by git from a repository's common dir: hooks and config. */
const COMMON_DIR_ENTRIES = ["hooks", "config", "config.worktree", "commondir"] as const;
/** Read by git from a linked worktree's own gitdir (config and hooks come from the common dir). */
const WORKTREE_GITDIR_ENTRIES = ["config.worktree", "commondir"] as const;

/** Which control path this is: a git-dir entry, or a root's `.git` gitdir FILE. */
export type GitControlEntry = (typeof COMMON_DIR_ENTRIES)[number] | ".git";

export interface GitControlPath {
  /** The path as git names it, e.g. `<gitdir>/hooks`. */
  path: string;
  /** Where it resolves to; differs from `path` only when the entry is a symlink. */
  real: string;
  entry: GitControlEntry;
  /** On the host at plan time. A `missing` path must still not be creatable. */
  kind: "dir" | "file" | "missing";
}

export interface GitProtection {
  /** Read-only, existing or not. Sorted by path. */
  controls: GitControlPath[];
  /** Directories that must not be renamed or removed. Sorted, so a parent comes before its children. */
  anchors: string[];
}

export interface GitProtectFs {
  kind(p: string): "dir" | "file" | "missing";
  readText(p: string): string | undefined;
  real(p: string): string;
  /** Names of the entries of a directory; empty when it cannot be read. */
  list(p: string): string[];
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
  list(p) {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
};

function within(root: string, p: string): boolean {
  return p === root || p.startsWith(`${root}${path.sep}`);
}

/** Every git control path and anchor inside `writableRoots`. Deterministic for a given filesystem. */
export function resolveGitProtection(writableRoots: readonly string[], fs: GitProtectFs = realFs): GitProtection {
  const controls = new Map<string, GitControlPath>();
  const anchors = new Set<string>();
  const seen = new Set<string>();
  const roots = writableRoots.map((r) => fs.real(r));
  // The OUTERMOST writable root holding `p`: with nested roots, a directory
  // between the inner and the outer root can still be renamed.
  const rootOf = (p: string): string | undefined =>
    roots.filter((r) => within(r, p)).sort((a, b) => a.length - b.length)[0];

  const addControl = (p: string, entry: GitControlEntry): void => {
    controls.set(p, { path: p, real: fs.real(p), entry, kind: fs.kind(p) });
  };

  const anchor = (dir: string): void => {
    const top = rootOf(dir);
    if (top === undefined) return;
    for (let p = dir; p !== top && within(top, p); p = path.dirname(p)) anchors.add(p);
  };

  const protectGitDir = (gitDir: string, entries: readonly GitControlEntry[]): void => {
    if (seen.has(gitDir) || rootOf(gitDir) === undefined) return;
    seen.add(gitDir);
    anchor(gitDir);
    for (const entry of entries) addControl(path.join(gitDir, entry), entry);
    // A common dir's linked worktrees take their commondir/config.worktree from here.
    const worktrees = path.join(gitDir, "worktrees");
    if (fs.kind(worktrees) === "dir") {
      for (const name of [...fs.list(worktrees)].sort()) {
        const wt = path.join(worktrees, name);
        if (fs.kind(wt) === "dir") protectGitDir(wt, WORKTREE_GITDIR_ENTRIES);
      }
    }
    const common = fs.readText(path.join(gitDir, "commondir"))?.trim();
    if (common) protectGitDir(fs.real(path.resolve(gitDir, common)), COMMON_DIR_ENTRIES);
  };

  for (const root of roots) {
    const dotGit = path.join(root, ".git");
    const kind = fs.kind(dotGit);
    if (kind === "dir") {
      anchor(dotGit); // the name itself, even when it is a symlink to the real git dir
      protectGitDir(fs.real(dotGit), COMMON_DIR_ENTRIES);
    } else if (kind === "file") {
      addControl(dotGit, ".git");
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readText(dotGit) ?? "");
      if (match?.[1] === undefined) continue;
      const gitDir = fs.real(path.resolve(root, match[1]));
      // A linked worktree's gitdir has a commondir; a submodule's gitdir is a full repository.
      const isLinked = fs.kind(path.join(gitDir, "commondir")) === "file";
      protectGitDir(gitDir, isLinked ? WORKTREE_GITDIR_ENTRIES : COMMON_DIR_ENTRIES);
    }
  }
  return {
    controls: [...controls.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    anchors: [...anchors].sort(),
  };
}
