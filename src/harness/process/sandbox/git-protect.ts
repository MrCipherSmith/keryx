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
// (`.git/worktrees/<name>`), its submodules (`.git/modules/**`, nested ones
// included, and each submodule's `<path>/.git` gitlink file), and a linked
// worktree or submodule root (`.git` is a FILE `gitdir: <path>`): the file itself
// is protected so it cannot be repointed, and when the gitdir it names lives
// inside a writable root its control paths are protected too, then those of the
// common dir it names via `commondir`. A gitdir outside every writable root is
// already read-only.
//
// Anchors: each protected git dir, and every directory between it and the
// writable root, must also stay where it is — renaming `.git` (or a parent of a
// worktree's gitdir) away and creating a fresh one would otherwise sidestep every
// rule on the old path. An anchor is always a REAL directory inside a writable
// root: bwrap turns it into a read-write self-bind, and a bind follows symlinks,
// so anchoring a link name would make its target writable (review-logic-w3:F-001).
// A symlink on the way to a git dir is recorded in `links` instead.
//
// Sealed: a full repository's `modules/` and `worktrees/` (and the name
// directories between `modules/` and a submodule gitdir) get no NEW entries, so a
// submodule gitdir or linked worktree created during the run cannot carry its
// own config, hooks or commondir.
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
  /**
   * Real directories inside a writable root that must not be renamed or removed.
   * Never a symlink. Sorted, so a parent comes before its children.
   */
  anchors: string[];
  /**
   * Symlinks inside a writable root that lead to a git dir (`.git -> elsewhere`), or
   * to a directory on the way to one: the link itself must not be replaced. Only a
   * rule on the NAME can hold this (Seatbelt `literal`); a mount follows the link.
   */
  links?: string[];
  /**
   * Directories whose direct entries cannot be created, renamed or removed,
   * whether or not they exist yet: a full repository's `modules/` and `worktrees/`,
   * and the name directories under `modules/`. Needs a rule that matches a path
   * that does not exist (Seatbelt `regex`); a mount cannot.
   */
  sealed?: string[];
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

