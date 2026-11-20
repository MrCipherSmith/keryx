// Agent-readable evidence. Only canonical PR links in project-owned Flow manifests establish a link.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { flowsRoot } from "../flow/store";
import { gitToplevel } from "../lib/clone-scope";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";
import type { LinkedFlowContext } from "./board-detail-types";
import type { FlowState } from "../flow/types";
import { readExistingReviews } from "./desk-run-legacy";
import { artifactDirectories, findKnownExcerpt, readKnown } from "./project-artifacts";
import { DeskRunStore, deskRunRoot } from "./desk-run-store";
import type { DeskRun, DeskRunKey } from "./desk-run-types";
import { manifestStamp, openReviewLinkIndex } from "./flow-link-index";
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
function* flowRefs(roots: string[], id?: string, wanted?: string, allowUnlinked = false) {
  const seen = new Set<string>();
  for (const root of roots) {
    const index = wanted ? openReviewLinkIndex(root, "flow-links") : undefined;
    for (const dir of artifactDirectories(flowsRoot(root))) {
      const directory = path.basename(dir);
      if (seen.has(directory) || !/^\d+-/.test(directory) || (id && !directory.startsWith(id + "-"))) continue;
      const file = path.join(dir, "flow.json");
      const stamp = index && manifestStamp(file);
      const link = index?.lookup(directory, stamp);
      if (link !== undefined && link !== wanted) {
        if (link) seen.add(directory);
        continue;
      }
      const raw = readKnown(file, 1024 * 1024);
      if (!raw) continue;
      let flow: FlowState;
      try { flow = JSON.parse(raw.text); } catch { continue; }
      if (typeof flow?.id !== "string" || !/^\d+$/.test(flow.id) || !directory.startsWith(flow.id + "-")) continue;
      const target = parseProjectPr(flow.pr?.url);
      index?.record(directory, stamp, target ? target.repo + "#" + target.number : "");
      if (target || allowUnlinked) {
        seen.add(directory);
        yield { dir, directory, flow, target, root };
      }
    }
    index?.save();
  }
}

export async function prForFlow(cwd: string, id: string) {
  if (!/^\d+$/.test(id)) throw new Error("configuration: Expected a numeric Flow ID.");
  const targets = [...flowRefs(await projectRoots(cwd), id.padStart(3, "0"))].flatMap(item => item.target ? [item.target] : []);
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

function* flowEvidenceLines(flow: FlowState) {
  for (const [ac, value] of Object.entries(flow.acConfirmed ?? {})) {
    if (typeof value?.note === "string") yield ac.slice(0, 120) + ": " + value.note;
  }
  for (const t of Array.isArray(flow.tasks) ? flow.tasks : []) {
    if (!t || !Array.isArray(t.evidenceRefs)) continue;
    const prefix = typeof t.id === "string" ? t.id.slice(0, 120) + ": " : "";
    for (const ref of t.evidenceRefs) if (typeof ref === "string") yield prefix + ref;
  }
}

function flowEvidence(flow: FlowState, limit: number, search?: string) {
  let rendered = "";
  for (const line of flowEvidenceLines(flow)) {
    if (search) {
      const match = excerpt(line, limit, search);
      if (match) return match;
    } else {
      const next = (rendered ? "\n" : "") + line;
      const remaining = limit - rendered.length;
      if (next.length > remaining) return rendered + next.slice(0, remaining) + " …";
      rendered += next;
    }
  }
  return rendered;
}

export async function readLinkedFlows(cwd: string, repo: string, number: number, search?: string) {
  return linkedFlows(await projectRoots(cwd), repo, number, search);
}

function linkedFlows(roots: string[], repo: string, number: number, search?: string, selectedId?: string) {
  let totalFlows = 0;
  const flows: LinkedFlowContext[] = [];
  for (const { dir, directory, flow, target, root } of flowRefs(roots, selectedId, selectedId ? undefined : repo.toLowerCase() + "#" + number, selectedId !== undefined)) {
    if (!selectedId && (target?.number !== number || target.repo !== repo.toLowerCase())) continue;
    totalFlows++;
    if (flows.length >= maxFlows) continue;
    const documents: Record<string, string> = {};
    for (const name of docs) {
      const latest = name === "journal.md" && !search;
      const file = path.join(dir, name);
      const value = search ? findKnownExcerpt(file, search, 1800)
        : excerpt(readKnown(file, 512 * 1024, latest ? "tail" : true)?.text, 1800, undefined, latest);
      if (value) documents[name] = value;
    }
    const tasks = (Array.isArray(flow.tasks) ? flow.tasks : [])
      .filter(task => typeof task?.title === "string")
      .map(task => [task.id, task.status, task.title, task.dispositionReason].filter(Boolean).join(" · "));
    const status = excerpt(tasks.join("\n"), 1800, search);
    if (status) documents["task-status"] = status;
    const evidence = flowEvidence(flow, 1800, search);
    if (evidence) documents["evidence"] = evidence;
    if (search && !Object.keys(documents).length && !excerpt(flow.title, 240, search)) continue;
    flows.push({
      id: flow.id, title: excerpt(flow.title, 240), status: excerpt(flow.status, 40),
      directory, checkout: root === roots[0] ? "primary" : "worktree", documents,
    });
  }
  if (selectedId && totalFlows !== 1) throw new Error("configuration: Selected Flow is missing or ambiguous in this project.");
  return { flows, totalFlows };
}

type PrInfo = { title: string; state: string; baseRefOid: string; headRefOid: string };
/** Caller must have verified repo, viewer and PR against GitHub before reading local evidence. */
export async function collectPrContext(cwd: string, key: DeskRunKey, pr: PrInfo, existingStore?: DeskRunStore, search?: string, selectedId?: string) {
  const roots = await projectRoots(cwd);
  const linked = linkedFlows(roots, key.repo, key.number, search, selectedId);
  let owned: DeskRunStore | undefined;
  try {
    if (!existingStore && existsSync(path.join(deskRunRoot(), "runs.sqlite"))) {
      owned = new DeskRunStore(deskRunRoot(), true);
    }
    const store = existingStore ?? owned;
    const history = new Map<string, DeskRun>();
    for (const run of store?.history(key).runs ?? []) history.set(run.id, run);
    const imports = new Set<string>();
    for (const root of roots) {
      for (const run of readExistingReviews(root, key)) {
        const saved = history.get(run.id);
        if (!imports.has(run.id) && (!saved || saved.source === "existing")) {
          history.set(run.id, run);
          imports.add(run.id);
        }
      }
    }
    const newest = [...history.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const summaries = [];
    for (const run of newest) {
      const result = run.result?.reportDeferred && !search ? store?.history(key, run.id).runs[0]?.result : run.result;
      const reason = excerpt(run.reason, 320, search);
      const fullReport = search && result?.reportDeferred ? store?.reportForSearch(key, run.id) : undefined;
      const report = excerpt(fullReport ?? result?.report, 2200, search);
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
      ...linked, ...(selectedId ? { selectedFlowId: selectedId } : {}), totalRuns: history.size, history: summaries,
    };
  } finally { owned?.close(); }
}
