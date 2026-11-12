import { stripVTControlCharacters } from "node:util";
import type { NormalizedMessage } from "../harness/provider/types";
import { isOperatorMessage } from "../session/compact";
import { hcHistoryEcho } from "./hc-message";

export type ConversationEntry = { label: string; text: string };
const PREVIEW_CHARS = 2048;

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

export function conversationEntry(message: NormalizedMessage, limit = Infinity): ConversationEntry | undefined {
  const { role } = message;
  const agentEcho = agentMessageEcho(message);
  if (role !== "assistant" && agentEcho === undefined && !isOperatorMessage(message)) return;
  const content = agentEcho?.line ?? message.content;
  const prefix = content.slice(0, limit);
  const text = displayText(prefix);
  if (text.trim().length === 0 && (prefix.length === content.length || content.trim().length === 0)) return;
  const label = agentEcho === undefined ? (role === "user" ? "You" : "Assistant") : displayText(agentEcho.marker);
  return { label, text: prefix.length < content.length ? `${text}…` : text };
}

export function conversationHistory(history: readonly NormalizedMessage[]): ConversationEntry[] {
  return history.flatMap((message) => conversationEntry(message) ?? []);
}

export function resumedConversation(history: readonly NormalizedMessage[]): ConversationEntry[] {
  // An operator prompt or a visible agent message starts a turn.
  const entries: ConversationEntry[] = [];
  for (let index = history.length - 1; index >= 0 && entries.length < 20; index--) {
    const message = history[index]!;
    const entry = conversationEntry(message, PREVIEW_CHARS);
    if (entry !== undefined) entries.push(entry);
    if (isOperatorMessage(message) || agentMessageEcho(message) !== undefined) break;
  }
  return entries.reverse();
}

export function conversationHistoryText(history: readonly NormalizedMessage[]): string {
  const entries = conversationHistory(history);
  if (entries.length === 0) return "This session has no messages yet.\n";
  return entries.map(({ label, text }) => `${label}: ${text}\n`).join("\n");
}
