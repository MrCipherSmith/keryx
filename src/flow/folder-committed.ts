import { nulSplit, runGit, showPrefix } from "./remote-flows";

// Flow 384: is a flow folder in `HEAD`?
//
// Flow folders were created by `flow init` and then left in the working tree:
// several never reached a commit, so the numbers they held were free as far as
// every other clone could tell. "In HEAD" is asked of git (`ls-tree`), not of
// the file system, because a folder that exists on disk proves nothing about
// what a pull request carries.

/** Paths handed to one `git ls-tree` call; a clone with hundreds of flows stays far below the argv limit. */
const BATCH = 100;

/**
 * The subset of `dirs` whose `flow.json` is committed in `HEAD`, or `null`
 * when `cwd` is not inside a git repository (or git is unavailable) — "not
 * applicable" and "nothing is committed" must stay distinguishable. A
 * repository with no commit yet commits nothing, so it answers an empty set.
 * Any OTHER failure to read the HEAD tree throws: an answer of "nothing is
 * committed" must mean git said so, never that git could not be asked.
 */
export async function flowFoldersInHead(cwd: string, dirs: readonly string[]): Promise<Set<string> | null> {
  const prefix = await showPrefix(cwd);
  if (prefix === null) {
    return null;
  }
  const committed = new Set<string>();
  if (dirs.length === 0) {
    return committed;
  }
  const head = await runGit(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (head === undefined) {
    return null;
  }
  if (head.code !== 0) {
    // An unborn HEAD (no commit yet): there is no tree, so nothing is committed.
    return committed;
  }
  for (let start = 0; start < dirs.length; start += BATCH) {
    const batch = dirs.slice(start, start + BATCH);
    const paths = batch.map((dir) => `${prefix}.metaproject/flows/${dir}/flow.json`);
    // `-z`: git C-quotes a non-ASCII path otherwise, and a project that lives in
    // a directory with such a name would then never match.
    const result = await runGit(cwd, ["ls-tree", "-z", "--name-only", "--full-tree", "HEAD", "--", ...paths]);
    if (result === undefined) {
      return null;
    }
    if (result.code !== 0) {
      throw new Error(
        `could not read HEAD tree (git ls-tree exited ${result.code}); not treating the flow folders as uncommitted`,
      );
    }
    const found = new Set(nulSplit(result.stdout));
    for (const [index, dir] of batch.entries()) {
      if (found.has(paths[index] ?? "")) {
        committed.add(dir);
      }
    }
  }
  return committed;
}
