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
  // corrupts an identifier, so the run is redacted unless the segment IMMEDIATELY
  // next to it is a real hash (hex, 16+ chars, at least one a-f). A label
  // (`ssn` / `social`) in the token, just before it, or in the same sentence just
  // after it overrides that.
  const ssnValues = (input: string) => detectPii(input).filter((m) => m.policyId === "pii.ssn").map((m) => m.value);
  const SSN = "123-45-6789";
  const md5 = "d41d8cd98f00b204e9800998ecf8427e";
  const sha1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
  const sha256 = "901131d838b17aac0f7885b81e03cbdc9f5157a00343d30ab22083685ed1416a";

  test("an SSN-shaped run in an ambiguous hyphenated identifier is still redacted", () => {
    expect(ssnValues("release-123-45-6789-hotfix")).toEqual([SSN]);
    expect(ssnValues("contact-123-45-6789-primary")).toEqual([SSN]);
    expect(ssnValues("a-123-45-6789")).toEqual([SSN]);
  });

  test("an SSN-shaped run directly beside a real hash is left alone", () => {
    expect(ssnValues("build-f53fd8cbab7a47fd-123-45-6789")).toEqual([]);
    expect(ssnValues("123-45-6789-f53fd8cbab7a47fd")).toEqual([]);
    expect(ssnValues("event-901131d838b17aac-123-45-6789-open")).toEqual([]);
  });

  test("md5 (32), sha1 (40) and sha256 (64) neighbours are all suppressed, on either side", () => {
    for (const digest of [md5, sha1, sha256]) {
      expect(ssnValues(`${digest}-${SSN}`)).toEqual([]);
      expect(ssnValues(`${SSN}-${digest}`)).toEqual([]);
      expect(ssnValues(`file-${digest}-${SSN}-v2`)).toEqual([]);
    }
  });

  test("a short or hex-looking neighbour is not evidence", () => {
    for (const input of [
      "build-a1b2c3d4-123-45-6789",
      "deadbeef-123-45-6789",
      "1234567e-123-45-6789",
      "ssn-12345678a-123-45-6789",
      "E1234567-123-45-6789",
      "20260912a-123-45-6789",
      "case-1234567e-123-45-6789",
      "20260912-123-45-6789",
    ]) {
      expect(ssnValues(input)).toEqual([SSN]);
    }
  });

  test("a hash that is not adjacent to the SSN does not suppress it", () => {
    expect(ssnValues(`${md5}-foo-${SSN}`)).toEqual([SSN]);
    expect(ssnValues(`${SSN}-foo-${md5}`)).toEqual([SSN]);
  });

  test("a label in or just before the token overrides a hash neighbour", () => {
    for (const input of [
      "john-smith-ssn-123-45-6789-deadbeef",
      "Employee-ID-deadbeef-SSN-123-45-6789",
      "abcdef12-ssn-123-45-6789",
      "SSN:123-45-6789-abcdef0123",
      `ssn-${md5}-${SSN}`,
      `${SSN}-${sha256}-social`,
      `ssn: ${sha1}-${SSN}`,
    ]) {
      expect(ssnValues(input)).toEqual([SSN]);
    }
  });

  test("a label right after the token vetoes suppression; a distant one does not", () => {
    expect(ssnValues(`${md5}-${SSN} is the SSN`)).toEqual([SSN]);
    expect(ssnValues(`${SSN}-${md5} (social)`)).toEqual([SSN]);
    expect(ssnValues(`${md5}-${SSN} and then a long unrelated sentence that mentions the ssn`)).toEqual([]);
    expect(ssnValues(`${md5}-${SSN}.\nthe ssn is elsewhere`)).toEqual([]);
    expect(ssnValues(`${md5}-${SSN}\nssn`)).toEqual([]);
    expect(ssnValues(`${md5}-${SSN}. ssn`)).toEqual([]);
  });

  test("a repeated SSN is judged at its own offset, not at the first occurrence", () => {
    expect(ssnValues(`${SSN}-${SSN}`)).toEqual([SSN, SSN]);
    expect(ssnValues(`${SSN}-${md5}-${SSN}`)).toEqual([]);
    expect(ssnValues(`${SSN}-foo-${SSN}-${md5}`)).toEqual([SSN]);
  });

  test("a truncated token never buys suppression", () => {
    const long = `${"a1b2c3d4-".repeat(30)}${SSN}`;
    expect(ssnValues(long)).toEqual([SSN]);
  });

  test("BOUNDARY — a bare SSN, a labelled SSN and one in a hyphenated sentence are still detected", () => {
    expect(ssnValues("ssn 123-45-6789")).toEqual([SSN]);
    expect(ssnValues("ssn: 123-45-6789")).toEqual([SSN]);
    expect(ssnValues("my number - 123-45-6789 - is private")).toEqual([SSN]);
    expect(ssnValues("SSN=123-45-6789.")).toEqual([SSN]);
  });
});
