// G-5 / AC6 (flow 356, audit remediation 3): agent worktrees under
// `.claude/worktrees/` — `keryx update`'s pruning offer and `keryx doctor`'s
// stale-worktree check share this module so the two surfaces can never
// disagree about which worktree is stale or where `.claude/worktrees` even
// is.
//
// WHY `git rev-parse --git-common-dir`, NOT `process.cwd()`
//
// `.claude/worktrees` lives beside the MAIN checkout, not beside whichever
// worktree an agent happens to be running in. A linked worktree's own
// `--git-dir` points at `<main>/.git/worktrees/<name>` — a subdirectory of
// the main checkout's `.git` — while `--git-common-dir` always resolves to
// the ONE shared `.git` every worktree of a repo points back to, main
// checkout included. Its parent directory is therefore the main checkout
// root from ANY worktree, which is the property both callers need: run from
// inside a linked worktree, "no `.claude/worktrees` directory" used to be
// the wrong answer (it was asking beside the wrong root) while the main
// checkout had dozens.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Resolve `git rev-parse --git-common-dir`, absolute. `undefined` outside a git repo, or if `git` itself is unavailable. */
export async function resolveGitCommonDir(cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--git-common-dir"], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0 || out.length === 0) {
      return undefined;
    }
    return path.isAbsolute(out) ? out : path.resolve(cwd, out);
  } catch {
    return undefined;
  }
}

/**
 * The MAIN checkout's root directory — the parent of the shared `.git` —
 * from `cwd`, whether `cwd` is the main checkout or a linked worktree.
 * `undefined` outside a git repository.
 */
export async function resolveMainCheckoutRoot(cwd: string): Promise<string | undefined> {
  const commonDir = await resolveGitCommonDir(cwd);
  return commonDir === undefined ? undefined : path.dirname(commonDir);
}

/** `.claude/worktrees` beside the main checkout, resolved from `cwd` (main or linked). `undefined` outside a git repo. */
export async function claudeWorktreesDir(cwd: string): Promise<string | undefined> {
  const mainRoot = await resolveMainCheckoutRoot(cwd);
  return mainRoot === undefined ? undefined : path.join(mainRoot, ".claude", "worktrees");
}

export type StaleWorktreeCandidate = {
  /** Directory name under `.claude/worktrees/`. */
  name: string;
  /** Absolute path. */
  path: string;
  ageDays: number;
};

/**
 * `git status --porcelain` in `worktreePath` is non-empty, OR the command
 * itself failed. A failure to determine cleanliness is NOT clean — this
 * function answers "is it safe to assume nothing would be lost", and an
 * unanswerable question is not a yes.
 */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: worktreePath, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) {
      return true;
    }
    return out.trim().length > 0;
  } catch {
    return true;
  }
}

/**
 * Commits on `worktreePath`'s `HEAD` not reachable from `mainBranch` (in the
 * MAIN checkout's own ref namespace — worktrees share one ref store).
 * `undefined` when this cannot be determined (no local `main` branch, a
 * detached/unborn `HEAD`, a `git` failure) — treated as UNSAFE to prune by
 * every caller, never as zero.
 */
export async function commitsAheadOfMain(worktreePath: string, mainBranch = "main"): Promise<number | undefined> {
  try {
    const proc = Bun.spawn(
      ["git", "rev-list", "--count", `${mainBranch}..HEAD`],
      { cwd: worktreePath, stdout: "pipe", stderr: "ignore" },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0 || out.length === 0 || !/^\d+$/.test(out)) {
      return undefined;
    }
    return Number.parseInt(out, 10);
  } catch {
    return undefined;
  }
}

/** Directories directly under `worktreesDir` — the candidate worktree set, unfiltered. Empty (never throws) when the directory is absent. */
async function listWorktreeDirs(worktreesDir: string): Promise<string[]> {
  try {
    const entries = await readdir(worktreesDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Worktrees under `worktreesDir` safe to prune: at least `maxAgeDays` old
 * (directory mtime — since creation, not last touch, which is the more
 * conservative reading of "stale"), with ZERO commits ahead of `mainBranch`
 * AND a clean `git status`. G-5's own safety boundary, absolute: a worktree
 * with unmerged commits or uncommitted changes is NEVER a candidate, no
 * matter its age — {@link commitsAheadOfMain} returning `undefined`
 * (unknowable) excludes it exactly like a positive count would.
 */
export async function findStaleWorktrees(
  worktreesDir: string,
  options: { maxAgeDays?: number; mainBranch?: string } = {},
): Promise<StaleWorktreeCandidate[]> {
  const maxAgeDays = options.maxAgeDays ?? 7;
  const mainBranch = options.mainBranch ?? "main";
  const names = await listWorktreeDirs(worktreesDir);
  const candidates: StaleWorktreeCandidate[] = [];
  for (const name of names) {
    const worktreePath = path.join(worktreesDir, name);
    let ageDays: number;
    try {
      const metadata = await stat(worktreePath);
      ageDays = (Date.now() - metadata.mtimeMs) / MS_PER_DAY;
    } catch {
      continue; // vanished between listing and stat — nothing to prune
    }
    if (ageDays < maxAgeDays) {
      continue;
    }
    const ahead = await commitsAheadOfMain(worktreePath, mainBranch);
    if (ahead === undefined || ahead > 0) {
      continue;
    }
    if (await hasUncommittedChanges(worktreePath)) {
      continue;
    }
    candidates.push({ name, path: worktreePath, ageDays });
  }
  return candidates;
}

/**
 * Remove one worktree via `git worktree remove` (run against the MAIN
 * checkout's git, so it can see and update the shared administrative
 * state), never a raw `rm -rf` — git's own removal also cleans up its
 * `.git/worktrees/<name>` bookkeeping and refuses (rather than silently
 * skips) a worktree it does not consider safe to remove, which is the
 * second line of defence behind {@link findStaleWorktrees}'s own filter.
 */
export async function pruneWorktree(mainRoot: string, worktreePath: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const proc = Bun.spawn(["git", "worktree", "remove", worktreePath], { cwd: mainRoot, stdout: "pipe", stderr: "pipe" });
    const stderrText = await new Response(proc.stderr).text();
    const ok = (await proc.exited) === 0;
    return ok ? { ok } : { ok, message: stderrText.trim() || "git worktree remove failed" };
  } catch (cause) {
    return { ok: false, message: String(cause) };
  }
}
