import type { RoutingClassifierResult } from "./classifier-chain-v2";
import type { RoutingRequest } from "./routing-request";

export type ApplyRoutingClassificationResult =
  | { readonly status: "ready"; readonly request: RoutingRequest }
  | { readonly status: "cancelled"; readonly reason: "cancelled" };

/**
 * Applies a strict classifier result without weakening trusted caller facts.
 * A known category is immutable; only `default` is treated as unclassified.
 */
export function applyRoutingClassificationResult(
  request: RoutingRequest,
  result: RoutingClassifierResult,
): ApplyRoutingClassificationResult {
  if (result.status === "cancelled") return { status: "cancelled", reason: "cancelled" };
  if (result.status === "fallback") {
    return { status: "ready", request: { ...request, classification: { status: "failed", receiptId: result.receiptId } } };
  }
  const capabilities = [...new Set([...request.requirements.capabilities, ...result.classification.requiredCapabilities])];
  return {
    status: "ready",
    request: {
      ...request,
      category: request.category === "default" ? result.classification.category : request.category,
      requirements: { ...request.requirements, capabilities },
      recommendation: { modelClass: result.classification.modelClass, source: "classifier", receiptId: result.receiptId },
    },
  };
}
