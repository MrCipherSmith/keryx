// Agent-readable evidence. Only canonical PR links in project-owned Flow manifests establish a link.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { flowsRoot } from "../flow/store";
import { gitToplevel } from "../lib/clone-scope";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";
import type { LinkedFlowContext } from "./board-detail-types";
import type { FlowState } from "../flow/types";
import { readExistingReviews } from "./desk-run-legacy";
import { artifactDirectories, readKnown } from "./project-artifacts";
import { DeskRunStore, deskRunRoot } from "./desk-run-store";
import type { DeskRun, DeskRunKey } from "./desk-run-types";
import { flowManifestStamp, openFlowLinkIndex } from "./flow-link-index";
import { mainCheckout } from "./watcher-project";

export const PR_CONTEXT_FILE = ".keryx-review-context.json";
const docs = ["description.md", "plan.md", "tasks.md", "acceptance-criteria.md", "journal.md", "evidence.md"] as const;
const maxFlows = 6;
const maxRuns = 12;

export function parseProjectPr(value: unknown) {
  if (typeof value !== "string") return;
  const match = /^https:\/\/github\.com\/([\w-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(value.trim());
  if (!match || !Number.isSafeInteger(Number(match[2]))) return;
  return { repo: match[1]!.toLowerCase(), number: Number(match[2]) };
}

async function projectRoots(cwd: string) {
  const env = withoutGitDiscoveryOverrides(process.env);
  const [primary, current] = await Promise.all([mainCheckout(cwd, env), gitToplevel(cwd, env)]);
  return [...new Set([primary, realpathSync(current ?? cwd)])];
}
function* flowRefs(roots: string[], id?: string, wanted?: string) {
  const seen = new Set<string>();
  for (const root of roots) {
    const index = wanted ? openFlowLinkIndex(root) : undefined;
    for (const dir of artifactDirectories(flowsRoot(root))) {
      const directory = path.basename(dir);
      if (seen.has(directory) || !/^\d+-/.test(directory) || (id && !directory.startsWith(id + "-"))) continue;
      const file = path.join(dir, "flow.json");
      const stamp = index && flowManifestStamp(file);
      const link = index?.lookup(directory, stamp);
      if (link !== undefined && link !== wanted) {
        seen.add(directory);
        continue;
      }
      const raw = readKnown(file, 1024 * 1024);
      if (!raw) continue;
      let flow: FlowState;
      try { flow = JSON.parse(raw.text); } catch { continue; }
      if (typeof flow?.id !== "string" || !/^\d+$/.test(flow.id) || !directory.startsWith(flow.id + "-")) continue;
      seen.add(directory);
      const target = parseProjectPr(flow.pr?.url);
      index?.record(directory, stamp, target ? target.repo + "#" + target.number : "");
      if (target) yield { dir, directory, flow, target, root };
    }
    index?.save();
  }
}

export async function prForFlow(cwd: string, id: string) {
  if (!/^\d+$/.test(id)) throw new Error("configuration: Expected a numeric Flow ID.");
  const targets = [...flowRefs(await projectRoots(cwd), id.padStart(3, "0"))].map(item => item.target);
  const first = targets[0];
  if (!first) throw new Error("configuration: This Flow has no linked GitHub pull request.");
  if (targets.some(t => t.repo !== first.repo || t.number !== first.number)) {
    throw new Error("configuration: This Flow ID links to multiple pull requests. Select one with --pr URL.");
  }
  return first;
}

function excerpt(text: unknown, limit: number, search?: string, latest = false): string {
  if (typeof text !== "string") return "";
  let from = latest ? Math.max(0, text.length - limit) : 0;
  if (search) {
    const index = text.toLowerCase().indexOf(search.toLowerCase());
    if (index < 0) return "";
    from = Math.max(0, index - Math.min(180, limit / 4));
  }
  return (from ? "… " : "") + text.slice(from, from + limit) + (from + limit < text.length ? " …" : "");
}

function flowEvidence(flow: FlowState) {
  const notes = Object.entries(flow.acConfirmed ?? {}).flatMap(([ac, value]) =>
    typeof value?.note === "string" ? [ac + ": " + value.note] : []);
  for (const t of Array.isArray(flow.tasks) ? flow.tasks : []) {
    if (!t || !Array.isArray(t.evidenceRefs)) continue;
    for (const ref of t.evidenceRefs) if (typeof ref === "string") notes.push(t.id + ": " + ref);
  }
  return notes.join("\n");
}

export async function readLinkedFlows(cwd: string, repo: string, number: number, search?: string) {
  return linkedFlows(await projectRoots(cwd), repo, number, search);
}

function linkedFlows(roots: string[], repo: string, number: number, search?: string) {
  let totalFlows = 0;
  const flows: LinkedFlowContext[] = [];
  for (const { dir, directory, flow, target, root } of flowRefs(roots, undefined, repo.toLowerCase() + "#" + number)) {
    if (target.number !== number || target.repo !== repo.toLowerCase()) continue;
    totalFlows++;
    if (flows.length >= maxFlows) continue;
    const documents: Record<string, string> = {};
    for (const name of docs) {
      const latest = name === "journal.md" && !search;
      const file = readKnown(path.join(dir, name), 512 * 1024, latest ? "tail" : true);
      const value = excerpt(file?.text, 1800, search, latest);
      if (value) documents[name] = value;
    }
    const tasks = (Array.isArray(flow.tasks) ? flow.tasks : [])
      .filter(task => typeof task?.title === "string")
      .map(task => [task.id, task.status, task.title, task.dispositionReason].filter(Boolean).join(" · "));
    const status = excerpt(tasks.join("\n"), 1800, search);
    if (status) documents["task-status"] = status;
    const evidence = excerpt(flowEvidence(flow), 1800, search);
    if (evidence) documents["evidence"] = evidence;
    if (search && !Object.keys(documents).length && !excerpt(flow.title, 240, search)) continue;
    flows.push({
      id: flow.id, title: excerpt(flow.title, 240), status: excerpt(flow.status, 40),
      directory, checkout: root === roots[0] ? "primary" : "worktree", documents,
    });
  }
  return { flows, totalFlows };
}

type PrInfo = { title: string; state: string; baseRefOid: string; headRefOid: string };
/** Caller must have verified repo, viewer and PR against GitHub before reading local evidence. */
export async function collectPrContext(cwd: string, key: DeskRunKey, pr: PrInfo, existingStore?: DeskRunStore, search?: string) {
  const roots = await projectRoots(cwd);
  const linked = linkedFlows(roots, key.repo, key.number, search);
  let owned: DeskRunStore | undefined;
  try {
    if (!existingStore && existsSync(path.join(deskRunRoot(), "runs.sqlite"))) {
      owned = new DeskRunStore(deskRunRoot(), true);
    }
    const store = existingStore ?? owned;
    const history = new Map<string, DeskRun>();
    for (const run of store?.history(key).runs ?? []) history.set(run.id, run);
    for (const root of roots) {
      for (const run of readExistingReviews(root, key)) if (!history.has(run.id)) history.set(run.id, run);
    }
    const newest = [...history.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const summaries = [];
    for (const run of newest) {
      const result = run.result?.reportDeferred ? store?.history(key, run.id).runs[0]?.result : run.result;
      const reason = excerpt(run.reason, 320, search);
      const report = excerpt(result?.report, 2200, search);
      if (search && !reason && !report && ![run.id, run.state, run.baseSha, run.headSha, result?.verdict]
        .some(value => excerpt(value, 100, search))) continue;
      summaries.push({
        id: run.id, source: run.source, state: run.state, createdAt: run.createdAt,
        requested: { baseSha: run.baseSha, headSha: run.headSha }, reviewed: result?.reviewed ?? null,
        verdict: result?.verdict ?? null, coverage: result?.coverage ?? "unknown",
        findings: result && result.findingsKnown !== false ? result.findings : null, reason, report,
      });
      if (summaries.length >= maxRuns) break;
    }
    return {
      version: 1 as const,
      pr: { url: `https://github.com/${key.repo}/pull/${key.number}`, title: excerpt(pr.title, 240),
        state: pr.state, baseSha: pr.baseRefOid, headSha: pr.headRefOid },
      ...linked, totalRuns: history.size, history: summaries,
    };
  } finally { owned?.close(); }
}
