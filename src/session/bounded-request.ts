// Flow 393 AC3: the bounded request.
//
// On a host that keeps working memory (pruneArchive + an open slate), old rounds do not ride along
// forever. In batches, the history is rewritten to:
//
//   [Anchors frame] [memory frame] [kept operator/assistant text] [last K rounds verbatim]
//
// plus (outside this module) the system instruction and plan that the request builder adds. The
// frame is REPLACED each time (every earlier frame is dropped, never appended to). The window
// starts at a tool-calling assistant message, so every tool result in it has its call and every
// call its result: the pairing the providers demand stays valid. Everything dropped is still
// reachable: `archive.jsonl` keeps the originals, the Trail names every step, `recall_step` reads
// a saved output and `history_search` finds text.
//
// The operator's own messages are never lost: they are kept (long ones clipped) in order, because
// they are the one thing the Trail cannot reconstruct. The model's text-only replies and the
// newest compaction summary are kept within a small token budget.
//
// Pure: it returns the rewritten array, the caller decides whether to apply it (the cache-cost
// gate in `rewrite-gate.ts`) and splices it in.

import { estimateMessageTokens } from "../harness/provider/context-guard";
import type { NormalizedMessage } from "../harness/provider/types";
import { isOperatorMessage, SUMMARY_HEADER } from "./compact";
import { hasReplay, withoutReplay, REASONING_KEEP_ROUNDS } from "./prune";
import { pruneThresholdsForWindow } from "./rewrite-gate";
import { isSlateFrameMessage } from "./slate-frame";

/** Tool-calling rounds kept verbatim after a rewrite. */
export const BOUNDED_KEEP_ROUNDS = 8;
/** Rounds of slack before the next rewrite: one rewrite per this many rounds, not one per round. */
export const BOUNDED_BATCH_ROUNDS = 4;
/** The window never shrinks below this many rounds, whatever its size. */
export const BOUNDED_MIN_ROUNDS = 2;
/** A kept operator message is cut to this many characters. */
export const KEPT_OPERATOR_CHARS = 1500;
/** A kept assistant text reply is cut to this many characters. */
export const KEPT_ASSISTANT_CHARS = 1200;
/** Token budget for the kept operator and assistant text together (the newest two operator turns always stay). */
export const KEPT_TEXT_TOKENS = 6000;
/** Operator turns that are kept whatever the budget says. */
const ALWAYS_KEEP_OPERATOR = 2;

export interface BoundedOptions {
  keepRounds?: number;
  batchRounds?: number;
  /** Verbatim window size cap in tokens; default min(20K, 15% of the context window). */
  windowTokenCap?: number;
  contextWindow?: number;
  /** Rewrite now whatever the batch size (the request would not fit). */
  force?: boolean;
}

export interface BoundedPlan {
  /** The rewritten history (frames first). A new array; `history` is untouched. */
  next: NormalizedMessage[];
  /** Index in `history` where the verbatim window starts. */
  windowStart: number;
  /** Tool-calling rounds that left the request. */
  droppedRounds: number;
  /** Trail steps of the dropped tool results, ascending. */
  droppedSteps: number[];
  /** Messages of `history` that are not in `next`. */
  droppedMessages: number;
  /** Operator messages that were before the window and did not stay (oldest first, unclipped). */
  droppedOperators: NormalizedMessage[];
  /** Estimated tokens saved (history minus next, frames included). */
  savedTokens: number;
  /** First index at which `next` differs from `history`. */
  firstChangedIndex: number;
}

export function boundedWindowCap(contextWindow: number | undefined): number {
  return pruneThresholdsForWindow(contextWindow).minSavingTokens;
}

export function tokensOf(messages: readonly NormalizedMessage[]): number {
  let t = 0;
  for (const m of messages) t += estimateMessageTokens(m);
  return t;
}

/** Indices of the assistant messages that made tool calls (a collapsed record has none). */
export function roundIndices(history: readonly NormalizedMessage[]): number[] {
  const out: number[] = [];
  history.forEach((m, i) => {
    if (m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0) out.push(i);
  });
  return out;
}

/** The exact `history_search` call that returns `m` in full, or a query-based hint for one with no timestamp. */
export function recallCall(m: NormalizedMessage): string {
  if (m.ts !== undefined) return `history_search {"ts":${JSON.stringify(m.ts)},"role":${JSON.stringify(m.role)}}`;
  const start = m.content.replace(/\s+/g, " ").trim().slice(0, 40);
  return `history_search {"query":${JSON.stringify(start)}} (then {"row":N})`;
}

