// Read-only Review board protocol shared by the CLI and the Desktop hosts.
import type { DeskReviewerProgress, DeskRunState } from "./desk-run-types";

export type ReviewBoardState = "open" | "closed" | "merged" | "all";
export type ReviewCi = "passed" | "failed" | "pending" | "none" | "unknown";

export interface ReviewCard {
  localReview?: {
    active: boolean;
    ready: boolean;
    awaitingAnswer?: true;
    publicationPending?: true;
    lastActivityAt?: string;
    runState?: DeskRunState | "other-revision";
    progress?: Omit<DeskReviewerProgress, "sessions"> | undefined;
    /** Newest finished result for another range. Present only when no run covers this range and none is active;
     * `runState` is then absent, because a finished `runState` means a result for this revision exists. */
    outdated?: { headSha: string; state: DeskRunState; /** The stale run's Review round, when the store records one. */ round?: number };
  };
  /** GitHub message node IDs addressed to this snapshot’s viewer. */
  addressedReplyIds?: string[];
  number: number;
  title: string;
  changeStats?: { files: number; additions: number; deletions: number };
  url: string;
  state: Exclude<ReviewBoardState, "all">;
  draft: boolean;
  author: string;
  assignees: string[];
  assigneesComplete?: boolean;
  reviewersComplete?: boolean;
  /** Logins for users and organization/slug for teams. */
  reviewers: string[];
  /** Present on watcher polls to recognize a re-request between two observations. */
  reviewRequestIds?: Record<string, string>;
  watcherMergeState?: string;
  watcherReviews?: { id: string; login: string; state: string }[];
  decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  ci: ReviewCi;
  headSha: string;
  baseSha: string;
  updatedAt: string;
}

export interface ReviewBoardSnapshot {
  version: 1;
  /** GitHub owner/name of the base repository. */
  repo: string;
  repositories: string[];
  repositoryId: string;
  viewer: string;
  fetchedAt: string;
  /** Present only for paged Desktop reads. null identifies the last page. */
  nextCursor?: string | null;
  /** JSON of one exceptional card split over transport frames, indexed from zero. */
  cardPart?: { digest: string; index: number; last: boolean; text: string; localReview?: ReviewCard["localReview"]; addressedReplyIds?: string[] };
  /** First transport page only: viewer-scoped reply IDs for PRs on subsequent pages. */
  replyHints?: { number: number; ids: string[] }[];
  /** First transport page only: verified PRs with active local reviews outside the GitHub page. */
  activeReviewCards?: ReviewCard[];
  cards: ReviewCard[];
  /** Missing pages or fields. A successful empty list has no warnings. */
  warnings: string[];
}
