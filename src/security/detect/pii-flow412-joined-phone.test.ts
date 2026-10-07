import { describe, expect, test } from "bun:test";
import { detectPii } from "./pii";

// Flow 412 AC1: a phone number joined to more digits by "-" or "." used to disappear, because the phone rule needs a
// non-digit on both sides and the digits that follow the number are such a digit run.

const phones = (content: string) => detectPii(content).filter((match) => match.policyId === "pii.phone");

describe("a phone joined to more digits is reported (flow 412 AC1)", () => {
  test("a number followed by a dash and a long digit group", () => {
    const [match, ...rest] = phones("415-555-0199-123456");
    expect(match?.value).toBe("415-555-0199");
    expect(match?.start).toBe(0);
    expect(rest).toHaveLength(0);
  });

  test("the same inside a sentence", () => {
    const content = "call 415-555-0199-123456 now";
    expect(phones(content).map((match) => match.value)).toContain("415-555-0199");
  });

  test("two dotted numbers joined by dots are both reported", () => {
    const content = "415.555.0199.415.555.0199";
    expect(phones(content).map((match) => [match.start, match.end])).toEqual([
      [0, 12],
      [13, 25],
    ]);
  });

  test("offsets point into the original text", () => {
    const content = "ref 415-555-0199-123456";
    const match = phones(content).find((candidate) => candidate.value === "415-555-0199");
    expect(match).toBeDefined();
    expect(content.slice(match?.start, match?.end)).toBe("415-555-0199");
  });
});

describe("joined digits that are not a phone stay unreported", () => {
  const quiet = [
    "20260912-3668-4760-9056-00112233445566",
    "8311-4841-3546-3949",
    "2026-10-07",
    "1234-5678-9012-3456-7890",
  ];
  for (const content of quiet) {
    test(content, () => {
      expect(phones(content)).toHaveLength(0);
    });
  }
});
