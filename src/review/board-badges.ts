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
  result: { reviewed: DeskRevision | null } | null;
  reviewerProgress?: LocalBadge["progress"];
};

/** Both Desktop's live history and SQLite's projected rows use the same ordering and revision rules. */
export function localBadge(runs: readonly BadgeRun[], revision: DeskRevision): LocalBadge {
  const active = runs.find(run => run.source !== "existing" && runActive(run) && run.state !== "queued")
    ?? runs.find(run => run.source !== "existing" && runActive(run));
  const roster = active && sameRange(active, revision) ? active.reviewerProgress : undefined;
  return {
    active: !!active,
    ready: runs.some(run => run.source !== "existing" && ["completed", "partial", "budget"].includes(run.state)
      && !!run.result && sameRange(run.result.reviewed, revision)),
    ...(roster ? { progress: { planned: roster.planned, finished: roster.finished, wave: roster.wave } } : {}),
  };
}
