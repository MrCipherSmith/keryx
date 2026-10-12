// Round-6 review fixes for the phone detector (PR 916 follow-up).
//
// 1. A phone followed by a list marker ("1.", "2)", "3 -") is still reported: the sticky match swallows the marker
//    digit, the verdict rejects the longer run, and the scanner retries the longest acceptable prefix.
// 2. The token-window rescan does not invent a phone inside a card, a grouped digit run or a table row.
// 3. Overlapping same-rule spans from the plain and the NFKC passes become one span (one mask).
// 4. "415 555 0199 415 555 0199" leaves no readable tail.

import { describe, expect, test } from "bun:test";
import { applyRedaction } from "../redact";
import { detectPii } from "./pii";

function spans(input: string, policyId?: string): Array<[string, string]> {
  return detectPii(input)
    .filter((match) => policyId === undefined || match.policyId === policyId)
    .map((match) => [match.policyId, match.value]);
}

function phones(input: string): string[] {
  return spans(input, "pii.phone").map(([, value]) => value);
}

describe("a phone followed by a list marker is still reported", () => {
  test.each([
    ["call 415-555-0199 1. next item", "415-555-0199"],
    ["call 415-555-0199 2) next item", "415-555-0199"],
    ["call 415-555-0199 3 - next item", "415-555-0199"],
    ["call (415) 555-0199 1. next item", "415) 555-0199"],
    ["call +1 415 555 0199 4. next item", "+1 415 555 0199"],
    ["call 415 555 0199 2) next item", "415 555 0199"],
    ["call 415.555.0199 1) next item", "415.555.0199"],
    ["call 415-555-0199 1. 2) next item", "415-555-0199"],
    ["call 415-555-0199 1.  2) next item", "415-555-0199"],
    ["call 415-555-0199\n1. next item", "415-555-0199"],
  ])("%j", (input, phone) => {
    expect(phones(input)).toEqual([phone]);
  });

  test("the marker itself is not swallowed into the phone", () => {
    const [value] = phones("call 415-555-0199 1. next item");
    expect(value).not.toContain("1.");
  });

  test("the phone is masked and the marker text survives", () => {
    const input = "call 415-555-0199 1. next item";
    const out = applyRedaction(input, detectPii(input));
    expect(out).not.toContain("555-0199");
    expect(out).toContain(" 1. next item");
  });
});

describe("the rescan does not invent a phone", () => {
  test("a spaced card yields the card and no phone", () => {
    const input = "Pay: 4111 1111 1111 1111, ok";
    expect(spans(input)).toEqual([["pii.credit-card", "4111 1111 1111 1111"]]);
  });

  test("a dashed card yields only the card", () => {
    expect(spans("card 4111-1111-1111-1111 ok")).toEqual([["pii.credit-card", "4111-1111-1111-1111"]]);
  });

  test("a grouped 16-digit run that is not a card yields no phone", () => {
    expect(phones("ref 1234 5678 9012 3456 end")).toEqual([]);
  });

  test("a long single-token ID run yields no phone", () => {
    expect(phones("id 12345678901234567890 end")).toEqual([]);
  });

  test("a pure-space long ID run yields no phone", () => {
    expect(phones("id 123 456 789 012 345 678 end")).toEqual([]);
  });

  test("a numeric table row yields no phone", () => {
    expect(phones("totals   12   12    0    0   0.0000   0.0500   ok")).toEqual([]);
    expect(phones("a 1 2 3 4 5 6 7 8 9 10 11 12")).toEqual([]);
  });
});

describe("two phones in one run", () => {
  test("a spaced NANP number repeated leaves no readable tail", () => {
    expect(phones("415 555 0199 415 555 0199")).toEqual(["415 555 0199", "415 555 0199"]);
  });

  test("a dashed number repeated is two phones", () => {
    expect(phones("415-555-0199 415-555-0199")).toEqual(["415-555-0199", "415-555-0199"]);
  });

  test("the repeated spaced number is fully masked", () => {
    const input = "415 555 0199 415 555 0199";
    const out = applyRedaction(input, detectPii(input));
    expect(out).not.toMatch(/\d{3}/);
  });
});

describe("overlapping spans from the plain and NFKC passes", () => {
  // The plain pass stops at the fullwidth digit (", [5,16)"); the NFKC pass reads it as a digit ("[5,17)").
  const input = "call 415-555-019９";

  test("become one span covering the union", () => {
    const found = detectPii(input).filter((match) => match.policyId === "pii.phone");
    expect(found.length).toBe(1);
    expect([found[0]?.start, found[0]?.end]).toEqual([5, 17]);
    expect(found[0]?.value).toBe("415-555-019９");
  });

  test("are masked once, with no digit left behind", () => {
    const out = applyRedaction(input, detectPii(input));
    expect(out).not.toMatch(/[0-9０-９]/);
    expect(out.startsWith("call ")).toBe(true);
    expect(out.slice(5)).toBe(out.slice(5).trim());
  });
});

describe("applyRedaction on overlapping spans of different rules", () => {
  const mask = (start: number, end: number, policyId: string, value: string) =>
    ({ policyId, start, end, value, line: 1, column: start + 1, mask: "pii" }) as never;

  test("redacts the union without a second marker", () => {
    const content = "x 4111111111111111 y";
    const out = applyRedaction(content, [mask(2, 14, "pii.phone", content.slice(2, 14)), mask(2, 18, "pii.credit-card", content.slice(2, 18))]);
    expect(out).not.toMatch(/\d/);
    expect(out.split("[REDACTED").length - 1).toBe(1);
  });

  test("redacts a partial overlap with no digit leak", () => {
    const content = "x 1234567890123456 y";
    const out = applyRedaction(content, [mask(2, 12, "pii.phone", content.slice(2, 12)), mask(8, 18, "pii.credit-card", content.slice(8, 18))]);
    expect(out).not.toMatch(/\d/);
    expect(out.startsWith("x ")).toBe(true);
    expect(out.endsWith(" y")).toBe(true);
  });
});
