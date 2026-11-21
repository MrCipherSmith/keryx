import { prepareAvailable, artifactsPrepared } from "./issue-flow-package";
import { canonicalPath } from "../lib/clone-scope";
import { assertGitRevision } from "../lib/git-revision";
import { findIssueFlows, issueSourceUrl, readFlow } from "../flow/service";
import { reviewGitCommonDir } from "../review/board-github";
import { projectGithubBinding } from "../review/github-account-store";
import { sessionDir } from "../session";
import { setSessionFlags } from "../session/organize";
import { issueCheckoutCatalog, issueCheckouts, selectIssueCheckout } from "./issue-checkouts";
import { issueBindingFile, privateJson, saveBinding, withIssueBinding, type BoundIssue } from "./issue-session";
import { issuePreparationPrompt, issueQuestion, issueTurnReceipt, issueTurnWorking } from "./issue-turn";
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

type Located = Awaited<ReturnType<typeof findIssueFlows>>[number];
function flowRef(project: IssueProjectRef, located: Located): IssueFlowRef {
  const { flow, dir, cwd } = located;
  return { id: flow.id, flowDir: dir, cwd, cloneId: project.cloneId, status: flow.status,
    ...(flow.baseBranch ? { baseBranch: flow.baseBranch } : {}) };
}

async function hydrate(result: IssueWorkspace, bound: BoundIssue, dataDir?: string): Promise<IssueWorkspace> {
  const launch = { ...bound.launch };
  result.launch = launch;
  if (!launch.sessionId || launch.stage === "registered") return result;
  result.session = { sessionId: launch.sessionId, profile: "shell", viewer: result.viewer, issue: result.issue, project: launch.project,
    ...(launch.flow ? { flow: launch.flow } : {}) };
  if (!launch.flow) return result;
  const dir = sessionDir(launch.project.cwd, launch.sessionId, dataDir);
  const packageState = await readFlow(launch.flow.cwd, launch.flow.flowDir).catch(() => undefined);
  const source = packageState?.source;
  if (packageState?.id !== launch.flow.id || source?.type !== "github-issue" ||
      issueSourceUrl(source.ref ?? "") !== issueSourceUrl(bound.flowSourceUrl ?? launch.issue.url)) {
    launch.stage = "resume_required";
    result.problem = { code: "resume_required", message: "Restore the linked Flow package before continuing preparation." };
    return result;
  }
  launch.flow = { ...launch.flow, status: packageState.status };
  result.session.flow = launch.flow;
  const question = issueQuestion(dir);
  const receipt = issueTurnReceipt(dir);
  if ((receipt && receipt.launchId !== launch.launchId) || (!receipt && launch.initialTurn.state !== "unsent")) {
    launch.stage = "launch_outcome_unknown";
    result.problem = { code: "launch_outcome_unknown", message: "Inspect the linked session before resuming preparation." };
  } else if (receipt) {
    launch.initialTurn = { state: "accepted", key: launch.launchId, turnId: receipt.turnId };
    if (question && question.answer === undefined) {
      launch.stage = "awaiting_answer";
      result.question = { id: question.id, sessionId: launch.sessionId };
    } else if (launch.flow.status !== "initializing" || await artifactsPrepared(launch.flow)) launch.stage = "prepared";
    else {
      launch.stage = issueTurnWorking(dir, bound, dataDir) ? "preparing" : "resume_required";
      if (launch.stage === "resume_required") result.problem = { code: "resume_required", message: "Open the linked session to continue from its saved work." };
    }
  } else if (launch.flow.status !== "initializing" || await artifactsPrepared(launch.flow)) launch.stage = "prepared";
  else result.initialTurn = { launchId: launch.launchId, text: issuePreparationPrompt(bound) };
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
  const record = privateJson<BoundIssue>(issueBindingFile(viewer, project, issue.ref, ports.dataDir));
  const source = issueSourceUrl(issue.ref.url)!;
  const urls = new Set([source]);
  const previous = record && issueSourceUrl(record.flowSourceUrl ?? record.launch.issue.url);
  if (previous) urls.add(previous);
  result.flows = (await findIssueFlows(project.cwd, urls)).map(f => flowRef(project, f));
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
      if (!baseBranch.trim() || Array.from(baseBranch).some(char => char.charCodeAt(0) <= 32)) throw new Error("Select a valid base branch before preparing the Flow.");
      if (request.flowDir && bound.launch.flow && bound.launch.flow.flowDir !== request.flowDir)
        return { ...result, problem: { code: "flow_choice_required", message: "This discussion already belongs to a different Flow." } };
      const ref = linked ?? bound.launch.flow ?? result.flows[0] ?? await ports.init({ ...project, baseBranch }, issue);
      if (!result.flows.some(flow => flow.flowDir === ref.flowDir)) result.flows.push(ref);
      if (ref.cwd !== project.cwd) {
        return { ...result, problem: { code: "project_required", message: "Open the checkout containing the existing Flow." } };
      }
      bound.launch.flow = ref;
      bound.flowSourceUrl ??= issue.ref.url;
      bound.preparationPrompt ??= issuePreparationPrompt(bound);
      if (bound.launch.stage === "session_bound") bound.launch.stage = "flow_bound";
      setSessionFlags(bound.launch.project.cwd, bound.launch.sessionId!, { flow: ref.flowDir }, ports.dataDir);
      saveBinding(file, bound);
    }
    const hydrated = await hydrate(result, bound, ports.dataDir);
    if (action === "open-session") delete hydrated.initialTurn;
    return hydrated;
  });
}

