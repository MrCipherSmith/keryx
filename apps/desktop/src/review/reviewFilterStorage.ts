import { CI_LABEL, DECISION_LABEL, EMPTY_FILTERS, REVIEW_PERIODS, STATE_LABEL, type Dimension, type Filters } from "./model";

// GitHub's repository node ID is stable across aliases and renames.
export function reviewFilterKey(cwd: string, repositoryId: string, viewer: string): string {
  return JSON.stringify(["keryx.review.filters", cwd, repositoryId, viewer.toLowerCase()]);
}

const allowed: Partial<Record<Dimension, ReadonlySet<string>>> = {
  state: new Set(Object.keys(STATE_LABEL)),
  decision: new Set([...Object.keys(DECISION_LABEL), ":none"]),
  ci: new Set(Object.keys(CI_LABEL)),
};

export function readReviewFilters(key: string): Filters {
  try {
    const value = localStorage.getItem(key);
    if (!value) return EMPTY_FILTERS;
    const record = JSON.parse(value);
    if (record?.version !== 1 || !record.filters || typeof record.filters !== "object" || Array.isArray(record.filters)) return EMPTY_FILTERS;
    const filters = { ...EMPTY_FILTERS };
    for (const dim of Object.keys(EMPTY_FILTERS) as Dimension[]) {
      if (!Object.hasOwn(record.filters, dim)) continue;
      const values: unknown = record.filters[dim];
      const choices = allowed[dim];
      if (!Array.isArray(values) || !values.every(value => typeof value === "string" && (!choices || choices.has(value)))) return EMPTY_FILTERS;
      filters[dim] = [...new Set<string>(values)];
    }
    const period = REVIEW_PERIODS.find(days => days === record.filters.updatedWithin);
    if (period) filters.updatedWithin = period;
    return filters;
  } catch {
    return EMPTY_FILTERS;
  }
}

export function saveReviewFilters(key: string, filters: Filters): void {
  try {
    if (filters === EMPTY_FILTERS) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ version: 1, filters }));
  } catch { /* Restricted or full storage still allows filtering the current board. */ }
}
