import { issueKey, type IssueLocalStage, type IssueScope, type IssueSummary } from "../../../../src/integrations/issues-contract";

export const STAGES: Record<IssueLocalStage["stage"], string> = {
  none: "No Flow", preparing: "Preparing", active: "In progress", needs_answer: "Needs an answer", done: "Done",
};

export const SOURCES: Record<IssueScope | "project", string> = {
  assigned: "Assigned to me", created: "Created by me", mentioned: "Mentioned", subscribed: "Subscribed", project: "GitHub Project",
};

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
  stage: string;
  status: string;
}

export const defaultFilters: Filters = {
  text: "", state: "open", since: "", sort: "desc", repository: "", label: "", author: "", assignee: "", stage: "", status: "",
};

export function repoName(issue: IssueSummary): string { return issue.ref.owner + "/" + issue.ref.repo; }
export function issueName(issue: IssueSummary): string { return repoName(issue) + "#" + issue.ref.number; }

/** Each board groups by its owner's state; the issue's open/closed status remains an independent filter. */
export function groupForRow(row: Row, project: boolean): string {
  return project ? row.optionId ?? "unassigned" : row.issue.work?.stage ?? "none";
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
      && (!f.stage || (issue.work?.stage ?? "none") === f.stage)
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
      for (const k of ["text", "repository", "label", "author", "assignee", "stage", "status"] as const)
        if (typeof raw.filters[k] === "string") filters[k] = raw.filters[k];
      if (/^\d{4}-\d\d-\d\d$/.test(raw.filters.since)) filters.since = raw.filters.since;
      if (["open", "closed", "all"].includes(raw.filters.state)) filters.state = raw.filters.state;
      if (raw.filters.sort === "asc") filters.sort = "asc";
    }
    return { filters, list: raw?.list === true };
  } catch { return { filters, list: false }; }
}
