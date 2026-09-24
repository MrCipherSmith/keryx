// W3 spec, "Reviewer profiles" + "Safety" > "No attribution, ever":
// `reviewerId` is a stable, opaque, per-project hash of the login — never the
// literal login — and a generalized lesson never carries the login, an
// @mention of it, or first-person/courtesy phrasing that would read as a
// quoted human voice rather than a generalized rule.
import { createHash } from "node:crypto";

// R1-F4: a bot login's `@mention` carries a bracketed suffix (`@copilot-
// reviewer[bot]`) that plain `[\w-]+` does not consume — `@copilot-reviewer`
// would be stripped and `[bot]` left dangling behind it. The optional
// `(?:\[[\w-]+\])?` tail consumes that suffix too.
const MENTION_PATTERN = /@[\w-]+(?:\[[\w-]+\])?/g;

/** Prefixes stripped (or rewritten to an imperative) after logins/mentions are removed. Order matters — later rules see the earlier ones' output. */
const COURTESY_REWRITES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /^\s*(?:i\s+think|imo|in\s+my\s+opinion)\s*[:,-]?\s*/i, replacement: "" },
  { pattern: /^\s*nit\s*[:,-]?\s*/i, replacement: "" },
  { pattern: /^\s*(?:could\s+you\s+please|could\s+you|can\s+you\s+please|can\s+you)\s+/i, replacement: "please " },
  { pattern: /^\s*(?:we\s+should|you\s+should|you\s+could|i\s+would)\s+/i, replacement: "" },
  { pattern: /^\s*please\s+/i, replacement: "" },
];

const MIN_LESSON_LEN = 12;
const MAX_LESSON_LEN = 260;

