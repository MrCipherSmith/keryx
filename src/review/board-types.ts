// Read-only Review board protocol shared by the CLI and the Desktop hosts.
import type { DeskReviewerProgress, DeskRunState } from "./desk-run-types";

export type ReviewBoardState = "open" | "closed" | "merged" | "all";
export type ReviewCi = "passed" | "failed" | "pending" | "none" | "unknown";

export interface ReviewCard {
  localReview?: {
    active: boolean;
    ready: boolean;
    awaitingAnswer?: true;
    lastActivityAt?: string;
    runState?: DeskRunState | "other-revision";
    progress?: Omit<DeskReviewerProgress, "sessions"> | undefined;
  };
  /** GitHub message node IDs addressed to this snapshot’s viewer. */
  addressedReplyIds?: string[];
  number: number;
  title: string;
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
  cards: ReviewCard[];
  /** Missing pages or fields. A successful empty list has no warnings. */
  warnings: string[];
}
