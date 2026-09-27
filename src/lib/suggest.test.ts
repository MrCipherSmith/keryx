import { expect, test } from "bun:test";
import { formatUnknownCommandMessage, suggestClosest } from "./suggest";

const KNOWN = ["doctor", "list", "status", "health", "memory"];

test("suggestClosest finds a one-edit typo", () => {
  expect(suggestClosest("docto", KNOWN)).toEqual(["doctor"]);
});

test("suggestClosest returns nothing beyond edit distance 2", () => {
  // "zzzqxvvv" vs every KNOWN entry is well beyond 2 edits.
  expect(suggestClosest("zzzqxvvv", KNOWN)).toEqual([]);
});

test("suggestClosest caps at 3, closest first, ties broken alphabetically", () => {
  const known = ["cat", "bat", "hat", "rat", "mat"];
  // "at" is 1 edit from every candidate (all length 3, one insertion) — a
  // tie on distance, broken alphabetically: bat, cat, hat before mat, rat.
  expect(suggestClosest("at", known)).toEqual(["bat", "cat", "hat"]);
});

test("suggestClosest is case-insensitive", () => {
  expect(suggestClosest("DOCTO", KNOWN)).toEqual(["doctor"]);
});

test("suggestClosest on an empty query returns nothing", () => {
  expect(suggestClosest("", KNOWN)).toEqual([]);
});

test("formatUnknownCommandMessage with a suggestion", () => {
  expect(formatUnknownCommandMessage("docto", KNOWN)).toBe(
    "Unknown command: docto. Did you mean: doctor? Run `keryx --help` for the list.",
  );
});

test("formatUnknownCommandMessage with no suggestion drops the clause entirely, not empty", () => {
  expect(formatUnknownCommandMessage("zzzqxvvv", KNOWN)).toBe(
    "Unknown command: zzzqxvvv. Run `keryx --help` for the list.",
  );
});
