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
    "workspace-a/proposal-3668-4760-9056-b",
  ];
  for (const input of cases) {
    expect(phones(input)).toEqual([]);
  }
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

// The bound the guard leans on: E.164 caps a subscriber number at 15 digits, so
// a match that is a fragment of a token carrying more than that is a fragment of
// an identifier, whatever it looks like on its own.
test("does NOT flag a fragment of an all-digit identifier longer than any phone number", () => {
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
