import type { RoutingClassifierAdapter, RoutingClassifierResult } from "./classifier-chain";
import type { BuildRoutingClassifierAdaptersInput } from "./classifier-production";
import type { NormalizedRoutingConfig } from "./config";
import type { ModelProfile } from "./model-profile";
import { RoutingBudgetLedger } from "./routing-budget";
import { runProductionRoutingClassification } from "./routing-classifier-service";
import type { RoutingRequest } from "./routing-request";
import { resolveRoutingForRuntime, type RoutingDecisionReceipt } from "./routing-runtime";
import {
  buildCatalogRoutingSnapshot,
  type RoutingSnapshotPolicy,
} from "./snapshot-adapter";
import type { RoutingSnapshot } from "./snapshot";
import type { FlatPickerProvider } from "./table";
import type { RoutingJournalLocation } from "./routing-journal";

export interface RoutingTurnClassifierPorts {
  readonly adapterInput: Omit<BuildRoutingClassifierAdaptersInput, "config" | "timeoutMs">;
  readonly estimatedCostUsd: (adapter: RoutingClassifierAdapter<string>) => number | null;
  readonly actualCostUsd?: (adapter: RoutingClassifierAdapter<string>) => number | undefined;
}

export interface RouteTurnInput {
  readonly task: string;
  /** Trusted, frozen task identity and requirements supplied by the calling surface. */
  readonly request: RoutingRequest;
  readonly config: NormalizedRoutingConfig;
  readonly providers: readonly FlatPickerProvider[];
  readonly profiles: Readonly<Record<string, ModelProfile>>;
  readonly snapshotMeta: {
    readonly observedAt: string;
    readonly policyRevision: string;
    readonly capabilityRevision: string;
  };
  /** Surface authority is expressed as facts/policy ports, not presentation dependencies. */
  readonly snapshotPolicy: RoutingSnapshotPolicy;
  readonly classifier: RoutingTurnClassifierPorts;
  /** Shadow/preview callers may resolve the trusted request without invoking a classifier. */
  readonly classify?: boolean;
  readonly journal?: RoutingJournalLocation & { readonly kind: "preview" | "dispatch" };
  readonly signal?: AbortSignal;
  /** Remaining time from the caller's single monotonic routing deadline. */
  readonly timeoutMs?: number;
  readonly budget?: RoutingBudgetLedger;
}

export type RouteTurnResult =
  | { readonly status: "cancelled" }
  | {
    readonly status: "ready";
    readonly request: RoutingRequest;
    readonly classification?: RoutingClassifierResult;
    readonly snapshot: RoutingSnapshot;
    readonly budget: RoutingBudgetLedger;
    readonly receipt: RoutingDecisionReceipt;
  };

/**
 * Surface-neutral v2 application service. It is the single owner of the
 * classify -> frozen snapshot -> resolve/journal sequence and of the budget
 * shared by classification and execution.
 */
export async function routeTurn(input: RouteTurnInput): Promise<RouteTurnResult> {
  const budget = input.budget ?? new RoutingBudgetLedger({
    ...(input.request.requirements.maxEstimatedCostUsd === undefined
      ? {}
      : { taskUsd: input.request.requirements.maxEstimatedCostUsd }),
    configUsd: input.config.execution.maxEstimatedCostUsd,
    unknownCost: input.config.execution.unknownCost,
  });
  let request = input.request;
  let classification: RoutingClassifierResult | undefined;
  if (input.classify !== false && input.config.categories[request.category].mode === "auto") {
    const classified = await runProductionRoutingClassification({
      task: input.task,
      request,
      config: input.config,
      budget,
      estimatedCostUsd: input.classifier.estimatedCostUsd,
      ...(input.classifier.actualCostUsd === undefined
        ? {}
        : { actualCostUsd: input.classifier.actualCostUsd }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      adapterInput: input.classifier.adapterInput,
    });
    if (classified.status === "cancelled" || input.signal?.aborted) return { status: "cancelled" };
    request = classified.request;
    classification = classified.classification;
  }
  if (input.signal?.aborted) return { status: "cancelled" };
  const snapshot = buildCatalogRoutingSnapshot({
    configDigest: input.config.configDigest,
    ...input.snapshotMeta,
    baseline: request.baseline,
    providers: input.providers,
    profiles: input.profiles,
    request,
    policy: input.snapshotPolicy,
  });
  const receipt = resolveRoutingForRuntime({
    request,
    snapshot,
    config: input.config,
    ...(classification?.status === "fallback"
      ? { fallbackReason: "classifier-failed" as const }
      : {}),
    ...(input.journal === undefined ? {} : { journal: input.journal }),
  });
  return {
    status: "ready",
    request,
    ...(classification === undefined ? {} : { classification }),
    snapshot,
    budget,
    receipt,
  };
}
