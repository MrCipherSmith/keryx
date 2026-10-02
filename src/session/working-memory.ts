// Flow 393: the working-memory rewrite, composed from its pure parts.
//
// One call per round on a host that keeps working memory. It plans the bounded request (frame +
// kept text + last K rounds), the observation packs and the reasoning-replay trim as ONE batch,
// asks the cache-cost gate whether the batch is worth re-billing the prefix for, logs the decision
// through the caller, and applies it. A rewrite that is skipped changes nothing.

import type { NormalizedMessage } from "../harness/provider/types";
import {
  LEAVING_NOTICE_MARKER,
  formatStepRanges,
  planBoundedRewrite,
  stepsLeavingNextRound,
  tokensOf,
  trimOldReplay,
} from "./bounded-request";
import {
  applyObservationPacks,
  planObservationPacks,
} from "./observation-pack";
import { cachedPriceRatio, decideRewrite, type RewriteDecision, type RewriteKind } from "./rewrite-gate";
import { buildSlateFrame, type FrameOptions } from "./slate-frame";
import type { Slate } from "./slate";

/** Per-conversation bookkeeping; keyed on the history array the turn holds. */
export interface WorkingMemoryState {
  /** Highest Trail step a leaving-the-request notice already named. */
  noticedThroughStep: number;
  /** Completed plan items when the last rewrite ran (or was first looked at). */
  completedAtLastRewrite: number | undefined;
  rewrites: number;
  /** Kind and reason of the last skipped rewrite that was logged: the same skip is not logged twice in a row. */
  lastSkipKey: string | undefined;
}

const states = new WeakMap<NormalizedMessage[], WorkingMemoryState>();

export function workingMemoryState(history: NormalizedMessage[]): WorkingMemoryState {
  let s = states.get(history);
  if (s === undefined) {
    s = { noticedThroughStep: 0, completedAtLastRewrite: undefined, rewrites: 0, lastSkipKey: undefined };
    states.set(history, s);
  }
  return s;
}

/**
 * Whether the plan advanced a step since the last rewrite (a boundary: the cache is about to go
 * stale anyway, so a rewrite there is cheap). The first look only records the baseline.
 */
export function atPlanBoundary(state: WorkingMemoryState, completedPlanItems: number): boolean {
  if (state.completedAtLastRewrite === undefined) {
    state.completedAtLastRewrite = completedPlanItems;
    return false;
  }
  return completedPlanItems > state.completedAtLastRewrite;
}

/**
 * Flow 393 AC5: the text of ONE notice per batch, naming the steps that leave the request at the
 * next rewrite; `undefined` when nothing is about to leave or a notice already covers it.
 */
export function leavingNotice(history: NormalizedMessage[], state: WorkingMemoryState): { text: string; steps: number[] } | undefined {
  const steps = stepsLeavingNextRound(history);
  if (steps === undefined) return undefined;
  const fresh = steps.filter((s) => s > state.noticedThroughStep);
  // One notice per batch: a notice already covered the oldest of these, so stay quiet until a
  // later, disjoint batch is about to leave.
  if (fresh.length === 0 || fresh.length < steps.length) return undefined;
  state.noticedThroughStep = steps[steps.length - 1] ?? state.noticedThroughStep;
  return {
    steps,
    text:
      `Steps ${formatStepRanges(steps)} ${LEAVING_NOTICE_MARKER}: older rounds are not re-sent. ` +
      `If a fact from them is still needed, save it now with slate_note. Their outputs stay readable with recall_step, ` +
      `slate_trail lists them and history_search finds earlier messages.`,
  };
}

/**
 * Flow 393 AC5: the paragraph of the system instruction a working-memory host adds. It states the
 * contract the rewrite relies on: older rounds leave the request, so a fact worth keeping goes in a
 * Note, and the Trail and the recall tools bring the rest back.
 */
