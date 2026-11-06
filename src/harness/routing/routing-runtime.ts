import type { NormalizedRoutingConfig } from "./config";
import type { RoutingDecision, RoutingReason } from "./decision";
import { resolveRoutingDecision } from "./resolver";
import type { RoutingRequest } from "./routing-request";
import type { RoutingSnapshot } from "./snapshot";
import { appendRoutingJournal, type RoutingJournalLocation } from "./routing-journal";

/** Sanitized receipt: it contains routing identities/digests, never prompt or credential data. */
export interface RoutingDecisionReceipt {
  readonly receiptId: string;
  readonly decision: RoutingDecision;
  readonly previousDecisionId?: string;
  readonly fallbackReason?: RoutingReason;
}

export interface ResolveRoutingForRuntimeInput {
  readonly request: RoutingRequest;
  readonly snapshot: RoutingSnapshot;
  readonly config: NormalizedRoutingConfig;
  readonly previousDecisionId?: string;
  readonly fallbackReason?: RoutingReason;
  readonly journal?: RoutingJournalLocation & { readonly kind: "preview" | "dispatch" };
}

/** Shared runtime entry point; callers do not implement selected/blocked precedence themselves. */
export function resolveRoutingForRuntime(input: ResolveRoutingForRuntimeInput): RoutingDecisionReceipt {
  const decision = resolveRoutingDecision(input.request, input.snapshot, input.config);
  if (input.journal !== undefined) {
    appendRoutingJournal(input.journal, {
      kind: input.journal.kind,
      decision,
      ...(input.previousDecisionId === undefined ? {} : { previousDecisionId: input.previousDecisionId }),
      ...(input.fallbackReason === undefined ? {} : { fallbackReason: input.fallbackReason }),
    });
  }
  return {
    receiptId: decision.decisionId,
    decision,
    ...(input.previousDecisionId !== undefined ? { previousDecisionId: input.previousDecisionId } : {}),
    ...(input.fallbackReason !== undefined ? { fallbackReason: input.fallbackReason } : {}),
  };
}

/**
 * Whether a selection receipt id is a routing decision id. Decision ids are the
 * sha256 hex digest `resolveRoutingDecision` assigns; a selection made outside
 * routing (a non-routing fallback) carries a random UUID instead.
 */
export function isRoutingDecisionId(receiptId: string): boolean {
  return /^[0-9a-f]{64}$/.test(receiptId);
}
