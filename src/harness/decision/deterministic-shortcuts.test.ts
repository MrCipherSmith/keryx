// Flow 338, AC2.
import { expect, test } from "bun:test";
import { classifyDeterministic, isSlashCommandLine } from "./deterministic-shortcuts";

test("isSlashCommandLine: only a line starting with / (after trim)", () => {
  expect(isSlashCommandLine("/model")).toBe(true);
  expect(isSlashCommandLine("  /route on")).toBe(true);
  expect(isSlashCommandLine("please run /model for me")).toBe(false);
});

test("classifyDeterministic: a slash command is left unclassified", () => {
  expect(classifyDeterministic("/route on")).toBeUndefined();
});

test("classifyDeterministic: short chit-chat resolves quick", () => {
  expect(classifyDeterministic("hi")).toBe("quick");
  expect(classifyDeterministic("thanks!")).toBe("quick");
  expect(classifyDeterministic("  thx  ")).toBe("quick");
  for (const line of ["hello", "hey", "yo", "thank you", "ty", "good morning", "good night", "gm", "lol", "haha", "welcome", "you're welcome"]) {
    expect(classifyDeterministic(line)).toBe("quick");
  }
});

test("classifyDeterministic: approvals and acknowledgements are NOT shortcut (they answer the previous turn)", () => {
  const words = ["great", "cool", "awesome", "nice", "np", "no problem", "got it", "perfect", "alright", "k", "fine", "done", "good", "lgtm", "go ahead", "proceed", "agreed", "right"];
  for (const word of words) {
    for (const line of [word, `${word}!`, word.toUpperCase()]) expect(classifyDeterministic(line)).toBeUndefined();
  }
});

test("classifyDeterministic: a bare approval or refusal is NOT shortcut (its meaning is the previous turn)", () => {
  for (const line of ["yes", "no", "ok", "  okay  ", "k", "sure", "sounds good", "yep", "yup", "nope", "nah", "да", "нет", "ок", "Sure!"]) {
    expect(classifyDeterministic(line)).toBeUndefined();
  }
});

test("classifyDeterministic: a longer message that merely starts with a greeting is NOT quick", () => {
  expect(classifyDeterministic("hi, can you also refactor the auth module while you're at it")).toBeUndefined();
});

test("classifyDeterministic: a request naming a review resolves review", () => {
  expect(classifyDeterministic("can you review this PR")).toBe("review");
  expect(classifyDeterministic("please do a code review of src/commands/shell.ts")).toBe("review");
  expect(classifyDeterministic("review the pull request #42")).toBe("review");
});

test("classifyDeterministic: review naming wins over a short chit-chat match when both could apply", () => {
  expect(classifyDeterministic("review please")).toBe("review");
});

test("classifyDeterministic: an unrelated word containing 'review' as a substring does not false-positive", () => {
  // "overview" must not match \breview\b.
  expect(classifyDeterministic("give me an overview of the auth module")).toBeUndefined();
});

test("classifyDeterministic: an ordinary coding request matches neither shortcut", () => {
  expect(classifyDeterministic("add a retry loop to the fetch call in providers.ts")).toBeUndefined();
});

test("classifyDeterministic: empty input is unclassified", () => {
  expect(classifyDeterministic("   ")).toBeUndefined();
});

 test("Russian smoke greeting is quick without matching unrelated coding requests", () => {
  expect(classifyDeterministic("Привет! Ответь одним словом.")).toBe("quick");
  expect(classifyDeterministic("Спасибо!")).toBe("quick");
  expect(classifyDeterministic("Привет! Исправь очередь сообщений")).toBeUndefined();
});
