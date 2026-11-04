import type { NormalizedRoutingV2Config } from "./config-v2";
import type { RoutingDecision, RoutingReason } from "./decision";
import { resolveRoutingDecision } from "./resolver";
import type { RoutingRequest } from "./routing-request";
import type { RoutingSnapshot } from "./snapshot";

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
  readonly config: NormalizedRoutingV2Config;
  readonly previousDecisionId?: string;
  readonly fallbackReason?: RoutingReason;
}

/** Shared runtime entry point; callers do not implement selected/blocked precedence themselves. */
export function resolveRoutingForRuntime(input: ResolveRoutingForRuntimeInput): RoutingDecisionReceipt {
  const decision = resolveRoutingDecision(input.request, input.snapshot, input.config);
  return {
    receiptId: decision.decisionId,
    decision,
    ...(input.previousDecisionId !== undefined ? { previousDecisionId: input.previousDecisionId } : {}),
    ...(input.fallbackReason !== undefined ? { fallbackReason: input.fallbackReason } : {}),
  };
}
