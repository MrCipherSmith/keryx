// A UUID is not a telephone number.
//
// `keryx security check-output` redacted the middle of a correlation id:
//
//   {"correlationId":"730344f3-3668-4760-9056-bf7292686b67"}
//   → {"correlationId":"730344f3-[REDACTED:phone]-bf7292686b67"}
//
// The phone pattern bounds itself with `(?<![\w.])` / `(?![\w.])`, and a hyphen
// satisfies both — while a hyphen is also a legal separator INSIDE the pattern.
// So a digit run sitting in the middle of a longer hyphenated identifier looked
// exactly like a dialling sequence: `3668-4760-9056` is 12 digits in 2-4 digit
// groups, which is what a phone number is.
//
// It surfaced as an intermittent CI failure — `src/sac/proposal-lifecycle-parity.test.ts`
// compares the CLI's JSON against the MCP surface's, and the MCP path redacts.
// The test failed exactly when `crypto.randomUUID()` happened to produce a
// phone-shaped middle: about one run in a hundred. The other ninety-nine passed
// while every one of those ids was one dice roll from being corrupted in
// production too.

import { expect, test } from "bun:test";
import { detectPii } from "./pii";

function phones(input: string): string[] {
  return detectPii(input)
    .filter((match) => match.policyId === "pii.phone")
    .map((match) => match.value);
}

test("the UUID from the CI failure is left whole", () => {
  // The literal that failed, kept verbatim so this test is the artefact.
  expect(phones('{"correlationId":"730344f3-3668-4760-9056-bf7292686b67"}')).toEqual([]);
});

test("does NOT flag a fragment of any hex identifier, hyphenated or not", () => {
  const cases = [
    "730344f3-3668-4760-9056-bf7292686b67",
    "urn:uuid:730344f3-3668-4760-9056-bf7292686b67",
    "event-f53fd8cbab7a47fd-3668-4760-9056",
    "sha256:901131d838b17aac-3668-4760-9056-0f7885b81e03cbdc",
  ];
  for (const input of cases) {
    expect(phones(input)).toEqual([]);
  }
});

// The direction this guard fails in, asserted so it cannot be reversed quietly.
//
// The first version of the guard suppressed the match whenever the enclosing
// token carried ANY letter. That reasoning — "a dialling sequence never
// contains a letter" — is true of the sequence and false of the token around
// it, and it silently stopped redacting real phone numbers that merely sat
// next to a word. Each of these was `MISSED` under that rule.
//
// A false positive corrupts an identifier; a false negative hands out a
// person's phone number. The detector exists for the second one.
test("REGRESSION — a real number next to a word is still redacted", () => {
  const cases = [
    "contact-415-555-0199-primary",
    "a-415-555-0199",
    "415-555-0199-z",
    "call 415-555-0199-ext205 now",
    "ticket TCK-415-555-0199-open",
    '{"phone-415-555-0199-key":"value"}',
  ];
  for (const input of cases) {
    expect(phones(input)).toEqual(["415-555-0199"]);
  }
});

test("an ambiguous word-wrapped digit run is redacted, deliberately", () => {
  // `proposal-3668-4760-9056-b` and `contact-415-555-0199-primary` are the same
  // shape, and no local signal separates them. One is an id and one is a phone
  // number; redacting both is the cost of never leaking the second.
  expect(phones("workspace-a/proposal-3668-4760-9056-b")).toEqual(["3668-4760-9056"]);
});

test("a token too long to read whole is redacted rather than guessed at", () => {
  // The outward scan is bounded (an unbounded one adds a second quadratic term
  // on adversarial input). Past the bound the evidence is incomplete, and
  // incomplete evidence must not buy suppression.
  const huge = `${"f".repeat(200)}-3668-4760-9056-${"a".repeat(200)}`;
  expect(phones(huge)).toEqual(["3668-4760-9056"]);
});

// Enumerated, not sampled. The empirical measurement that opened flow 260 was
// "46 of 5 000 random UUIDs are redacted, about 0.9 %" — a number that only
// exists because the shape is reachable by chance. Asserting it deterministically
// is the point: these are the middles that USED to match, so a regression here
// cannot hide behind a lucky seed.
test("every phone-shaped UUID middle is left whole", () => {
  const middles = [
    "3668-4760-9056",
    "1234-4567-8901",
    "0000-4000-8000",
    "9999-4999-9999",
    "4155-4550-1990",
  ];
  for (const middle of middles) {
    const uuid = `730344f3-${middle}-bf7292686b67`;
    expect(phones(uuid)).toEqual([]);
    // …and inside the JSON an MCP tool actually returns.
    expect(phones(`{"correlationId":"${uuid}"}`)).toEqual([]);
  }
});

