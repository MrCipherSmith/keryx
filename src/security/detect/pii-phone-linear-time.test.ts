import { describe, expect, test } from "bun:test";
import { detectPii, execPhone } from "./pii";

// A sentence-final period does not join a number to what follows (`Phone: 415-555-0199.`), but `.` and a word
// character does (`1.2.3.4`, `10.5.x`).
const REFERENCE_PHONE = /(?<![\w.])(\+?\d[\d\s().-]{7,}\d)(?!\w|\.\w)/g;

type Span = { index: number; text: string };

function referenceSpans(content: string): Span[] {
  return [...content.matchAll(REFERENCE_PHONE)].map((m) => ({ index: m.index as number, text: m[1] as string }));
}

function scannedSpans(content: string): Span[] {
  const spans: Span[] = [];
  for (let m = execPhone(content, 0); m !== null; m = execPhone(content, m.index + m[0].length)) {
    spans.push({ index: m.index, text: m[1] as string });
  }
  return spans;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const FRAGMENTS = [
  "1", "12", "123", "4567", "123456789", "0", " ", "  ", "\t", "(", ")", "-", ".", "+", "a", "_", "x", "-1.", "1.",
  "é", "\n", "/", "555-0199", "+1", "ab12cd34", "2026-07-09", ",", ":", "@", "1-1.", " 11.", "(1.",
];
const ALPHABET = "0123456789 ().-+a_.\t,";

const phones = (content: string) =>
  detectPii(content)
    .filter((match) => match.policyId === "pii.phone")
    .map((match) => match.value);

function generate(random: () => number, count: number, build: (random: () => number) => string): string[] {
  return Array.from({ length: count }, () => build(random));
}

describe("the phone scanner matches the reference regex span for span", () => {
  test("fragment-built inputs", () => {
    const random = seededRandom(0xfeed);
    const inputs = generate(random, 6000, (rnd) => {
      let content = "";
      for (let j = 1 + Math.floor(rnd() * 24); j > 0; j -= 1) {
        content += FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)] as string;
      }
      return content;
    });
    for (const content of inputs) {
      expect(scannedSpans(content)).toEqual(referenceSpans(content));
    }
  });

  test("character-built inputs over digits, spaces, ().-, + and word chars", () => {
    const random = seededRandom(0xbeef);
    const inputs = generate(random, 12000, (rnd) => {
      let content = "";
      for (let j = 1 + Math.floor(rnd() * 40); j > 0; j -= 1) {
        content += ALPHABET[Math.floor(rnd() * ALPHABET.length)] as string;
      }
      return content;
    });
    for (const content of inputs) {
      expect(scannedSpans(content)).toEqual(referenceSpans(content));
    }
  });

  test("directed cases", () => {
    const cases = [
      "",
      "+",
      "415-555-0199",
      "a+415-555-0199",
      "+1 415 555 0199.",
      "415-555-0199.",
      "x415-555-0199",
      "(415) 555-0199 and +44 20 7946 0958",
      "-1.-1.-1.-1.-1.-1.-1.",
      "-1.-1.-1.-1.-1.-1.-1.-1.-1.-1.5",
      "1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6",
      "123456789.",
      "123456789.123456789",
      "123456789-",
      "-123456789a",
      "..123456789",
      "12345678 9",
    ];
    for (const content of cases) {
      expect(scannedSpans(content)).toEqual(referenceSpans(content));
    }
  });

  test("a sentence-final period does not hide a number (SEC-F-002)", () => {
    expect(phones("Phone: 415-555-0199.")).toEqual(["415-555-0199"]);
    expect(phones("My number is +1 415 555 0199.")).toEqual(["+1 415 555 0199"]);
    // The span starts at the first digit, as it does without the period: an opening parenthesis is not part of it.
    expect(phones("Call (415) 555-0199.")).toEqual(["415) 555-0199"]);
    expect(phones("Call (415) 555-0199")).toEqual(["415) 555-0199"]);
    expect(phones("Call 415-555-0199. Then 415-555-0198.")).toEqual(["415-555-0199", "415-555-0198"]);
    expect(phones("Call 415-555-0199.\nNext line")).toEqual(["415-555-0199"]);
  });

  test("a period followed by a word character still joins the number to a longer token", () => {
    expect(phones("version 1.2.3.4")).toEqual([]);
    expect(phones("value 123456789.123456789")).toEqual([]);
    expect(phones("see 415-555-0199.x")).toEqual([]);
  });

  test("a number glued to other digits by a space is found (SEC-F-003)", () => {
    expect(phones("12345678 415-555-0199")).toEqual(["415-555-0199"]);
    expect(phones("2026-07-09 415-555-0199")).toEqual(["415-555-0199"]);
    expect(phones("415-555-0199 12345678")).toEqual(["415-555-0199"]);
    expect(phones("ref 12345678 +1 415 555 0199 end")).toEqual(["+1 415 555 0199"]);
    expect(phones("415-555-0199\n12345678\n415-555-0198")).toEqual(["415-555-0199", "415-555-0198"]);
  });

  test("a table of numbers is still not a phone number", () => {
    expect(phones("12  12  0  0  0.0000")).toEqual([]);
    expect(phones("12345678  415  555  0199")).toEqual([]);
    expect(phones("1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6")).toEqual([]);
    expect(phones("rows 12 34\n56 78\n90 12\n34 56 78")).toEqual([]);
  });

  test("a rescan never reports a span that overlaps another or leaves the original text", () => {
    const random = seededRandom(0xcafe);
    const pieces = ["1", "12", "123", "1234", "12345678", "415-555-0199", "2026-07-09", " ", " ", "\n", "-", ".", "(", ")", "+1", "+", "a"];
    for (let i = 0; i < 6000; i += 1) {
      let content = "";
      for (let j = 1 + Math.floor(random() * 14); j > 0; j -= 1) {
        content += pieces[Math.floor(random() * pieces.length)] as string;
      }
      let previousEnd = 0;
      for (const match of detectPii(content).filter((m) => m.policyId === "pii.phone")) {
        expect(content.slice(match.start, match.end)).toBe(match.value);
        expect(match.start).toBeGreaterThanOrEqual(previousEnd);
        previousEnd = match.end;
        const digits = match.value.replace(/\D/g, "").length;
        expect(digits >= 9 && digits <= 15).toBe(true);
      }
    }
  });

  test("detectPii still redacts the usual phone shapes", () => {
    expect(phones("call +14155550199 or 415-555-0199 now")).toEqual(["+14155550199", "415-555-0199"]);
    expect(phones("contact-415-555-0199-primary")).toEqual(["415-555-0199"]);
  });
});

