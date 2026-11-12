import { expect, test } from "bun:test";
import type { NormalizedMessage } from "../harness/provider/types";
import { conversationHistory, resumedConversation } from "./conversation-history";

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
