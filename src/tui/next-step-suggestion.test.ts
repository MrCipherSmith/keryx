import { expect, test } from "bun:test";
import {
  NEXT_STEP_SUGGESTION_MAX_LENGTH,
  NEXT_STEP_SUGGESTION_MAX_WORDS,
  NextStepSuggestionGate,
  sanitizeNextStepSuggestion,
} from "./next-step-suggestion";

// --- sanitizeNextStepSuggestion (AC14) --------------------------------------

test("sanitizeNextStepSuggestion: normalizes internal/leading/trailing whitespace", () => {
  expect(sanitizeNextStepSuggestion("  run   the\n\ttests  ")).toBe("run the tests");
});

test("sanitizeNextStepSuggestion: discards an empty reply", () => {
  expect(sanitizeNextStepSuggestion("")).toBeUndefined();
  expect(sanitizeNextStepSuggestion("   ")).toBeUndefined();
  expect(sanitizeNextStepSuggestion("\n\t")).toBeUndefined();
});

test("sanitizeNextStepSuggestion: discards the model's explicit 'nothing useful' dot", () => {
  expect(sanitizeNextStepSuggestion(".")).toBeUndefined();
  expect(sanitizeNextStepSuggestion("  .  ")).toBeUndefined();
});

test("sanitizeNextStepSuggestion: discards a reply longer than the character budget", () => {
  const long = "a".repeat(NEXT_STEP_SUGGESTION_MAX_LENGTH + 1);
  expect(sanitizeNextStepSuggestion(long)).toBeUndefined();
});

test("sanitizeNextStepSuggestion: keeps a reply exactly at the character budget", () => {
  const exact = "a".repeat(NEXT_STEP_SUGGESTION_MAX_LENGTH);
  expect(sanitizeNextStepSuggestion(exact)).toBe(exact);
});

test("sanitizeNextStepSuggestion: discards a reply containing '<' or '>'", () => {
  expect(sanitizeNextStepSuggestion("run <script>alert(1)</script>")).toBeUndefined();
  expect(sanitizeNextStepSuggestion("check a < b")).toBeUndefined();
  expect(sanitizeNextStepSuggestion("check a > b")).toBeUndefined();
});

test("sanitizeNextStepSuggestion: truncates to the word budget before the length check", () => {
  const words = Array.from({ length: NEXT_STEP_SUGGESTION_MAX_WORDS + 10 }, (_, i) => `w${i}`);
  const result = sanitizeNextStepSuggestion(words.join(" "));
  expect(result).toBe(words.slice(0, NEXT_STEP_SUGGESTION_MAX_WORDS).join(" "));
});

test("sanitizeNextStepSuggestion: keeps an ordinary short imperative reply", () => {
  expect(sanitizeNextStepSuggestion("Commit the fix")).toBe("Commit the fix");
});

// --- NextStepSuggestionGate (AC14) ------------------------------------------

test("NextStepSuggestionGate: start() returns a non-aborted signal and isActive becomes true", () => {
  const gate = new NextStepSuggestionGate();
  expect(gate.isActive).toBe(false);
  const { signal, isCurrent } = gate.start();
  expect(signal.aborted).toBe(false);
  expect(isCurrent()).toBe(true);
  expect(gate.isActive).toBe(true);
});

test("NextStepSuggestionGate: cancel() aborts the current request's signal and clears isCurrent/isActive", () => {
  const gate = new NextStepSuggestionGate();
  const { signal, isCurrent } = gate.start();
  gate.cancel("user typed");
  expect(signal.aborted).toBe(true);
  expect(isCurrent()).toBe(false);
  expect(gate.isActive).toBe(false);
});

test("NextStepSuggestionGate: cancel() on an idle gate is a no-op (never throws)", () => {
  const gate = new NextStepSuggestionGate();
  expect(() => gate.cancel("no request in flight")).not.toThrow();
  expect(gate.isActive).toBe(false);
});

test("NextStepSuggestionGate: start() supersedes and aborts the PREVIOUS request", () => {
  const gate = new NextStepSuggestionGate();
  const first = gate.start();
  expect(first.signal.aborted).toBe(false);

  const second = gate.start();
  // The first request's signal is aborted the moment a second one begins —
  // this is what makes "a new turn started while a suggestion request was
  // still outstanding" safe: the OLD request can never win the race.
  expect(first.signal.aborted).toBe(true);
  expect(first.isCurrent()).toBe(false);
  expect(second.signal.aborted).toBe(false);
  expect(second.isCurrent()).toBe(true);
});

test("NextStepSuggestionGate: isCurrent() reflects only the latest start(), not call order of resolution", () => {
  const gate = new NextStepSuggestionGate();
  const older = gate.start();
  const newer = gate.start();
  // Simulate the older request's provider call resolving LATE, after a newer
  // one already started — the exact race AC14 requires never surface a late
  // reply for.
  expect(older.isCurrent()).toBe(false);
  expect(newer.isCurrent()).toBe(true);
});

test("NextStepSuggestionGate: start() combines the request's own controller with a timeout signal", async () => {
  const gate = new NextStepSuggestionGate();
  const { signal } = gate.start(5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(signal.aborted).toBe(true);
});
