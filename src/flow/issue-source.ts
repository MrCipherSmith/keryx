import path from "node:path";
import { canonicalPath, gitCommonDir } from "../lib/clone-scope";
import { readAllocationLedger, resolveAllocationScope } from "./allocation";
import { listFlowDirs, readFlow } from "./store";
import type { FlowState } from "./types";

/** GitHub source URLs from legacy packages predate the node-ID based desktop index. */
export function issueSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const match = /^\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)\/?$/i.exec(url.pathname);
    if (!match || url.protocol !== "https:" || url.host !== "github.com" || url.username || url.password) return;
    return `https://github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}/issues/${match[3]}`;
  } catch { return; }
}

export interface LocatedIssueFlow { cwd: string; dir: string; flow: FlowState }

/** One local scan for all visible issues. Clone-private allocation records also locate unmerged sibling packages. */
export async function findIssueFlows(cwd: string, urls: ReadonlySet<string>): Promise<LocatedIssueFlow[]> {
  if (!urls.size) return [];
  const scope = await resolveAllocationScope(cwd);
  const root = await canonicalPath(cwd);
  const dirs = new Map<string, Set<string>>([[root, new Set(await listFlowDirs(root))]]);
  for (const row of await readAllocationLedger(scope)) {
    if (!row.cwd || !row.issue || !urls.has(row.issue) || row.retired || path.basename(row.dir) !== row.dir) continue;
    const location = await canonicalPath(row.cwd);
    if (location === root) continue;
    let names = dirs.get(location);
    if (!names) {
      const common = await gitCommonDir(location);
      if (!common || path.resolve(common) !== path.resolve((await gitCommonDir(root)) ?? "")) continue;
      dirs.set(location, names = new Set());
    }
    names.add(row.dir);
  }
  const found: LocatedIssueFlow[] = [];
  const seen = new Set<string>();
  for (const [location, names] of dirs) {
    const pending = Array.from(names);
    // Bound concurrent reads even for clones with thousands of historical packages.
    await Promise.all(Array.from({ length: Math.min(12, pending.length) }, async () => {
      for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
        if (seen.has(name)) continue;
        const flow = await readFlow(location, name).catch(() => undefined);
        const url = flow?.source?.type === "github-issue" && flow.source.ref ? issueSourceUrl(flow.source.ref) : undefined;
        if (flow && url && urls.has(url)) { found.push({ cwd: location, dir: name, flow }); seen.add(name); }
      }
    }));
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}
