import { stripVTControlCharacters } from "node:util";
import type { NormalizedMessage } from "../harness/provider/types";
import { isOperatorMessage } from "./compact";

export type ConversationEntry = { role: "user" | "assistant"; text: string };

export function conversationHistory(history: readonly NormalizedMessage[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (const message of history) {
    const { role } = message;
    if (role !== "assistant" && (role !== "user" || !isOperatorMessage(message))) continue;
    const text = stripVTControlCharacters(message.content)
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "    ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
    if (text.trim().length > 0) entries.push({ role, text });
  }
  return entries;
}

export function resumedConversation(history: readonly NormalizedMessage[]): ConversationEntry[] {
  // A real operator prompt starts a turn, even when its text is empty.
  let start = history.length;
  while (start > 0 && !isOperatorMessage(history[--start]!)) {
    // Walk back past assistant/tool rounds and injected context.
  }
  return conversationHistory(history.slice(start)).slice(-20);
}

export function conversationHistoryText(history: readonly NormalizedMessage[]): string {
  const entries = conversationHistory(history);
  if (entries.length === 0) return "This session has no messages yet.\n";
  return entries.map(({ role, text }) => `${role === "user" ? "You" : "Assistant"}: ${text}\n`).join("\n");
}
