import { createHash } from "node:crypto";
import { MIN_SLICE_MAX_BYTES, type SliceEntry, type SliceManifest, packWaves, resliceText, waveBytesOf } from "./slice";
import { type WaveSummary, requiredSlices, sliceGraph, summarizeWaves } from "./waves";

/** Statuses that mean the reviewer did not finish its scope. INCOMPLETE is not a schema status; a reviewer that ran out of rounds reports it. */
export const RETRYABLE_STATUSES: readonly string[] = ["INCOMPLETE", "BLOCKED"];

/** Failed rounds one reviewer may be handed in total, whatever progress each made. */
export const MAX_RETRY_ROUNDS = 6;
/** Consecutive results that add no newly covered slice before the reviewer is `not-run`. */
export const MAX_STALLED_RESULTS = 2;

export type ReviewerRetryState = {
  /** Failed rounds handed out so far (retry and context decisions). Unfinished results that moved the scope forward still count here, against MAX_RETRY_ROUNDS. */
  attempt: number;
  status: string;
  notRun: boolean;
  /** Consecutive results that covered nothing new. Absent in a state written before progress was tracked: `attempt` stands in. */
  stalls?: number;
  /** Slice ids this reviewer has reported covering, across every result. */
  covered?: string[];
};

export type RetryState = {
  schemaVersion: 1;
  scopeFingerprint?: string;
  reviewers: Record<string, ReviewerRetryState>;
};

export type ReviewerResult = {
  reviewer?: string;
  status?: string;
  /** Scope identity from the dispatch that produced this result. */
  scopeFingerprint?: string;
  attempt?: number;
  /** The slices this result covered: id strings, or objects carrying an `id` (reviewers write both). */
  slices?: unknown;
  needs_context?: string[];
};

export type RetryDecision = "accepted" | "retry" | "context" | "wave" | "not-run";

export type RetryPlan = {
  decision: RetryDecision;
  reviewer: string;
  status: string;
  /** Failed rounds already spent before this result. */
  priorAttempts: number;
  reason: string;
  /** Present when decision is `not-run`: the line the report carries so the gap is never read as a clean pass. */
  reportLine?: string;
  /** Smaller slices a retry cut, each with its own text, to be appended to the manifest. Present when this result made no progress. */
  newSlices: Array<SliceEntry & { text: string }>;
  /** Present when decision is `context`: what the reviewer asked for, to be supplied in one re-dispatch. */
  needsContext?: string[];
  /** What to dispatch now: the next wave, no more than the manifest's wave budget. */
  wave: SliceEntry[];
  /** Everything still to hand out, this wave included. */
  remaining: WaveSummary;
  /** True when this result covered a slice the reviewer had not covered before; an attempt is not spent on it. */
  progress: boolean;
  /** Consecutive results with no new coverage, this one included. */
  stalls: number;
  state: RetryState;
};

/** Retry children do not change the original scope identity. Missing content identity fails closed. */
export function scopeFingerprint(manifest: SliceManifest, read?: (entry: SliceEntry) => string): string | undefined {
  const originals = manifest.slices.filter((entry) => entry.retryOf === undefined);
  const slices = originals.map((entry) => {
    const contentHash = read === undefined ? entry.contentHash : createHash("sha256").update(read(entry)).digest("hex");
    return { ...entry, contentHash };
  });
  if (slices.some((entry) => entry.contentHash === undefined)) return undefined;
  return createHash("sha256").update(JSON.stringify({ source: manifest.source, maxBytes: manifest.maxBytes, waveBytes: manifest.waveBytes, omissions: manifest.omissions, slices })).digest("hex");
}

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
  /** Slice ids the reviewer was assigned. Falls back to the slices its path gate requires. */
  sliceIds?: string[];
  /** Slices covered by earlier results that this result does not list. */
  covered?: string[];
  /** Plan the next wave even when the result is finished or absent. Without a result nothing is counted as a stall. */
  nextWave?: boolean;
  state: RetryState;
  readSliceText: (entry: SliceEntry) => string;
};

const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : []);

/** Slice ids of a reviewer's `slices`: each entry is an id string or an object with a string `id`. Anything else is counted, not read. */
export function readSliceIds(value: unknown): { ids: string[]; unusable: number } {
  if (!Array.isArray(value)) return { ids: [], unusable: 0 };
  const ids = new Set<string>();
  let unusable = 0;
  for (const entry of value) {
    const id = typeof entry === "string" ? entry : entry !== null && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id.trim() !== "") ids.add(id);
    else unusable += 1;
  }
  return { ids: [...ids], unusable };
}

