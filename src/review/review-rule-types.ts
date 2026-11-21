// Wire contract shared by the CLI, native host and Desktop.
import type { PrRepairSettings, PrSubscription, PrWatchTopic } from "./watcher-types";

export interface ReviewRule {
  id: string;
  name: string;
  enabled: boolean;
  event: "review_requested" | "push";
  author: string;
  assignee: string;
  reviewer: string;
  requireGreen: boolean;
  budgetMinutes: number;
  /** Null means the operator did not set a token limit. */
  budgetTokens: number | null;
}

export type ReviewPrMode = { mode: "project" | "manual" } | { mode: "auto"; ruleId: string };

export type ReviewRuleAction =
  | { kind: "status"; number?: number | undefined }
  | { kind: "save"; rule: ReviewRule; expected?: ReviewRule | null | undefined; number?: number | undefined }
  | { kind: "delete"; id: string; expected?: ReviewRule | undefined; number?: number | undefined }
  | { kind: "mode"; number: number; choice: ReviewPrMode }
  | { kind: "subscription"; number: number; topics: PrWatchTopic[]; rebase?: boolean | undefined; repair?: PrRepairSettings | undefined };

export interface ReviewRuleActivity {
  number: number;
  at: string;
  headSha: string;
  reason: string;
  state: "waiting" | "ready" | "started" | "linked" | "skipped";
  runId?: string;
}

export interface ReviewRuleSnapshot {
  version: 1;
  rules: ReviewRule[];
  choice: ReviewPrMode;
  activity: ReviewRuleActivity[];
  subscriptions?: PrSubscription[];
}