export async function issueWorkspaceStages(cwd: string, viewer: IssueViewer, refs: IssueRef[],
  ports: { catalog?: typeof issueCheckoutCatalog; authorized?: IssueWorkPorts["authorized"]; dataDir?: string } = {},
): Promise<Record<string, IssueLocalStage>> {
  const stages: Record<string, IssueLocalStage> = {};
  const groups = new Map<string, IssueRef[]>();
  for (const ref of refs) { const group = groups.get(ref.repositoryId); if (group) group.push(ref); else groups.set(ref.repositoryId, [ref]); }
  const catalog = await (ports.catalog ?? issueCheckoutCatalog)(cwd, refs);
  await Promise.all(Array.from(groups.values(), async issues => {
    const first = issues[0]!;
    const urls = new Set(issues.map(ref => issueSourceUrl(ref.url)!));
    for (const project of catalog.get(first.repositoryId) ?? []) {
      if (!await (ports.authorized ?? projectIsAuthorized)(project, viewer)) continue;
      const flows = await findIssueFlows(project.cwd, urls);
      for (const ref of issues) {
        const binding = privateJson<BoundIssue>(issueBindingFile(viewer, project, ref, ports.dataDir));
        const matches = flows.filter(f => issueSourceUrl(f.flow.source.ref ?? "") === issueSourceUrl(ref.url));
        const existing = stages[issueKey(ref)];
        const workspace = binding && await hydrate({ viewer, issue: ref, projects: [project], flows: [] }, binding, ports.dataDir);
        const stage = workspace?.launch?.stage;
        const reason = workspace?.problem?.message;
        if (stage === "awaiting_answer" || stage === "resume_required" || stage === "launch_outcome_unknown" || matches.some(f => f.flow.status === "blocked"))
          stages[issueKey(ref)] = { stage: "needs_answer", reason: reason ?? (workspace?.question ? "Answer the coordinator in Sessions." : "Inspect the blocked Flow.") };
        else if (!existing || existing.stage === "none") {
          const status = workspace?.launch?.flow?.status ?? matches.find(f => f.flow.status !== "done")?.flow.status ?? matches[0]?.flow.status;
          stages[issueKey(ref)] = {
            stage: status === "done" ? "done" : status === "initializing" || stage === "preparing" ? "preparing" : status ? "active" : "none",
            ...(workspace?.initialTurn ? { canResumePreparation: true } : {}),
            ...(stage === "prepared" && status === "initializing" ? { reason: "Plan and criteria ready for Freeze." } : {}),
          };
        }
      }
    }
  }));
  return stages;
}
