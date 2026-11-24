// Update round: pick the previous attempt a new round builds on (spec "Раунд обновления", items 1 and 4).
// It works on the DeskRun attempt format only, so it serves a review's rounds as well as a PR's run history.
import { DESK_RUN_SCOPE, type DeskRun } from "./desk-run-types";

export interface PriorAttempt {
  attempt: DeskRun;
  /** The attempt left part of the diff unreviewed; the new round plans that area as unreviewed. */
  partial: boolean;
}

/**
 * The newest attempt (`attempts` is newest first) whose accepted findings the next round may build on.
 * The options key is deliberately not compared: changing settings between rounds does not break the link.
 */
export function selectPriorAttempt(attempts: readonly DeskRun[], scope: string = DESK_RUN_SCOPE): PriorAttempt | undefined {
  for (const attempt of attempts) {
    if (attempt.source === "existing" || attempt.scope !== scope) continue;
    if (attempt.state !== "completed" && attempt.state !== "partial") continue;
    // Delete and archive withdraw the attempt (its evidence is discarded); complete and close keep real findings, restore re-admits.
    if (attempt.decision?.action === "delete" || attempt.decision?.action === "archive") continue;
    const result = attempt.result;
    if (!result?.reviewed || result.findingsKnown !== true) continue;
    return { attempt, partial: attempt.state === "partial" || result.coverage !== "complete" };
  }
  return undefined;
}
