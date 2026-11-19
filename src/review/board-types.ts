// Read-only Review board protocol shared by the CLI and the Desktop hosts.
import type { DeskReviewerProgress } from "./desk-run-types";

export type ReviewBoardState = "open" | "closed" | "merged" | "all";
export type ReviewCi = "passed" | "failed" | "pending" | "none" | "unknown";

export interface ReviewCard {
  localReview?: { active: boolean; ready: boolean; progress?: Pick<DeskReviewerProgress, "wave" | "planned" | "finished"> | undefined };
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
  cards: ReviewCard[];
  /** Missing pages or fields. A successful empty list has no warnings. */
  warnings: string[];
}
