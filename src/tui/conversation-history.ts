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

function agentMessageEcho(message: NormalizedMessage): ReturnType<typeof hcHistoryEcho> {
  return message.role === "user" && message.provenance === "tool" && message.injected !== true
    ? hcHistoryEcho(message.content)
    : undefined;
}

export function conversationHistory(history: readonly NormalizedMessage[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (const message of history) {
    const { role } = message;
    const agentEcho = agentMessageEcho(message);
    if (role !== "assistant" && agentEcho === undefined && !isOperatorMessage(message)) continue;
    const text = displayText(agentEcho?.line ?? message.content);
    if (text.trim().length > 0) {
      const label = agentEcho === undefined ? (role === "user" ? "You" : "Assistant") : displayText(agentEcho.marker);
      entries.push({ label, text });
    }
  }
  return entries;
}

export function resumedConversation(history: readonly NormalizedMessage[]): ConversationEntry[] {
  // An operator prompt or a visible agent message starts a turn.
  let start = history.length;
  while (start > 0) {
    const message = history[--start]!;
    if (isOperatorMessage(message) || agentMessageEcho(message) !== undefined) break;
  }
  return conversationHistory(history.slice(start)).slice(-20);
}

export function conversationHistoryText(history: readonly NormalizedMessage[]): string {
  const entries = conversationHistory(history);
  if (entries.length === 0) return "This session has no messages yet.\n";
  return entries.map(({ label, text }) => `${label}: ${text}\n`).join("\n");
}
