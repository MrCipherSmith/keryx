// Regression tests for the phone false positive that made `keryx security eval`
// unreadable through `keryx ctx` (review 2026-07-26, finding B-03).
//
// The loose phone pattern treats whitespace as a grouping separator, so every
// row of an aligned numeric report scored as a phone number and was masked.

import { expect, test } from "bun:test";
import { detectPii } from "./pii";

function phones(input: string): string[] {
  return detectPii(input)
    .filter((match) => match.policyId === "pii.phone")
    .map((match) => match.value);
}

test("does NOT flag whitespace-aligned numeric table columns", () => {
  // A verbatim row of the security eval report's own output.
  const row = "prompt-injection               12   12    0    0   0.0000   0.0500   ok";
  expect(phones(row)).toEqual([]);
});

test("does NOT flag a single-space numeric column run", () => {
  expect(phones("secret 6 6 0 0 0.0000 0.0000 ok")).toEqual([]);
});

test("does NOT flag a whole report through the detector", () => {
  const report = [
    "security eval — false-negative rate by detector",
    "cases: 42",
    "detector                     pos   TP   FN   FP   fnRate  ceiling  status",
    "prompt-injection              12   12    0    0   0.0000   0.0500   ok",
    "secret                         6    6    0    0   0.0000   0.0000   ok",
  ].join("\n");
  expect(phones(report)).toEqual([]);
});

test("STILL flags an international phone number with single-space groups", () => {
  expect(phones("Reach the rota at +1 415 555 0199 today.")).toEqual(["+1 415 555 0199"]);
});

test("STILL flags dash- and paren-separated phone numbers", () => {
  expect(phones("call 415-555-0199 now")).toEqual(["415-555-0199"]);
  // The capture starts at the first digit, so the leading `(` is not part of
  // the value — assert on detection, not on that pre-existing capture detail.
  expect(phones("call (415) 555-0199 now")).toEqual(["415) 555-0199"]);
});
