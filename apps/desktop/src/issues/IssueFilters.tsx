import { useState } from "react";
import { Dialog } from "../components/ui";
import { defaultFilters, STAGES, type Filters, type ProjectBoard } from "./model";

export function IssueFilters({ filters, project, apply, close }: {
  filters: Filters; project?: ProjectBoard; apply: (filters: Filters) => void; close: () => void;
}) {
  const [draft, setDraft] = useState(filters);
  const field = (key: keyof Filters, value: string) => setDraft(prev => ({ ...prev, [key]: value }));
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
      <label>Keryx stage<select value={draft.stage} onChange={e => field("stage", e.target.value)}>
        <option value="">All stages</option>{Object.entries(STAGES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      {([["repository", "Repository", "owner/repo"], ["author", "Author", "GitHub login"], ["assignee", "Assignee", "Login or Unassigned"],
        ["label", "Label", "Label name"]] as const).map(([key, title, hint]) => <label key={key}>{title}
          <input value={draft[key]} placeholder={hint} onChange={e => field(key, e.target.value)} /></label>)}
      {project && <label>Project Status<select value={draft.status} onChange={e => field("status", e.target.value)}>
        <option value="">All statuses</option><option value="unassigned">No status</option>
        {project.options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select></label>}
    </div>
    <p className="review-filter-hint">Use commas for multiple repositories, authors, assignees or labels.</p>
  </Dialog>;
}
