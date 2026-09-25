// Flow 338, AC2 — deterministic routing shortcuts. Decided WITHOUT any
// classifier call (Jev or main-model): a caller checks this FIRST
// (`classify-turn.ts`), and only reaches for a real classifier when nothing
// here matched. Pure, synchronous, no I/O — same "heuristic, not a registry
// lookup" discipline `src/review/turn-guard.ts`'s own regexes document at
// their definitions.

import type { RoutingCategory } from "../routing/table";

/** A short greeting/thanks/acknowledgement — the "quick" category's cheapest, highest-confidence case. */
const CHITCHAT_RE =
  /^(?:hi|hello|hey|yo|thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|awesome|sounds good|got it|sure|yes|no|yep|yup|nope|nah|good morning|good night|gm|lol|haha|np|no problem|welcome|you're welcome)[.!?]*$/i;

/** A word-count/character bound so a longer message that merely STARTS with a greeting is never misread as chit-chat. */
const CHITCHAT_MAX_CHARS = 24;
const CHITCHAT_MAX_WORDS = 4;

/** The request explicitly names a review, a PR, or a pull request. */
const REVIEW_RE = /\b(?:code\s+review|review(?:s|ed|ing)?|PRs?|pull\s+requests?)\b/i;

/**
 * AC2: bypass ANY classifier for a slash command — routing never applies to
 * one (the shell dispatches `/…` lines before a request ever reaches
 * `classifyTurn`; this check is a defensive second layer, not the only
 * gate).
 */
export function isSlashCommandLine(line: string): boolean {
  return line.trim().startsWith("/");
}

/**
 * The deterministic-shortcut category for `line`, or `undefined` when
 * nothing matched and a real classifier stage should run instead. Review
 * naming is checked before chit-chat so a short review-naming line (`"review
 * PR"`) resolves `"review"`, never `"quick"`.
 */
export function classifyDeterministic(line: string): RoutingCategory | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || isSlashCommandLine(trimmed)) return undefined;
  if (REVIEW_RE.test(trimmed)) return "review";
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  if (trimmed.length <= CHITCHAT_MAX_CHARS && words.length <= CHITCHAT_MAX_WORDS && CHITCHAT_RE.test(trimmed)) {
    return "quick";
  }
  return undefined;
}