// 10 000 UUIDs, and not one of them left to chance.
//
// The measurement that opened this flow used `crypto.randomUUID()`, which is
// exactly the wrong tool for a regression test: it would have caught the defect
// with ~0.9 % probability per id, so a run that passed would have proved
// nothing. This generator is seeded, so the corpus is identical on every machine
// and every run — including the ~90 phone-shaped middles it is guaranteed to
// contain, which is the whole reason it is here.
function seededUuids(count: number, seed: number): string[] {
  let state = seed >>> 0;
  const nextHex = (): string => {
    // xorshift32 — small, deterministic, and adequate for generating shapes.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return (state % 16).toString(16);
  };
  const run = (n: number): string => Array.from({ length: n }, nextHex).join("");
  return Array.from({ length: count }, () => {
    // v4 layout: the version nibble is 4 and the variant nibble is 8-b.
    const variant = "89ab"[state % 4] as string;
    return `${run(8)}-${run(4)}-4${run(3)}-${variant}${run(3)}-${run(12)}`;
  });
}

test("10 000 seeded v4 UUIDs produce no phone finding at all", () => {
  const uuids = seededUuids(10_000, 0x5eed_1234);
  const flagged = uuids.filter((uuid) => phones(uuid).length > 0);
  expect(flagged).toEqual([]);
});

test("CONTROL — that corpus really does contain the shape this guard rejects", () => {
  // Without this, a generator that silently produced 10 000 letter-heavy ids
  // would make the test above vacuous: it would pass on the unfixed detector
  // too, and assert nothing. Count the middles that the OLD boundary would have
  // matched — a run of 9-15 digits in 2-4 digit groups, hyphen-separated.
  const uuids = seededUuids(10_000, 0x5eed_1234);
  const phoneShapedMiddle = /^\d{4}-\d{4}-\d{4}$/;
  const susceptible = uuids.filter((uuid) => {
    const parts = uuid.split("-");
    return phoneShapedMiddle.test(`${parts[1]}-${parts[2]}-${parts[3]}`);
  });
  // The version nibble is always `4` and the variant always `8`-`b`, so a
  // susceptible middle needs the other ten nibbles to be digits. Rare, but the
  // corpus is sized so that it happens — assert it does.
  expect(susceptible.length).toBeGreaterThan(0);
  // And each one is still left whole.
  for (const uuid of susceptible) {
    expect(phones(uuid)).toEqual([]);
  }
});

// An all-digit identifier is rejected BEFORE the boundary guard, by the
// pre-existing `digits < 9 || digits > 15` bound: the regex takes the whole run
// greedily, and 34 digits is not a phone number. Asserted because the behaviour
// matters, and labelled accurately because a round of this review found the
// earlier comment here claiming coverage of a guard this input never reaches.
test("does NOT flag an all-digit identifier longer than any phone number", () => {
  expect(phones("20260912-3668-4760-9056-00112233445566")).toEqual([]);
});

// The reason this is a boundary guard and not a weaker pattern. Each of these
// is a phone number the detector is there to catch, and each still is one.
test("STILL flags the phone numbers the corpus is built on", () => {
  expect(phones("call 415-555-0199 now")).toEqual(["415-555-0199"]);
  expect(phones("Reach the rota at +1 415 555 0199 today.")).toEqual(["+1 415 555 0199"]);
  expect(phones("call (415) 555-0199 now")).toEqual(["415) 555-0199"]);
  expect(phones("Tel:+14155550199")).toEqual(["+14155550199"]);
  expect(phones("415.555.0199")).toEqual(["415.555.0199"]);
});

test("STILL flags a phone number that merely sits next to punctuation", () => {
  // Bracketed, quoted, parenthesised — none of these make it an identifier.
  expect(phones('"415-555-0199"')).toEqual(["415-555-0199"]);
  expect(phones("[415-555-0199]")).toEqual(["415-555-0199"]);
  expect(phones("(415-555-0199)")).toEqual(["415-555-0199"]);
  expect(phones("phone: 415-555-0199, ext 4")).toEqual(["415-555-0199"]);
});