/**
 * Decide what follows a reviewer result.
 *
 * An attempt is spent only by a result that covered no slice the reviewer had not covered before. A reviewer that
 * moves the scope forward is handed the next wave of what is still uncovered, as it was cut, and is not penalised;
 * two results in a row with nothing new, or MAX_RETRY_ROUNDS failed rounds in all, make it `not-run`. A reviewer that
 * stalls gets the uncovered slices re-cut at half the size and a halved wave. Only the operator can accept a smaller
 * set than that, with their own quote, at `review complete`.
 */
export function planRetry(input: PlanRetryInput): RetryPlan {
  const { manifest, result, reviewer } = input;
  const status = String(result.status ?? "").toUpperCase();
  const fingerprint = scopeFingerprint(manifest, input.readSliceText);
  const current = fingerprint !== undefined && input.state.scopeFingerprint === fingerprint;
  const incoming = readSliceIds(result.slices);
  const hasIncoming = status !== "" || result.attempt !== undefined || incoming.ids.length > 0 || asStrings(input.covered).length > 0;
  const hasPriorScope = input.state.scopeFingerprint !== undefined || Object.keys(input.state.reviewers).length > 0;
  if (hasIncoming && (
    (result.scopeFingerprint !== undefined && result.scopeFingerprint !== fingerprint) ||
    (!current && hasPriorScope && result.scopeFingerprint !== fingerprint)
  )) {
    throw new Error("Reviewer result is not bound to the current scope; re-dispatch before importing coverage or attempts.");
  }
  if (result.reviewer !== undefined && result.reviewer !== reviewer) {
    throw new Error("Reviewer result belongs to a different reviewer.");
  }

  const known = current ? input.state.reviewers[reviewer] : undefined;
  const resultAttempt = Number.isInteger(result.attempt) ? (result.attempt as number) : 0;
  const priorRounds = Math.max(known?.attempt ?? 0, resultAttempt);
  const priorStalls = Math.max(known?.stalls ?? known?.attempt ?? 0, resultAttempt);
  const state: RetryState = { schemaVersion: 1, ...(fingerprint === undefined ? {} : { scopeFingerprint: fingerprint }), reviewers: current ? { ...input.state.reviewers } : {} };

  const ids = new Set(manifest.slices.map((entry) => entry.id));
  const priorCovered = new Set(known?.covered ?? []);
  const reportedSlices = [...incoming.ids, ...asStrings(input.covered)];
  const reported = reportedSlices.filter((id) => ids.has(id));
  const covered = new Set([...priorCovered, ...reported]);
  const progress = reported.some((id) => !priorCovered.has(id));
  const evaluated = status !== "";
  const stalls = !evaluated ? priorStalls : progress ? 0 : priorStalls + 1;

  const graph = sliceGraph(manifest, reviewer);
  const wanted = input.sliceIds ?? requiredSlices(manifest, reviewer);
  const open = graph.open(wanted.filter((id) => ids.has(id)), graph.accounted(covered));
  const budget = waveBytesOf(manifest);

  const remember = (over: Partial<ReviewerRetryState>): void => {
    state.reviewers[reviewer] = { attempt: priorRounds, status: evaluated ? status : (known?.status ?? ""), notRun: false, stalls, covered: [...covered].sort(), ...over };
  };
  const plan = (decision: RetryDecision, reason: string, extra: Partial<RetryPlan> = {}): RetryPlan => {
    const waves = packWaves(open, budget);
    return {
      decision,
      reviewer,
      status,
      priorAttempts: priorRounds,
      reason: incoming.unusable === 0 ? reason : `${reason}; ${incoming.unusable} slice entr${incoming.unusable === 1 ? "y" : "ies"} without a usable id ignored`,
      newSlices: [],
      wave: waves[0] ?? [],
      remaining: summarizeWaves(waves),
      progress,
      stalls,
      state,
      ...extra,
    };
  };
  const notRun = (reason: string): RetryPlan => {
    remember({ notRun: true });
    return plan("not-run", reason, { reportLine: notRunLine(reviewer, status), wave: [], remaining: summarizeWaves([]) });
  };

  const hasContext = asStrings(result.needs_context).some((item) => item.trim() !== "");
  const planningOnly = status === "" && input.nextWave === true;
  const finished = !hasContext && (status === "DONE" || status === "DONE_WITH_CONCERNS" || planningOnly);
  if (!finished && status !== "NEEDS_CONTEXT" && !RETRYABLE_STATUSES.includes(status) && !hasContext) return notRun(`unrecognized or missing reviewer status: ${status || "missing"}`);
  if (finished) {
    const informed = input.nextWave === true || reportedSlices.length > 0 || Array.isArray(result.slices);
    if (!informed) {
      return plan("accepted", `${status || "no status"} is a finished result`, { wave: [], remaining: summarizeWaves([]) });
    }
    if (open.length === 0) {
      remember({ stalls: 0 });
      return plan("accepted", `${status || "no status"} is a finished result and every assigned slice is covered`, { wave: [], remaining: summarizeWaves([]), stalls: 0 });
    }
    if (stalls >= MAX_STALLED_RESULTS) {
      return notRun(`${stalls} results in a row covered no new slice; ${open.length} assigned slice(s) are still open`);
    }
    remember({});
    const waves = packWaves(open, budget);
    const summary = summarizeWaves(waves);
    return plan("wave", `${status || "no result"}; ${summary.slices} slice(s) are uncovered — dispatch the next wave (${summary.waves} left), no attempt is spent`);
  }

  if (stalls >= MAX_STALLED_RESULTS) {
    return notRun(`${status} again with no new slice covered (${stalls} results in a row)`);
  }
  if (priorRounds >= MAX_RETRY_ROUNDS) {
    return notRun(`${status} after ${priorRounds} failed rounds, the most a reviewer is handed`);
  }
  const rounds = priorRounds + 1;

  if (status === "NEEDS_CONTEXT" || hasContext) {
    // The reviewer stopped to ask. Folding that into the verdict as finished is the false pass this exists to prevent:
    // the questions are put to it, and a reviewer that asks again having covered nothing new is a gap, not a pass.
    remember({ attempt: rounds });
    const needsContext = asStrings(result.needs_context).filter((item) => item.trim() !== "");
    const redo = open.length > 0 ? open : graph.open(wanted.filter((id) => ids.has(id)), new Set());
    const waves = packWaves(redo, budget);
    return plan("context", `${status}; answer ${needsContext.length || "its"} open question(s) and re-dispatch ${progress ? "the uncovered slices" : "the same slices"} — the scope is not closed`, {
      needsContext,
      wave: waves[0] ?? [],
      remaining: summarizeWaves(waves),
    });
  }

  if (open.length === 0) {
    return notRun("every assigned slice is reported covered or none is in the manifest, so there is nothing left to hand out");
  }

  if (progress) {
    remember({ attempt: rounds });
    const waves = packWaves(open, budget);
    const summary = summarizeWaves(waves);
    return plan("retry", `${status}, but it covered new slices; hand out the next wave of the ${summary.slices} still uncovered (${summary.waves} left), no attempt is spent`);
  }

  const largest = Math.max(...open.map((entry) => entry.bytes));
  const target = Math.min(Math.floor(manifest.maxBytes / 2), Math.floor(largest / 2));
  if (target < MIN_SLICE_MAX_BYTES) {
    return notRun(`the largest open slice is ${largest} bytes, too small to cut in half`);
  }
  const prefix = `r${rounds}-${safeReviewerName(reviewer)}`;
  const pieces = resliceText(open.map(input.readSliceText), target, { prefix });
  const newSlices = pieces.map((piece) => ({
    ...piece,
    retryOf: open.map((entry) => entry.id),
    attempt: rounds,
    reviewer,
  }));
  const shrunk = Math.max(Math.max(...pieces.map((piece) => piece.bytes)), Math.floor(budget / 2 ** stalls));
  const waves = packWaves(pieces, shrunk);
  remember({ attempt: rounds });
  return plan("retry", `${status} with nothing new covered; re-cut ${open.length} open slice(s) of up to ${largest} bytes into ${newSlices.length} of up to ${target} bytes, ${waves.length} wave(s) of at most ${shrunk} bytes`, {
    newSlices,
    wave: waves[0] ?? [],
    remaining: summarizeWaves(waves),
  });
}
