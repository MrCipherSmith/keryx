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
import type { TriggerRunCost, TriggerRunOutcomeKind, UnattendedDenial } from "../trigger/record";

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
 * Project-wide spend from fired triggers (AC2). `spentUsd` is the TRUE total
 * — every run's cost, project-wide, whether or not it named a flow.
 *
 * Flow 297 gave some runs a flow reference (`TriggerDispatchRecord.flow`),
 * and THOSE runs are also shown individually under their flow's own
 * `FlowGovernance.dispatch.spend` (below). `attributedToFlowsUsd` is how much
 * of `spentUsd` that is — a SUBSET, not a separate figure: a reader must
 * never compute `spentUsd + sum(flow.dispatch.spend.spentUsd)`, because that
 * double-counts every flow-attributed dollar. `undefined` (never `0` by
 * coercion) when no flow-attributed run recorded a cost.
 */
export type ProjectTriggerSpend =
  /** `runs.jsonl` has never been written: a demonstrated $0, not an unknown. */
  | { state: "absent" }
  /** The ledger exists but could not be read; spend cannot be verified. */
  | { state: "unreadable"; reason: string }
  | {
      state: "present";
      /** Sum of `cost.usd` over every run whose cost WAS recorded — the project's true total, flow-attributed runs included. */
      spentUsd: number;
      runsWithCostRecorded: number;
      /** Runs that fired but whose cost was never recorded — counted, never folded into the $0. */
      runsWithCostNotRecorded: number;
      runsTotal: number;
      /** Flow 297 (AC2 follow-up): the part of `spentUsd` also shown under a flow's own `dispatch.spend` — never additive with it. */
      attributedToFlowsUsd: number | undefined;
    };

/**
 * Flow 297 (AC1, AC2): one unattended trigger-dispatch run this flow named
 * (`TriggerDispatchRecord.flow` — flow 290), joined from the same ledger
 * `ProjectTriggerSpend` reads. Its outcome and cost are the CLOSING record's
 * own — a run still open (only a "reserved" record, no closing one yet) never
 * appears here; see `FlowDispatch.openReservations` for that case.
 */
export type FlowDispatchRun = {
  runId: string;
  trigger: string;
  at: string;
  task: string | undefined;
  outcome: TriggerRunOutcomeKind;
  cost: TriggerRunCost;
  /** AC1: every call this run's unattended approval gate denied — the tool, the reason; this run's own `at` is the time. */
  denials: readonly UnattendedDenial[];
};

/** Flow 297 (AC2): a spend reservation this flow's dispatch opened that no closing record (or `keryx trigger resolve`) has closed yet — shown as reserved, never as spent. */
export type FlowOpenReservation = {
  runId: string;
  trigger: string;
  at: string;
  usd: number;
};

/**
 * Flow 297 (AC2): figures over `runs` only — an open reservation is tracked
 * separately (`openReservedUsd`) and never folded into `spentUsd`, the same
 * "reserved, not spent" rule the project-wide trigger ledger already keeps.
 *
 * `includedInProjectTriggerSpend` is always `true`: every dispatch run here
 * is also part of `ProjectGovernance.triggerSpend.spentUsd` (and of that
 * figure's own `attributedToFlowsUsd` subset) — this flow's `spentUsd` is a
 * SLICE of the project total, not an addition to it. A consumer summing
 * `triggerSpend.spentUsd` across every flow's `dispatch.spend.spentUsd`
 * double-counts every dollar shown here.
 */
export type FlowDispatchSpend = {
  runsTotal: number;
  spentUsd: number | undefined;
  runsWithCostRecorded: number;
  runsWithCostNotRecorded: number;
  openReservedUsd: number;
  readonly includedInProjectTriggerSpend: true;
};

/**
 * Flow 297 (AC1, AC2): this flow's slice of the trigger ledger — mirrors
 * `ProjectTriggerSpend`'s own `absent | unreadable | present` discipline, for
 * the identical reason: "no dispatch run has ever named this flow" (a
 * demonstrated absence, when the ledger itself is absent) and "the ledger
 * could not be read" are different facts, and neither is ever presented as a
 * silent `spentUsd: 0`/empty `runs: []`.
 */
export type FlowDispatch =
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly reason: string }
  | {
      readonly state: "present";
      readonly spend: FlowDispatchSpend;
      readonly runs: readonly FlowDispatchRun[];
      readonly openReservations: readonly FlowOpenReservation[];
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
  /** Flow 297 (AC1, AC2): unattended trigger-dispatch runs this flow named, plus their denials and open reservations. */
  dispatch: FlowDispatch;
};

/**
 * Flow 297 (AC1): narrowed from "no durable record of policy allow/ask/deny
 * decisions exists" — that was true project-wide before flow 290. Since flow
 * 290 shipped in the same release, every UNATTENDED dispatch run's denials
 * (tool, reason, time) ARE recorded (`TriggerDispatchRecord.denials`,
 * surfaced above in `FlowDispatch`/`FlowDispatchRun.denials`); what remains
 * unrecorded is specifically an INTERACTIVE session's own allow/ask/deny
 * decisions, which still have no durable log anywhere in this build.
 */
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
