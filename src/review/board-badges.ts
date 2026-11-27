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
export const runFinished = (run: Pick<DeskRun, "state">) => run.state === "completed" || run.state === "partial" || run.state === "budget";

type BadgeRun = Pick<DeskRun, "state" | "source" | "baseSha" | "headSha"> & {
  id?: string;
  sessionId?: string | null;
  decision?: DeskRun["decision"];
  result: { reviewed: DeskRevision | null } | null;
  reviewerProgress?: LocalBadge["progress"];
  pendingQuestion?: DeskRun["pendingQuestion"];
  pendingQuestions?: DeskRun["pendingQuestions"];
  publication?: DeskRun["publication"];
  publishedVerdict?: DeskRun["publishedVerdict"];
  awaitingAnswer?: boolean;
  lastActivityAt?: string | undefined;
  /** Null when SQL reads a store that predates rounds. */
  round?: number | null;
};

/** Both Desktop's live history and SQLite's projected rows use the same ordering and revision rules. */
export function localBadge(runs: readonly BadgeRun[], revision: DeskRevision): LocalBadge {
  runs = runs.filter(run => run.source !== "existing" && run.decision?.action !== "archive" && run.decision?.action !== "delete");
  const active = runs.filter(runActive);
  const current = active.find(run => sameRange(run, revision)) ?? active[0];
  // History is newest first. A review on an older range belongs in the lane but
  // its percentage must not be attributed to the current PR revision.
  const latest = current ?? runs.find(run => sameRange(run, revision));
  const same = !!latest && sameRange(latest, revision);
  const awaiting = latest?.awaitingAnswer ?? (latest?.pendingQuestions ? latest.pendingQuestions.length > 0 : !!latest?.pendingQuestion);
  const roster = same ? latest.reviewerProgress : undefined;
  const ready = runs.some(run => runFinished(run) && !!run.result && sameRange(run.result.reviewed, revision));
  // Outdated is a fallback only: any run on this range, or any active run, says more about the card.
  const stale = latest || ready ? undefined : runs.find(run => runFinished(run) && !!run.result?.reviewed);
  const outdated = stale?.result?.reviewed ? { headSha: stale.result.reviewed.headSha, state: stale.state,
    ...(typeof stale.round === "number" && { round: stale.round }) } : undefined;
  const bound = latest ?? stale;
  return {
    ...(bound?.sessionId && bound.id && { sessionId: bound.sessionId, runId: bound.id }),
    active: !!current,
    ready,
    ...(latest ? { runState: same ? latest.state : "other-revision" } : {}),
    ...(outdated && { outdated }),
    ...(same && latest.state === "running" && latest.source === "manual" && awaiting && { awaitingAnswer: true }),
    ...(same && latest.publication === "pending" && sameRange(latest.result?.reviewed ?? null, revision) && { publicationPending: true }),
    ...(same && !current && latest.publication === "published" && sameRange(latest.result?.reviewed ?? null, revision) &&
      { published: latest.publishedVerdict ? { verdict: latest.publishedVerdict } : {} }),
    ...(same && latest.state === "running" && latest.lastActivityAt && { lastActivityAt: latest.lastActivityAt }),
    ...(roster ? { progress: { planned: roster.planned, finished: roster.finished, wave: roster.wave,
      ...(roster.completed !== undefined && { completed: roster.completed }),
    } } : {}),
  };
}