/** `"rv-"` + first 16 hex chars of sha256(`projectIdentity\nlogin.toLowerCase()`) — stable per project, opaque, never reversible to the login in the rendered `.mdc`. */
export function reviewerIdFor(projectIdentity: string, login: string): string {
  const hash = createHash("sha256").update(`${projectIdentity}\n${login.toLowerCase()}`).digest("hex");
  return `rv-${hash.slice(0, 16)}`;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `text` contains any of `logins` at an identifier boundary — the
 * last-resort check `generalizeLesson` runs on its OWN output (R2-F6):
 * regardless of how the strip pass above is tuned, a login that somehow
 * survives generalization (a shape neither this file's author anticipated,
 * or a login containing regex-special characters some future caller passes
 * unescaped) is caught here rather than shipped into a stored record, a
 * `keryx learn review`/apply rendering, or a graduated agent body. Every
 * caller of `generalizeLesson` that also renders already-generalized text
 * later (extract's upsert, `graduate.ts`'s agent-candidate body,
 * `apply.ts`'s proposal rendering) re-runs this same check as a final gate
 * right before that text reaches disk.
 *
 * Boundary-matched ONLY, for every login length, regardless of how long the
 * login is (never preceded/followed by `[A-Za-z0-9-]`; `_` counts as a
 * boundary, not a word character, per R2-F6). A real occurrence (`@login`,
 * `login[bot]`, `login_reviewer`, `Login's`) is still caught, since the
 * character right after a bare login mention is essentially never itself
 * `[A-Za-z0-9-]`. Note `-` is itself a login-class character, not a
 * boundary: `login-reviewer` is NOT caught by this function (see R4-F1/R5-F1
 * /R5-F2's fallback removal below) — a login glued to more text with a
 * hyphen is the same accepted, documented gap as `alicedev`.
 *
 * R3-F2: a short configured login (`ed`, `al`, `rob`, `max`, `dev`) used to
 * match inside ordinary English words (`named`, `already`, `problem`,
 * `max-width`, `developer`) under a plain substring test and hard-refused
 * every lesson/apply/graduate-apply that happened to contain one — including
 * `graduate.ts`'s own fixed agent-candidate template text ("...learned
 * pattern(s)...", "graduated from...") for a project that configured a
 * login like `ed`.
 *
 * R4-F1/R5-F1/R5-F2: a 5+ character login used to ALSO fall back to a plain
 * substring match, as defense-in-depth against a login glued to surrounding
 * text with no identifier boundary at all (`alicedev` inside
 * `alicedeveloper`). That fallback could not distinguish a project's own
 * FIXED prose from a member's variable content: a configured login like
 * `chang` or `revie` sat inside Keryx's own constant wording
 * (`REVIEWER_COMMENT_TRIGGER_PREFIX`'s "prepar**ing** a **chang**e for
 * **revie**w...", or the literal domain name `review-conventions`, or
 * `graduate.ts`'s own summary/keyword text) and false-refused every
 * reviewer-comment lesson or graduation for that project, regardless of what
 * any comment actually said (findings R4-F1, R5-F1, R5-F2). Every caller
 * that assembles fixed wording around variable content is responsible for
 * handing this function ONLY the variable part (see
 * `stripReviewerCommentTriggerPrefix`, and `graduate.ts`'s login gate, which
 * checks only member `trigger`/`action` text, never the proposal's own
 * summary/suggestedName) — the fallback itself is gone. Accepted, documented
 * limitation: a login glued to other letters on both sides with no boundary
 * character anywhere (e.g. `alicedev` inside `alicedeveloper`, or
 * `alicedev` inside `alicedevxreview`) is NOT caught by this function. That
 * residual risk is intentional — a false positive against ordinary prose
 * was the more frequent, more damaging failure mode (an entire project's
 * self-learning loop silently refusing every lesson), while a login glued
 * with zero boundary characters on either side is a narrow, unlikely shape.
 */
export function containsConfiguredLogin(text: string, logins: readonly string[]): boolean {
  return logins.some((login) => {
    const trimmed = login.trim();
    if (trimmed.length === 0) return false;
    const escaped = escapeForRegExp(trimmed);
    return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`, "i").test(text);
  });
}

/**
 * Fixed wording `signals/reviewer-comment.ts` prepends to every generalized
 * lesson's keyword hint to build a reviewer-comment record's `trigger`
 * (`` `${REVIEWER_COMMENT_TRIGGER_PREFIX}${hint})` ``). Exported so every
 * caller that runs a login gate over a record's `trigger`
 * (`extract.ts`'s upsert, `apply.ts`'s apply gate) can strip this constant
 * wording first via `stripReviewerCommentTriggerPrefix` below, rather than
 * checking Keryx's own fixed prose for a configured login.
 */
export const REVIEWER_COMMENT_TRIGGER_PREFIX = "When preparing a change for review in this project (";

/**
 * R4-F1 (review round 4, PR #691, minor): `containsConfiguredLogin`'s 5+
 * char substring fallback (see its own doc comment above) is intentionally
 * a plain substring test — real defense-in-depth for a login glued to
 * surrounding text with no identifier boundary. Run against a
 * reviewer-comment record's FULL trigger, that same fallback also matches a
 * configured login that is merely a substring of Keryx's own FIXED trigger
 * wording rather than of the comment's actual (variable) content: a
 * 5+-character login `chang` sits inside "change" in
 * `REVIEWER_COMMENT_TRIGGER_PREFIX` ("...preparing a **chang**e for
 * review..."), so a project that configures that login would have EVERY
 * reviewer-comment record's extract/apply refused, unconditionally, no
 * matter what the comment said. The fix is not to weaken the fallback (that
 * would reopen R2-F6) but to never hand it the fixed wording in the first
 * place: strip the known constant prefix (and its matching trailing `)`)
 * before a login gate inspects a reviewer-comment trigger, leaving only the
 * variable keyword-hint text a login could actually appear in. A trigger
 * that does not carry the prefix (every other signal's trigger) is returned
 * unchanged.
 */
export function stripReviewerCommentTriggerPrefix(trigger: string): string {
  if (!trigger.startsWith(REVIEWER_COMMENT_TRIGGER_PREFIX)) return trigger;
  const rest = trigger.slice(REVIEWER_COMMENT_TRIGGER_PREFIX.length);
  return rest.endsWith(")") ? rest.slice(0, -1) : rest;
}

/**
 * Strips `@mentions`, every literal `login` in `logins` (case-insensitive,
 * word-bounded), and leading first-person/courtesy phrasing, collapses
 * whitespace, and returns the result — or `null` when the generalized text
 * falls outside the 12-260 char bound `learn.ts`'s own extractor already
 * uses (too short to be a lesson, too long to have actually been
 * generalized rather than just trimmed), OR (R2-F6) when, after every strip,
 * any of `logins` still appears in the result at an identifier boundary (see
 * `containsConfiguredLogin`) — the lesson is dropped entirely rather than
 * shipped with a residual attribution fragment.
 */
export function generalizeLesson(text: string, logins: readonly string[]): string | null {
  let value = text.replace(MENTION_PATTERN, "");
  for (const login of logins) {
    const trimmed = login.trim();
    if (trimmed.length === 0) continue;
    // R1-F4/R2-F6: `\b...\b` never matched a login ending (or starting) in a
    // non-word character adjacent to another non-word character — e.g. a bot
    // login `copilot-reviewer[bot]` followed by a space: `]` and ` ` are
    // both non-word, so `\b` finds no transition there and the whole match
    // fails, leaving the literal login (a bracket, a dot, a leading hyphen —
    // anything not `[A-Za-z0-9_]`) sitting in the generalized text. Explicit
    // lookarounds on "is this a login/word character" replace `\b` and only
    // refuse to match when the login is actually glued to more of the same
    // class on either side (e.g. `alice` must still not match inside
    // `alicedev`) — but R2-F6: that class is `[A-Za-z0-9-]`, NOT `[\w-]`.
    // `\w` includes `_`, which let `alicedev_ prefers early returns…` defeat
    // the boundary entirely (`_` right after the login read as "more of the
    // same word-class", so the whole match failed) — `_` is punctuation to a
    // login, not a login character, so it now counts as a boundary the same
    // way a space or a bracket does.
    const escaped = escapeForRegExp(trimmed);
    value = value.replace(new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`, "gi"), "");
  }
  for (const rule of COURTESY_REWRITES) {
    value = value.replace(rule.pattern, rule.replacement);
  }
  value = value.replace(/\s+/g, " ").trim();
  if (value.length < MIN_LESSON_LEN || value.length > MAX_LESSON_LEN) return null;
  if (containsConfiguredLogin(value, logins)) return null;
  return value;
}
