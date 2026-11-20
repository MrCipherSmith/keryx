import type { ReviewCard } from "./board-types";
import type { DeskRevision, DeskRun } from "./desk-run-types";

export type LocalBadge = NonNullable<ReviewCard["localReview"]>;
export type BadgeCard = DeskRevision & { number: number; localReview?: LocalBadge };
export interface BadgeSnapshot {
  version: 1;
  repositoryId: string;
  viewer: string;
  cards: BadgeCard[];
}

export const runActive = (run: Pick<DeskRun, "state">) => run.state === "running" || run.state === "queued" || run.state === "cancelling";
export const sameRange = (a: DeskRevision | null, b: DeskRevision) => a?.baseSha === b.baseSha && a.headSha === b.headSha;

type BadgeRun = Pick<DeskRun, "state" | "source" | "baseSha" | "headSha"> & {
  decision?: DeskRun["decision"];
  result: { reviewed: DeskRevision | null } | null;
  reviewerProgress?: LocalBadge["progress"];
  pendingQuestion?: DeskRun["pendingQuestion"];
  pendingQuestions?: DeskRun["pendingQuestions"];
  awaitingAnswer?: boolean;
  lastActivityAt?: string | undefined;
};

/** Both Desktop's live history and SQLite's projected rows use the same ordering and revision rules. */
export function localBadge(runs: readonly BadgeRun[], revision: DeskRevision): LocalBadge {
  runs = runs.filter(run => run.decision?.action !== "archive" && run.decision?.action !== "delete");
  const active = runs.filter(run => run.source !== "existing" && runActive(run));
  const current = active.find(run => sameRange(run, revision)) ?? active[0];
  // History is newest first. A review on an older range belongs in the lane but
  // its percentage must not be attributed to the current PR revision.
  const latest = current ?? runs.find(run => run.source !== "existing" && sameRange(run, revision));
  const same = !!latest && sameRange(latest, revision);
  const awaiting = latest?.awaitingAnswer ?? (latest?.pendingQuestions ? latest.pendingQuestions.length > 0 : !!latest?.pendingQuestion);
  const roster = same ? latest.reviewerProgress : undefined;
  return {
    active: !!current,
    ready: runs.some(run => run.source !== "existing" && ["completed", "partial", "budget"].includes(run.state)
      && !!run.result && sameRange(run.result.reviewed, revision)),
    ...(latest ? { runState: same ? latest.state : "other-revision" } : {}),
    ...(same && latest.state === "running" && latest.source === "manual" && awaiting && { awaitingAnswer: true }),
    ...(same && latest.state === "running" && latest.lastActivityAt && { lastActivityAt: latest.lastActivityAt }),
    ...(roster ? { progress: { planned: roster.planned, finished: roster.finished, wave: roster.wave,
      ...(roster.completed !== undefined && { completed: roster.completed }),
    } } : {}),
  };
}
