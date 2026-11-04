import type { ModelSelection } from "../child/model";

interface PilotObservationBase {
  readonly requestId: string;
  readonly snapshotDigest: string;
  readonly classifierReceiptId?: string;
  readonly selection?: ModelSelection;
}

export type RoutingPilotObservation =
  | (PilotObservationBase & { readonly kind: "preview" })
  | (PilotObservationBase & {
      readonly kind: "dispatch";
      readonly fallback?: { readonly parentDecisionId?: string; readonly reason?: string };
    });

function comparisonKey(observation: PilotObservationBase): string {
  return JSON.stringify([observation.requestId, observation.snapshotDigest, observation.classifierReceiptId]);
}

function selectionKey(selection: ModelSelection): string {
  return JSON.stringify([selection.providerId, selection.modelId]);
}

function verdict(samples: number, failures: number): "unmeasured" | "pass" | "fail" {
  if (samples === 0) return "unmeasured";
  return failures === 0 ? "pass" : "fail";
}

/** Observations are collected for the pilot window by the caller. No prompt or credentials are needed. */
export function summarizeRoutingPilot(observations: readonly RoutingPilotObservation[]) {
  const previews = new Map<string, Set<string>>();
  for (const observation of observations) {
    if (observation.kind !== "preview" || observation.selection === undefined) continue;
    const key = comparisonKey(observation);
    const selections = previews.get(key) ?? new Set<string>();
    selections.add(selectionKey(observation.selection));
    previews.set(key, selections);
  }

  let comparableDispatches = 0;
  let unmatchedDispatches = 0;
  let mismatches = 0;
  let fallbackDispatches = 0;
  let incompleteFallbacks = 0;
  for (const observation of observations) {
    if (observation.kind !== "dispatch") continue;
    if (observation.fallback !== undefined) {
      fallbackDispatches++;
      if (!observation.fallback.parentDecisionId?.trim() || !observation.fallback.reason?.trim()) {
        incompleteFallbacks++;
      }
    }
    const selections = previews.get(comparisonKey(observation));
    if (selections === undefined) {
      unmatchedDispatches++;
      continue;
    }
    comparableDispatches++;
    if (observation.selection === undefined || selections.size !== 1 || !selections.has(selectionKey(observation.selection))) {
      mismatches++;
    }
  }

  return {
    comparableDispatches,
    unmatchedDispatches,
    mismatches,
    fallbackDispatches,
    incompleteFallbacks,
    parity: verdict(comparableDispatches, mismatches),
    fallbackTrace: verdict(fallbackDispatches, incompleteFallbacks),
  };
}
