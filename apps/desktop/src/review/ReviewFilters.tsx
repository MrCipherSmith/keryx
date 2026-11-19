import { useMemo, useState } from "react";
import { Dialog } from "../components/ui";
import { CI_LABEL, DECISION_LABEL, EMPTY_FILTERS, STATE_LABEL, type Dimension, type Filters } from "./model";
import type { ReviewCard } from "./types";

const DIMENSIONS: Record<Dimension, string> = {
  state: "PR state", ci: "Checks on head commit", decision: "GitHub review decision",
  author: "Author", assignee: "Assignee", reviewer: "Review requested from",
};

function roleOptions(values: string[], extra: string[], emptyLabel?: string) {
  const entries = [...new Set([...values, ...extra])].filter((v) => v !== ":none").sort((a, b) => a.localeCompare(b));
  return Object.fromEntries([...(emptyLabel ? [[":none", emptyLabel]] : []), ...entries.map((v) => [v, v || "Unknown author"])]);
}

export function filterSummary(f: Filters): string[] {
  const result: string[] = [];
  for (const dim of Object.keys(DIMENSIONS) as Dimension[]) {
    const val = f[dim];
    if (dim === "state" && val.length === 2 && val.includes("open") && val.includes("draft")) continue;
    if (!val.length && dim !== "state") continue;
    const labels: Record<string, string> = dim === "state" ? STATE_LABEL : dim === "ci" ? CI_LABEL
      : dim === "decision" ? { ...DECISION_LABEL, ":none": "No decision" } : dim === "author" ? { "": "Unknown author" } : { ":none": "None" };
    result.push(DIMENSIONS[dim] + " · " + (val.map((v) => labels[v] ?? v).join(", ") || "All"));
  }
  return result;
}

interface Props {
  cards: ReviewCard[];
  filters: Filters;
  onClose: () => void;
  onApply: (filters: Filters) => void;
}

export function ReviewFilters({ cards, filters, onClose, onApply }: Props) {
  const [draft, setDraft] = useState(filters);
  const options = useMemo<Record<Dimension, Record<string, string>>>(() => ({
    author: roleOptions(cards.map(c => c.author), filters.author),
    assignee: roleOptions(cards.flatMap((c) => c.assignees), filters.assignee, "Unassigned"),
    reviewer: roleOptions(cards.flatMap((c) => c.reviewers), filters.reviewer, "No review requests"),
    decision: { ...DECISION_LABEL, ":none": "No decision" },
    state: STATE_LABEL, ci: CI_LABEL,
  }), [cards, filters]);

  function toggle(dim: Dimension, value: string) {
    setDraft((prev) => ({
      ...prev, [dim]: prev[dim].includes(value) ? prev[dim].filter((v) => v !== value) : [...prev[dim], value],
    }));
  }
  return <Dialog title="Filter pull requests" icon="checklist" width={640} onClose={onClose}
    footer={<>
      <button className="btn" onClick={() => setDraft(EMPTY_FILTERS)}>Reset filters</button>
      <div className="grow" />
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={() => onApply(draft)}>Apply filters</button>
    </>}>
    <p className="review-filter-hint">Leave a group unchecked to include all values.</p>
    <div className="review-filter-groups">
      {(Object.keys(DIMENSIONS) as Dimension[]).map((dim) => <fieldset key={dim}>
        <legend>{DIMENSIONS[dim]}</legend>
        <div className="review-filter-values">
          {Object.entries(options[dim]).map(([value, label]) => <label key={value}>
            <input type="checkbox" checked={draft[dim].includes(value)} onChange={() => toggle(dim, value)} />
            <span>{label}</span>
          </label>)}
          {!Object.keys(options[dim]).length && <small>No values available</small>}
        </div>
      </fieldset>)}
    </div>
  </Dialog>;
}
