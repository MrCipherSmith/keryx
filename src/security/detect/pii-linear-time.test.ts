import { describe, expect, test } from "bun:test";
import { detectPii, isValidIban } from "./pii";

const REFERENCE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// The same rule with Unicode letters, digits and marks and the Unicode word boundary (`user@bücher.example`).
const REFERENCE_UNICODE_EMAIL =
  /(?:(?<=[\p{L}\p{N}\p{M}_])(?![\p{L}\p{N}\p{M}_])|(?<![\p{L}\p{N}\p{M}_])(?=[\p{L}\p{N}\p{M}_]))[\p{L}\p{N}\p{M}._%+-]+@[\p{L}\p{N}\p{M}.-]+\.[\p{L}\p{M}]{2,}(?![\p{L}\p{N}\p{M}_])/gu;
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
  "Aa", "Bb", "Cc", "1", "23", "-", "_", ".", "%", "+", "com", "a.b", "@@", ".c", "a@b", "x.y@", "co.uk",
];
const UNICODE_FRAGMENTS = [...FRAGMENTS, "é", "ü", "jörg@example.de", "user@bücher.example", "日本@例え.jp", "٣", "\u0301", "𝐚", "😀"];

function corpus(fragments: string[], seed: number, count: number): string[] {
  const random = seededRandom(seed);
  return Array.from({ length: count }, () => {
    let content = "";
    for (let j = 1 + Math.floor(random() * 30); j > 0; j -= 1) {
      content += fragments[Math.floor(random() * fragments.length)] as string;
    }
    return content;
  });
}

describe("detectPii matches the reference rules", () => {
  test("email and person-name spans are identical on a generated ASCII corpus", () => {
    for (const content of corpus(FRAGMENTS, 0x5eed, 4000)) {
      expect(detectedSpans(content, "pii.email")).toEqual(referenceSpans(content, REFERENCE_EMAIL, 0));
      expect(detectedSpans(content, "pii.person-name")).toEqual(referenceSpans(content, REFERENCE_NAME, 1));
    }
  });

  test("with non-ASCII text, email spans are the Unicode rule's plus any the ASCII rule found", () => {
    for (const content of corpus(UNICODE_FRAGMENTS, 0x5eed2, 4000)) {
      const detected = detectedSpans(content, "pii.email");
      const unicode = referenceSpans(content, REFERENCE_UNICODE_EMAIL, 0);
      const ascii = referenceSpans(content, REFERENCE_EMAIL, 0);
      const key = (span: Span) => `${span.start}:${span.value}`;
      const detectedKeys = new Set(detected.map(key));
      for (const span of unicode) {
        expect(detectedKeys.has(key(span))).toBe(true);
      }
      for (const span of ascii) {
        // Never lost: either reported as before or inside a longer Unicode span.
        const covered = detected.some((d) => d.start <= span.start && d.start + d.value.length >= span.start + span.value.length);
        expect(covered).toBe(true);
      }
      const allowed = new Set([...unicode, ...ascii].map(key));
      for (const span of detected) {
        expect(allowed.has(key(span))).toBe(true);
      }
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
    ];
    for (const content of cases) {
      expect(detectedSpans(content, "pii.email")).toEqual(referenceSpans(content, REFERENCE_EMAIL, 0));
    }
  });

  test("emails with a non-ASCII local part or domain are reported whole", () => {
    expect(detectedSpans("mail jörg@example.de now", "pii.email").map((span) => span.value)).toEqual(["jörg@example.de"]);
    expect(detectedSpans("mail user@bücher.example now", "pii.email").map((span) => span.value)).toEqual(["user@bücher.example"]);
    expect(detectedSpans("mail 日本@例え.jp now", "pii.email").map((span) => span.value)).toEqual(["日本@例え.jp"]);
    expect(detectedSpans("é@b.cc xé@b.cc", "pii.email").map((span) => span.value)).toEqual(["é@b.cc", "xé@b.cc"]);
  });

  test("an address the ASCII rule found is still found when a letter follows it", () => {
    expect(detectedSpans("a.ba@b.ccabc\u0660", "pii.email").map((span) => span.value)).toContain("a.ba@b.ccabc");
  });

  test("fullwidth @ and dots are read as ASCII, and spans refer to the original text", () => {
    const content = "write x\uff20example\uff0ecom now";
    const [span] = detectedSpans(content, "pii.email");
    expect(span?.value).toBe("x\uff20example\uff0ecom");
    expect(content.slice(span?.start, (span?.start ?? 0) + (span?.value.length ?? 0))).toBe("x\uff20example\uff0ecom");
  });
});

// An IBAN is recognised by a hand-written scanner, so the regex it replaced is the reference.
const REFERENCE_IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{1,4}){2,8}\b/g;

