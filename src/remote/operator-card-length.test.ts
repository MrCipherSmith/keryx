// Flow 456: an operator card the topic would cut gets no remote Yes/No buttons.

import { expect, test } from "bun:test";
import { operatorCardTooLongForTopic } from "./shell-bridge";
import { MAX_APPROVAL_PROMPT_CHARS } from "./protocol";

const shortCard = ["Lift the ceiling from 25 to 31?", "current ceiling: 25", "subject: package pkg-1"];
const longCard = ["Post this review?", ...Array.from({ length: 80 }, (_, i) => `finding ${i}: ${"x".repeat(60)}`), "subject: pr 1"];

test("a card that fits is answerable in the topic", () => {
  expect(operatorCardTooLongForTopic("flow_confirm", "{}", { alwaysAsk: true, card: shortCard })).toBe(false);
});

test("a card longer than the approval prompt limit is not answerable in the topic", () => {
  expect(longCard.join("\n").length).toBeGreaterThan(MAX_APPROVAL_PROMPT_CHARS);
  expect(operatorCardTooLongForTopic("review_post", "{}", { alwaysAsk: true, card: longCard })).toBe(true);
});

test("an ordinary (non-card) approval is never routed to the shell by length", () => {
  expect(operatorCardTooLongForTopic("shell_exec", JSON.stringify({ command: "x".repeat(10_000) }), {})).toBe(false);
});
