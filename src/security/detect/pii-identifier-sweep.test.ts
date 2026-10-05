// Does any OTHER PII pattern match a fragment of an identifier?
//
// `pii.phone` did (flow 260): a hyphen satisfied both its boundary lookarounds
// AND its internal separator class, so a digit run inside a UUID looked like a
// dialling sequence. The guard that fixed it is specific to that rule, which
// makes "are the others affected?" a question that must be answered rather than
// assumed — a layer absent from a report reads as checked and clean.
//
// This file is that answer, kept executable so it stays true. Each rule is put
// against the shapes that broke `pii.phone`: a v4 UUID, a hex digest, a
// hyphenated slug, and an over-long all-digit identifier.
//
// Result at the time of writing — every other rule is unaffected, for a reason
// per rule:
//
//   pii.email        `@` and a dotted TLD are not identifier characters; a UUID
//                    has neither.
//   pii.address      requires capitalised street words (`Street`, `Ave`, …).
//   pii.person-name  requires a context word (`customer:`, `name is`) and two
//                    Capitalised words.
//   pii.iban         `\b[A-Z]{2}\d{2}…` — needs two uppercase letters at a word
//                    boundary, and `isValidIban` checks mod-97.
//   pii.credit-card  can span a hyphenated digit run, but `isValidCreditCard`
//                    (Luhn) rejects what is not a card number.
//   pii.ssn          `\b\d{3}-\d{2}-\d{4}\b` can sit inside a hyphenated token.
//                    It is the one rule where the same weakness was reachable and
//                    flow 261 gave it the phone rule's guard; see the block below.
//   pii.ip           dotted quads / colon groups; `isValidIp` range-checks.

import { describe, expect, test } from "bun:test";
import { detectPii } from "./pii";

const SHAPES: ReadonlyArray<readonly [string, string]> = [
  ["a v4 UUID", "730344f3-3668-4760-9056-bf7292686b67"],
  ["a prefixed UUID", "urn:uuid:730344f3-3668-4760-9056-bf7292686b67"],
  ["a sha256 digest", "901131d838b17aac0f7885b81e03cbdc9f5157a00343d30ab22083685ed1416a"],
  ["a hyphenated event id", "event-f53fd8cbab7a47fd-3668-4760-9056"],
  ["an over-long all-digit id", "20260912-3668-4760-9056-00112233445566"],
  ["a flow directory name", "001-2026-07-09-managed-review-feedback-loop"],
];

describe("no PII rule fires on an identifier", () => {
  for (const [label, input] of SHAPES) {
    test(`${label} produces no finding of any kind`, () => {
      expect(detectPii(input)).toEqual([]);
    });
  }

  test("nor inside the JSON an MCP tool returns", () => {
    const body = JSON.stringify({
      correlationId: "730344f3-3668-4760-9056-bf7292686b67",
      eventId: "event-f53fd8cbab7a47fd",
      priorEventHash: "901131d838b17aac0f7885b81e03cbdc9f5157a00343d30ab22083685ed1416a",
      workspaceId: "workspace-a",
      proposalId: "proposal-a",
    });
    expect(detectPii(body)).toEqual([]);
  });
});

describe("pii.ssn follows the phone rule (flow 261)", () => {
  // `pii.ssn` is bounded by `\b`, which a hyphen also satisfies, so an SSN-shaped
  // run can sit inside a longer hyphenated token. Flow 261 decided it the way flow
  // 260 decided phone: a false negative leaks an SSN, a false positive only
  // corrupts an identifier, so the run is redacted unless the surroundings are
  // POSITIVE hex-identifier evidence (a UUID, a digest, a hash-prefixed id).
  const ssnValues = (input: string) => detectPii(input).filter((m) => m.policyId === "pii.ssn").map((m) => m.value);

  test("an SSN-shaped run in an ambiguous hyphenated identifier is still redacted", () => {
    expect(ssnValues("release-123-45-6789-hotfix")).toEqual(["123-45-6789"]);
    expect(ssnValues("contact-123-45-6789-primary")).toEqual(["123-45-6789"]);
    expect(ssnValues("a-123-45-6789")).toEqual(["123-45-6789"]);
  });

  test("an SSN-shaped run next to a hex or hash identifier part is left alone", () => {
    expect(ssnValues("build-a1b2c3d4-123-45-6789")).toEqual([]);
    expect(ssnValues("123-45-6789-f53fd8cbab7a47fd")).toEqual([]);
    expect(ssnValues("event-901131d838b17aac-123-45-6789-open")).toEqual([]);
  });

  test("a date-like or all-digit neighbour is not hex evidence", () => {
    expect(ssnValues("20260912-123-45-6789")).toEqual(["123-45-6789"]);
  });

  test("a truncated token never buys suppression", () => {
    const long = `${"a1b2c3d4-".repeat(12)}123-45-6789`;
    expect(ssnValues(long)).toEqual(["123-45-6789"]);
  });

  test("BOUNDARY — a bare SSN, a labelled SSN and one in a hyphenated sentence are still detected", () => {
    expect(ssnValues("ssn 123-45-6789")).toEqual(["123-45-6789"]);
    expect(ssnValues("ssn: 123-45-6789")).toEqual(["123-45-6789"]);
    expect(ssnValues("my number - 123-45-6789 - is private")).toEqual(["123-45-6789"]);
    expect(ssnValues("SSN=123-45-6789.")).toEqual(["123-45-6789"]);
  });
});