describe("the IBAN scanner matches the reference regex", () => {
  const IBAN_FRAGMENTS = ["GB82", "WEST", "1234", "5698", "7654", "32", "A", "AB12", "XX00", " ", "  ", "-", "_", "a", "9", "DE89", "3704", "0044", "0532", "0130", "00"];
  test("candidate spans are identical on a generated corpus", () => {
    const random = seededRandom(0x1ba);
    for (let i = 0; i < 6000; i += 1) {
      let content = "";
      for (let j = 1 + Math.floor(random() * 14); j > 0; j -= 1) {
        content += IBAN_FRAGMENTS[Math.floor(random() * IBAN_FRAGMENTS.length)] as string;
      }
      // `detectPii` only reports candidates that pass mod 97, so compare the candidates through the validator too.
      const expected = [...content.matchAll(REFERENCE_IBAN)].map((m) => m[0]).filter(isValidIban);
      const detected = detectPii(content)
        .filter((match) => match.policyId === "pii.iban")
        .map((match) => match.value);
      expect(detected).toEqual(expected);
    }
  });

  test("valid IBANs are found in the usual shapes", () => {
    const ibans = (content: string) =>
      detectPii(content)
        .filter((match) => match.policyId === "pii.iban")
        .map((match) => match.value);
    expect(ibans("pay GB82WEST12345698765432 now")).toEqual(["GB82WEST12345698765432"]);
    expect(ibans("pay GB82 WEST 1234 5698 7654 32, thanks")).toEqual(["GB82 WEST 1234 5698 7654 32"]);
    expect(ibans("DE89370400440532013000")).toEqual(["DE89370400440532013000"]);
    expect(ibans("GB82WEST12345698765433")).toEqual([]);
  });

  test("a valid IBAN after an adversarial prefix is found at every size", () => {
    // The regex took ~1 s per 160k of this prefix, and above ~250k characters the engine returned null,
    // which silently dropped the IBAN that followed.
    for (const length of [160_000, 320_000, 640_000]) {
      const prefix = shaped(`XX00${"A".repeat(40)}-`, length);
      const found = detectPii(`${prefix}\nGB82WEST12345698765432\n`).filter((match) => match.policyId === "pii.iban");
      expect(found.map((match) => match.value)).toEqual(["GB82WEST12345698765432"]);
    }
  }, 60_000);
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

function shaped(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

// Each shape was quadratic before: the first four through the email rule, the next two through the
// person-name rule's whitespace backtracking, the IBAN shapes through the regex's group backtracking. `123-45-6789-`
// also drives the SSN identifier guard, and the last shapes drive the normalised pass.
const SHAPES: Record<string, (length: number) => string> = {
  "123-45-6789-": (n) => shaped("123-45-6789-", n),
  "s.": (n) => shaped("s.", n),
  "x-078-05-1120-": (n) => shaped("x-078-05-1120-", n),
  "a-": (n) => shaped("a-", n),
  "user + spaces": (n) => `user${" ".repeat(n)}x`,
  "name is + spaces": (n) => `name is${" ".repeat(n)}Aa`,
  "XX00 + 40 letters + hyphen": (n) => shaped(`XX00${"A".repeat(40)}-`, n),
  "AA00 dense": (n) => shaped("AA00", n),
  "AA00 B spaced": (n) => shaped("AA00 B", n),
  "valid IBAN repeated": (n) => shaped("GB82WEST12345698765432 ", n),
  "fullwidth SSN": (n) => shaped("\uff10\uff17\uff18-\uff10\uff15-\uff11\uff11\uff12\uff10 ", n),
  "Arabic-Indic SSN": (n) => shaped("\u0660\u0667\u0668-\u0660\u0665-\u0661\u0661\u0662\u0660 ", n),
  "U+2011 SSN": (n) => shaped("078\u201105\u20111120 ", n),
  "no-break space card": (n) => shaped("4111\u00a01111\u00a01111\u00a01111 ", n),
  "non-ASCII email local part": (n) => shaped("\u00e9.\u00e9@", n),
  "non-ASCII email domain": (n) => shaped("a.a@b\u00e9", n),
  "glued SSN": (n) => shaped("x078-05-1120_a ", n),
  "SSN beside a hash and a label": (n) => shaped("hash d41d8cd98f00b204e9800998ecf8427e-078-05-1120 tin ", n),
};

describe("detectPii runs in linear time on very long inputs", () => {
  for (const [name, build] of Object.entries(SHAPES)) {
    test(
      `${LARGE / 1000}k characters of ${name}`,
      () => {
        const small = bestOf(build(SMALL));
        const full = bestOf(build(LARGE));
        expect(full).toBeLessThan(CEILING_MS);
        expect(full).toBeLessThan(RATIO_LIMIT * Math.max(small, FLOOR_MS));
      },
      60_000,
    );
  }
});
