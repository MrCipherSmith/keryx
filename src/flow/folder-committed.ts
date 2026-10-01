import { lines, runGit, showPrefix } from "./remote-flows";

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
 */
export async function flowFoldersInHead(cwd: string, dirs: readonly string[]): Promise<Set<string> | null> {
  const prefix = await showPrefix(cwd);
  if (prefix === null) {
    return null;
  }
  const committed = new Set<string>();
  for (let start = 0; start < dirs.length; start += BATCH) {
    const batch = dirs.slice(start, start + BATCH);
    const paths = batch.map((dir) => `${prefix}.metaproject/flows/${dir}/flow.json`);
    const result = await runGit(cwd, ["ls-tree", "--name-only", "--full-tree", "HEAD", "--", ...paths]);
    if (result === undefined) {
      return null;
    }
    if (result.code !== 0) {
      // No HEAD to read (a repository with no commit): nothing is committed.
      continue;
    }
    const found = new Set(lines(result.stdout));
    for (const [index, dir] of batch.entries()) {
      if (found.has(paths[index] ?? "")) {
        committed.add(dir);
      }
    }
  }
  return committed;
}