/** Deepest `modules/` name nesting walked; a submodule name rarely has more than a few segments. */
const MAX_MODULE_DEPTH = 16;

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/** `path = <p>` values of a `.gitmodules` file: where this working tree's submodules live. */
function gitmodulePaths(text: string | undefined): string[] {
  return [...(text ?? "").matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((m) => unquote(m[1] ?? "")).filter((p) => p.length > 0);
}

/** A submodule gitdir's `core.worktree`: where its working tree (and so its `.git` gitlink file) lives. */
function coreWorktree(config: string | undefined): string | undefined {
  const value = /^\s*worktree\s*=\s*(.+?)\s*$/m.exec(config ?? "")?.[1];
  return value === undefined ? undefined : unquote(value);
}

/** Every git control path, anchor, link and sealed dir inside `writableRoots`. Deterministic for a given filesystem. */
export function resolveGitProtection(writableRoots: readonly string[], fs: GitProtectFs = realFs): GitProtection {
  const controls = new Map<string, GitControlPath>();
  const anchors = new Set<string>();
  const links = new Set<string>();
  const sealed = new Set<string>();
  const seenGitDirs = new Set<string>();
  const seenTrees = new Set<string>();
  const roots = writableRoots.map((r) => fs.real(r));
  // The OUTERMOST writable root holding `p`: with nested roots, a directory
  // between the inner and the outer root can still be renamed.
  const rootOf = (p: string): string | undefined =>
    roots.filter((r) => within(r, p)).sort((a, b) => a.length - b.length)[0];

  const addControl = (p: string, entry: GitControlEntry): void => {
    controls.set(p, { path: p, real: fs.real(p), entry, kind: fs.kind(p) });
  };

  // Only a real, existing directory inside a root; its parents are then real too.
  const anchor = (dir: string): void => {
    const top = rootOf(dir);
    if (top === undefined || fs.kind(dir) !== "dir" || fs.real(dir) !== dir) return;
    for (let p = dir; p !== top && within(top, p); p = path.dirname(p)) anchors.add(p);
  };

  /** Follow `p` (named inside a real directory); a link name inside a root is recorded, never anchored. */
  const follow = (p: string): string => {
    const real = fs.real(p);
    if (real !== p && rootOf(p) !== undefined) links.add(p);
    return real;
  };

  const seal = (dir: string): void => {
    if (rootOf(dir) !== undefined) sealed.add(dir);
  };

  /** `gitDir` is a real path. A full repository (COMMON_DIR_ENTRIES) also brings its worktrees and submodules. */
  const protectGitDir = (gitDir: string, entries: readonly GitControlEntry[]): void => {
    if (seenGitDirs.has(gitDir) || rootOf(gitDir) === undefined) return;
    seenGitDirs.add(gitDir);
    anchor(gitDir);
    for (const entry of entries) addControl(path.join(gitDir, entry), entry);
    if (entries === COMMON_DIR_ENTRIES) {
      // Linked worktrees take their commondir/config.worktree from here.
      const worktrees = follow(path.join(gitDir, "worktrees"));
      seal(worktrees);
      if (fs.kind(worktrees) === "dir") {
        for (const name of [...fs.list(worktrees)].sort()) {
          const wt = follow(path.join(worktrees, name));
          if (fs.kind(wt) === "dir") protectGitDir(wt, WORKTREE_GITDIR_ENTRIES);
        }
      }
      walkModules(follow(path.join(gitDir, "modules")), 0);
    }
    const common = fs.readText(path.join(gitDir, "commondir"))?.trim();
    if (common) protectGitDir(fs.real(path.resolve(gitDir, common)), COMMON_DIR_ENTRIES);
  };

  // `modules/<name>` where a name may hold slashes: a directory with a HEAD is a
  // submodule gitdir, any other directory is one more name segment.
  const walkModules = (dir: string, depth: number): void => {
    if (depth > MAX_MODULE_DEPTH || rootOf(dir) === undefined) return;
    seal(dir);
    if (fs.kind(dir) !== "dir") return;
    for (const name of [...fs.list(dir)].sort()) {
      const sub = follow(path.join(dir, name));
      if (fs.kind(sub) !== "dir") continue;
      if (fs.kind(path.join(sub, "HEAD")) === "missing") {
        walkModules(sub, depth + 1);
        continue;
      }
      protectGitDir(sub, COMMON_DIR_ENTRIES);
      const worktree = coreWorktree(fs.readText(path.join(sub, "config")));
      if (worktree !== undefined) protectWorkingTree(fs.real(path.resolve(sub, worktree)), true);
    }
  };

  /**
   * A working tree's `.git`, real `tree`. For a submodule's working tree the `.git`
   * gitlink is protected even when it does not exist yet (an uninitialised
   * submodule), and the tree itself is anchored so it cannot be swapped.
   */
  const protectWorkingTree = (tree: string, submodule: boolean): void => {
    if (seenTrees.has(tree) || rootOf(tree) === undefined) return;
    seenTrees.add(tree);
    const dotGit = path.join(tree, ".git");
    const kind = fs.kind(dotGit);
    if (kind === "missing" && !submodule) return; // no repository: a contained `git init` must still work
    if (submodule) anchor(tree);
    if (kind === "dir") {
      protectGitDir(follow(dotGit), COMMON_DIR_ENTRIES);
    } else {
      addControl(dotGit, ".git");
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readText(dotGit) ?? "");
      if (match?.[1] !== undefined) {
        const gitDir = fs.real(path.resolve(tree, match[1]));
        // A linked worktree's gitdir has a commondir; a submodule's gitdir is a full repository.
        const isLinked = fs.kind(path.join(gitDir, "commondir")) === "file";
        protectGitDir(gitDir, isLinked ? WORKTREE_GITDIR_ENTRIES : COMMON_DIR_ENTRIES);
      }
    }
    // Submodules registered in this working tree, initialised or not.
    for (const sub of gitmodulePaths(fs.readText(path.join(tree, ".gitmodules")))) {
      const subTree = path.resolve(tree, sub);
      if (subTree !== tree && within(tree, subTree)) protectWorkingTree(fs.real(subTree), true);
    }
  };

  for (const root of roots) protectWorkingTree(root, false);
  return {
    controls: [...controls.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    anchors: [...anchors].sort(),
    links: [...links].sort(),
    sealed: [...sealed].sort(),
  };
}
