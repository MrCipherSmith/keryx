// Portable Desktop review protocol. Times are ISO 8601 and revisions are full Git object IDs.
import type { ReviewRunUsage, ReviewUsageCounts } from "./run-usage";

export const LEGACY_DESK_RUN_SCOPE = "review-autonomous/fixed-pr/v1";
// Host-owned attempt contract: completion requires the prepared queue, reviewer receipts and file coverage.
export const DESK_RUN_SCOPE = "review-autonomous/fixed-pr/v2";
export interface DeskRunKey {
  repo: string;
  repositoryId: string;
  viewer: string;
  number: number;
}
export interface DeskRevision {
  baseSha: string;
  headSha: string;
}
/** Persist the exact rule, limits and trigger that authorized an unattended run. */
export interface DeskSchedule {
  project: string;
  ruleId: string;
  ruleName: string;
  event: "push" | "review_requested";
  author: string;
  assignee: string;
  recipient: string | null;
  requireGreen: boolean;
  budgetMinutes: number;
  /** Null means the operator did not set a token limit. */
  budgetTokens: number | null;
  attemptKey: string;
}
export interface DeskResult {
  reviewed: DeskRevision | null;
  verdict: string | null;
  coverage: "complete" | "partial" | "unknown";
  findingsKnown?: boolean;
  findings: { blocker: number; major: number; minor: number; info: number };
  report: string;
  reportDeferred?: boolean;
}
export type DeskRunState =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "partial"
  | "blocked"
  | "failed"
  | "cancelled"
  | "skipped"
  | "budget";
export interface DeskReviewerSession {
  id: string;
  reviewer: string;
  wave: number;
  state: "planned" | "running" | "completed" | "failed" | "cancelled" | "partial" | "unknown";
  provider?: string;
  model?: string;
  startedAt?: string;
  finishedAt?: string;
  usage?: ReviewUsageCounts;
  usagePartial?: true;
  activity?: { at?: string; label: string }[];
  truncated?: boolean;
}
export interface DeskReviewerProgress {
  /** Null until a dispatch plan is recorded. */
  planned: number | null;
  finished: number;
  wave: number | null;
  sessions: DeskReviewerSession[];
}
export interface DeskRun extends DeskRevision {
  id: string;
  source: "manual" | "scheduled" | "existing";
  schedule?: DeskSchedule;
  /** Counts automatic dispatches of this range, including confirmed pre-spend failures. */
  preflightAttempt?: number;
  usage?: ReviewRunUsage;
  reviewerProgress?: DeskReviewerProgress;
  retryableBeforeSpend?: boolean;
  /** A completed run is reusable only with the same execution profile and coverage contract. */
  scope?: string;
  state: DeskRunState;
  phase: string;
  reason: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: DeskResult | null;
}
export interface DeskRunSnapshot {
  version: 1;
  runs: DeskRun[]; // newest request first, including any queued revision
}
export type DeskFinish = Pick<DeskRun, "state" | "phase" | "reason" | "result" | "usage" | "retryableBeforeSpend" | "reviewerProgress">;
