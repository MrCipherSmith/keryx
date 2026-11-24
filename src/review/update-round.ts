// Update round: pick the previous attempt a new round builds on (spec "Раунд обновления", items 1 and 4).
// It works on the DeskRun attempt format only, so it serves a review's rounds as well as a PR's run history.
//
// One rule for "the attempts before this round" ({@link earlierRoundAttempts}): the delta base and the publication
// answer carry-over both read it. A usable previous attempt is one whose package is a closed round, or a partial attempt
// whose package holds an ingested findings list; only the package on disk can tell, so {@link previousRoundAttempts}
// orders the candidates and the executor hands on the first one whose package qualifies (flow 520 T14 B1).
import { DESK_RUN_SCOPE, type DeskRun } from "./desk-run-types";

export interface PriorAttempt {
  attempt: DeskRun;
  /** The attempt left part of the diff unreviewed; the new round plans that area as unreviewed. */
  partial: boolean;
}

/** Delete and archive withdraw an attempt (its evidence is discarded); complete and close keep real findings, restore re-admits. */
const withdrawn = (attempt: DeskRun): boolean => attempt.decision?.action === "delete" || attempt.decision?.action === "archive";

/** The round an attempt belongs to; a store that has not placed rounds yet treats an attempt's own range as its round. */
const roundOf = (attempt: DeskRun): string => attempt.round !== undefined ? `round:${attempt.round}` : `range:${attempt.baseSha}..${attempt.headSha}`;

/**
 * Every attempt that may hold accepted findings a next round builds on, in the order they are tried: the newest round
 * first (`attempts` is newest first) and, within one round, its completed attempts before its partial ones, so a later
 * partial retry never hides an older complete attempt of the same round. The options key is deliberately not compared:
 * changing settings between rounds does not break the link.
 */
export function priorAttemptCandidates(attempts: readonly DeskRun[], scope: string = DESK_RUN_SCOPE): PriorAttempt[] {
  const rounds = new Map<string, PriorAttempt[]>();
  for (const attempt of attempts) {
    if (attempt.source === "existing" || attempt.scope !== scope) continue;
    if (attempt.state !== "completed" && attempt.state !== "partial") continue;
    if (withdrawn(attempt)) continue;
    const result = attempt.result;
    if (!result?.reviewed || result.findingsKnown !== true) continue;
    const key = roundOf(attempt);
    const round = rounds.get(key) ?? [];
    round.push({ attempt, partial: attempt.state === "partial" || result.coverage !== "complete" });
    rounds.set(key, round);
  }
  return [...rounds.values()].flatMap((round) => [...round.filter((item) => !item.partial), ...round.filter((item) => item.partial)]);
}

/** The first of {@link priorAttemptCandidates}. */
export function selectPriorAttempt(attempts: readonly DeskRun[], scope: string = DESK_RUN_SCOPE): PriorAttempt | undefined {
  return priorAttemptCandidates(attempts, scope)[0];
}

/**
 * The attempts of the same Review from rounds before `current`'s, newest first: never `current` itself nor another
 * attempt of its own round, never an imported one, never one the operator deleted or archived.
 */
export function earlierRoundAttempts(runs: readonly DeskRun[], current: DeskRun): DeskRun[] {
  return runs.filter((item) => {
    if (item.id === current.id || item.source === "existing" || withdrawn(item)) return false;
    if (current.reviewId !== undefined && item.reviewId !== undefined && item.reviewId !== current.reviewId) return false;
    if (current.round !== undefined && item.round !== undefined) return item.round < current.round;
    return item.baseSha !== current.baseSha || item.headSha !== current.headSha;
  });
}

/**
 * The attempts a new attempt may build on (flow 520 AC7, spec "Раунд обновления" item 1), in the order to try them:
 * {@link priorAttemptCandidates} over {@link earlierRoundAttempts}, whatever their settings.
 */
export function previousRoundAttempts(runs: readonly DeskRun[], current: DeskRun): PriorAttempt[] {
  return priorAttemptCandidates(earlierRoundAttempts(runs, current));
}

/** What the worker hands the executor: each candidate's run directory and whether it ended partial, in order. */
export function previousRunInputs(runs: readonly DeskRun[], current: DeskRun, directory: (id: string) => string): { runDir: string; partial: boolean }[] {
  return previousRoundAttempts(runs, current).map((item) => ({ runDir: directory(item.attempt.id), partial: item.partial }));
}

/** The first of {@link previousRoundAttempts}. */
export function previousRoundAttempt(runs: readonly DeskRun[], current: DeskRun): PriorAttempt | undefined {
  return previousRoundAttempts(runs, current)[0];
}

/** The highest round of the same Review after `current`'s, or undefined when `current` is its Review's latest round. */
export function newerRoundOf(runs: readonly DeskRun[], current: DeskRun): number | undefined {
  if (current.reviewId === undefined || current.round === undefined) return undefined;
  let newest: number | undefined;
  for (const item of runs) {
    if (item.id === current.id || item.reviewId !== current.reviewId || item.round === undefined || item.round <= current.round) continue;
    if (newest === undefined || item.round > newest) newest = item.round;
  }
  return newest;
}
