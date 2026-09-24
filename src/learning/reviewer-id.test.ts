import { describe, expect, test } from "bun:test";
import { generalizeLesson, reviewerIdFor } from "./reviewer-id";

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

  test("still does NOT strip a login glued to more of the same word class (alicedev_ is not a match for alicedev)", () => {
    // Conservative on purpose: `alicedev_` is glued to a trailing word
    // character, so it is not treated as an exact, bounded occurrence of the
    // login `alicedev` — the same reason `alice` must not match inside
    // `alicedeveloper`.
    const result = generalizeLesson("alicedev_ prefers early returns over nested conditionals for readability", ["alicedev"]);
    expect(result?.toLowerCase()).toContain("alicedev_");
  });
});
