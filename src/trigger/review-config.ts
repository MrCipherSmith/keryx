// Flow 424 (AC9): the configuration block of a scheduled autonomous review.
//
// Like the digest, a scheduled review is NOT a second scheduler: it is a flow 295 `agent-task`
// schedule entry that carries one extra optional block, `action.review`. `confirmedHash` is an
// HMAC over the whole stored action, so the pull request and the budgets are covered by the
// operator's confirmation: editing them behind an installed timer makes the entry refuse to run.
// Unlike the digest, the OS timer fires it (`keryx trigger run <name>`), because a review is long.
//
// Pure: no I/O.

export const REVIEW_STALL_MINUTES_DEFAULT = 10;

const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/;

export interface ReviewConfig {
  /** The pull request URL reviewed on every fire. */
  readonly ref: string;
  readonly budgetMinutes?: number;
  readonly budgetTokens?: number;
  readonly stallMinutes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every problem with a raw `action.review` block; empty means valid. `undefined` (no block) is valid. */
export function reviewConfigProblems(raw: unknown, action: { readonly digest?: unknown } | undefined): string[] {
  if (raw === undefined) return [];
  if (!isRecord(raw)) return ["action.review: must be an object { ref, budgetMinutes?, budgetTokens?, stallMinutes? }"];
  const problems: string[] = [];
  const known = new Set(["ref", "budgetMinutes", "budgetTokens", "stallMinutes"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) problems.push(`action.review.${key}: unknown field (known: ref, budgetMinutes, budgetTokens, stallMinutes)`);
  }
  if (typeof raw["ref"] !== "string" || !PR_URL.test(raw["ref"].trim())) {
    problems.push("action.review.ref: must be a pull request URL (https://github.com/<owner>/<repo>/pull/<number>)");
  }
  for (const key of ["budgetMinutes", "stallMinutes"] as const) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      problems.push(`action.review.${key}: must be a positive number`);
    }
  }
  const tokens = raw["budgetTokens"];
  if (tokens !== undefined && (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens <= 0)) {
    problems.push("action.review.budgetTokens: must be a positive whole number");
  }
  if (action?.digest !== undefined) problems.push("action.review: cannot be combined with action.digest");
  return problems;
}

/** Fill the defaults of a (validated) block. */
export function normalizeReviewConfig(raw: unknown): ReviewConfig | undefined {
  if (!isRecord(raw) || typeof raw["ref"] !== "string") return undefined;
  return {
    ref: raw["ref"].trim(),
    ...(typeof raw["budgetMinutes"] === "number" ? { budgetMinutes: raw["budgetMinutes"] } : {}),
    ...(typeof raw["budgetTokens"] === "number" ? { budgetTokens: raw["budgetTokens"] } : {}),
    stallMinutes: typeof raw["stallMinutes"] === "number" ? raw["stallMinutes"] : REVIEW_STALL_MINUTES_DEFAULT,
  };
}
