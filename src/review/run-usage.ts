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
  /** Known charges by currency when the complete cost cannot be totaled. */
  reportedCosts?: ReviewMoney[];
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
function saneMoney(value: unknown): value is ReviewMoney {
  return record(value) && typeof value.amount === "number" && Number.isFinite(value.amount) && value.amount >= 0 &&
    typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency);
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
  for (const key of ["cost", "estimatedCost"] as const) {
    const charge = raw[key];
    if (saneMoney(charge)) counts[key] = { amount: charge.amount, currency: charge.currency };
  }
  if (!counts.cost && Array.isArray(raw.reportedCosts)) {
    const charges = raw.reportedCosts.filter(saneMoney).map(({ amount, currency }) => ({ amount, currency }));
    if (charges.length) counts.reportedCosts = charges;
  }
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
  if (!sum.cost && (a.cost || b.cost || a.reportedCosts || b.reportedCosts)) {
    const subtotals = new Map<string, number>();
    for (const counts of [a, b]) {
      for (const charge of counts.cost ? [counts.cost] : counts.reportedCosts ?? []) {
        subtotals.set(charge.currency, (subtotals.get(charge.currency) ?? 0) + charge.amount);
      }
    }
    if (subtotals.size) sum.reportedCosts = Array.from(subtotals, ([currency, amount]) => ({ amount, currency }));
  }
  return sum;
}
interface UsageRange {
  first: number;
  counts: ReviewUsageCounts;
  partial: boolean;
}

/** Ordered subtotal tree. A receipt replacement changes one leaf and its ancestors. */
export class UsageRanges {
  private readonly levels = [new Map<number, UsageRange>()];

  set(index: number, range: UsageRange | undefined): void {
    for (let level = 0; ; level++) {
      const nodes = this.levels[level] ?? (this.levels[level] = new Map());
      if (range) nodes.set(index, range);
      else nodes.delete(index);
      if (index === 0 && level === this.levels.length - 1 && nodes.size <= 1) return;
      index = Math.floor(index / 2);
      const left = nodes.get(index * 2);
      const right = nodes.get(index * 2 + 1);
      range = left && right ? {
        first: left.first,
        counts: sumCounts(left.counts, right.counts),
        partial: left.partial || right.partial,
      } : left ?? right;
    }
  }

  get total(): UsageRange | undefined {
    return this.levels.at(-1)?.get(0);
  }
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
  if (v.reportedCosts !== undefined && !(Array.isArray(v.reportedCosts) && v.reportedCosts.every(saneMoney))) return false;
  return tokenFields.every(key => v[key] === undefined || (typeof v[key] === "number" && Number.isSafeInteger(v[key]) && v[key] >= 0)) &&
    ["cost", "estimatedCost"].every(key => v[key] === undefined || saneMoney(v[key]));
}

export function validRunUsage(value: unknown): value is ReviewRunUsage {
  return record(value) && typeof value.partial === "boolean" && validUsageCounts(value.total) && validUsageCounts(value.coordinator) &&
    Array.isArray(value.reviewers) && value.reviewers.every(row => record(row) && typeof row.reviewer === "string" &&
      (row.partial === undefined || row.partial === true) && (row.source === undefined || row.source === "external-runtime") &&
      (row.model === undefined || typeof row.model === "string") && (row.provider === undefined || typeof row.provider === "string") && validUsageCounts(row));
}
