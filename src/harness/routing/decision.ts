import type { ModelClass, ModelRef } from "./model-class";

export type RoutingReason =
  | "policy-denied"
  | "provider-scope-conflict"
  | "credentials-missing"
  | "auth-failed"
  | "model-unavailable"
  | "candidate-unverified"
  | "capability-missing"
  | "context-insufficient"
  | "cooldown"
  | "budget-exceeded"
  | "cost-unknown"
  | "minimum-class-unproven"
  | "class-below-minimum"
  | "empty-class"
  | "classifier-failed"
  | "config-invalid"
  | "attempts-exhausted"
  | "cancelled"
  | "uncertain-outcome";

export type RoutingAssignmentSource = "user-override" | "project" | "user" | "builtin";
export type RoutingRecommendationSource = "none" | "task-signals" | "agent" | "classifier" | "classifier-fallback";
export type RoutingFallbackReason = "candidate-fallback" | "class-escalated" | "class-downgraded" | "pin-fallback" | "classifier-fallback";

export interface RoutingExclusion {
  readonly target?: ModelRef;
  readonly modelClass?: ModelClass;
  readonly reason: RoutingReason;
}

interface RoutingDecisionBase {
  readonly schemaVersion: 2;
  readonly decisionId: string;
  readonly requestId: string;
  readonly parentDecisionId?: string;
  readonly configDigest: string;
  readonly snapshotDigest: string;
  readonly assignmentSource: RoutingAssignmentSource;
  readonly recommendationSource: RoutingRecommendationSource;
  readonly requestedClass?: ModelClass;
  readonly selectedClass?: ModelClass;
  readonly exclusions: readonly RoutingExclusion[];
  readonly classifierReceiptId?: string;
  readonly fallbackReason?: RoutingFallbackReason;
}

export type RoutingDecision =
  | (RoutingDecisionBase & { readonly status: "selected"; readonly selection: ModelRef })
  | (RoutingDecisionBase & { readonly status: "blocked"; readonly reason: RoutingReason })
  | (RoutingDecisionBase & { readonly status: "needs-classification" })
  | (RoutingDecisionBase & { readonly status: "unmanaged" });
