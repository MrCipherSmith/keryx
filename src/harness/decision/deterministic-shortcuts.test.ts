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
  expect(classifyDeterministic("  ok  ")).toBe("quick");
  expect(classifyDeterministic("sounds good")).toBe("quick");
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
