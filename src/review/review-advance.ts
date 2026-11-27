// `keryx review advance` (spec "Раунд обновления"): open the next round of the same Review on the pull request's
// current range. The review-orchestrator skill's "Head moved" procedure calls the command; its round runs through the
// Desktop dispatch path (`requestDeskRun` start), which picks the previous round the update builds on (update-round.ts)
// and places the attempt in the Review. Desktop's "Update review" uses `reviewedAttempt` and `advanceRequest` here and
// sends the round to the PR's session as a turn (apps/desktop/src/review/updateRound.ts).

import type { DeskReviewOptions } from "./desk-run-options";
import type { DeskRevision, DeskRun, DeskRunKey, DeskRunSnapshot } from "./desk-run-types";
import { newerRoundOf } from "./update-round";

/** An update round keeps the reviewed attempt's settings, except automatic publication: the operator decides again. */
export function updateRoundOptions(options: DeskReviewOptions | undefined): DeskReviewOptions | undefined {
  if (options === undefined) return undefined;
  const { autoPublish: _automatic, ...rest } = options;
  return rest;
}

const withdrawn = (run: DeskRun): boolean => run.decision?.action === "delete" || run.decision?.action === "archive";

/**
 * The attempt the update round follows: the one named, or else the newest attempt of the Review's latest round.
 * An imported (`existing`) or withdrawn attempt is never a round to update.
 */
export function reviewedAttempt(runs: readonly DeskRun[], id?: string): DeskRun {
  const candidates = runs.filter((run) => run.source !== "existing" && !withdrawn(run));
  if (id !== undefined) {
    const named = candidates.find((run) => run.id === id);
    // Not an access or configuration problem (Desktop drops the panel for those): the attempt was archived, deleted or
    // imported since the panel was read.
    if (!named) throw new Error("stale: This attempt was archived, deleted or imported, so it cannot be updated. Update the review from its latest round.");
    return named;
  }
  const latest = [...candidates].sort((a, b) => (b.round ?? 0) - (a.round ?? 0) || b.createdAt.localeCompare(a.createdAt))[0];
  if (!latest) throw new Error("configuration: This pull request has no review to update. Start a review first.");
  return latest;
}

export type AdvanceInput = { reviewed: DeskRun; runs: readonly DeskRun[]; current: DeskRevision; prState: string };

/** What the update round starts with, or why it cannot start. */
export function advanceRequest({ reviewed, runs, current, prState }: AdvanceInput): { revision: DeskRevision; options?: DeskReviewOptions } {
  if (prState !== "OPEN") throw new Error("stale: This pull request is no longer open.");
  if (newerRoundOf(runs, reviewed) !== undefined) {
    throw new Error("stale: A later round of this Review already exists. Refresh the Review and update from its latest round.");
  }
  if (reviewed.baseSha === current.baseSha && reviewed.headSha === current.headSha) {
    throw new Error("configuration: This round already reviews the pull request's current head; there is nothing to update.");
  }
  const options = updateRoundOptions(reviewed.options);
  return { revision: current, ...(options && { options }) };
}

export type AdvanceDeps = {
  resolve: (repo: string, number: number) => Promise<{ key: DeskRunKey; pr: { state: string; baseRefOid: string; headRefOid: string } }>;
  history: (key: DeskRunKey) => DeskRun[];
  start: (key: DeskRunKey, revision: DeskRevision, options?: DeskReviewOptions) => Promise<DeskRunSnapshot>;
};

export type AdvanceArgs = {
  repo: string;
  number: number;
  /** When given (Desktop), they must name the account and repository the project resolves to. */
  repositoryId?: string | undefined;
  viewer?: string | undefined;
  /** The attempt to update from; the Review's latest round by default. */
  id?: string | undefined;
  /** The range the caller saw; the update round refuses when the pull request has moved again since. */
  revision?: DeskRevision | undefined;
};

export async function advanceReview(args: AdvanceArgs, deps: AdvanceDeps): Promise<DeskRunSnapshot> {
  const { key, pr } = await deps.resolve(args.repo, args.number);
  if ((args.repositoryId !== undefined && args.repositoryId !== key.repositoryId) ||
      (args.viewer !== undefined && args.viewer.toLowerCase() !== key.viewer.toLowerCase())) {
    throw new Error("access: GitHub account or repository changed. Refresh the board.");
  }
  const current = { baseSha: pr.baseRefOid, headSha: pr.headRefOid };
  if (args.revision !== undefined && (args.revision.baseSha !== current.baseSha || args.revision.headSha !== current.headSha)) {
    throw new Error("stale: The pull request revision has changed. Refresh the board to review its current range.");
  }
  const runs = deps.history(key);
  const reviewed = reviewedAttempt(runs, args.id);
  const { revision, options } = advanceRequest({ reviewed, runs, current, prState: pr.state });
  return deps.start(key, revision, options);
}