function clip(m: NormalizedMessage, max: number): string {
  const text = m.content;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[… ${text.length - max} more characters; read the whole message with ${recallCall(m)}]`;
}

function sameMessage(a: NormalizedMessage | undefined, b: NormalizedMessage | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.role === b.role && a.content === b.content && a.toolCallId === b.toolCallId && a.ts === b.ts;
}

/** Trail steps of the tool results answering the tool-calling rounds listed in `roundsDropped`. */
function stepsOfRounds(history: readonly NormalizedMessage[], upTo: number): number[] {
  const steps: number[] = [];
  for (let i = 0; i < upTo; i++) {
    const m = history[i];
    if (m?.role === "tool" && m.trailStep !== undefined) steps.push(m.trailStep);
  }
  return steps.sort((a, b) => a - b);
}

/**
 * The window start for `history`, or `undefined` when no rewrite is due: fewer than
 * keep + batch rounds, and no force. The start is the oldest of the last `keepRounds` rounds,
 * moved forward (never past the newest `BOUNDED_MIN_ROUNDS`) while the window is over its cap.
 */
export function boundedWindowStart(history: readonly NormalizedMessage[], opts: BoundedOptions = {}): number | undefined {
  const keep = opts.keepRounds ?? BOUNDED_KEEP_ROUNDS;
  const batch = opts.batchRounds ?? BOUNDED_BATCH_ROUNDS;
  const cap = opts.windowTokenCap ?? boundedWindowCap(opts.contextWindow);
  const rounds = roundIndices(history);
  const due = rounds.length >= keep + batch || (opts.force === true && rounds.length > BOUNDED_MIN_ROUNDS);
  if (!due) return undefined;
  let startRound = Math.max(0, rounds.length - keep);
  const lastAllowed = Math.max(0, rounds.length - BOUNDED_MIN_ROUNDS);
  const windowTokens = (round: number): number => tokensOf(history.slice(rounds[round] ?? history.length));
  while (startRound < lastAllowed && windowTokens(startRound) > cap) startRound += 1;
  const start = rounds[startRound];
  return start === undefined || startRound === 0 ? undefined : start;
}

/**
 * The operator, text-only assistant and summary messages before `windowStart` that stay, in order,
 * clipped. Operator messages are never dropped for budget alone beyond the newest
 * {@link ALWAYS_KEEP_OPERATOR}; the oldest go first.
 */
function partitionBeforeWindow(
  history: readonly NormalizedMessage[],
  windowStart: number,
): { kept: NormalizedMessage[]; droppedOperators: NormalizedMessage[] } {
  type Candidate = { index: number; msg: NormalizedMessage; operator: boolean; original: NormalizedMessage };
  const candidates: Candidate[] = [];
  let summaryAt = -1;
  for (let i = 0; i < windowStart; i++) {
    const m = history[i];
    if (m?.role === "user" && m.content.startsWith(SUMMARY_HEADER)) summaryAt = i;
  }
  for (let i = 0; i < windowStart; i++) {
    const m = history[i];
    if (m === undefined) continue;
    if (i === summaryAt) {
      candidates.push({ index: i, msg: m, operator: true, original: m });
    } else if (m.role === "user" && isOperatorMessage(m) && !isSlateFrameMessage(m)) {
      candidates.push({ index: i, msg: { ...m, content: clip(m, KEPT_OPERATOR_CHARS) }, operator: true, original: m });
    } else if (
      m.role === "assistant" &&
      m.collapsed !== true &&
      (m.toolCalls === undefined || m.toolCalls.length === 0) &&
      m.content.trim().length > 0
    ) {
      const { reasoning: _dropped, ...rest } = m;
      candidates.push({ index: i, msg: { ...rest, content: clip(m, KEPT_ASSISTANT_CHARS) }, operator: false, original: m });
    }
  }
  // Newest first, within the budget; the newest operator turns and the summary always stay.
  const keep = new Set<number>();
  let used = 0;
  let operators = 0;
  for (let k = candidates.length - 1; k >= 0; k--) {
    const c = candidates[k];
    if (c === undefined) continue;
    const cost = estimateMessageTokens(c.msg);
    const isSummary = c.index === summaryAt;
    const mandatory = isSummary || (c.operator && operators < ALWAYS_KEEP_OPERATOR);
    if (c.operator && !isSummary) operators += 1;
    if (mandatory || used + cost <= KEPT_TEXT_TOKENS) {
      keep.add(k);
      used += cost;
    }
  }
  return {
    kept: candidates.filter((_, k) => keep.has(k)).map((c) => c.msg),
    droppedOperators: candidates.filter((c, k) => !keep.has(k) && c.operator && c.index !== summaryAt).map((c) => c.original),
  };
}

/** The phrase every leaving-the-request notice carries (see `leavingNotice` in working-memory.ts). */
export const LEAVING_NOTICE_MARKER = "leave the request at the next rewrite";

/** A harness notice that named steps about to leave. Once they have left it has done its job. */
export function isLeavingNotice(m: NormalizedMessage): boolean {
  return m.role === "user" && m.provenance === "harness" && m.content.includes(LEAVING_NOTICE_MARKER);
}

/** A copy of `window` with the oldest replay items stripped (the newest three keep theirs). */
export function trimOldReplay(window: readonly NormalizedMessage[]): NormalizedMessage[] {
  const out = [...window];
  let kept = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m !== undefined && hasReplay(m)) {
      if (kept < REASONING_KEEP_ROUNDS) kept += 1;
      else out[i] = withoutReplay(m);
    }
  }
  return out;
}

/**
 * Plan the bounded rewrite of `history` with `frames` at the front, or `undefined` when none is
 * due (or it would drop nothing). Pure: `history` is not touched.
 */
export function planBoundedRewrite(
  history: readonly NormalizedMessage[],
  frames: readonly NormalizedMessage[],
  opts: BoundedOptions = {},
): BoundedPlan | undefined {
  const windowStart = boundedWindowStart(history, opts);
  if (windowStart === undefined) return undefined;
  // A notice that said "these steps leave" is stale once they have: it is dropped with them.
  const window = trimOldReplay(history.slice(windowStart)).filter((m) => !isLeavingNotice(m));
  const before = partitionBeforeWindow(history, windowStart);
  const next = [...frames, ...before.kept, ...window];
  const droppedRounds = roundIndices(history.slice(0, windowStart)).length;
  let firstChangedIndex = 0;
  while (firstChangedIndex < history.length && sameMessage(history[firstChangedIndex], next[firstChangedIndex])) {
    firstChangedIndex += 1;
  }
  return {
    next,
    windowStart,
    droppedRounds,
    droppedSteps: stepsOfRounds(history, windowStart),
    droppedMessages: windowStart,
    droppedOperators: before.droppedOperators,
    savedTokens: tokensOf(history) - tokensOf(next),
    firstChangedIndex,
  };
}

/** `[3,4,5,9]` as `3-5, 9`. */
export function formatStepRanges(steps: readonly number[]): string {
  const sorted = [...new Set(steps)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const first = sorted[i] as number;
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1] as number) === (sorted[j] as number) + 1) j += 1;
    const last = sorted[j] as number;
    parts.push(first === last ? `${first}` : `${first}-${last}`);
    i = j + 1;
  }
  return parts.join(", ");
}

/**
 * Flow 393 AC5: the Trail steps that the rewrite one round from now would drop, when that rewrite
 * is due then (so the model can write Notes first). `undefined` while it is not.
 */
export function stepsLeavingNextRound(history: readonly NormalizedMessage[], opts: BoundedOptions = {}): number[] | undefined {
  const boundary = nextRewriteBoundary(history, opts);
  if (boundary === undefined) return undefined;
  const steps = stepsOfRounds(history, boundary);
  return steps.length > 0 ? steps : undefined;
}

/** The history index before which everything leaves at the next rewrite, or `undefined` while none is due. */
function nextRewriteBoundary(history: readonly NormalizedMessage[], opts: BoundedOptions): number | undefined {
  const keep = opts.keepRounds ?? BOUNDED_KEEP_ROUNDS;
  const batch = opts.batchRounds ?? BOUNDED_BATCH_ROUNDS;
  const rounds = roundIndices(history);
  // One more round will have been added when the rewrite runs.
  if (rounds.length + 1 < keep + batch) return undefined;
  const dropCount = rounds.length + 1 - keep;
  return rounds[dropCount];
}

/**
 * The operator messages the rewrite one round from now would stop sending (only the newest
 * {@link ALWAYS_KEEP_OPERATOR} stay whatever the budget). A lower bound: the rewrite may move its window
 * start forward when the window is over its cap.
 */
export function operatorTurnsLeavingNextRound(history: readonly NormalizedMessage[], opts: BoundedOptions = {}): NormalizedMessage[] {
  const boundary = nextRewriteBoundary(history, opts);
  return boundary === undefined ? [] : partitionBeforeWindow(history, boundary).droppedOperators;
}

const NAMED_OPERATOR_TURNS = 5;

function previewOf(m: NormalizedMessage): string {
  const flat = m.content.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}...` : flat;
}

/**
 * One sentence per dropped operator turn group: how many, which (time and opening words) and the exact
 * call that reads each in full. Empty when none dropped.
 */
export function describeDroppedOperators(dropped: readonly NormalizedMessage[], verb: string): string {
  if (dropped.length === 0) return "";
  const named = dropped
    .slice(-NAMED_OPERATOR_TURNS)
    .map((m) => `${m.ts ?? "?"} "${previewOf(m)}" (${recallCall(m)})`)
    .join("; ");
  const more = dropped.length > NAMED_OPERATOR_TURNS ? ` and ${dropped.length - NAMED_OPERATOR_TURNS} older (history_search {"query":"<words you remember>","role":"user"})` : "";
  return `${dropped.length} earlier operator message${dropped.length === 1 ? "" : "s"} ${verb}: ${named}${more}.`;
}
