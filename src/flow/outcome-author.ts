// Who wrote a flow's outcome criterion: an agent, or a human.
//
// `flow.json` carries `outcomeAuthor` as an optional field. Absent reads
// `unknown` — neither agent nor human — and reading never rewrites a file. The
// value is recorded at `flow init` (default `agent`; `human` only when the flag
// says so, never inferred from a git identity, an owner or the environment) and
// changed only by `flow outcome author`, which leaves a journal line. Nothing
// gates on it: it labels a sample so that "did the outcome slot get filled" can
// be read separately for the flows an agent created and the flows a person did.

export const OUTCOME_AUTHORS = ["agent", "human"] as const;
export type OutcomeAuthor = (typeof OUTCOME_AUTHORS)[number];

/** What a reader prints for a flow: a recorded author, or `unknown` when the field is absent. */
export type OutcomeAuthorReading = OutcomeAuthor | "unknown";

/** Every reading a reader can print, in the order they are listed: the two recorded authors, then `unknown`. */
export const OUTCOME_AUTHOR_READINGS: readonly OutcomeAuthorReading[] = [...OUTCOME_AUTHORS, "unknown"];

/** The author a new flow carries when `--outcome-author` is not given. */
export const DEFAULT_OUTCOME_AUTHOR: OutcomeAuthor = "agent";

/**
 * The reading of a raw `outcomeAuthor` value. Anything that is not exactly
 * `agent` or `human` (absent, malformed, a future value) reads `unknown`: a
 * reader never invents an author and never fails on a file it did not write.
 */
export function readOutcomeAuthor(value: unknown): OutcomeAuthorReading {
  return value === "agent" || value === "human" ? value : "unknown";
}

/** Throws unless `raw` is exactly `agent` or `human`. The message names the flag, so every caller refuses in one voice. */
export function parseOutcomeAuthor(raw: unknown, flag = "--outcome-author"): OutcomeAuthor {
  if (raw === "agent" || raw === "human") return raw;
  const shown = typeof raw === "string" ? `"${raw}"` : "nothing";
  throw new Error(`${flag} must be one of: ${OUTCOME_AUTHORS.join(", ")} (got ${shown}).`);
}
