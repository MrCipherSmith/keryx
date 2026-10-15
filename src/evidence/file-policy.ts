import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { keryxDataDir } from "../session/paths";
const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
/** Resolve existing ancestors, reserving absent session subtrees too. */
function canonicalCandidate(input: string): string {
  let current = path.resolve(input);
  const tail: string[] = [];
  while (true) {
    // Do not confuse a dangling symlink with an absent path.
    try { lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current)); current = parent; continue;
    }
    return path.join(realpathSync(current), ...tail.reverse());
  }
}
/** Session-owned bytes are never generic files, independent of archive opt-in. */
export function evidenceFileOutsideSessionStore(projectRoot: string, relative: string, dataDir?: string): boolean {
  try {
    const target = path.resolve(projectRoot, relative), sessions = path.resolve(keryxDataDir(dataDir), "sessions");
    return !inside(sessions, target) && !inside(canonicalCandidate(sessions), canonicalCandidate(target));
  } catch { return false; }
}
