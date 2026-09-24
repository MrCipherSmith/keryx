import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  containsConfiguredLogin,
  generalizeLesson,
  mayCarryReviewerText,
  REVIEWER_COMMENT_TRIGGER_PREFIX,
  reviewerIdFor,
  stripReviewerCommentTriggerPrefix,
} from "./reviewer-id";

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

  // R4-F1/R5-F1/R5-F2 removed `containsConfiguredLogin`'s 5+-char substring
  // fallback (see its own doc comment): that fallback was the ONLY thing
  // that used to catch `alicedev` sitting inside `alicedeveloper` with no
  // identifier boundary on the right. Boundary-only matching does not strip
  // or refuse it either (the bounded-regex strip pass never matched this
  // shape — `alicedev` is glued to a trailing `e`, not a boundary). This is
  // now a documented, accepted limitation: a login glued to other letters
  // with no boundary character anywhere is not caught.
  test("documented limitation: a login glued to a longer word with no boundary (alicedev inside alicedeveloper) is NOT stripped or dropped", () => {
    const result = generalizeLesson("alicedeveloper prefers early returns over nested conditionals for readability", ["alicedev"]);
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).toContain("alicedeveloper");
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

  // R4-F1/R5-F1/R5-F2: same documented limitation as above — `alicedev`
  // glued to `xreview` on both sides (no boundary character anywhere) is no
  // longer caught now that the substring fallback is gone.
  test("documented limitation: a login glued on both sides with no boundary anywhere (alicedev inside alicedevxreview) is NOT stripped or dropped", () => {
    const result = generalizeLesson("never merge without alicedevxreview signing off on the migration plan", ["alicedev"]);
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).toContain("alicedevxreview");
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

  // R4-F1/R5-F1/R5-F2 (review rounds 4-5, PR #691): `containsConfiguredLogin`
  // no longer has a substring fallback at all, so a 5+ char login that is
  // merely a substring of the fixed prefix's words with no boundary (`chang`
  // inside "change") no longer matches — boundary-only matching already
  // handles that case. But the fixed prefix ALSO contains the literal WHOLE
  // WORD "review", bounded by spaces on both sides ("...for **review** in
  // this project...") — that IS a real boundary match, so a login equal to
  // that whole word still trips the gate on the raw (unstripped) trigger.
  // Callers must still strip `REVIEWER_COMMENT_TRIGGER_PREFIX`
  // (`stripReviewerCommentTriggerPrefix`) before running a login gate over a
  // reviewer-comment trigger.
  test("R4-F1/R5-F1/R5-F2: the fixed reviewer-comment trigger wording no longer trips a partial-word login (boundary-only), but a whole-word login ('review') still needs the prefix stripped", () => {
    const fixedTrigger = `${REVIEWER_COMMENT_TRIGGER_PREFIX}prefer early returns over nested conditionals)`;
    expect(containsConfiguredLogin(fixedTrigger, ["chang"])).toBe(false); // "change" — no boundary after "chang"
    expect(containsConfiguredLogin(fixedTrigger, ["review"])).toBe(true); // "review" is a whole, bounded word in the fixed prefix
    expect(containsConfiguredLogin(stripReviewerCommentTriggerPrefix(fixedTrigger), ["chang"])).toBe(false);
    expect(containsConfiguredLogin(stripReviewerCommentTriggerPrefix(fixedTrigger), ["review"])).toBe(false);
  });
});

describe("stripReviewerCommentTriggerPrefix", () => {
  test("strips the fixed prefix and trailing ')', leaving only the keyword hint", () => {
    const trigger = `${REVIEWER_COMMENT_TRIGGER_PREFIX}prefer early returns over nested conditionals)`;
    expect(stripReviewerCommentTriggerPrefix(trigger)).toBe("prefer early returns over nested conditionals");
  });

  test("returns a trigger unchanged when it does not carry the fixed prefix (every other signal's trigger)", () => {
    const trigger = "the same file region is edited twice in one turn window";
    expect(stripReviewerCommentTriggerPrefix(trigger)).toBe(trigger);
  });

  test("a real login occurrence in the stripped keyword hint is still caught", () => {
    const trigger = `${REVIEWER_COMMENT_TRIGGER_PREFIX}@chang flagged this)`;
    expect(containsConfiguredLogin(stripReviewerCommentTriggerPrefix(trigger), ["chang"])).toBe(true);
  });
});

