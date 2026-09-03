/**
 * What the router does today, recorded before it is changed.
 *
 * This file exists because of a measured failure, not a preference. An earlier
 * attempt at the routing fix was reviewed three times and each round found
 * regressions the round before had introduced: 29 one-word triggers silently
 * stopped matching inflected forms, the count of triggers with no order-free
 * path went from 11 to 17, and a synonym family kept a mapping its sibling had
 * lost. Every one traced to the same cause — the corpus of the day asserted only
 * cases that were expected to WORK, so each round could see its improvements and
 * none could see its losses.
 *
 * The fix for that is ordering, not effort. The baseline is written first, it
 * records what the scorer actually does INCLUDING what it does wrong, and a
 * change to the scorer shows up as a diff of this file. A regression stops being
 * invisible and becomes a line someone has to justify.
 *
 * `verdict` is what a human would answer, so `wrong` entries are the work
 * remaining and `ok` entries are what must not be lost. Neither is an assertion
 * that the current behaviour is right — only that it is what happens.
 *
 * The file was written BEFORE the scorer was touched, recording ten entries as
 * wrong. All ten moved and no `ok` entry was lost — the first strictly positive
 * change this router has had, and the only reason anyone can say so is that the
 * losing side was written down first. Six entries remain `wrong` and every one
 * is bare token overlap at a score of 10-20: noise far below any trigger, not a
 * recommendation anything acts on.
 */
export interface BaselineEntry {
  readonly query: string;
  /** Top-ranked skill today, or null when the router names nothing. */
  readonly top: string | null;
  readonly score: number;
  readonly verdict: "ok" | "wrong";
  /** Why it is wrong, when it is. */
  readonly note?: string;
}

export const ROUTING_BASELINE: readonly BaselineEntry[] = [
  { query: "review", top: "review-orchestrator", score: 65, verdict: "ok" },
  { query: "do a review", top: "review-orchestrator", score: 65, verdict: "ok" },
  { query: "review the PR", top: "review-orchestrator", score: 65, verdict: "ok" },
  { query: "сделай мне полное ревью без исправления", top: "review-orchestrator", score: 75, verdict: "ok" },
  { query: "frontend review", top: "review-frontend", score: 75, verdict: "ok" },
  { query: "security review", top: "review-security-code", score: 75, verdict: "ok" },
  { query: "backend review", top: "review-backend", score: 75, verdict: "ok" },
  { query: "review the mobx store", top: "code-mobx-store-review", score: 85, verdict: "ok" },
  { query: "проверь безопасность кода", top: "review-security-code", score: 105, verdict: "ok" },
  { query: "commitment issues", top: "changelog", score: 10, verdict: "wrong", note: "token overlap at 10, far below any trigger — noise, not a recommendation" },
  { query: "pushback from the team", top: "reviewer-skill-creator", score: 10, verdict: "wrong", note: "same: bare token overlap" },
  { query: "preview the deck", top: null, score: 0, verdict: "ok" },
  { query: "open the file", top: "code-verifier", score: 10, verdict: "wrong", note: "token overlap at 10" },
  { query: "проверка почты", top: "docpack-review", score: 20, verdict: "wrong", note: "token overlap at 20; провер no longer implies review, so nothing confident answers" },
  { query: "проверь почту", top: "docpack-review", score: 20, verdict: "wrong", note: "token overlap at 20 — noise, not a recommendation" },
  { query: "what is 2+2", top: "changelog", score: 10, verdict: "wrong", note: "token overlap at 10" },
  { query: "run the deployment", top: "deploy", score: 65, verdict: "ok" },
  { query: "brainstorming ideas", top: "brainstorm", score: 85, verdict: "ok" },
  { query: "interviewing me first", top: "interviewer", score: 55, verdict: "ok" },
  { query: "reviewing the diff now", top: "review-orchestrator", score: 55, verdict: "ok" },
  { query: "commits are failing", top: "commit", score: 40, verdict: "ok" },
  { query: "создай фло на эту задачу", top: "flow-orchestrator", score: 105, verdict: "ok" },
  { query: "open a PR", top: "pr", score: 95, verdict: "ok" },
  { query: "commit changes", top: "commit", score: 105, verdict: "ok" },
  { query: "security audit", top: "security-audit", score: 205, verdict: "ok" },
  { query: "architecture review", top: "review-architecture", score: 75, verdict: "ok" },
];
