import { useState } from "react";
import { Dialog } from "../components/ui";
import { defaultFilters, filterChoices, toggleChoice, UNASSIGNED, type Filters, type ProjectBoard } from "./model";

/** The logins the Author and Assignee groups offer (`issuePeople`). */
export interface IssuePeople { authors: string[]; assignees: string[] }

export function IssueFilters({ filters, project, people, apply, close }: {
  filters: Filters; project?: ProjectBoard; people: IssuePeople; apply: (filters: Filters) => void; close: () => void;
}) {
  const [draft, setDraft] = useState(filters);
  const field = (key: keyof Filters, value: string) => setDraft(prev => ({ ...prev, [key]: value }));
  const group = (key: "author" | "assignee", title: string, values: string[]) => {
    const chosen = filterChoices(draft[key]).map(value => value.toLowerCase());
    return <fieldset>
      <legend>{title}</legend>
      <div className="review-filter-values">
        {values.map(value => <label key={value}>
          <input type="checkbox" checked={chosen.includes(value.toLowerCase())}
            onChange={() => setDraft(prev => ({ ...prev, [key]: toggleChoice(prev[key], value) }))} />
          <span>{value}</span>
        </label>)}
        {!values.length && <small>No values available</small>}
      </div>
    </fieldset>;
  };
  return <Dialog title="Filter issues" icon="list" onClose={close} width={540} footer={<>
    <button className="btn" onClick={() => setDraft({ ...defaultFilters, text: draft.text })}>Reset filters</button>
    <button className="btn" onClick={close}>Cancel</button>
    <button className="btn btn-primary" onClick={() => apply(draft)}>Apply filters</button>
  </>}>
    <div className="issue-filter-grid">
      <label>GitHub state<select value={draft.state} onChange={e => field("state", e.target.value)}>
        <option value="all">All states</option><option value="open">Open</option><option value="closed">Closed</option>
      </select></label>
      <label>Updated since<input type="date" value={draft.since} onChange={e => field("since", e.target.value)} /></label>
      <label>Sort by update<select value={draft.sort} onChange={e => field("sort", e.target.value)}>
        <option value="desc">Newest first</option><option value="asc">Oldest first</option>
      </select></label>
      {([["repository", "Repository", "owner/repo"], ["label", "Label", "Label name"]] as const).map(([key, title, hint]) => <label key={key}>{title}
          <input value={draft[key]} placeholder={hint} onChange={e => field(key, e.target.value)} /></label>)}
      {project && <label>Project Status<select value={draft.status} onChange={e => field("status", e.target.value)}>
        <option value="">All statuses</option><option value="unassigned">No status</option>
        {project.options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select></label>}
    </div>
    <div className="review-filter-groups issue-filter-people">
      {group("author", "Author", people.authors)}
      {group("assignee", "Assignee", [UNASSIGNED, ...people.assignees])}
    </div>
    <p className="review-filter-hint">Leave Author or Assignee unchecked to include everyone; the people listed are those on the loaded issues. Use commas for multiple repositories or labels.</p>
  </Dialog>;
}
