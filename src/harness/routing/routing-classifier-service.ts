import { buildRoutingClassifierAdapters, type BuildRoutingClassifierAdaptersInput } from "./classifier-production-v2";
import {
  runRoutingClassifierChain,
  type RoutingClassifierAdapter,
  type RoutingClassifierResult,
} from "./classifier-chain-v2";
import type { NormalizedRoutingV2Config } from "./config-v2";
import { routingV2Digest } from "./config-v2";
import type { RoutingBudgetLedger } from "./routing-budget";
import { applyRoutingClassificationResult } from "./routing-classification-runtime";
import type { RoutingRequest } from "./routing-request";

export type RoutingClassificationServiceResult =
  | { readonly status: "ready"; readonly request: RoutingRequest; readonly classification: RoutingClassifierResult }
  | { readonly status: "cancelled"; readonly reason: "cancelled"; readonly classification: RoutingClassifierResult };

export interface RunRoutingClassificationInput {
  readonly task: string;
  readonly request: RoutingRequest;
  readonly config: NormalizedRoutingV2Config;
  readonly adapters: readonly RoutingClassifierAdapter<string>[];
  readonly budget: RoutingBudgetLedger;
  readonly estimatedCostUsd: (adapter: RoutingClassifierAdapter<string>) => number | null;
  readonly actualCostUsd?: (adapter: RoutingClassifierAdapter<string>) => number | undefined;
  readonly signal?: AbortSignal;
  /** Caller-owned remaining time from a larger monotonic routing deadline. */
  readonly timeoutMs?: number;
}

/** Canonical classify-once path used by every v2 consumer. */
export async function runRoutingClassification(input: RunRoutingClassificationInput): Promise<RoutingClassificationServiceResult> {
  const expectedAdapterIds = input.config.classifier.chain.map((entry) => entry.adapterId);
  const actualAdapterIds = input.adapters.map((adapter) => adapter.id);
  if (expectedAdapterIds.length !== actualAdapterIds.length || expectedAdapterIds.some((id, index) => id !== actualAdapterIds[index])) {
    throw new Error("routing classifier adapters do not match the normalized config chain");
  }
  const timeoutMs = Math.max(1, Math.floor(Math.min(input.config.classifier.timeoutMs, input.timeoutMs ?? Number.POSITIVE_INFINITY)));
  const classification = await runRoutingClassifierChain(input.task, {
    adapters: input.adapters,
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
      requirementsDigest: routingV2Digest(input.request.requirements),
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
  const timeoutMs = Math.max(1, Math.floor(Math.min(input.config.classifier.timeoutMs, input.timeoutMs ?? Number.POSITIVE_INFINITY)));
  const adapters = buildRoutingClassifierAdapters({
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
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
}
