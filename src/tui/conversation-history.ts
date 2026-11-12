import { stripVTControlCharacters } from "node:util";
import type { NormalizedMessage } from "../harness/provider/types";
import { isOperatorMessage } from "../session/compact";
import { hcHistoryEcho } from "./hc-message";

export type ConversationEntry = { label: string; text: string };

function displayText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

export function conversationHistory(history: readonly NormalizedMessage[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (const message of history) {
    const { role } = message;
    if (role !== "assistant" && (role !== "user" || !isOperatorMessage(message))) continue;
    const agentEcho = role === "user" ? hcHistoryEcho(message.content) : undefined;
    const text = displayText(agentEcho?.line ?? message.content);
    if (text.trim().length > 0) {
      const label = agentEcho === undefined ? (role === "user" ? "You" : "Assistant") : displayText(agentEcho.marker);
      entries.push({ label, text });
    }
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
  return entries.map(({ label, text }) => `${label}: ${text}\n`).join("\n");
}
