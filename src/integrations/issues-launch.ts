import path from "node:path";
import { readFile, access } from "node:fs/promises";
import { canonicalPath } from "../lib/clone-scope";
import { assertGitRevision } from "../lib/git-revision";
import { findIssueFlows, flowsRoot, issueSourceUrl, parseAcKinds, readFlow } from "../flow/service";
import { reviewGitCommonDir } from "../review/board-github";
import { projectGithubBinding } from "../review/github-account-store";
import { sessionDir } from "../session";
import { sessionLeaseState } from "../session/lease";
import { setSessionFlags } from "../session/organize";
import { issueCheckouts, selectIssueCheckout } from "./issue-checkouts";
import { issueBindingFile, privateJson, saveBinding, withIssueBinding, type BoundIssue } from "./issue-session";
import { issuePreparationPrompt, issueQuestion, issueTurnReceipt } from "./issue-turn";
import { issueKey, type IssueWorkspace, type IssueRef, type IssueViewer, type IssueDetail, type IssueFlowRef,
  type IssueProjectRef, type IssueLocalStage } from "./issues-contract";

export type IssueWorkAction = "workspace" | "open-session" | "prepare-flow";
export interface IssueWorkRequest { ref: IssueRef; selectedCwd?: string; flowDir?: string; baseBranch?: string }
export interface IssueWorkPorts {
  read: (cwd: string, login: string, issue: IssueRef) => Promise<{ viewer: IssueViewer; issue: IssueDetail }>;
  init: (project: IssueProjectRef, issue: IssueDetail) => Promise<IssueFlowRef>;
  projects?: typeof issueCheckouts;
  authorized?: (project: IssueProjectRef, viewer: IssueViewer) => Promise<boolean>;
  dataDir?: string;
}

function projectLoginMatches(project: string, viewer: IssueViewer): boolean {
  const binding = projectGithubBinding(project);
  return !binding || binding.login?.toLowerCase() === viewer.login.toLowerCase();
}

async function projectIsAuthorized(project: IssueProjectRef, viewer: IssueViewer): Promise<boolean> {
  const common = await reviewGitCommonDir(project.cwd);
  return !!common && projectLoginMatches(common, viewer);
}

async function prepareAvailable(cwd: string): Promise<IssueWorkspace["problem"]> {
  const manifest = await readFile(path.join(cwd, ".metaproject/metaproject.json"), "utf8").catch(() => "");
  if (!manifest || JSON.parse(manifest)?.modules?.tasks?.enabled !== true)
    return { code: "tasks_module_unavailable", message: "Enable Task Manager in this project's Metaproject to prepare a Flow." };
  try { await access(path.join(cwd, ".metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md")); }
  catch { return { code: "capability_missing", message: "Install the flow-orchestrator skill in this project, then retry." }; }
}

type Located = Awaited<ReturnType<typeof findIssueFlows>>[number];
function flowRef(project: IssueProjectRef, located: Located): IssueFlowRef {
  const { flow, dir, cwd } = located;
  return { id: flow.id, flowDir: dir, cwd, cloneId: project.cloneId, status: flow.status,
    ...(flow.baseBranch ? { baseBranch: flow.baseBranch } : {}) };
}

async function artifactsPrepared(ref: IssueFlowRef): Promise<boolean> {
  const root = path.join(flowsRoot(ref.cwd), ref.flowDir);
  try {
    const [flow, plan, ac] = await Promise.all([readFlow(ref.cwd, ref.flowDir),
      readFile(path.join(root, "plan.md"), "utf8"), readFile(path.join(root, "acceptance-criteria.md"), "utf8")]);
    const parsed = parseAcKinds(ac);
    return flow.tasks.some(task => task.origin !== "scaffold") && !!plan.trim() && !plan.includes("Chosen approach and why (link brainstorm")
      && parsed.criteria.length > 0 && parsed.errors.length === 0 && parsed.criteria.every(c => !c.text.includes("<replace"));
  } catch { return false; }
}

