import { describe, expect, test } from "bun:test";
import { detectPii } from "./pii";

// Flow 412, review round 1: S7 (cards and IBANs written with more separators) and S9 (an SSN written with a space, a
// dot, a slash, mixed separators or none).

const spans = (content: string, policyId: string) =>
  detectPii(content)
    .filter((match) => match.policyId === policyId)
    .map((match) => [match.start, match.end]);

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("cards with other separators (S7)", () => {
  const cards: Array<[string, number]> = [
    ["4111.1111 1111.1111", 19],
    ["4111 1111\n1111 1111", 19],
    ["4111 - 1111 - 1111 - 1111", 25],
    ["4111, 1111, 1111, 1111", 22],
    ["4111:1111:1111:1111", 19],
    ["4111：1111：1111：1111", 19],
    ["4111\n\n1111\n\n1111\n\n1111", 22],
    ["4111-\n1111-\n1111-\n1111", 22],
    ["4111 1111-1111 1111", 19],
  ];
  for (const [content, length] of cards) {
    test(JSON.stringify(content), () => {
      expect(spans(content, "pii.credit-card")).toEqual([[0, length]]);
    });
  }

  test("a list of numbers is not cut into a card", () => {
    for (const content of [
      "1234, 5678, 9012, 3456, 7890",
      "4111:1111:1111:1111:1111",
      "x 4111, 1111, 1111, 1111, 1111",
      "12,345,678,901,234,567",
      "2026-10-07 12:30:45",
    ]) {
      expect(spans(content, "pii.credit-card"), content).toEqual([]);
    }
  });
});

describe("IBANs with other separators (S7)", () => {
  const ibans: Array<[string, number]> = [
    ["GB82-WEST-1234-5698-7654-32", 27],
    ["GB82.WEST.1234.5698.7654.32", 27],
    ["GB82 WEST\n1234 5698 7654 32", 27],
    ["GB82  WEST  1234  5698  7654  32", 32],
    ["NL91-ABNA-0417-1643-00", 22],
    ["NL91/ABNA/0417/1643/00", 22],
  ];
  for (const [content, length] of ibans) {
    test(JSON.stringify(content), () => {
      expect(spans(content, "pii.iban")).toEqual([[0, length]]);
    });
  }

  test("a wrong check digit or a short number is not one", () => {
    for (const content of ["GB82-WEST-1234-5698-7654-33", "GB82-WEST-1234-5698", "GB82 WEST 1234 5698 7654 3"]) {
      expect(spans(content, "pii.iban"), content).toEqual([]);
    }
  });
});

describe("an SSN with any separator or none (S9)", () => {
  const found: Array<[string, number, number]> = [
    ["078 05 1120", 0, 11],
    ["078.05.1120", 0, 11],
    ["078/05/1120", 0, 11],
    ["078_05_1120", 0, 11],
    ["078 - 05 - 1120", 0, 15],
    ["078\n05-1120", 0, 11],
    ["078-05 1120", 0, 11],
    ["078 05-1120", 0, 11],
    ["SSN: 078 05 1120", 5, 16],
    ["ssn 078051120", 4, 13],
    ["SSN#078051120", 4, 13],
    ["ss# 078051120", 4, 13],
    ["Social Security Number: 078051120", 24, 33],
    ["social security no 078051120 x", 19, 28],
    ["id 078 05 1120 3", 3, 14],
  ];
  for (const [content, start, end] of found) {
    test(JSON.stringify(content), () => {
      expect(spans(content, "pii.ssn")).toEqual([[start, end]]);
    });
  }

  test("nine digits without a label are not an SSN", () => {
    for (const content of ["order 078051120", "tel 078051120", "x078051120", "SSN 0780511200", "078051120"]) {
      expect(spans(content, "pii.ssn"), content).toEqual([]);
    }
  });

  test("an impossible SSN is not one, whatever the separator", () => {
    for (const content of ["000 05 1120", "666 05 1120", "078 00 1120", "078 05 0000", "SSN 000051120"]) {
      expect(spans(content, "pii.ssn"), content).toEqual([]);
    }
  });

  test("a part of a longer number is not one", () => {
    for (const content of ["1 078 05 1120", "078 05 11201", "078 05 1120 1234", "2026 078 05 1120"]) {
      expect(spans(content, "pii.ssn"), content).toEqual([]);
    }
  });

  // Measured false-positive rates (seeded, 20000 samples each). Phone numbers and order ids never read as an SSN; a
  // random `ddd dd dddd` in prose is shaped like one, and about 88% of those are valid by the SSA rules (area not 000,
  // 666 or 9xx, group not 00, serial not 0000) -- the operator's rule is that a leak is worse than a masked identifier.
  test("false positives on phone numbers, order ids and prose", () => {
    const next = seeded(412009);
    const digits = (count: number) => Array.from({ length: count }, () => Math.floor(next() * 10)).join("");
    const samples = 20000;
    let phones = 0;
    let orders = 0;
    let bare = 0;
    let spaced = 0;
    for (let i = 0; i < samples; i += 1) {
      if (spans(`call ${digits(3)}-${digits(3)}-${digits(4)} today`, "pii.ssn").length > 0) phones += 1;
      if (spans(`order ORD-${digits(9)} shipped`, "pii.ssn").length > 0) orders += 1;
      if (spans(`the number ${digits(9)} was seen`, "pii.ssn").length > 0) bare += 1;
      if (spans(`ref ${digits(3)} ${digits(2)} ${digits(4)} end`, "pii.ssn").length > 0) spaced += 1;
    }
    expect(phones).toBe(0);
    expect(orders).toBe(0);
    expect(bare).toBe(0);
    expect(spaced / samples).toBeGreaterThan(0.8);
    expect(spaced / samples).toBeLessThan(0.95);
  });
});
