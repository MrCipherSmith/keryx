// Counts describe the observations the provider actually returned. Cache reads and writes
// are subsets of input. Missing prices and missing token counts are distinct from zero.
export interface ReviewMoney { amount: number; currency: string }
export interface ReviewUsageCounts {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: ReviewMoney;
  estimatedCost?: ReviewMoney;
}
export interface ReviewerUsage extends ReviewUsageCounts {
  reviewer: string;
  provider?: string;
  model?: string;
  source?: "external-runtime";
  partial?: true;
}
export interface ReviewRunUsage {
  total: ReviewUsageCounts;
  coordinator: ReviewUsageCounts;
  reviewers: ReviewerUsage[];
  partial: boolean;
}

const tokenFields = ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
function saneMoney(value?: ReviewMoney): value is ReviewMoney {
  return !!value && Number.isFinite(value.amount) && value.amount >= 0 && /^[A-Z]{3}$/.test(value.currency);
}
export function usageCounts(raw: ReviewUsageCounts): ReviewUsageCounts {
  const counts: ReviewUsageCounts = {};
  for (const key of tokenFields) {
    const value = raw[key];
    if (value !== undefined && Number.isSafeInteger(value) && value >= 0) counts[key] = value;
  }
  if (counts.totalTokens === undefined && (counts.inputTokens !== undefined || counts.outputTokens !== undefined)) {
    counts.totalTokens = (counts.inputTokens ?? 0) + (counts.outputTokens ?? 0);
  }
  for (const key of ["cost", "estimatedCost"] as const) if (saneMoney(raw[key])) counts[key] = raw[key];
  return counts;
}
export function sumCounts(a: ReviewUsageCounts | undefined, b: ReviewUsageCounts): ReviewUsageCounts {
  if (!a) return usageCounts(b);
  const sum: ReviewUsageCounts = {};
  for (const key of tokenFields) {
    if (a[key] !== undefined || b[key] !== undefined) sum[key] = (a[key] ?? 0) + (b[key] ?? 0);
  }
  for (const key of ["cost", "estimatedCost"] as const) {
    const l = a[key], r = b[key];
    if (l && r && l.currency === r.currency) sum[key] = { amount: l.amount + r.amount, currency: l.currency };
  }
  return sum;
}
export function sameReviewer(a: ReviewerUsage, b: ReviewerUsage): boolean {
  return a.reviewer === b.reviewer && a.provider === b.provider && a.model === b.model && a.source === b.source;
}
export function mergeRunUsage(a: ReviewRunUsage | undefined, b: ReviewRunUsage): ReviewRunUsage {
  if (a === undefined) return b;
  const reviewers = [...a.reviewers];
  for (const row of b.reviewers) {
    const i = reviewers.findIndex(it => sameReviewer(it, row));
    const prior = reviewers[i];
    if (!prior) reviewers.push(row);
    else {
      const { reviewer, provider, model, source } = row;
      reviewers[i] = { reviewer, ...(source ? { source } : {}), ...(provider ? { provider } : {}), ...(model ? { model } : {}),
        ...(prior.partial || row.partial ? { partial: true } : {}), ...sumCounts(prior, row) };
    }
  }
  return { total: sumCounts(a.total, b.total), coordinator: sumCounts(a.coordinator, b.coordinator), reviewers, partial: a.partial || b.partial };
}

function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }

export function validUsageCounts(v: unknown): v is ReviewUsageCounts {
  if (!record(v)) return false;
  return tokenFields.every(key => v[key] === undefined || (typeof v[key] === "number" && Number.isSafeInteger(v[key]) && v[key] >= 0)) &&
    ["cost", "estimatedCost"].every(key => v[key] === undefined || (record(v[key]) && typeof v[key].currency === "string"
      && typeof v[key].amount === "number" && saneMoney({ amount: v[key].amount, currency: v[key].currency })));
}

export function validRunUsage(value: unknown): value is ReviewRunUsage {
  return record(value) && typeof value.partial === "boolean" && validUsageCounts(value.total) && validUsageCounts(value.coordinator) &&
    Array.isArray(value.reviewers) && value.reviewers.every(row => record(row) && typeof row.reviewer === "string" &&
      (row.partial === undefined || row.partial === true) && (row.source === undefined || row.source === "external-runtime") &&
      (row.model === undefined || typeof row.model === "string") && (row.provider === undefined || typeof row.provider === "string") && validUsageCounts(row));
}
