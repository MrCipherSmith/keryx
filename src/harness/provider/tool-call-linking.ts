// Tool-call linking: decide, per request, which assistant calls and which tool
// results form a complete pair.
//
// Every OpenAI-compatible API rejects a `role:"tool"` message whose
// `tool_call_id` names no preceding assistant call, and rejects an assistant
// `tool_calls` that nothing answers. Those half-pairs are not hypothetical:
// compaction cuts a window at a user boundary, a resumed session replays a
// truncated transcript, and a batch can be abandoned mid-flight by a budget or a
// denied approval. Rather than requiring every producer of history to preserve
// pairs, adapters ask this module what is actually linked in the array they are
// about to serialize; anything unpaired is reported as degraded and rendered the
// way it was before tool linking existed. A correct conversation gets the real
// loop, a degenerate one gets the old text form, and neither gets a 400.

import type { NormalizedMessage, NormalizedToolCall } from "./types";

export interface LinkedMessage {
  message: NormalizedMessage;
  /**
   * Assistant only: the calls that ARE answered later in this same request.
   * Empty when the message is not an assistant turn, carries no calls, or none
   * of its calls were answered — in which case it serializes as plain content.
   */
  linkedCalls: NormalizedToolCall[];
  /**
   * Tool only: the id this result answers, present only when a preceding
   * assistant message in this request declares that exact call.
   */
  linkedToolCallId?: string;
}

function isUsableCall(call: NormalizedToolCall | undefined): call is NormalizedToolCall {
  return (
    call !== undefined &&
    typeof call.id === "string" &&
    call.id.length > 0 &&
    typeof call.name === "string" &&
    call.name.length > 0
  );
}

/**
 * Pair assistant tool calls with the tool results that answer them.
 *
 * Pure and total: duplicate ids, malformed entries, an empty array, and a
 * conversation with no tool traffic at all are handled without throwing. A
 * duplicate id resolves to the FIRST unanswered call carrying it, so a repeated
 * id cannot make one result answer two calls.
 */
export function linkToolCalls(messages: readonly NormalizedMessage[]): LinkedMessage[] {
  // Which call ids are answered by some later tool message. Counting, not a
  // set membership test: two results with the same id must not license two
  // copies of one call.
  const answersById = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }
    const id = message.toolCallId;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    answersById.set(id, (answersById.get(id) ?? 0) + 1);
  }

  // Calls declared so far and not yet consumed by a result, per id. Both sides
  // draw down a budget so a repeated id can never link more results than calls
  // (or more calls than results).
  const declaredBudget = new Map<string, number>();
  const remainingAnswers = new Map(answersById);
  const out: LinkedMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      const linkedCalls: NormalizedToolCall[] = [];
      for (const call of calls) {
        if (!isUsableCall(call)) {
          continue;
        }
        const budget = remainingAnswers.get(call.id) ?? 0;
        if (budget <= 0) {
          continue; // nothing later answers this call
        }
        remainingAnswers.set(call.id, budget - 1);
        declaredBudget.set(call.id, (declaredBudget.get(call.id) ?? 0) + 1);
        linkedCalls.push({ id: call.id, name: call.name, arguments: call.arguments ?? "" });
      }
      out.push({ message, linkedCalls });
      continue;
    }

    if (message.role === "tool") {
      const id = message.toolCallId;
      const available = typeof id === "string" && id.length > 0 ? (declaredBudget.get(id) ?? 0) : 0;
      const linked = available > 0;
      if (linked && typeof id === "string") {
        declaredBudget.set(id, available - 1);
      }
      out.push({
        message,
        linkedCalls: [],
        ...(linked ? { linkedToolCallId: id } : {}),
      });
      continue;
    }

    out.push({ message, linkedCalls: [] });
  }

  return out;
}
