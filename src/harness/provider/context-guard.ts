// Auto-compaction guard for provider context-window overflow (flow 267).
//
// An OpenAI-compatible gateway rejects a request once its serialized size
// crosses the model's real context window — `"you requested 0 output tokens
// and your prompt contains at least 200001 input tokens"` is the confirmed
// wire shape (flow 267's incident report). Nothing in the round loop
// (`commands/agent.ts`) ever shrank `history` before a request; the only
// shrink mechanism, `compactMessages` (`session/compact.ts`), ran solely from
// the manual `/compact` command. This module is the sizing half of the fix:
// a cheap, synchronous estimate of what a request will actually serialize to,
// and the threshold decision for whether to compact before sending it. The
// caller (`agent.ts`'s round loop) does the compacting itself, by reusing
// `compactMessages` — this module only decides WHETHER, never HOW.

import type { NormalizedToolDefinition } from "./types";

/**
 * The minimal shape `estimateRequestTokens` needs from a history message —
 * structurally satisfied by `NormalizedMessage` (never imported directly) so
 * this also accepts the narrower `{ content: string }[]` shape `tui-shell.ts`'s
 * pre-existing `estimateContextTokens` callers already pass.
 */
export interface EstimatableMessage {
  content: string;
  toolCalls?: readonly { arguments: string }[];
}

/**
 * Rough token estimate (chars/4, same crude precision as the `/status`
 * estimator this supersedes — never a real tokenizer) for the FULL next
 * request body: every message's `content`, every `toolCalls[].arguments`
 * string (an assistant tool call's raw JSON input, sized independently of
 * `content`), the system instruction, and the serialized tool-definition
 * schemas sent on every round.
 *
 * Supersedes `tui-shell.ts`'s narrower `estimateContextTokens`, which summed
 * `content` only and undercounted a request that also carried a large
 * tool-call/tool-schema payload — the exact undercount mechanism behind the
 * flow 267 incident (a request the UI showed as ~162k chars/4 actually
 * serialized past 200k tokens). `toolDefs` contributes nothing when empty —
 * an omitted/empty tool list must not phantom-inflate the estimate merely
 * because `JSON.stringify([])` is non-empty text.
 */
export function estimateRequestTokens(
  history: readonly EstimatableMessage[],
  systemInstruction: string,
  toolDefs: readonly NormalizedToolDefinition[],
): number {
  let chars = systemInstruction.length;
  if (toolDefs.length > 0) {
    chars += JSON.stringify(toolDefs).length;
  }
  for (const message of history) {
    chars += message.content.length;
    for (const call of message.toolCalls ?? []) {
      chars += call.arguments.length;
    }
  }
  return Math.round(chars / 4);
}

/**
 * Trip the guard once `estimate` reaches 85% of `window` — matching the
 * manual `/compact` command's own `keepLastUserTurns: 3` default, so an
 * auto-compact looks identical to one the user triggered themselves.
 *
 * `window === undefined` ALWAYS returns `false`: `model-limits.ts`'s
 * `loadSessionLimits` never invents a context window (no hardcoded 128k), and
 * this guard must not either — an unknown window means byte-identical
 * behavior to before this guard existed (AC2), not a guessed threshold.
 */
export function needsCompaction(estimate: number, window: number | undefined): boolean {
  if (window === undefined) {
    return false;
  }
  return estimate >= 0.85 * window;
}
