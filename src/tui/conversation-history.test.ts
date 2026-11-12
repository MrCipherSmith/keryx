import { expect, test } from "bun:test";
import type { NormalizedMessage } from "../harness/provider/types";
import { conversationHistory, conversationHistoryText, resumedConversation } from "./conversation-history";
import { frameSubmittedLine } from "./hc-message";

test("resume shows the last turn including replies and skips injected context and tool output", () => {
  const history: NormalizedMessage[] = [
    { role: "user", content: "Older question" },
    { role: "assistant", content: "Older answer" },
    { role: "user", content: "Latest question" },
    { role: "assistant", content: "Checking the result" },
    { role: "tool", content: "raw output" },
    { role: "user", content: "Injected context", injected: true },
    { role: "assistant", content: "Latest answer" },
  ];
  expect(resumedConversation(history).map(({ text }) => text)).toEqual([
    "Latest question", "Checking the result", "Latest answer",
  ]);
  expect(conversationHistory(history).map(({ text }) => text)).toEqual([
    "Older question", "Older answer", "Latest question", "Checking the result", "Latest answer",
  ]);
});

test("a long last turn shows its last 20 messages in order", () => {
  const replies = Array.from({ length: 25 }, (_, index) => ({ role: "assistant" as const, content: `Reply ${index}` }));
  const history: NormalizedMessage[] = [{ role: "user", content: "Question" }, ...replies];
  expect(resumedConversation(history).map(({ text }) => text)).toEqual(replies.slice(-20).map(({ content }) => content));
});

test("archived agent messages keep their sender and display the original body", () => {
  const framed = frameSubmittedLine('<hc from="t7 review">Review complete</hc>');
  const history: NormalizedMessage[] = [
    { role: "user", content: framed, provenance: "project" },
    { role: "user", content: "A tool notification", provenance: "tool" },
    { role: "user", content: framed, provenance: "tool" },
    { role: "assistant", content: "Acknowledged" },
  ];
  const entries = [
    { label: "◂ t7 review ❯", text: "Review complete" },
    { label: "Assistant", text: "Acknowledged" },
  ];
  expect(resumedConversation(history)).toEqual(entries);
  expect(conversationHistory(history)).toEqual([{ label: "You", text: framed }, ...entries]);
  expect(conversationHistoryText(history)).toContain("◂ t7 review ❯: Review complete");
});
