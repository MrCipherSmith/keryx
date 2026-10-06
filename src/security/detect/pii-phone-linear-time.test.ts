import { describe, expect, test } from "bun:test";
import { detectPii, execPhone } from "./pii";

const REFERENCE_PHONE = /(?<![\w.])(\+?\d[\d\s().-]{7,}\d)(?![\w.])/g;

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

  test("detectPii still redacts the usual phone shapes", () => {
    const phones = (content: string) =>
      detectPii(content)
        .filter((match) => match.policyId === "pii.phone")
        .map((match) => match.value);
    expect(phones("call +14155550199 or 415-555-0199 now")).toEqual(["+14155550199", "415-555-0199"]);
    expect(phones("contact-415-555-0199-primary")).toEqual(["415-555-0199"]);
  });
});

function bestOf(content: string): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run += 1) {
    const startedAt = performance.now();
    detectPii(content);
    best = Math.min(best, performance.now() - startedAt);
    if (best > 1_000) {
      break;
    }
  }
  return best;
}

function wholeUnits(unit: string, length: number): string {
  return unit.repeat(Math.floor(length / unit.length));
}

// Each shape is one long `[\d\s().-]` run in which no digit is followed by a valid match end, so
// every start used to rescan the run to its end.
const SHAPES = ["-1.", " 11.", "-12.", "(1.", "- 1."];

describe("detectPii runs in linear time on long phone-shaped inputs", () => {
  for (const unit of SHAPES) {
    test(
      `160k characters of ${JSON.stringify(unit)} repeated`,
      () => {
        const half = bestOf(wholeUnits(unit, 80_000));
        const full = bestOf(wholeUnits(unit, 160_000));
        expect(full).toBeLessThan(1_500);
        // Millisecond-scale linear runs are noisy, so the ratio is measured against a floor.
        expect(full).toBeLessThan(3.5 * Math.max(half, 20));
      },
      60_000,
    );
  }
});
