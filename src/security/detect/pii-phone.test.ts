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

// Flow packages are named `NNN-YYYY-MM-DD-<slug>`, and that prefix satisfied
// every phone heuristic — so `ls .metaproject/flows` reached agents fully masked
// and no flow directory could be opened (keryx session 4a24a760, 2026-08-19).
test("does NOT flag the ISO-dated prefix of a flow directory name", () => {
  expect(phones("001-2026-07-09-managed-review-feedback-loop")).toEqual([]);
  expect(phones("144-2026-08-11-agent-mode-web-fetch")).toEqual([]);
});

test("does NOT flag a flow-directory listing, path-qualified or bare", () => {
  const listing = [
    "001-2026-07-09-managed-review-feedback-loop",
    ".metaproject/flows/144-2026-08-11-agent-mode-web-fetch/flow.json",
    "176-2026-08-19-security-detector-false-positives",
  ].join("\n");
  expect(phones(listing)).toEqual([]);
});

test("does NOT flag other dated identifiers built on a calendar date", () => {
  expect(phones("release-2026-01-31-hotfix")).toEqual([]);
  // A date with a non-calendar month/day is not exempted — the guard keys on a
  // real date, so it cannot be widened into a blanket digit-run escape hatch.
  expect(phones("call 415-555-0199 now")).toEqual(["415-555-0199"]);
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
