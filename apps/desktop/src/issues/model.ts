import { issueKey, type IssueListSource, type IssueLocalStage, type IssueSummary } from "../../../../src/integrations/issues-contract";
import { boundSessions, type SessionInfo, type SessionSubject } from "../acp/types";

export const STAGES: Record<IssueLocalStage["stage"], string> = {
  none: "No Flow", preparing: "Preparing", active: "In progress", needs_answer: "Needs an answer", done: "Done",
};

/** Where the board reads issues from; the project repository comes first and is the default (D5). */
export const SOURCES: Record<IssueListSource | "project", string> = {
  repository: "Project repository", assigned: "Assigned to me", created: "Created by me", mentioned: "Mentioned", subscribed: "Subscribed", project: "GitHub Project",
};

export type IssueSource = keyof typeof SOURCES;
/** The source shown when no preference is stored for the account. */
export const DEFAULT_SOURCE: IssueSource = "repository";

export type ProjectSource = { owner: string; number: number };
export interface ProjectBoard {
  id: string;
  owner: string;
  number: number;
  title: string;
  fieldId: string | null;
  canWrite: boolean;
  options: { id: string; name: string }[];
}
export interface Row {
  issue: IssueSummary;
  itemId?: string;
  optionId?: string | null;
}
export interface Filters {
  text: string;
  state: "open" | "closed" | "all";
  since: string;
  sort: "asc" | "desc";
  repository: string;
  label: string;
  author: string;
  assignee: string;
  status: string;
}

export const defaultFilters: Filters = {
  text: "", state: "open", since: "", sort: "desc", repository: "", label: "", author: "", assignee: "", status: "",
};

export function repoName(issue: IssueSummary): string { return issue.ref.owner + "/" + issue.ref.repo; }
export function issueName(issue: IssueSummary): string { return repoName(issue) + "#" + issue.ref.number; }

/** A GitHub Project groups by its Status field; any other source groups by the issue's GitHub state. */
export function groupForRow(row: Row, project: boolean): string {
  return project ? row.optionId ?? "unassigned" : row.issue.state;
}

/** The board's lanes: the Project's Status options, or Open and, when the state filter includes closed issues, Closed. */
export function issueGroups(project: ProjectBoard | undefined, state: Filters["state"]): { id: string; label: string }[] {
  if (project) return [...project.options.map(o => ({ id: o.id, label: o.name })), { id: "unassigned", label: "No status" }];
  return [{ id: "open", label: "Open" }, ...(state === "open" ? [] : [{ id: "closed", label: "Closed" }])];
}

/** The Subject a session works on when it is bound to this issue. */
export function issueSubject(issue: IssueSummary): SessionSubject {
  return { kind: "issue", repo: repoName(issue), number: issue.ref.number, url: issue.ref.url, repositoryId: issue.ref.repositoryId };
}

/** The non-archived sessions bound to the issue through their `subject`, newest first. */
export function issueSessions(sessions: readonly SessionInfo[], issue: IssueSummary): SessionInfo[] {
  return boundSessions(sessions, issueSubject(issue));
}

export function mergeRows(previous: Row[], next: Row[]): Row[] {
  const rows = new Map(previous.map(row => [issueKey(row.issue.ref), row]));
  for (const row of next) rows.set(issueKey(row.issue.ref), row);
  return [...rows.values()];
}

function includesOption(filter: string, values: string[]): boolean {
  const choices = filter.toLowerCase().split(",").map(value => value.trim()).filter(Boolean);
  return !choices.length || values.some(value => choices.includes(value.toLowerCase()));
}

export function visibleRows(rows: Row[], f: Filters): Row[] {
  const query = f.text.trim().toLowerCase();
  const numberQuery = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/.exec(query);
  return rows.filter(({ issue, optionId }) => {
    const searchMatches = numberQuery
      ? issue.ref.number === Number(numberQuery[2]) && (!numberQuery[1] || numberQuery[1] === repoName(issue).toLowerCase())
      : issue.title.toLowerCase().includes(query) || issueName(issue).toLowerCase().includes(query);
    return searchMatches && (f.state === "all" || issue.state === f.state)
      && (!f.since || issue.updatedAt.slice(0, 10) >= f.since)
      && includesOption(f.repository, [repoName(issue)]) && includesOption(f.author, [issue.author])
      && includesOption(f.label, issue.labels) && includesOption(f.assignee, issue.assignees.length ? issue.assignees : ["Unassigned"])
      && (!f.status || (optionId ?? "unassigned") === f.status);
  }).sort((a, b) => {
    const dates = a.issue.updatedAt.localeCompare(b.issue.updatedAt);
    return (f.sort === "asc" ? dates : -dates) || issueKey(a.issue.ref).localeCompare(issueKey(b.issue.ref));
  });
}

export function readPreferences(key: string): { filters: Filters; list: boolean } {
  const filters = { ...defaultFilters };
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null");
    if (raw && typeof raw.filters === "object" && raw.filters) {
      // A stored Flow stage filter from an earlier version is ignored: the filter is gone.
      for (const k of ["text", "repository", "label", "author", "assignee", "status"] as const)
        if (typeof raw.filters[k] === "string") filters[k] = raw.filters[k];
      if (/^\d{4}-\d\d-\d\d$/.test(raw.filters.since)) filters.since = raw.filters.since;
      if (["open", "closed", "all"].includes(raw.filters.state)) filters.state = raw.filters.state;
      if (raw.filters.sort === "asc") filters.sort = "asc";
    }
    return { filters, list: raw?.list === true };
  } catch { return { filters, list: false }; }
}
