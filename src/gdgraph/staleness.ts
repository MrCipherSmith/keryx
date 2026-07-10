import { stat } from "node:fs/promises";
import path from "node:path";

// Cheap, low-noise graph-staleness signal: the graph is "maybe stale" when the
// repo's `.git/HEAD` (which changes on commit / branch switch) is newer than the
// built graph storage. Unlike "uncommitted changes", this does NOT fire on every
// working-tree edit during active development — only after the repo state moved
// since the last build. Best-effort: any error ⇒ not stale (never warns wrongly).
export async function graphMaybeStale(cwd: string): Promise<boolean> {
  const nodes = path.join(cwd, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl");
  const head = path.join(cwd, ".git", "HEAD");
  try {
    const [nodesStat, headStat] = await Promise.all([stat(nodes), stat(head)]);
    return headStat.mtimeMs > nodesStat.mtimeMs;
  } catch {
    return false;
  }
}

export const STALE_NOTE = "note: repo moved since the last graph build — `keryx gdgraph build` to refresh.";