async function hydrate(result: IssueWorkspace, bound: BoundIssue, dataDir?: string): Promise<IssueWorkspace> {
  const launch = { ...bound.launch };
  result.launch = launch;
  if (!launch.sessionId || launch.stage === "registered") return result;
  result.session = { sessionId: launch.sessionId, profile: "shell", viewer: result.viewer, issue: result.issue, project: launch.project,
    ...(launch.flow ? { flow: launch.flow } : {}) };
  if (!launch.flow) return result;
  const dir = sessionDir(launch.project.cwd, launch.sessionId, dataDir);
  const question = issueQuestion(dir);
  const receipt = issueTurnReceipt(dir);
  if (receipt && receipt.launchId !== launch.launchId) {
    launch.stage = "launch_outcome_unknown";
    result.problem = { code: "launch_outcome_unknown", message: "Inspect the linked session before resuming preparation." };
  } else if (receipt) {
    launch.initialTurn = { state: "accepted", key: launch.launchId, turnId: receipt.turnId };
    if (question && question.answer === undefined) {
      launch.stage = "awaiting_answer";
      result.question = { id: question.id, sessionId: launch.sessionId };
    } else if (await artifactsPrepared(launch.flow)) launch.stage = "prepared";
    else {
      const lease = sessionLeaseState(launch.project.cwd, launch.sessionId, dataDir);
      launch.stage = !receipt.settled && (lease.state === "live" || lease.state === "mine") ? "preparing" : "resume_required";
      if (launch.stage === "resume_required") result.problem = { code: "resume_required", message: "Open the linked session to continue from its saved work." };
    }
  } else if (launch.flow.status !== "initializing" || await artifactsPrepared(launch.flow)) launch.stage = "prepared";
  else result.initialTurn = { launchId: launch.launchId, text: issuePreparationPrompt(launch) };
  return result;
}

/** The read port must authenticate afresh before any viewer-private binding is consulted. */
export async function issueWorkspace(action: IssueWorkAction, cwd: string, login: string, request: IssueWorkRequest,
  ports: IssueWorkPorts): Promise<IssueWorkspace> {
  const { viewer, issue } = await ports.read(cwd, login, request.ref);
  if (viewer.login.toLowerCase() !== login.toLowerCase() || issueKey(issue.ref) !== issueKey(request.ref))
    throw new Error("access: The selected GitHub identity or issue changed. Refresh Issues.");
  const projects = await (ports.projects ?? issueCheckouts)(cwd, issue.ref);
  const root = await canonicalPath(cwd);
  const selected = request.selectedCwd && await canonicalPath(request.selectedCwd);
  const project = selectIssueCheckout(projects, selected);
  const result: IssueWorkspace = { viewer, issue: issue.ref, projects, flows: [] };
  if (!project || (selected && selected !== root) || (action !== "workspace" && project.cwd !== root))
    return { ...result, problem: { code: projects.length > 1 ? "project_ambiguous" : "project_required",
      message: projects.length ? "Open a matching checkout to work on this issue." : "Connect a checkout of this repository to work on this issue." } };
  if (!await (ports.authorized ?? projectIsAuthorized)(project, viewer))
    return { ...result, problem: { code: "account_mismatch", message: "Select the GitHub account connected to this checkout." } };
  const source = issueSourceUrl(issue.ref.url)!;
  result.flows = (await findIssueFlows(project.cwd, new Set([source]))).map(f => flowRef(project, f));
  const record = privateJson<BoundIssue>(issueBindingFile(viewer, project, issue.ref, ports.dataDir));
  const linked = result.flows.find(f => f.flowDir === (request.flowDir ?? record?.launch.flow?.flowDir));
  if (action === "workspace") return record ? hydrate(result, record, ports.dataDir) : result;
  if (action === "prepare-flow") {
    const problem = await prepareAvailable(project.cwd);
    if (problem) return { ...result, problem };
    if ((!linked && request.flowDir) || (!linked && result.flows.length > 1))
      return { ...result, problem: { code: "flow_choice_required", message: "Select the existing Flow to prepare." } };
    const target = linked ?? result.flows[0];
    if (target && target.cwd !== project.cwd) return { ...result, problem: { code: "project_required", message: "Open the checkout containing the selected Flow." } };
  }
  return withIssueBinding(viewer, project, issue, ports.dataDir, async (bound, file) => {
    if (action === "prepare-flow") {
      if (bound.launch.project.cwd !== root)
        return { ...await hydrate(result, bound, ports.dataDir), problem: { code: "project_required", message: "Open the checkout containing the linked discussion." } };
      const baseBranch = assertGitRevision(request.baseBranch ?? project.baseBranch);
      if (!baseBranch.trim() || /[\s\x00-\x1f]/.test(baseBranch)) throw new Error("Select a valid base branch before preparing the Flow.");
      if (request.flowDir && bound.launch.flow && bound.launch.flow.flowDir !== request.flowDir)
        return { ...result, problem: { code: "flow_choice_required", message: "This discussion already belongs to a different Flow." } };
      const ref = linked ?? bound.launch.flow ?? result.flows[0] ?? await ports.init({ ...project, baseBranch }, issue);
      if (!result.flows.some(flow => flow.flowDir === ref.flowDir)) result.flows.push(ref);
      bound.launch.flow = ref;
      if (bound.launch.stage === "session_bound") bound.launch.stage = "flow_bound";
      setSessionFlags(bound.launch.project.cwd, bound.launch.sessionId!, { flow: ref.flowDir }, ports.dataDir);
      saveBinding(file, bound);
    }
    return hydrate(result, bound, ports.dataDir);
  });
}

