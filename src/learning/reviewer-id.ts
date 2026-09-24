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
 * Strips `@mentions`, every literal `login` in `logins` (case-insensitive,
 * word-bounded), and leading first-person/courtesy phrasing, collapses
 * whitespace, and returns the result — or `null` when the generalized text
 * falls outside the 12-260 char bound `learn.ts`'s own extractor already
 * uses (too short to be a lesson, too long to have actually been
 * generalized rather than just trimmed).
 */
export function generalizeLesson(text: string, logins: readonly string[]): string | null {
  let value = text.replace(MENTION_PATTERN, "");
  for (const login of logins) {
    const trimmed = login.trim();
    if (trimmed.length === 0) continue;
    // R1-F4: `\b...\b` never matched a login ending (or starting) in a
    // non-word character adjacent to another non-word character — e.g. a bot
    // login `copilot-reviewer[bot]` followed by a space: `]` and ` ` are
    // both non-word, so `\b` finds no transition there and the whole match
    // fails, leaving the literal login (a bracket, a dot, a leading hyphen —
    // anything not `[A-Za-z0-9_]`) sitting in the generalized text. Explicit
    // lookarounds on "is this a login/word character" (`[\w-]`, word chars
    // plus hyphen so a login is not treated as "bounded" by its own internal
    // hyphens) replace `\b` and only refuse to match when the login is
    // actually glued to more of the same class on either side (e.g. `alice`
    // must still not match inside `alicedev`).
    const escaped = escapeForRegExp(trimmed);
    value = value.replace(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "gi"), "");
  }
  for (const rule of COURTESY_REWRITES) {
    value = value.replace(rule.pattern, rule.replacement);
  }
  value = value.replace(/\s+/g, " ").trim();
  if (value.length < MIN_LESSON_LEN || value.length > MAX_LESSON_LEN) return null;
  return value;
}
