// Flow 291, AC3/AC4 — who confirmed what, who signed completion, and what
// every `flow complete` attempt's gates decided. Pure projections over an
// already-loaded `FlowState`; nothing here reads a file or calls a gate.

import { readAcKindRecords, reportFromRecords } from "../flow/ac-kinds";
import type { FlowState } from "../flow/types";
import type { CriterionConfirmation, FlowAcceptance, FlowConfirmations, FlowGateOutcomes } from "./types";

/**
 * AC3: join `acConfirmed` (which knows WHEN but never WHO) with `signatures`
 * (which knows both, plus the identity's basis). `recorded: false` means
 * this flow predates flow 289's signing record entirely — distinct from an
 * empty `criteria` array, which would mean signing existed but nothing was
 * confirmed yet.
 *
 * When two-plus `ac-confirm` signatures exist for the same criterion (a
 * reconfirmation — signatures are append-only, never replaced), the LAST one
 * is used: it is the one `acConfirmed[criterion]` currently reflects.
 */
export function summarizeConfirmations(flow: FlowState): FlowConfirmations {
  if (flow.signatures === undefined) {
    return { recorded: false };
  }

  const criteria: CriterionConfirmation[] = Object.entries(flow.acConfirmed).map(([criterion, entry]) => {
    const signature = [...(flow.signatures ?? [])]
      .reverse()
      .find((candidate) => candidate.kind === "ac-confirm" && candidate.criterion === criterion);
    return {
      criterion,
      confirmedAt: entry.at,
      note: entry.note,
      // Never presented as verified when no matching signature exists — the
      // identity is left undefined rather than guessed.
      identity: signature?.identity,
    };
  });

  const completionSignature = [...flow.signatures].reverse().find((candidate) => candidate.kind === "complete");

  return {
    recorded: true,
    criteria,
    completionSignature:
      completionSignature === undefined
        ? undefined
        : {
            at: completionSignature.at,
            identity: completionSignature.identity,
            acChecksum: completionSignature.acChecksum,
            headCommit: completionSignature.headCommit,
            ...(completionSignature.confirmation ? { confirmation: completionSignature.confirmation } : {}),
          },
  };
}

/**
 * Acceptance layer W0: verification-kind coverage from the DERIVED `acKinds`.
 *
 * An absent (or unreadable-shaped) `acKinds` is a flow frozen before kinds
 * existed: it reads as FULLY `unclassified` over `criteriaInFile` criteria, never
 * as zero criteria and never as `none`. `criteriaInFile` is what the caller
 * counted in the criteria file; `undefined` means it could not be read, and the
 * total stays `undefined` rather than becoming a zero.
 */
export function summarizeAcceptance(flow: FlowState, criteriaInFile: number | undefined): FlowAcceptance {
  const records = readAcKindRecords(flow.acKinds);
  if (records === undefined) {
    const total = criteriaInFile;
    return {
      recorded: false,
      total,
      counts: { exec: 0, invariant: 0, judged: 0, none: 0, unclassified: total ?? 0 },
      runnable: 0,
    };
  }
  const report = reportFromRecords(flow.id, records);
  return { recorded: true, total: report.total, counts: { ...report.counts }, runnable: report.runnable };
}

/**
 * AC4: `flow.completionAttempts` verbatim, or `recorded: false` when the
 * field is absent — every flow completed before flow 291, and any flow that
 * has never had `complete` invoked since. Never backfilled or inferred.
 */
export function summarizeGateOutcomes(flow: FlowState): FlowGateOutcomes {
  if (flow.completionAttempts === undefined) {
    return { recorded: false };
  }
  return { recorded: true, attempts: flow.completionAttempts };
}
