import { describe, expect, test } from "bun:test";
import { detectPii } from "./pii";

const REFERENCE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const REFERENCE_NAME =
  /\b(?:name\s+is|customer|client|user|patient|employee)\s*:?\s+([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g;

type Span = { start: number; value: string };

function referenceSpans(content: string, regex: RegExp, valueGroup: number): Span[] {
  return [...content.matchAll(regex)].map((m) => {
    const value = m[valueGroup] as string;
    return { start: valueGroup === 0 ? (m.index as number) : (m.index as number) + m[0].indexOf(value), value };
  });
}

function detectedSpans(content: string, policyId: string): Span[] {
  return detectPii(content)
    .filter((match) => match.policyId === policyId)
    .map((match) => ({ start: match.start, value: match.value }));
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const FRAGMENTS = [
  "a", "b.c", "@", "x@y.zz", "u@d.example.com", "user", "customer", "name is", "client", ":", " ", "  ", "\t", "\n",
  "Aa", "Bb", "Cc", "1", "23", "-", "_", ".", "%", "+", "é", "com", "a.b", "@@", ".c", "a@b", "x.y@", "co.uk",
];

describe("detectPii matches the reference rules", () => {
  test("email and person-name spans are identical on a generated corpus", () => {
    const random = seededRandom(0x5eed);
    for (let i = 0; i < 4000; i += 1) {
      const length = 1 + Math.floor(random() * 30);
      let content = "";
      for (let j = 0; j < length; j += 1) {
        content += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] as string;
      }
      expect(detectedSpans(content, "pii.email")).toEqual(referenceSpans(content, REFERENCE_EMAIL, 0));
      expect(detectedSpans(content, "pii.person-name")).toEqual(referenceSpans(content, REFERENCE_NAME, 1));
    }
  });

  test("email edge cases keep their reference spans", () => {
    const cases = [
      "",
      "@",
      "a@b.c",
      "a@b.cc",
      "-a@b.cc",
      "--@b.cc and x@y.zz",
      "a@@b.cc",
      "a@b.cc@d.ee",
      "first.last+tag@sub.example.co.uk, other@x.io.",
      "x@a.a.a.a.a x@a.a.a.bb",
      "a.b.c.d@e.f.g.hh_ z@q.rr",
      "_a@b.cc",
      "é@b.cc xé@b.cc",
    ];
    for (const content of cases) {
      expect(detectedSpans(content, "pii.email")).toEqual(referenceSpans(content, REFERENCE_EMAIL, 0));
    }
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

function shaped(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

// Each shape was quadratic before: the first four through the email rule, the last two through the
// person-name rule's whitespace backtracking. `123-45-6789-` also drives the SSN identifier guard.
const SHAPES: Record<string, (length: number) => string> = {
  "123-45-6789-": (n) => shaped("123-45-6789-", n),
  "s.": (n) => shaped("s.", n),
  "x-078-05-1120-": (n) => shaped("x-078-05-1120-", n),
  "a-": (n) => shaped("a-", n),
  "user + spaces": (n) => `user${" ".repeat(n)}x`,
  "name is + spaces": (n) => `name is${" ".repeat(n)}Aa`,
};

describe("detectPii runs in linear time on very long inputs", () => {
  for (const [name, build] of Object.entries(SHAPES)) {
    test(
      `160k characters of ${name}`,
      () => {
        const half = bestOf(build(80_000));
        const full = bestOf(build(160_000));
        expect(full).toBeLessThan(1_500);
        // Millisecond-scale linear runs are noisy, so the ratio is measured against a floor.
        expect(full).toBeLessThan(3.5 * Math.max(half, 20));
      },
      60_000,
    );
  }
});
