// Portable Desktop review protocol. Times are ISO 8601 and revisions are full Git object IDs.
import type { DeskReviewOptions } from "./desk-run-options";
export type { DeskReviewOptions } from "./desk-run-options";
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
  activity?: { at?: string; label: string; kind?: "message" | "answer" | "tool" | "result" | "error" | "status" }[];
  finalOutput?: string;
  needsContext?: true;
  outcomeReason?: string;
  truncated?: boolean;
}
export interface DeskReviewerProgress {
  /** Null until a dispatch plan is recorded. */
  planned: number | null;
  finished: number;
  /** Successful wave assignments, counting the latest retry once. Absent in legacy checkpoints. */
  completed?: number;
  wave: number | null;
  sessions: DeskReviewerSession[];
}
export interface DeskQuestionReviewer {
  reviewerSessionId: string;
  reviewer?: string;
  wave?: number;
}
export interface DeskQuestion extends Partial<DeskQuestionReviewer> {
  id: string;
  question: string;
  reviewContext?: true;
  options: { id: string; label: string; description: string; recommended?: boolean }[];
  allowFreeform: boolean;
}
export interface CoordinatorEvent {
  kind: "message" | "question" | "tool" | "result" | "error" | "answer" | "status";
  text: string;
  questionId?: string;
  reviewer?: string;
  final?: true;
}
export const DESK_REVIEW_ACTIONS = ["complete", "close", "archive", "restore", "delete"] as const;
export type DeskReviewAction = typeof DESK_REVIEW_ACTIONS[number];
export type DeskReviewDecision = { action: DeskReviewAction; reason: string; at: string };
export type DeskReviewCheck = { id: string; title: string; evidence: string; canWaive: boolean };
export function canContinueDeskRun(run: DeskRun): boolean {
  return run.source !== "existing" && !run.closure &&
    !(run.options?.orchestrator === false && run.state === "partial" && run.result?.findingsKnown) && (!run.decision || run.decision.action === "restore") &&
    (run.state === "partial" || run.state === "blocked" || run.state === "budget" || run.state === "failed" || run.state === "cancelled");
}

export interface DeskRun extends DeskRevision {
  continuation?: { previousId: string; guidance?: string };
  publication?: import("./desk-publication-types").PublicationOutcome;
  decision?: DeskReviewDecision;
  closure?: "completed" | "closed";
  /** Public events are projected on demand for the selected attempt. */
  coordinatorActivity?: CoordinatorEvent[];
  /** Compatibility projection: coordinator first, otherwise the first pending reviewer question. */
  pendingQuestion?: DeskQuestion;
  pendingQuestions?: DeskQuestion[];
  /** Most recent write to this attempt’s coordinator transcript. */
  lastActivityAt?: string;
  id: string;
  source: "manual" | "scheduled" | "existing";
  schedule?: DeskSchedule;
  options?: DeskReviewOptions;
  /** Effective options used to produce this run’s evidence. */
  effectiveOptionsKey?: string;
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
  /** The Review this attempt belongs to. Projected from the store's columns, never kept in its details;
   * absent when read from a store that predates Reviews. */
  reviewId?: string;
  round?: number;
  /** The attempt this one follows; null for the first attempt of a Review. */
  previousRunId?: string | null;
}
export interface DeskRunSnapshot {
  completion?: { checks: DeskReviewCheck[] };
  startedRunId?: string;
  version: 1;
  runs: DeskRun[]; // newest request first, including any queued revision
}
export type DeskFinish = Pick<DeskRun, "state" | "phase" | "reason" | "result" | "usage" | "retryableBeforeSpend" | "reviewerProgress">;
