import { describe, expect, test } from "bun:test";
import { detectPii } from "./pii";

// Flow 412, review round 1, joined and wrapped phones: L1 (a phone that ends a line with a dot or a dash, followed by a
// card or digits on the next line), L7 (a phone span that crosses a line break into the next line), L10 (a rescan
// window inside a card), S4 (phones joined with `-` or `.`).

const found = (content: string, policyId: string) => detectPii(content).filter((match) => match.policyId === policyId);
const phones = (content: string) => found(content, "pii.phone").map((match) => content.slice(match.start, match.end));
const spans = (content: string, policyId: string) => found(content, policyId).map((match) => [match.start, match.end]);

describe("a phone that ends a line is not lost to the line below it (L1)", () => {
  test("a card on the next line", () => {
    for (const content of ["Phone 415-555-0199.\n4111-1111-1111-1111", "Phone 415-555-0199.\n4111 1111 1111 1111"]) {
      expect(phones(content), content).toEqual(["415-555-0199"]);
      expect(found(content, "pii.credit-card"), content).toHaveLength(1);
    }
  });

  test("a card on the same line", () => {
    expect(phones("Phone 415-555-0199. 4111 1111 1111 1111")).toEqual(["415-555-0199"]);
    expect(phones("Phone 415-555-0199\n4111 1111 1111 1111")).toEqual(["415-555-0199"]);
    expect(phones("Phone 415-555-0199.4111 1111 1111 1111")).toEqual(["415-555-0199"]);
  });

  test("several numbers and breaks in one text", () => {
    const content = "415-555-0199. 4111 1111 1111 1111-\n415-555-0199 - ";
    expect(phones(content)).toEqual(["415-555-0199", "415-555-0199"]);
    expect(found(content, "pii.credit-card")).toHaveLength(1);
  });

  test("a phone after a card whose last group ends the line with a dash", () => {
    const content = "5500 0000 0000 0004-\n415-555-0199 4111-1111-1111-1111.x-\n";
    expect(found(content, "pii.credit-card").length).toBeGreaterThanOrEqual(1);
    const reported = phones(content);
    expect(reported[0]).toBe("415-555-0199");
    expect(reported.length).toBeGreaterThanOrEqual(2);
  });
});

describe("a phone span stops at the line break after it (L7)", () => {
  test("text on the next line", () => {
    const content = "Phone: 415-555-0199.\n123 Main Street";
    expect(phones(content)).toEqual(["415-555-0199"]);
  });

  test("digits on the next line", () => {
    expect(phones("Call 415-555-0199.\n0800 123 4567")).toEqual(["415-555-0199"]);
    expect(phones("Call 415-555-0199-\n0800 123 4567")).toEqual(["415-555-0199"]);
  });

  test("a number wrapped over two lines is still one", () => {
    expect(phones("tel 415-555-\n0199")).toHaveLength(1);
    expect(phones("tel 415-555-\n0199")[0]?.replace(/\D/g, "")).toBe("4155550199");
  });
});

describe("joined phones (S4)", () => {
  const cases: Array<[string, string[]]> = [
    ["4155550199-123456", ["4155550199"]],
    ["4155550199.123456", ["4155550199"]],
    ["+14155550199-4155550199", ["+14155550199", "4155550199"]],
    ["4155550199-4155550199", ["4155550199", "4155550199"]],
    ["415-555-0199-4155550199", ["415-555-0199", "4155550199"]],
    ["415-555-0199-415-555-0199-415-555-0199", ["415-555-0199", "415-555-0199", "415-555-0199"]],
    ["(415) 555-0199-123456", ["415) 555-0199"]],
    ["415 555 0199-123456", ["415 555 0199"]],
    ["415-555-0199-123456", ["415-555-0199"]],
    ["415.555.0199.415.555.0199", ["415.555.0199", "415.555.0199"]],
    ["5500000000000004-415-555-0199", ["415-555-0199"]],
  ];
  for (const [content, expected] of cases) {
    test(JSON.stringify(content), () => {
      expect(phones(content)).toEqual(expected);
    });
  }

  test("a parenthesis phone with a joined tail is found whole", () => {
    expect(phones("(415) 555-0199-415-555-0199").length).toBeGreaterThanOrEqual(2);
  });

  test("identifiers, dates and groups of four stay quiet", () => {
    for (const content of [
      "20260912-3668-4760-9056-00112233445566",
      "1234-5678-9012-3456-7890",
      "8311-4841-3546-3949",
      "2026-10-07",
    ]) {
      expect(phones(content), content).toEqual([]);
    }
  });
});

describe("a number window inside a card is not a phone (L10)", () => {
  // `Phone 415-555-0199.4111 1111 1111 1111`: the phone run reaches into the card, and the window that holds the
  // card's first digits is a piece of the card, not a second number. Without `dropRescansInsideCards` it is reported
  // as `phone[24,38]` next to the card.
  test("no phone overlaps a card", () => {
    const content = "Phone 415-555-0199.4111 1111 1111 1111";
    const cards = spans(content, "pii.credit-card");
    expect(cards).toEqual([[19, 38]]);
    for (const [start, end] of spans(content, "pii.phone") as Array<[number, number]>) {
      expect(end <= 19 || start >= 38, `phone [${start},${end}] overlaps the card`).toBe(true);
    }
    expect(phones(content)).toEqual(["415-555-0199"]);
  });

  test("the phone before the card is still reported", () => {
    expect(phones("Phone 415-555-0199.4111 1111 1111 1111")).toEqual(["415-555-0199"]);
  });
});
