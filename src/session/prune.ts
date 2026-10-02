// Send-time pruning of old tool results (flow 387 T11).
//
// A real session carried ~600K chars of tool results (180 messages) that were
// re-sent on every round. Before each request, results outside a protected window
// are replaced by a fixed placeholder that names a file holding the full text.
// Patterns: opencode `session/compaction.ts` prune (protect the last 2 turns + the
// newest 40K tokens, only act past a 20K saving), gemini-cli `toolOutputMasking`.
//
// Only the CONTENT of a `role: "tool"` message changes: the message stays in place
// with its `toolCallId`, so every assistant tool call keeps its result. The pruned
// copy replaces the history entry (never a mutation), so `archive.jsonl`, which
// holds the original message objects, keeps the original text. Saving is batched
// (>= 20K tokens) so the provider's prompt-cache prefix is not broken every round,
// and idempotent: an already-cleared result is never counted or rewritten.
//
// This module takes the session dir from its caller and never resolves a
// config-dir path itself (see the note in `./paths.ts`).

import { extractSpillPath, writeToolOutputFile } from "../harness/tool/output-spill";
import type { NormalizedMessage } from "../harness/provider/types";
import { indexOfKeepFrom } from "./compact";

/** Operator turns (and everything after their start) that are never pruned. */
export const PRUNE_PROTECT_OPERATOR_TURNS = 2;
/** Newest tool-result tokens that are never pruned. */
export const PRUNE_PROTECT_TOOL_TOKENS = 40_000;
/** Prune only when it saves at least this many estimated tokens. */
export const PRUNE_MIN_SAVING_TOKENS = 20_000;
/** Start of every placeholder; also how an already-cleared result is recognised. */
export const CLEARED_PREFIX = "[Old tool result cleared";

const PLAIN_PLACEHOLDER = `${CLEARED_PREFIX} to save context]`;

export function clearedPlaceholder(filePath: string | undefined): string {
  return filePath === undefined ? PLAIN_PLACEHOLDER : `${CLEARED_PREFIX} — full text: ${filePath}]`;
}

export function isClearedToolResult(m: NormalizedMessage): boolean {
  return m.role === "tool" && m.content.startsWith(CLEARED_PREFIX);
}

function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface PrunePlanEntry {
  index: number;
  /** Estimated tokens the placeholder saves. */
  saving: number;
}

/**
 * Which tool results are outside the protected window, and what clearing them
 * saves. Pure. Walks newest to oldest: tool-result tokens accumulate and the result
 * that pushes the total past the protected budget, and every older one, is a
 * candidate unless it sits inside the last `protectTurns` operator turns.
 */
export function planPrune(
  history: readonly NormalizedMessage[],
  opts: { protectTurns?: number; protectTokens?: number } = {},
): { entries: PrunePlanEntry[]; savedTokens: number } {
  const protectFrom = indexOfKeepFrom(history, opts.protectTurns ?? PRUNE_PROTECT_OPERATOR_TURNS);
  const protectTokens = opts.protectTokens ?? PRUNE_PROTECT_TOOL_TOKENS;
  const entries: PrunePlanEntry[] = [];
  let total = 0;
  let savedTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m === undefined || m.role !== "tool") {
      continue;
    }
    const size = tokens(m.content);
    total += size;
    // `indexOfKeepFrom` answers 0 when there are fewer operator turns than asked,
    // which protects everything; so does an exhausted protected-token budget.
    if (i >= protectFrom || total <= protectTokens || isClearedToolResult(m)) {
      continue;
    }
    const saving = size - tokens(clearedPlaceholder(extractSpillPath(m.content)));
    if (saving > 0) {
      entries.push({ index: i, saving });
      savedTokens += saving;
    }
  }
  return { entries, savedTokens };
}

export interface PruneOptions {
  /** Live session dir; without one the placeholder carries no path. */
  sessionDir: string | undefined;
  protectTurns?: number;
  protectTokens?: number;
  /** Overrides {@link PRUNE_MIN_SAVING_TOKENS} (the overflow retry takes any saving). */
  minSavingTokens?: number;
}

export interface PruneResult {
  /** Tool results replaced. */
  pruned: number;
  /** Estimated tokens saved. */
  savedTokens: number;
}

/**
 * Replace old tool results in `history` (in place, same array) with placeholders when
 * that saves enough. A result already spilled by `spillLargeToolOutput` keeps its
 * spill file; any other is written to `<sessionDir>/tool-output/` first so the
 * placeholder can always name a readable path. A failed write degrades to the plain
 * placeholder (the archive still has the original).
 */
export async function pruneToolOutputs(history: NormalizedMessage[], opts: PruneOptions): Promise<PruneResult> {
  const plan = planPrune(history, {
    ...(opts.protectTurns !== undefined ? { protectTurns: opts.protectTurns } : {}),
    ...(opts.protectTokens !== undefined ? { protectTokens: opts.protectTokens } : {}),
  });
  if (plan.entries.length === 0 || plan.savedTokens < (opts.minSavingTokens ?? PRUNE_MIN_SAVING_TOKENS)) {
    return { pruned: 0, savedTokens: 0 };
  }
  let pruned = 0;
  let savedTokens = 0;
  for (const entry of plan.entries) {
    const m = history[entry.index];
    if (m === undefined || m.role !== "tool" || isClearedToolResult(m)) {
      continue;
    }
    let filePath = extractSpillPath(m.content);
    if (filePath === undefined && opts.sessionDir !== undefined) {
      filePath = await writeToolOutputFile(opts.sessionDir, m.toolCallId ?? `pruned-${entry.index}`, m.content);
    }
    history[entry.index] = { ...m, content: clearedPlaceholder(filePath) };
    pruned += 1;
    savedTokens += tokens(m.content) - tokens(clearedPlaceholder(filePath));
  }
  return { pruned, savedTokens };
}
