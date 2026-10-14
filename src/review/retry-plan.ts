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
  /** The open questions of the last NEEDS_CONTEXT this reviewer sent, normalised; a second one that repeats them shows no progress. */
  questions?: string[];
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
  /** The slices this result covered: id strings, or objects carrying an `id` (reviewers write both). An object whose `status` is set and not done-like does not cover its slice. */
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

/** The reason a role that asked for context twice is `not-run`: the host cannot supply what it needs. `review-layout` needs a browser. */
export function noEngineReason(reviewer: string): string {
  return reviewer === "review-layout" ? "layout: no engine" : "no engine";
}

/** Words that say a question needs a browser or a rendering engine, and words that say the reviewer can do without one. */
const ENGINE_TERMS = /\b(browser|playwright|chromium|puppeteer|headless|screenshot|rendered?|rendering|storybook|dev server|engine)\b/i;
const ENGINE_FREE = /\b(without|no need for|instead of)\b[^.\n]{0,24}\b(browser|engine|render\w*)\b|\bsource[- ]only\b|\bstatic(ally)?\b/i;

/**
 * Why a second NEEDS_CONTEXT with nothing new is `not-run`. The host-has-no-engine reason is kept only when the questions
 * ask for a browser or engine and name no route that works without one; anything else is a plain lack of progress.
 */
export function stalledContextReason(reviewer: string, questions: string[]): string {
  const text = questions.join("\n");
  return ENGINE_TERMS.test(text) && !ENGINE_FREE.test(text) ? noEngineReason(reviewer) : "no progress after one context refill";
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

/** An object entry in a reviewer's `slices` covers its slice only when it carries no status or one of these. */
const DONE_SLICE_STATUSES = new Set(["DONE", "COMPLETE", "COMPLETED", "COVERED", "OK"]);

export type SliceReading = {
  /** Ids that count: strings, and objects whose status is absent or done-like. */
  ids: string[];
  /** Entries with no usable id. */
  unusable: number;
  /** Objects with an id whose status says the slice was not finished; the id is not in `ids` unless another entry covers it. */
  notCovered: Array<{ id: string; status: string }>;
};

/**
 * Slice ids of a `slices` list: each entry is an id string or an object with a string `id`. Anything else is counted, not read.
 * `covered` (a reviewer's result) reads an object's `status`; `assigned` (a driver's dispatch list) is an assignment, so it does not.
 * `retry-plan` and `ledger build` both read a result through this, so they cannot disagree on what a reviewer covered.
 */
export function readSliceIds(value: unknown, as: "covered" | "assigned" = "covered"): SliceReading {
  if (!Array.isArray(value)) return { ids: [], unusable: 0, notCovered: [] };
  const ids = new Set<string>();
  const notCovered = new Map<string, string>();
  let unusable = 0;
  for (const entry of value) {
    const object = entry !== null && typeof entry === "object" ? (entry as { id?: unknown; status?: unknown }) : undefined;
    const id = typeof entry === "string" ? entry : object?.id;
    if (typeof id !== "string" || id.trim() === "") { unusable += 1; continue; }
    const status = object?.status;
    if (as === "covered" && status !== undefined && status !== null && !(typeof status === "string" && (status.trim() === "" || DONE_SLICE_STATUSES.has(status.trim().toUpperCase())))) {
      notCovered.set(id, String(status));
    } else ids.add(id);
  }
  return { ids: [...ids], unusable, notCovered: [...notCovered].filter(([id]) => !ids.has(id)).map(([id, status]) => ({ id, status })) };
}

/** What a reading dropped, worded once for `retry-plan` and `ledger build`. */
export function sliceReadingNotes(reading: SliceReading): string[] {
  const notes: string[] = [];
  if (reading.unusable > 0) notes.push(`${reading.unusable} slice entr${reading.unusable === 1 ? "y" : "ies"} without a usable id ignored`);
  if (reading.notCovered.length > 0) {
    const shown = reading.notCovered.slice(0, 5).map((entry) => `${entry.id} (${entry.status})`).join(", ");
    const more = reading.notCovered.length > 5 ? `, … (+${reading.notCovered.length - 5})` : "";
    notes.push(`${reading.notCovered.length} slice(s) reported with a status that is not done, counted as uncovered: ${shown}${more}`);
  }
  return notes;
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
  const questions = [...new Set(asStrings(result.needs_context).map((item) => item.trim().replace(/\s+/g, " ").toLowerCase()).filter((item) => item !== ""))].sort();
  const asksForContext = status === "NEEDS_CONTEXT" || questions.length > 0;
  // A NEEDS_CONTEXT with a question it has not asked before moves the dispatch forward as a new slice does.
  const newQuestion = asksForContext && questions.some((item) => !(known?.questions ?? []).includes(item));
  const stalls = !evaluated ? priorStalls : progress || newQuestion ? 0 : priorStalls + 1;

  const graph = sliceGraph(manifest, reviewer);
  const wanted = input.sliceIds ?? requiredSlices(manifest, reviewer);
  const open = graph.open(wanted.filter((id) => ids.has(id)), graph.accounted(covered));
  const budget = waveBytesOf(manifest);

  const remember = (over: Partial<ReviewerRetryState>): void => {
    const asked = asksForContext ? questions : known?.questions;
    state.reviewers[reviewer] = { attempt: priorRounds, status: evaluated ? status : (known?.status ?? ""), notRun: false, stalls, covered: [...covered].sort(), ...(asked === undefined ? {} : { questions: asked }), ...over };
  };
  const plan = (decision: RetryDecision, reason: string, extra: Partial<RetryPlan> = {}): RetryPlan => {
    const waves = packWaves(open, budget);
    return {
      decision,
      reviewer,
      status,
      priorAttempts: priorRounds,
      reason: [reason, ...sliceReadingNotes(incoming)].join("; "),
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

  if (asksForContext && known?.status === "NEEDS_CONTEXT" && !known.notRun && !progress && !newQuestion) {
    // One refill is the contract. A second NEEDS_CONTEXT that covered no new slice and asks nothing new means the host
    // cannot supply it (a shell host has no browser for review-layout): record the gap as Not run instead of looping on
    // the same question. One that moved the scope or asked something new still gets its refill, within the usual bounds.
    const reason = stalledContextReason(reviewer, asStrings(result.needs_context));
    remember({ notRun: true });
    return plan("not-run", reason, { reportLine: `- **Not run:** ${reviewer} — ${reason}; it asked for context twice and nothing was supplied that moved it, never counted as a clean pass`, wave: [], remaining: summarizeWaves([]) });
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
