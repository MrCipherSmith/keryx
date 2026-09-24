import { describe, expect, test } from "bun:test";
import { containsConfiguredLogin, generalizeLesson, reviewerIdFor } from "./reviewer-id";

const PROJECT_IDENTITY = "a".repeat(64);

describe("reviewerIdFor", () => {
  test("stable, opaque, rv- prefixed, 16 hex chars", () => {
    const id = reviewerIdFor(PROJECT_IDENTITY, "octocat");
    expect(id).toMatch(/^rv-[0-9a-f]{16}$/);
    expect(reviewerIdFor(PROJECT_IDENTITY, "octocat")).toBe(id);
    expect(reviewerIdFor(PROJECT_IDENTITY, "OctoCat")).toBe(id); // case-insensitive login
  });

  test("never contains the literal login", () => {
    const id = reviewerIdFor(PROJECT_IDENTITY, "octocat");
    expect(id).not.toContain("octocat");
  });

  test("differs per project identity", () => {
    expect(reviewerIdFor(PROJECT_IDENTITY, "octocat")).not.toBe(reviewerIdFor("b".repeat(64), "octocat"));
  });
});

describe("generalizeLesson", () => {
  test("strips the login and mentions, and courtesy phrasing, into an imperative", () => {
    const result = generalizeLesson("@octocat could you please add a null check before dereferencing the pointer", [
      "octocat",
    ]);
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).not.toContain("octocat");
    expect(result).not.toContain("@");
  });

  test("returns null when the generalized text is too short", () => {
    expect(generalizeLesson("@octocat nit: ok", ["octocat"])).toBeNull();
  });

  test("returns null when the generalized text exceeds 260 chars", () => {
    const long = "a".repeat(300);
    expect(generalizeLesson(long, [])).toBeNull();
  });

  test("is case-insensitive on the login", () => {
    const result = generalizeLesson("OctoCat said this should use a constant instead of a magic number", ["octocat"]);
    expect(result?.toLowerCase()).not.toContain("octocat");
  });

  // R1-F4 (review round 1, PR #691, major): `\b...\b` never matched a login
  // ending in a non-word character (`]`) immediately followed by another
  // non-word character (a space) — `\b` needs a word/non-word TRANSITION,
  // and both sides here are non-word, so the whole match failed and the
  // literal bot login stayed in the "generalized" text (probe p4.ts).
  test("strips a bot login ending in a bracket (copilot-reviewer[bot])", () => {
    const result = generalizeLesson("As copilot-reviewer[bot] notes, always validate inputs at the boundary", [
      "copilot-reviewer[bot]",
    ]);
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).not.toContain("copilot-reviewer");
    expect(result?.toLowerCase()).not.toContain("[bot]");
  });

  test("strips an @mention of a bracketed bot login (@copilot-reviewer[bot]), not just the @name part", () => {
    const result = generalizeLesson("@copilot-reviewer[bot] always validate inputs at the boundary before using them", [
      "copilot-reviewer[bot]",
    ]);
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).not.toContain("copilot-reviewer");
    expect(result).not.toContain("[bot]");
    expect(result).not.toContain("@");
  });

  test("still strips a hyphenated login inside parentheses (regression: lookaround boundaries, not \\b)", () => {
    const result = generalizeLesson("Per the style guide (Alice-Dev) keep functions small and focused", ["alice-dev"]);
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).not.toContain("alice-dev");
  });

  // The bounded-regex pass alone still does not strip `alicedev` out of
  // `alicedeveloper` (glued to a trailing alphanumeric, no boundary) — but
  // R2-F6's final substring safety net (`containsConfiguredLogin`) still
  // finds "alicedev" sitting inside "alicedeveloper" either way and drops
  // the whole lesson rather than shipping a record that merely LOOKS
  // attribution-free. Conservative on purpose: a name-shaped false positive
  // costs one dropped lesson; a missed one costs a stored login.
  test("R2-F6: drops a lesson where the login is a substring of a longer word (alicedev inside alicedeveloper)", () => {
    const result = generalizeLesson("alicedeveloper prefers early returns over nested conditionals for readability", ["alicedev"]);
    expect(result).toBeNull();
  });

  // R2-F6 (review round 2, PR #691, PROBE p4.ts): `_` is punctuation to a
  // login, not a login character — the old boundary class `[\w-]` (which
  // `\w` folds `_` into) treated a login immediately followed by `_` as
  // "glued to more of the same word class" and refused to strip it, leaving
  // the literal login in the "generalized" text. The boundary is now
  // `[A-Za-z0-9-]`, which does not include `_`, so `_` counts as a boundary
  // the same way a space does.
  test("R2-F6: strips a login glued to a trailing underscore (alicedev_ IS a bounded match for alicedev)", () => {
    const result = generalizeLesson("alicedev_ prefers early returns over nested conditionals for readability", ["alicedev"]);
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).not.toContain("alicedev");
  });

  // R2-F6: the final safety net — even when the boundary regex fails to
  // strip a login (e.g. `alicedev` glued to `xreview`, no boundary
  // character on either side at all), the lesson is dropped entirely rather
  // than shipped with the login still in it.
  test("R2-F6: drops (returns null for) a lesson whose login survives stripping with no boundary on either side", () => {
    const result = generalizeLesson("never merge without alicedevxreview signing off on the migration plan", ["alicedev"]);
    expect(result).toBeNull();
  });

  test("R2-F6: passing every configured author (not just the comment's own) strips a login the comment merely names", () => {
    // `reviewer-comment.ts`'s signal now passes the FULL configured login
    // list to every `generalizeLesson` call, not just the current comment's
    // own author — a comment from alice naming a co-reviewer must not leak
    // bob's login either.
    const result = generalizeLesson("as bob-reviewer said, keep functions small and focused", ["alice", "bob-reviewer"]);
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).not.toContain("bob-reviewer");
  });
});

describe("containsConfiguredLogin", () => {
  test("case-insensitive substring match", () => {
    expect(containsConfiguredLogin("Per ALICE's review, keep it small", ["alice"])).toBe(true);
    expect(containsConfiguredLogin("keep it small", ["alice"])).toBe(false);
  });

  test("empty/whitespace-only logins are ignored, not treated as always-matching", () => {
    expect(containsConfiguredLogin("anything at all", ["", "   "])).toBe(false);
  });
});
