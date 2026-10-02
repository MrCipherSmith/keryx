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
  /**
   * Flow 387 T7: an assistant message's replayed reasoning. The opaque
   * `replay[].data` payloads (encrypted reasoning items, thinking signatures)
   * are echoed to the provider on EVERY later request, so they weigh on the
   * request body exactly like `content` does — ~143K chars in one real session.
   */
  reasoning?: { replay?: readonly { data: unknown }[] };
}

/** Serialized size of one message's replayed-reasoning payloads (flow 387 T7). */
function replayChars(message: EstimatableMessage): number {
  let chars = 0;
  for (const item of message.reasoning?.replay ?? []) {
    chars += (typeof item.data === "string" ? item.data : (JSON.stringify(item.data) ?? "")).length;
  }
  return chars;
}

/** Chars of one message's contribution to the request body. */
function messageChars(message: EstimatableMessage): number {
  let chars = message.content.length + replayChars(message);
  for (const call of message.toolCalls ?? []) {
    chars += call.arguments.length;
  }
  return chars;
}

/** Chars of the non-message request overhead: system instruction + tool schemas. */
function overheadChars(systemInstruction: string, toolDefs: readonly NormalizedToolDefinition[]): number {
  return systemInstruction.length + (toolDefs.length > 0 ? JSON.stringify(toolDefs).length : 0);
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
  let chars = overheadChars(systemInstruction, toolDefs);
  for (const message of history) {
    chars += messageChars(message);
  }
  return Math.round(chars / 4);
}

/**
 * Flow 387 T7: the last provider-reported input-token count together with the
 * request it described — enough to tell later whether it still applies.
 */
export interface UsageAnchor {
  /** Provider-reported `usage.inputTokens` for the request. */
  inputTokens: number;
  /** `history.length` when that request was built. */
  messageCount: number;
  /** The last message that request carried; identity proves the prefix is intact. */
  lastMessage: object | undefined;
  /** System-instruction + tool-schema chars of that request. */
  overheadChars: number;
}

/**
 * Snapshot a request at build time (call BEFORE sending, with the exact
 * `history`/system/tools the request used); pair the result with the
 * provider-reported `inputTokens` via {@link toUsageAnchor}.
 */
export interface RequestSnapshot {
  messageCount: number;
  lastMessage: object | undefined;
  overheadChars: number;
}

export function snapshotRequest(
  history: readonly EstimatableMessage[],
  systemInstruction: string,
  toolDefs: readonly NormalizedToolDefinition[],
): RequestSnapshot {
  return {
    messageCount: history.length,
    lastMessage: history[history.length - 1],
    overheadChars: overheadChars(systemInstruction, toolDefs),
  };
}

/** A non-positive / non-finite count is treated as "not reported" (no anchor). */
export function toUsageAnchor(snapshot: RequestSnapshot, inputTokens: number | undefined): UsageAnchor | undefined {
  if (inputTokens === undefined || !Number.isFinite(inputTokens) || inputTokens <= 0 || snapshot.messageCount === 0) {
    return undefined;
  }
  return { inputTokens, ...snapshot };
}

/**
 * Flow 387 T7: pre-request size estimate anchored on the provider's own count
 * (pattern: codex `history.rs` / pi `compaction.ts`) — last reported input
 * tokens + a chars/4 estimate of what was added since (messages appended after
 * the anchored request, plus any change in system-instruction/tool-schema size,
 * e.g. the per-round plan snapshot). The anchored prefix is only trusted while
 * it is provably intact: when history shrank or the message at the anchored
 * position is no longer the same object (compaction splice, resume, edit), or
 * no anchor exists, this falls back to {@link estimateRequestTokens}.
 */
export function estimateWithUsageAnchor(
  history: readonly EstimatableMessage[],
  systemInstruction: string,
  toolDefs: readonly NormalizedToolDefinition[],
  anchor: UsageAnchor | undefined,
): number {
  if (
    anchor === undefined ||
    history.length < anchor.messageCount ||
    history[anchor.messageCount - 1] !== anchor.lastMessage
  ) {
    return estimateRequestTokens(history, systemInstruction, toolDefs);
  }
  let addedChars = overheadChars(systemInstruction, toolDefs) - anchor.overheadChars;
  for (let i = anchor.messageCount; i < history.length; i += 1) {
    addedChars += messageChars(history[i] as EstimatableMessage);
  }
  return anchor.inputTokens + Math.round(addedChars / 4);
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

/**
 * Flow 387 T6: did the provider reject a request because it outgrew the model's
 * context window? The adapters already normalize the documented
 * `context_length_exceeded` code to `kind: "context_overflow"`; the Codex /
 * ChatGPT backend can instead answer a bare HTTP 400 whose only signal is the
 * message ("... your prompt contains at least N input tokens"), which lands as
 * `invalid_request`/`unknown`. Message matching is therefore a fallback for
 * those two generic kinds only — never for auth, rate-limit or 5xx errors.
 */
export function isContextOverflowError(error: { kind: string; message?: string } | undefined): boolean {
  if (error === undefined) {
    return false;
  }
  if (error.kind === "context_overflow") {
    return true;
  }
  if (error.kind !== "invalid_request" && error.kind !== "unknown") {
    return false;
  }
  const message = error.message ?? "";
  return (
    /context_length_exceeded/i.test(message) ||
    /prompt contains at least \d+ input tokens/i.test(message) ||
    /maximum context length/i.test(message) ||
    /exceeds? the context window/i.test(message)
  );
}