// R7-F3 (review round 7, PR #691, minor): `mayCarryReviewerText` is the ONE
// scoping rule every attribution gate in `src/learning` must use to decide
// whether a record's/draft's text needs a configured-login check at all.
describe("mayCarryReviewerText", () => {
  test("true for the deterministic reviewer-comment signal", () => {
    expect(mayCarryReviewerText({ extractor: "reviewer-comment", extractorKind: "deterministic" })).toBe(true);
  });

  test("true for any model-backed extractor, regardless of its self-declared label", () => {
    expect(mayCarryReviewerText({ extractor: "model-summarizer", extractorKind: "model-backed" })).toBe(true);
    expect(mayCarryReviewerText({ extractor: "fake", extractorKind: "model-backed" })).toBe(true);
  });

  test("false for every other deterministic signal", () => {
    expect(mayCarryReviewerText({ extractor: "reverted-edit", extractorKind: "deterministic" })).toBe(false);
    expect(mayCarryReviewerText({ extractor: "repeated-correction", extractorKind: "deterministic" })).toBe(false);
    expect(mayCarryReviewerText({ extractor: "failing-to-passing-test", extractorKind: "deterministic" })).toBe(false);
    expect(mayCarryReviewerText({ extractor: "health-regression", extractorKind: "deterministic" })).toBe(false);
  });

  test("false when extractorKind is omitted and the label is not 'reviewer-comment'", () => {
    expect(mayCarryReviewerText({ extractor: "reverted-edit" })).toBe(false);
  });
});

// R7-F3: a source-scan guard so a future attribution gate cannot reintroduce
// the R7-F2/R7-F3 drift — a `containsConfiguredLogin` call site outside this
// file that is NOT scoped by `mayCarryReviewerText` (i.e. an unconditional
// gate, or one scoped only by a hand-rolled `extractor === "reviewer-comment"`
// check that silently drops the model-backed case again). `reviewer-profile.ts`
// is explicitly allowlisted: it operates only over `domain:
// "review-conventions"` records, which today only the `reviewer-comment`
// signal ever produces, so it has no `Provenance` in scope to gate with.
describe("guard: every containsConfiguredLogin call site outside reviewer-id.ts is scoped by mayCarryReviewerText", () => {
  const ALLOWLISTED_FILES = new Set(["reviewer-profile.ts"]);

  const CALL_MARKER = "containsConfiguredLogin(";
  // How far back from a call site to look for a `mayCarryReviewerText(`
  // reference gating it. Wide enough to span the longest doc comment +
  // enclosing `if` in this codebase today (measured: the farthest real gate
  // is ~2000 chars from its call site, in `applyGraduation`'s member-text
  // gate), but local enough that it cannot reach into a wholly unrelated
  // function elsewhere in the same file (e.g. `graduate.ts`'s
  // `keywordSourceFor`, which also compares
  // `record.provenance.extractor === "reviewer-comment"` for an unrelated
  // reason — keyword-source selection, not an attribution gate — but never
  // itself references `mayCarryReviewerText(`, so it cannot satisfy this
  // guard for any call site even if it fell inside the window).
  const WINDOW = 2500;

  test("source scan", () => {
    const dir = path.join(import.meta.dir);
    const files = readdirSync(dir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "reviewer-id.ts",
    );
    expect(files.length).toBeGreaterThan(0); // sanity: the scan actually looked at something

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), "utf8");
      if (!source.includes(CALL_MARKER)) continue;
      if (ALLOWLISTED_FILES.has(file)) continue;

      let searchFrom = 0;
      for (;;) {
        const callIndex = source.indexOf(CALL_MARKER, searchFrom);
        if (callIndex < 0) break;
        searchFrom = callIndex + CALL_MARKER.length;
        const windowStart = Math.max(0, callIndex - WINDOW);
        const before = source.slice(windowStart, callIndex);
        if (!before.includes("mayCarryReviewerText(")) {
          offenders.push(`${file}@${callIndex}: containsConfiguredLogin call is not preceded by a mayCarryReviewerText guard within ${WINDOW} chars`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