export async function issueWorkspaceStages(cwd: string, viewer: IssueViewer, refs: IssueRef[]): Promise<Record<string, IssueLocalStage>> {
  const stages: Record<string, IssueLocalStage> = {};
  const groups = new Map<string, IssueRef[]>();
  for (const ref of refs) { const group = groups.get(ref.repositoryId); if (group) group.push(ref); else groups.set(ref.repositoryId, [ref]); }
  await Promise.all(Array.from(groups.values(), async issues => {
    const first = issues[0]!;
    const urls = new Set(issues.map(ref => issueSourceUrl(ref.url)!));
    for (const project of await issueCheckouts(cwd, first)) {
      if (!await projectIsAuthorized(project, viewer)) continue;
      const flows = await findIssueFlows(project.cwd, urls);
      for (const ref of issues) {
        const binding = privateJson<BoundIssue>(issueBindingFile(viewer, project, ref));
        const matches = flows.filter(f => issueSourceUrl(f.flow.source.ref ?? "") === issueSourceUrl(ref.url));
        const existing = stages[issueKey(ref)];
        const workspace = binding && await hydrate({ viewer, issue: ref, projects: [project], flows: [] }, binding);
        const stage = workspace?.launch?.stage;
        const reason = workspace?.problem?.message;
        if (stage === "awaiting_answer" || stage === "resume_required" || stage === "launch_outcome_unknown" || matches.some(f => f.flow.status === "blocked"))
          stages[issueKey(ref)] = { stage: "needs_answer", reason: reason ?? (workspace?.question ? "Answer the coordinator in Sessions." : "Inspect the blocked Flow.") };
        else if (!existing || existing.stage === "none") {
          const status = matches.find(f => f.flow.status !== "done")?.flow.status ?? matches[0]?.flow.status;
          stages[issueKey(ref)] = { stage: status === "done" ? "done" : status === "initializing" || stage === "preparing" ? "preparing" : status ? "active" : "none" };
        }
      }
    }
  }));
  return stages;
}
