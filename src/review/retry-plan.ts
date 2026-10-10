import { MIN_SLICE_MAX_BYTES, type SliceEntry, type SliceManifest, resliceText } from "./slice";

/** Statuses that mean the reviewer did not finish its scope. INCOMPLETE is not a schema status; a reviewer that ran out of rounds reports it. */
export const RETRYABLE_STATUSES: readonly string[] = ["INCOMPLETE", "BLOCKED"];

export type RetryState = {
  schemaVersion: 1;
  reviewers: Record<string, { attempt: number; status: string; notRun: boolean }>;
};

export type ReviewerResult = {
  reviewer?: string;
  status?: string;
  attempt?: number;
  slices?: string[];
  needs_context?: string[];
};

export type RetryDecision = "accepted" | "retry" | "context" | "not-run";

export type RetryPlan = {
  decision: RetryDecision;
  reviewer: string;
  status: string;
  /** Attempts already spent before this result. */
  priorAttempts: number;
  reason: string;
  /** Present when decision is `not-run`: the line the report carries so the gap is never read as a clean pass. */
  reportLine?: string;
  /** Smaller slices to dispatch, each with its own text. Present when decision is `retry`. */
  newSlices: Array<SliceEntry & { text: string }>;
  /** Present when decision is `context`: what the reviewer asked for, to be supplied in one re-dispatch of the same slices. */
  needsContext?: string[];
  state: RetryState;
};

export function emptyRetryState(): RetryState {
  return { schemaVersion: 1, reviewers: {} };
}

export function safeReviewerName(reviewer: string): string {
  return reviewer.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "reviewer";
}

export function notRunLine(reviewer: string, status: string): string {
  return `- **Not run:** ${reviewer} — ${status} after a smaller-slice retry; never counted as a clean pass`;
}

export type PlanRetryInput = {
  manifest: SliceManifest;
  result: ReviewerResult;
  reviewer: string;
  /** Slice ids the reviewer was assigned. Falls back to the result's, then to every slice. */
  sliceIds?: string[];
  state: RetryState;
  readSliceText: (entry: SliceEntry) => string;
};

/**
 * Decide what follows a reviewer that did not finish.
 *
 * One retry on slices half the size, then it is `not-run`. A third dispatch of
 * the same reviewer would spend the same budget on the same input, and an
 * INCOMPLETE reviewer folded into the verdict is the false pass this exists to
 * prevent.
 */
export function planRetry(input: PlanRetryInput): RetryPlan {
  const { manifest, result, reviewer } = input;
  const status = String(result.status ?? "").toUpperCase();
  const known = input.state.reviewers[reviewer];
  const priorAttempts = Math.max(known?.attempt ?? 0, Number.isInteger(result.attempt) ? (result.attempt as number) : 0);
  const state: RetryState = { schemaVersion: 1, reviewers: { ...input.state.reviewers } };

  if (status === "NEEDS_CONTEXT") {
    // The reviewer stopped to ask. Folding that into the verdict as finished is the false pass this exists to prevent:
    // the questions are put to it once, with the same slices, and a second ask is a gap, not a pass.
    if (priorAttempts >= 1) {
      state.reviewers[reviewer] = { attempt: priorAttempts, status, notRun: true };
      return { decision: "not-run", reviewer, status, priorAttempts, reason: `${status} again after ${priorAttempts} re-dispatch with context`, reportLine: notRunLine(reviewer, status), newSlices: [], state };
    }
    state.reviewers[reviewer] = { attempt: priorAttempts + 1, status, notRun: false };
    const needsContext = (result.needs_context ?? []).filter((item) => typeof item === "string" && item.trim() !== "");
    return {
      decision: "context",
      reviewer,
      status,
      priorAttempts,
      reason: `${status}; answer ${needsContext.length || "its"} open question(s) and re-dispatch the same slices once — the scope is not closed`,
      newSlices: [],
      needsContext,
      state,
    };
  }

  if (!RETRYABLE_STATUSES.includes(status)) {
    return { decision: "accepted", reviewer, status, priorAttempts, reason: `${status || "no status"} is a finished result`, newSlices: [], state };
  }

  const notRun = (reason: string): RetryPlan => {
    state.reviewers[reviewer] = { attempt: priorAttempts, status, notRun: true };
    return { decision: "not-run", reviewer, status, priorAttempts, reason, reportLine: notRunLine(reviewer, status), newSlices: [], state };
  };

  if (priorAttempts >= 1) {
    return notRun(`${status} again after ${priorAttempts} retry`);
  }

  const wanted = input.sliceIds ?? result.slices ?? manifest.slices.map((entry) => entry.id);
  const assigned = manifest.slices.filter((entry) => wanted.includes(entry.id));
  if (assigned.length === 0) {
    return notRun("no assigned slice is in the manifest, so there is nothing to cut smaller");
  }

  const largest = Math.max(...assigned.map((entry) => entry.bytes));
  const target = Math.min(Math.floor(manifest.maxBytes / 2), Math.floor(largest / 2));
  if (target < MIN_SLICE_MAX_BYTES) {
    return notRun(`the largest assigned slice is ${largest} bytes, too small to cut in half`);
  }

  const prefix = `r${priorAttempts + 1}-${safeReviewerName(reviewer)}`;
  const pieces = resliceText(assigned.map(input.readSliceText), target, { prefix });
  const newSlices = pieces.map((piece) => ({
    ...piece,
    retryOf: assigned.map((entry) => entry.id),
    attempt: priorAttempts + 1,
    reviewer,
  }));
  state.reviewers[reviewer] = { attempt: priorAttempts + 1, status, notRun: false };
  return {
    decision: "retry",
    reviewer,
    status,
    priorAttempts,
    reason: `${status}; re-cut ${assigned.length} slice(s) of up to ${largest} bytes into ${newSlices.length} of up to ${target} bytes`,
    newSlices,
    state,
  };
}
