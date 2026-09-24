import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  containsConfiguredLogin,
  gateReviewerText,
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

/**
 * Strips `/* ... *\/` and `// ...` comments from TypeScript source while
 * leaving string/template literals untouched (a naive "strip from `//` to
 * end of line" pass would truncate any line containing a URL string like
 * `"https://..."`). Matches a string OR a comment; only a comment match is
 * replaced.
 */
function stripComments(source: string): string {
  const STRING_OR_COMMENT = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  return source.replace(STRING_OR_COMMENT, (match) => (match.startsWith("//") || match.startsWith("/*") ? "" : match));
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// R8-F3: the old guard only scanned THIS directory's top-level files for a
// `containsConfiguredLogin(` call textually preceded (within a char window)
// by `mayCarryReviewerText(` — proven, against `r12/g`'s five injected
// mutations, to miss: a nested file (`signals/newgate.ts` — top-level-only
// scan), a comment inserted between an unscoped call and an unrelated
// `mayCarryReviewerText(` mention elsewhere in the file (defeats the window
// check without actually gating anything), and an aliased import
// (`containsConfiguredLogin as ccl` — the call site then reads `ccl(...)`,
// which never matches the literal call marker at all). Only the plainest
// mutation (an unscoped call added to a fresh top-level file with the
// literal, unaliased name) was ever caught.
//
// The structural fix (R8-F1/R8-F2/R8-F3) makes the whole class of guard
// evasion moot: `containsConfiguredLogin` is no longer called anywhere
// outside `reviewer-id.ts` at all — every learned-text sink gates through
// `gateReviewerText` instead, which applies `mayCarryReviewerText`
// internally. So the guard no longer needs to find a call and check it is
// "gated nearby"; it bans any REFERENCE (import, aliased import, or call) to
// `containsConfiguredLogin` from every non-test `.ts` file under `src/`
// (recursively — not just this directory) other than this one. There is no
// allowlist any more: `reviewer-profile.ts` now gates through
// `gateReviewerText` like every other sink (see that file).
describe("guard: containsConfiguredLogin is never imported or called outside reviewer-id.ts", () => {
  const SRC_ROOT = path.join(import.meta.dir, "..");
  const SELF = path.join(import.meta.dir, "reviewer-id.ts");
  const IDENTIFIER = /\bcontainsConfiguredLogin\b/;

  test("source scan (recursive, comments stripped)", () => {
    const files = walkTsFiles(SRC_ROOT).filter((file) => file !== SELF);
    expect(files.length).toBeGreaterThan(0); // sanity: the scan actually looked at something

    const offenders: string[] = [];
    for (const file of files) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      if (IDENTIFIER.test(stripped)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  // R8-F1/R8-F2/R8-F3: every module that writes learned/generalized text
  // must go through the one consolidated gate rather than hand-rolling its
  // own check (which is what let `promote.ts` skip attribution entirely,
  // R8-F2).
  test("every learned-text sink module imports gateReviewerText", () => {
    const SINKS = ["extract.ts", "apply.ts", "graduate.ts", "promote.ts", "reviewer-profile.ts"];
    const missing = SINKS.filter((name) => {
      const source = stripComments(readFileSync(path.join(import.meta.dir, name), "utf8"));
      return !/\bgateReviewerText\b/.test(source);
    });
    expect(missing).toEqual([]);
  });
});

describe("gateReviewerText", () => {
  const LOGINS = ["alice"];

  test("refuses when trigger/action carries a configured login and provenance may carry reviewer text", () => {
    const result = gateReviewerText(
      { provenance: { extractor: "reviewer-comment" }, trigger: "irrelevant", action: "@alice prefers early returns" },
      LOGINS,
    );
    expect(result.refused).toBe(true);
  });

  test("does not inspect trigger/action when provenance may not carry reviewer text", () => {
    const result = gateReviewerText(
      { provenance: { extractor: "reverted-edit" }, trigger: "irrelevant", action: "@alice prefers early returns" },
      LOGINS,
    );
    expect(result.refused).toBe(false);
  });

  test("strips REVIEWER_COMMENT_TRIGGER_PREFIX before checking trigger", () => {
    const trigger = `${REVIEWER_COMMENT_TRIGGER_PREFIX}prefer early returns)`;
    const result = gateReviewerText({ provenance: { extractor: "reviewer-comment" }, trigger, action: "keep it short" }, ["review"]);
    expect(result.refused).toBe(false); // "review" only appears in the stripped fixed prefix, not the variable hint
  });

  // R9-F1/R9-F2 (review round 9, PR #691): `gateReviewerText` used to also
  // take an `extraTokens` list, checked by token equality against
  // `loginKeywordSet`, so `applyGraduation` could re-check a proposal's
  // persisted `suggestedName`/summary tokens against logins configured after
  // the proposal was written — but that re-check inspected STORED tokens,
  // not the member records, so it could not distinguish a token that
  // legitimately survived per-member filtering from one that leaked. Removed:
  // `applyGraduation` now recomputes the candidate's name/summary from the
  // member records at apply time instead (`graduate.ts`), so there is
  // nothing stale left to re-check, and `extraTokens` had no other caller
  // that actually needed it (`reviewer-profile.ts`'s `reviewerId` is an
  // opaque hash that can never equal a login).
  test("empty logins never refuse", () => {
    const result = gateReviewerText({ provenance: { extractor: "reviewer-comment" }, trigger: "", action: "@alice said so" }, []);
    expect(result.refused).toBe(false);
  });
});
