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
//   pii.ssn          `\b\d{3}-\d{2}-\d{4}\b` can sit inside a hyphenated token,
//                    and `isValidSsn` only range-checks. See the case below:
//                    this is the one place the same weakness is REACHABLE, and
//                    it is asserted rather than glossed.
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

describe("the one rule where the same shape is reachable, stated rather than glossed", () => {
  // `pii.ssn` is bounded by `\b`, which a hyphen also satisfies, so an SSN-shaped
  // run CAN sit inside a longer hyphenated token. It is not the defect flow 260
  // repaired — no identifier in this codebase produced one — but the weakness is
  // the same shape, so it is pinned here: if a future change makes this fire,
  // the sweep says so instead of the next intermittent CI failure.
  test("an SSN-shaped run inside a hyphenated identifier is detected today", () => {
    const found = detectPii("release-123-45-6789-hotfix").filter((m) => m.policyId === "pii.ssn");
    // Documented as-is. Changing this is a product decision about SSN recall,
    // not a side effect of the phone fix — which is why the phone guard was
    // written for `pii.phone` alone.
    expect(found.map((m) => m.value)).toEqual(["123-45-6789"]);
  });

  test("BOUNDARY — and a bare SSN is of course still detected", () => {
    const found = detectPii("ssn 123-45-6789").filter((m) => m.policyId === "pii.ssn");
    expect(found.map((m) => m.value)).toEqual(["123-45-6789"]);
  });
});
