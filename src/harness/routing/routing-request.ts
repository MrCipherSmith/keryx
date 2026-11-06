import type { RoutingCategory } from "./table";
import type { ModelClass, ModelRef } from "./model-class";
import type { RoutingAssignment } from "./config";

export const ROUTING_CAPABILITIES = ["tools", "vision", "structured-output"] as const;
export type RoutingCapability = (typeof ROUTING_CAPABILITIES)[number];

export type RoutingOrigin = "operator" | "review" | "subagent" | "unattended" | "native-session";
export type RecommendationSource = "task-signals" | "agent" | "classifier";

export interface RoutingRequirements {
  readonly capabilities: readonly RoutingCapability[];
  readonly inputTokensRequired: number;
  readonly outputTokensReserved: number;
  readonly minimumClass?: ModelClass;
  readonly maxEstimatedCostUsd?: number;
}

export interface RoutingRecommendation {
  readonly modelClass: ModelClass;
  readonly source: RecommendationSource;
  readonly receiptId?: string;
}

export interface RoutingClassificationFailure {
  readonly status: "failed";
  readonly receiptId?: string;
}

export interface RoutingRequest {
  readonly requestId: string;
  readonly parentDecisionId?: string;
  readonly category: RoutingCategory;
  readonly origin: RoutingOrigin;
  readonly baseline: ModelRef;
  readonly requirements: RoutingRequirements;
  readonly userOverride?: RoutingAssignment;
  readonly recommendation?: RoutingRecommendation;
  readonly classification?: RoutingClassificationFailure;
}