// Linear work scales 4x from 40k to 160k characters and quadratic work 16x. The ratio of the best of five
// runs is gated at 8, the midpoint, with a floor so that millisecond-scale runs do not turn timer noise into a
// ratio, and an absolute ceiling for the case where both sizes are already slow.
const SMALL = 40_000;
const LARGE = 160_000;
const RUNS = 5;
const RATIO_LIMIT = 8;
const FLOOR_MS = 10;
const CEILING_MS = 1_500;

function bestOf(content: string): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < RUNS; run += 1) {
    const startedAt = performance.now();
    detectPii(content);
    best = Math.min(best, performance.now() - startedAt);
    if (best > CEILING_MS) {
      break;
    }
  }
  return best;
}

function wholeUnits(unit: string, length: number): string {
  return unit.repeat(Math.floor(length / unit.length));
}

// The first group is one long `[\d\s().-]` run in which no digit is followed by a valid match end, so every
// start used to rescan the run to its end. The second group is a run that the regex matches whole but the digit
// count rejects, which the rescan then searches for shorter numbers: it must stay linear in the run.
const SHAPES = [
  "-1.", " 11.", "-12.", "(1.", "- 1.",
  "1 ", "12 ", "12345678 ", "12345678 415-555-0199 ", "415-555-0199. ", "1234 1234 12 ", "1111111111111 1 ", "123 45 ", "(1) ", "1-1 ",
  "12\n", "415-555-0199\r\n  ", "1  ",
];

describe("detectPii runs in linear time on long phone-shaped inputs", () => {
  for (const unit of SHAPES) {
    test(
      `160k characters of ${JSON.stringify(unit)} repeated`,
      () => {
        const small = bestOf(wholeUnits(unit, SMALL));
        const full = bestOf(wholeUnits(unit, LARGE));
        expect(full).toBeLessThan(CEILING_MS);
        expect(full).toBeLessThan(RATIO_LIMIT * Math.max(small, FLOOR_MS));
      },
      60_000,
    );
  }
});
