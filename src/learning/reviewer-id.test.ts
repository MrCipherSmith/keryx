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

  // R3-F2 (review round 3, PR #691, minor): this used to be a plain
  // case-insensitive substring test, so a short configured login matched
  // inside ordinary English words and hard-refused lessons/apply/graduate
  // apply that never actually named the login. Proven against the pre-fix
  // code (git HEAD, before this task's edit) in `w3-f2-check.ts`:
  // `containsConfiguredLogin("Prefer named exports over default exports in
  // shared modules", ["ed"])` pre-fix -> `true` (matches inside "named");
  // post-fix -> `false`.
  test("a short login does not match inside an ordinary word (named/already/problem/max-width/developer)", () => {
    expect(containsConfiguredLogin("Prefer named exports over default exports in shared modules", ["ed"])).toBe(false);
    expect(containsConfiguredLogin("Keep functions small and focused on a single responsibility", ["al"])).toBe(false);
    expect(containsConfiguredLogin("Avoid nested ternaries because they make problems harder to debug", ["rob"])).toBe(false);
    expect(containsConfiguredLogin("Use max-width tokens rather than raw pixel values", ["max"])).toBe(false);
    expect(containsConfiguredLogin("Keep devDependencies pinned to exact versions", ["dev"])).toBe(false);
  });

  // R3-F2: the specific regression named in the finding — `graduate.ts`'s
  // own fixed agent-candidate role template contains "graduated" and
  // "learned", both of which contain "ed" as a substring but never at an
  // identifier boundary — must not trip the login gate for a project that
  // configured a short login like "ed".
  test("the graduate role template's fixed text does not trip a short configured login", () => {
    const roleTemplate =
      'Applies guidance graduated from 3 learned pattern(s) in the "testing" domain. ' +
      "Read-only: report findings and suggested guidance rather than making changes yourself.";
    expect(containsConfiguredLogin(roleTemplate, ["ed"])).toBe(false);
  });

  // A real occurrence must still be refused: `_` counts as a boundary
  // (R2-F6), and the character right after a bare login mention is
  // essentially never itself `[A-Za-z0-9-]`.
  test("a real occurrence (@mention, bracketed bot suffix, possessive) is still refused", () => {
    expect(containsConfiguredLogin("as @ed pointed out, this needs a null check", ["ed"])).toBe(true);
    expect(containsConfiguredLogin("ed[bot] flagged this in review", ["ed"])).toBe(true);
    expect(containsConfiguredLogin("Per ed's review, keep it small", ["ed"])).toBe(true);
    expect(containsConfiguredLogin("ed_reviewer left a comment", ["ed"])).toBe(true);
  });
});
