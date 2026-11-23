// Wire types shared by the CLI, ACP shell and Desktop. No platform imports.
export interface IssueRef {
  host: string;
  nodeId: string;
  repositoryId: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
}

/** Resolved by an authenticated GitHub request. A login supplied by a caller is only a selector. */
export interface IssueViewer {
  host: string;
  nodeId: string;
  login: string;
}

export type IssueScope = "assigned" | "created" | "mentioned" | "subscribed";

/** What `keryx issues list` reads: a viewer scope, or the GitHub repository of the project's cwd. */
export type IssueListSource = IssueScope | "repository";

export interface IssueLocalStage {
  stage: "none" | "preparing" | "active" | "needs_answer" | "done";
  reason?: string;
  /** This viewer has a bound package with an initial turn that can still be submitted. */
  canResumePreparation?: boolean;
}

export interface IssueSummary {
  ref: IssueRef;
  title: string;
  state: "open" | "closed";
  author: string;
  assignees: string[];
  labels: string[];
  createdAt: string;
  updatedAt: string;
  work?: IssueLocalStage;
}

export interface IssueDetail extends IssueSummary {
  body: string;
  stateReason?: string;
}

export interface IssueComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface IssuePage<T> {
  viewer: IssueViewer;
  items: T[];
  nextCursor: string | null;
  incomplete: boolean;
}

export interface IssueProjectRef {
  projectId: string;
  /** Shared across linked worktrees of this clone. */
  cloneId: string;
  cwd: string;
  baseBranch: string;
}

export interface IssueFlowRef {
  cloneId: string;
  flowDir: string;
  status?: "initializing" | "ready" | "in-progress" | "implemented" | "completing" | "done" | "blocked";
  baseBranch?: string;
  cwd: string;
  id: string;
}

export interface IssueSessionRef {
  sessionId: string;
  profile: string;
  viewer: IssueViewer;
  issue: IssueRef;
  project: IssueProjectRef;
  flow?: IssueFlowRef;
}

export type IssueLaunchStage =
  | "registered" | "session_bound" | "flow_bound" | "preparing"
  | "awaiting_answer" | "prepared" | "launch_outcome_unknown" | "resume_required";

export interface IssueLaunch {
  version: 1;
  launchId: string;
  viewer: IssueViewer;
  issue: IssueRef;
  project: IssueProjectRef;
  stage: IssueLaunchStage;
  sessionId?: string;
  flow?: IssueFlowRef;
  initialTurn: { key: string; state: "unsent" | "unknown" } | { key: string; state: "accepted"; turnId: string };
}

export interface IssueWorkspace {
  issue: IssueRef;
  viewer: IssueViewer;
  projects: IssueProjectRef[];
  flows: IssueFlowRef[];
  session?: IssueSessionRef;
  launch?: IssueLaunch;
  initialTurn?: { launchId: string; text: string };
  question?: { id: string; sessionId: string };
  problem?: {
    code: "project_required" | "project_ambiguous" | "account_mismatch" | "source_unavailable"
      | "rate_limited" | "tasks_module_unavailable" | "capability_missing" | "flow_choice_required"
      | "session_leased" | "launch_outcome_unknown" | "resume_required";
    message: string;
  };
}

// Keys are injective tuples even for opaque node IDs containing punctuation.
export function issueKey(issue: Pick<IssueRef, "host" | "nodeId">): string {
  return JSON.stringify([issue.host.toLowerCase(), issue.nodeId]);
}

export function issueViewerKey(viewer: IssueViewer): string {
  return JSON.stringify([viewer.host.toLowerCase(), viewer.nodeId]);
}

/** Package discovery is shared by all authorized viewers of one clone. */
export function issueFlowKey(cloneId: string, issue: IssueRef): string {
  return JSON.stringify([cloneId, issue.host.toLowerCase(), issue.nodeId]);
}

/** Private discussions belong to a local profile and authenticated viewer. */
export function issueSessionKey(profile: string, viewer: IssueViewer, cloneId: string, issue: IssueRef): string {
  return JSON.stringify([profile, issueViewerKey(viewer), issueFlowKey(cloneId, issue)]);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Compare legacy URL-only Flow sources against an independently resolved issue. Never fetch this URL. */
function matchesIssueUrl(input: string, issue: Pick<IssueRef, "host" | "owner" | "repo" | "number">): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.host !== issue.host.toLowerCase()) return false;
  const match = /^\/([a-z\d_.-]+)\/([a-z\d_.-]+)\/issues\/([1-9]\d*)\/?$/i.exec(url.pathname);
  return !!match && match[1]!.toLowerCase() === issue.owner.toLowerCase()
    && match[2]!.toLowerCase() === issue.repo.toLowerCase() && Number(match[3]) === issue.number;
}

export function matchesIssueSource(source: { type: string; ref: string | null }, issue: IssueRef): boolean {
  return source.type === "github-issue" && typeof source.ref === "string" && matchesIssueUrl(source.ref, issue);
}

export function isIssueViewer(value: unknown): value is IssueViewer {
  return object(value) && text(value.host) && text(value.nodeId) && text(value.login);
}

export function isIssueRef(value: unknown): value is IssueRef {
  if (!object(value) || !text(value.host) || !text(value.nodeId) || !text(value.repositoryId)
    || !text(value.owner) || !text(value.repo) || !text(value.url) || typeof value.number !== "number"
    || !Number.isSafeInteger(value.number) || value.number < 1) return false;
  return matchesIssueUrl(value.url, { host: value.host, owner: value.owner, repo: value.repo, number: value.number });
}
