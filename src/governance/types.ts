// Flow 291 — the governance report: spend, confirmations, signatures and
// gate outcomes, unified across flows (and optionally across projects).
//
// Every type here follows the house rule this whole feature exists to keep
// honest: "not recorded" and "0" are never the same fact. A field that was
// never measured is `undefined`/a dedicated `recorded: false` variant, never
// a coerced zero — see `src/review/caps.ts`'s `evaluateSpendCap`,
// `src/trigger/record.ts`'s `TriggerRunCost`, and `src/flow/identity.ts`'s
// `Identity` for the precedent this mirrors.

import type { FlowCompletionAttempt, GateOutcome, Identity } from "../flow/types";

export type { GateOutcome, Identity };

/**
 * Spend recorded on one flow's review rounds (AC1). Each figure is summed
 * only over the rounds that reported it, and is `undefined` — never `0` —
 * when no round reported that particular figure. `roundsTotal` and
 * `roundsWithCost` are always real counts, so a reader can see partial
 * coverage (e.g. `roundsWithCost: 1, roundsTotal: 3`) rather than a sum that
 * silently drops the gap.
 */
export type FlowReviewSpend = {
  roundsTotal: number;
  /** Rounds whose manifest carries a `cost` object at all (any field). */
  roundsWithCost: number;
  spentUsd: number | undefined;
  roundsWithSpentUsd: number;
  inputTokens: number | undefined;
  roundsWithInputTokens: number;
  outputTokens: number | undefined;
  roundsWithOutputTokens: number;
};

/**
 * Project-wide spend from fired triggers (AC2). Never flow-attributed — a
 * `TriggerRunRecord` carries no flow reference, so this is reported once per
 * project, alongside a note explaining why it cannot be folded into any
 * flow's total.
 */
export type ProjectTriggerSpend =
  /** `runs.jsonl` has never been written: a demonstrated $0, not an unknown. */
  | { state: "absent" }
  /** The ledger exists but could not be read; spend cannot be verified. */
  | { state: "unreadable"; reason: string }
  | {
      state: "present";
      /** Sum of `cost.usd` over every run whose cost WAS recorded. */
      spentUsd: number;
      runsWithCostRecorded: number;
      /** Runs that fired but whose cost was never recorded — counted, never folded into the $0. */
      runsWithCostNotRecorded: number;
      runsTotal: number;
    };

/** One AC's confirmation, joined from `acConfirmed` and the matching `ac-confirm` signature. */
export type CriterionConfirmation = {
  criterion: string;
  confirmedAt: string;
  note: string | undefined;
  /** `undefined` when no matching signature exists — never presented as verified. */
  identity: Identity | undefined;
};

/**
 * Who confirmed what, and who signed completion (AC3). `recorded: false`
 * means this flow predates flow 289's signing record entirely
 * (`flow.signatures === undefined`) — an empty confirmation list is a
 * different fact from "nobody has ever signed anything here", and the two
 * must never be presented the same way.
 */
export type FlowConfirmations =
  | { recorded: false }
  | {
      recorded: true;
      criteria: CriterionConfirmation[];
      /** The most recent `complete`-kind signature, when one exists. */
      completionSignature:
        | { at: string; identity: Identity; acChecksum: string | null; headCommit: string | undefined }
        | undefined;
    };

/**
 * Gate outcomes recorded across every `flow complete` attempt (AC4). Reads
 * `FlowState.completionAttempts` directly — `recorded: false` when that
 * field is absent (every attempt made before flow 291, and any flow that has
 * never had `complete` invoked since).
 */
export type FlowGateOutcomes =
  | { recorded: false }
  | { recorded: true; attempts: FlowCompletionAttempt[] };

export type FlowGovernance = {
  id: string;
  dir: string;
  slug: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  owner: Identity | undefined;
  spend: FlowReviewSpend;
  confirmations: FlowConfirmations;
  gateOutcomes: FlowGateOutcomes;
};

/** AC9: no durable record of policy allow/ask/deny decisions exists today. */
export type PolicyDecisionsSummary = {
  recorded: false;
  reason: string;
};

export type GovernanceFilters = {
  flow?: string | undefined;
  owner?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
};

export type ProjectGovernance = {
  /** Absolute project root. */
  root: string;
  /** Registry display name, when this project came from the registry (`--all-projects`). */
  displayName: string | undefined;
  state: "ok" | "skipped";
  /** Populated only when `state` is `skipped`. */
  reason: string | undefined;
  flows: FlowGovernance[];
  triggerSpend: ProjectTriggerSpend;
  policyDecisions: PolicyDecisionsSummary;
};

export type GovernanceReport = {
  schemaVersion: 1;
  generatedAt: string;
  filters: GovernanceFilters;
  allProjects: boolean;
  projects: ProjectGovernance[];
};

/** The shape-guarded reader's result — mirrors `src/health/service.ts`'s `readLatest`. */
export type GovernanceReportRead =
  | { state: "absent" }
  | { state: "present"; report: GovernanceReport }
  | { state: "malformed"; reason: string };
