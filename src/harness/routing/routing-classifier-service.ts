import { buildRoutingClassifierAdapters, type BuildRoutingClassifierAdaptersInput } from "./classifier-production";
import {
  runRoutingClassifierChain,
  type RoutingClassifierAdapter,
  type RoutingClassifierResult,
} from "./classifier-chain";
import type { NormalizedRoutingConfig } from "./config";
import { routingDigest } from "./config";
import type { RoutingBudgetLedger } from "./routing-budget";
import { applyRoutingClassificationResult } from "./routing-classification-runtime";
import type { RoutingRequest } from "./routing-request";

export type RoutingClassificationServiceResult =
  | { readonly status: "ready"; readonly request: RoutingRequest; readonly classification: RoutingClassifierResult }
  | { readonly status: "cancelled"; readonly reason: "cancelled"; readonly classification: RoutingClassifierResult };

export interface RunRoutingClassificationInput {
  readonly task: string;
  readonly request: RoutingRequest;
  readonly config: NormalizedRoutingConfig;
  readonly adapters: readonly RoutingClassifierAdapter<string>[];
  readonly budget: RoutingBudgetLedger;
  readonly estimatedCostUsd: (adapter: RoutingClassifierAdapter<string>) => number | null;
  readonly actualCostUsd?: (adapter: RoutingClassifierAdapter<string>) => number | undefined;
  readonly signal?: AbortSignal;
  /** Caller-owned remaining time from a larger monotonic routing deadline. */
  readonly timeoutMs?: number;
}

function classifierTimeoutMs(input: Pick<RunRoutingClassificationInput, "config" | "timeoutMs">): number {
  const remainingMs = Math.min(input.config.classifier.timeoutMs, input.timeoutMs ?? Number.POSITIVE_INFINITY);
  return remainingMs <= 0 ? 0 : Math.max(1, Math.floor(remainingMs));
}

/** Canonical classify-once path used by every v2 consumer. */
export async function runRoutingClassification(input: RunRoutingClassificationInput): Promise<RoutingClassificationServiceResult> {
  const timeoutMs = classifierTimeoutMs(input);
  const adapters = timeoutMs === 0 ? [] : input.adapters;
  if (timeoutMs > 0) {
    const expectedAdapterIds = input.config.classifier.chain.map((entry) => entry.adapterId);
    if (expectedAdapterIds.length !== adapters.length || expectedAdapterIds.some((id, index) => id !== adapters[index]?.id)) {
      throw new Error("routing classifier adapters do not match the normalized config chain");
    }
  }
  const classification = await runRoutingClassifierChain(input.task, {
    adapters,
    deadlineMs: timeoutMs,
    minConfidence: input.config.classifier.minConfidence,
    onFailure: input.config.classifier.onFailure,
    budget: input.budget,
    estimatedCostUsd: input.estimatedCostUsd,
    ...(input.actualCostUsd === undefined ? {} : { actualCostUsd: input.actualCostUsd }),
    receiptContext: {
      receiptVersion: 1,
      requestId: input.request.requestId,
      configDigest: input.config.configDigest,
      requirementsDigest: routingDigest(input.request.requirements),
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const applied = applyRoutingClassificationResult(input.request, classification);
  if (applied.status === "cancelled") return { ...applied, classification };
  return { status: "ready", request: applied.request, classification };
}

export interface RunProductionRoutingClassificationInput
  extends Omit<RunRoutingClassificationInput, "adapters"> {
  readonly adapterInput: Omit<BuildRoutingClassifierAdaptersInput, "config" | "timeoutMs">;
}

/** Production registry/factory wrapper; consumers never construct adapters themselves. */
export async function runProductionRoutingClassification(
  input: RunProductionRoutingClassificationInput,
): Promise<RoutingClassificationServiceResult> {
  const timeoutMs = classifierTimeoutMs(input);
  const adapters = timeoutMs === 0 ? [] : buildRoutingClassifierAdapters({
    ...input.adapterInput,
    config: input.config,
    timeoutMs,
  });
  return runRoutingClassification({
    task: input.task,
    request: input.request,
    config: input.config,
    adapters,
    budget: input.budget,
    estimatedCostUsd: input.estimatedCostUsd,
    ...(input.actualCostUsd === undefined ? {} : { actualCostUsd: input.actualCostUsd }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    timeoutMs,
  });
}