export function buildWorkingMemoryInstruction(): string {
  return [
    "Working memory: this session keeps its history on disk and does not re-send all of it.",
    "Older rounds leave the request in batches; what stays is the Anchors block, your Notes, a digest of the Trail (one line per tool call you made) and the most recent rounds.",
    "A fact you will still need after that belongs in a Note: call slate_note with a short key and the fact (set, replace or delete; 2000 characters per note).",
    "Before a batch leaves, the shell sends one notice naming the steps; write Notes then, not afterwards.",
    "To get something back, call recall_step for a saved tool output, slate_trail to list steps by file, tool or step range, or history_search to find earlier text.",
    "Read a recalled output only when you need it: the Trail line says what the call was and whether it succeeded.",
  ].join(" ");
}

export interface WorkingMemoryInput {
  history: NormalizedMessage[];
  sessionDir: string;
  /** The slate to build the frame from; without one only packs and the replay trim can apply. */
  slate: Slate | undefined;
  frame: FrameOptions;
  contextWindow?: number;
  providerId?: string;
  remainingRounds: number;
  atPlanBoundary: boolean;
  /** The request would overflow the window: applied whatever the gate says. */
  forced: boolean;
  /** Called once, just before `history` changes (hosts flush their archive here). */
  beforeApply?: () => void;
}

export interface WorkingMemoryResult {
  /** The gate's verdict; absent when there was nothing to rewrite. */
  decision?: RewriteDecision;
  applied: boolean;
  /** Messages `history` lost (the host treats a shortening like a compaction). */
  removed: number;
  droppedRounds: number;
  droppedSteps: number[];
  packed: number;
  /** Estimated tokens the batch removed from every later request. */
  savedTokens: number;
}

const NOTHING: WorkingMemoryResult = { applied: false, removed: 0, droppedRounds: 0, droppedSteps: [], packed: 0, savedTokens: 0 };

export async function rewriteWorkingMemory(input: WorkingMemoryInput): Promise<WorkingMemoryResult> {
  const { history } = input;
  const frames = input.slate === undefined ? [] : buildSlateFrame(input.slate, input.frame);
  const bounded =
    frames.length === 0
      ? undefined
      : planBoundedRewrite(history, frames, {
          ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
          ...(input.forced ? { force: true } : {}),
        });
  const base = bounded?.next ?? trimOldReplay(history);
  const packs = planObservationPacks(base);
  const before = tokensOf(history);
  const savedByRewrite = before - tokensOf(base);
  const savedTokens = savedByRewrite + packs.reduce((a, p) => a + p.saving, 0);
  const changedBase = bounded !== undefined || savedByRewrite > 0;
  if (!changedBase && packs.length === 0) {
    return NOTHING;
  }
  let firstChanged = bounded?.firstChangedIndex ?? history.length;
  if (bounded === undefined) {
    // No frame rewrite: the change starts at the first message the replay trim or a pack alters.
    for (let i = 0; i < history.length; i++) {
      if (history[i] !== base[i]) {
        firstChanged = i;
        break;
      }
    }
  }
  for (const p of packs) firstChanged = Math.min(firstChanged, p.index);
  const invalidatedTokens = tokensOf(history.slice(Math.min(firstChanged, history.length)));
  const kind: RewriteKind = bounded !== undefined ? "frame" : packs.length > 0 ? "pack" : "prune";
  const decision = decideRewrite({
    kind,
    savedTokens,
    invalidatedTokens,
    remainingRounds: input.remainingRounds,
    cachedRatio: cachedPriceRatio(input.providerId),
    atPlanBoundary: input.atPlanBoundary,
    forced: input.forced,
  });
  if (!decision.apply) {
    return { ...NOTHING, decision };
  }
  input.beforeApply?.();
  const lengthBefore = history.length;
  history.splice(0, history.length, ...base);
  const { packed } = await applyObservationPacks(history, packs, input.sessionDir);
  const state = workingMemoryState(history);
  state.rewrites += 1;
  return {
    decision,
    applied: true,
    removed: lengthBefore - history.length,
    droppedRounds: bounded?.droppedRounds ?? 0,
    droppedSteps: bounded?.droppedSteps ?? [],
    packed,
    savedTokens,
  };
}
