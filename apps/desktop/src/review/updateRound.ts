// "Update review" on a moved head (Desktop Review v3): the next round of the same Review, sent as a session turn.
// Pure: App reads the PR's attempt history and sends the turn; this decides whether it may go and how.
import type { DeskReviewOptions } from "../../../../src/review/desk-run-options";
import type { DeskRevision, DeskRun } from "../../../../src/review/desk-run-types";
import { advanceRequest, reviewedAttempt } from "../../../../src/review/review-advance";
import { reviewSessionMode, type ReviewSessionMode } from "../session/useAcpSession";

export interface UpdateRoundTurn {
  /** The reviewed attempt's settings without automatic publication; absent when the attempt recorded none. */
  options?: DeskReviewOptions;
  /** The permission mode the PR's session is raised to: the reviewed attempt's review mode, else Trust (never Auto
   * from a default, since no launch dialog showed the operator a mode). */
  mode: ReviewSessionMode;
  /** The update opens a round on a Review the operator may have closed: `state open` needs `--reopen` for it. */
  reopen: true;
}

/**
 * Whether the update round may start and with what. Refuses, as `keryx review advance` does, when the attempt was
 * withdrawn, a later round already exists (a session round counts from `keryx review start`, which registers it) or
 * the round already reviews this range. The open-PR check is the caller's: the publish dialog offers the update only
 * on an open PR, and the turn's skill re-reads the pull request; the GitHub head is not re-read here.
 */
export function updateRoundTurn(runs: readonly DeskRun[], id: string, revision: DeskRevision): UpdateRoundTurn {
  const reviewed = reviewedAttempt(runs, id);
  const { options } = advanceRequest({ reviewed, runs, current: revision, prState: "OPEN" });
  return { ...(options && { options }), mode: options ? reviewSessionMode(options.mode) : "trust", reopen: true };
}
