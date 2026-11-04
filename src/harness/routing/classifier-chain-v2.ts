import type { ModelClass } from "./model-class";
import type { RoutingBudgetLedger } from "./routing-budget";
import { routingV2Digest } from "./config-v2";

export type RoutingCategory = "default" | "review" | "subagents" | "quick" | "coding" | "planning" | "docs" | "unattended";
export type RoutingCapability = "tools" | "vision" | "structured-output";

export interface RoutingClassification {
  readonly category: RoutingCategory;
  readonly modelClass: ModelClass;
  readonly confidence: number;
  readonly reasonCode: string;
  readonly requiredCapabilities: readonly RoutingCapability[];
}

export interface RoutingClassifierAdapter<Input = unknown> {
  readonly id: string;
  classify(input: Input, context: { readonly signal: AbortSignal }): Promise<unknown>;
}

export type ClassifierFallbackAssignment =
  | { readonly mode: "baseline"; readonly fallbackClass?: ModelClass }
  | { readonly mode: "class"; readonly modelClass: ModelClass }
  | { readonly mode: "model"; readonly target: { readonly providerId: string; readonly modelId: string }; readonly fallbackClass?: ModelClass };

export interface ClassificationTraceEntry {
  readonly adapterId: string;
  readonly outcome: "accepted" | "low-confidence" | "invalid" | "failed" | "timeout" | "cancelled" | "budget-exceeded" | "cost-unknown";
  readonly confidence?: number;
}

export type RoutingClassifierResult =
  | { readonly status: "classified"; readonly classification: RoutingClassification; readonly adapterId: string; readonly receiptId: string; readonly trace: readonly ClassificationTraceEntry[] }
  | { readonly status: "fallback"; readonly assignment: ClassifierFallbackAssignment; readonly reason: "classifier-failed"; readonly receiptId: string; readonly trace: readonly ClassificationTraceEntry[] }
  | { readonly status: "cancelled"; readonly reason: "cancelled"; readonly trace: readonly ClassificationTraceEntry[] };

export interface RunRoutingClassifierChainOptions<Input> {
  readonly adapters: readonly RoutingClassifierAdapter<Input>[];
  readonly deadlineMs?: number;
  readonly minConfidence: number;
  readonly onFailure: ClassifierFallbackAssignment;
  readonly signal?: AbortSignal;
  readonly budget?: RoutingBudgetLedger;
  readonly estimatedCostUsd?: (adapter: RoutingClassifierAdapter<Input>) => number | null;
  /** Provider usage reconciler; undefined keeps the conservative reservation amount. */
  readonly actualCostUsd?: (adapter: RoutingClassifierAdapter<Input>) => number | undefined;
  /** Stable, non-secret identities that bind the receipt to its routing request/config. */
  readonly receiptContext?: {
    readonly receiptVersion: 1;
    readonly requestId: string;
    readonly configDigest: string;
    readonly requirementsDigest: string;
  };
}

const CATEGORIES = new Set<RoutingCategory>(["default", "review", "subagents", "quick", "coding", "planning", "docs", "unattended"]);
const MODEL_CLASSES = new Set<ModelClass>(["light", "standard", "expert", "frontier"]);
const CAPABILITIES = new Set<RoutingCapability>(["tools", "vision", "structured-output"]);
const CLASSIFICATION_KEYS = new Set(["category", "modelClass", "confidence", "reasonCode", "requiredCapabilities"]);

export function parseRoutingClassification(value: unknown): RoutingClassification | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !CLASSIFICATION_KEYS.has(key))) return undefined;
  if (!CATEGORIES.has(record.category as RoutingCategory) || !MODEL_CLASSES.has(record.modelClass as ModelClass)) return undefined;
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) return undefined;
  if (typeof record.reasonCode !== "string" || record.reasonCode.length < 1 || record.reasonCode.length > 240) return undefined;
  if (!Array.isArray(record.requiredCapabilities)) return undefined;
  if (record.requiredCapabilities.some((capability) => !CAPABILITIES.has(capability as RoutingCapability))) return undefined;
  if (new Set(record.requiredCapabilities).size !== record.requiredCapabilities.length) return undefined;
  return {
    category: record.category as RoutingCategory,
    modelClass: record.modelClass as ModelClass,
    confidence: record.confidence,
    reasonCode: record.reasonCode,
    requiredCapabilities: record.requiredCapabilities as RoutingCapability[],
  };
}

function cancelled(trace: readonly ClassificationTraceEntry[]): RoutingClassifierResult {
  return { status: "cancelled", reason: "cancelled", trace };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** Runs at most three classifiers once each under one aggregate deadline. */
export async function runRoutingClassifierChain<Input>(input: Input, options: RunRoutingClassifierChainOptions<Input>): Promise<RoutingClassifierResult> {
  const deadlineMs = options.deadlineMs ?? 3_000;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) throw new Error("classifier deadlineMs must be an integer from 1 to 30000");
  if (!Number.isFinite(options.minConfidence) || options.minConfidence < 0 || options.minConfidence > 1) throw new Error("classifier minConfidence must be from 0 to 1");
  if (options.adapters.length > 3) throw new Error("classifier chain supports at most three adapters");
  const adapterIds = options.adapters.map((adapter) => adapter.id);
  if (adapterIds.some((id) => id.length === 0) || new Set(adapterIds).size !== adapterIds.length) throw new Error("classifier adapter ids must be non-empty and unique");

  const trace: ClassificationTraceEntry[] = [];
  const receiptBinding = {
    inputDigest: routingV2Digest(input),
    adapterIds,
    deadlineMs,
    minConfidence: options.minConfidence,
    onFailure: options.onFailure,
    ...(options.receiptContext === undefined ? {} : { context: options.receiptContext }),
  };
  if (options.signal?.aborted) return cancelled(trace);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let deadlineReached = false;
  const timer = setTimeout(() => {
    deadlineReached = true;
    controller.abort(new Error("classifier deadline exceeded"));
  }, deadlineMs);

  try {
    for (const adapter of options.adapters) {
      if (options.signal?.aborted) return cancelled(trace);
      const estimatedCostUsd = options.estimatedCostUsd?.(adapter) ?? null;
      const reserved = options.budget?.reserve({ estimatedCostUsd, purpose: "classifier" });
      if (reserved !== undefined && !reserved.ok) {
        trace.push({ adapterId: adapter.id, outcome: reserved.reason });
        continue;
      }
      try {
        try {
          const raw = await Promise.race([adapter.classify(input, { signal: controller.signal }), abortPromise(controller.signal)]);
          if (options.signal?.aborted) {
            trace.push({ adapterId: adapter.id, outcome: "cancelled" });
            return cancelled(trace);
          }
          if (deadlineReached) {
            trace.push({ adapterId: adapter.id, outcome: "timeout" });
            break;
          }
          const classification = parseRoutingClassification(raw);
          if (classification === undefined) {
            trace.push({ adapterId: adapter.id, outcome: "invalid" });
            continue;
          }
          if (classification.confidence < options.minConfidence) {
            trace.push({ adapterId: adapter.id, outcome: "low-confidence", confidence: classification.confidence });
            continue;
          }
          trace.push({ adapterId: adapter.id, outcome: "accepted", confidence: classification.confidence });
          return {
            status: "classified",
            classification,
            adapterId: adapter.id,
            receiptId: routingV2Digest({ ...receiptBinding, adapterId: adapter.id, classification, trace }),
            trace,
          };
        } catch {
          if (options.signal?.aborted) {
            trace.push({ adapterId: adapter.id, outcome: "cancelled" });
            return cancelled(trace);
          }
          if (deadlineReached) {
            trace.push({ adapterId: adapter.id, outcome: "timeout" });
            break;
          }
          trace.push({ adapterId: adapter.id, outcome: "failed" });
        }
      } finally {
        if (reserved?.ok === true && options.budget !== undefined) {
          let actualCostUsd = estimatedCostUsd ?? 0;
          try {
            const reported = options.actualCostUsd?.(adapter);
            if (reported !== undefined && Number.isFinite(reported) && reported >= 0) actualCostUsd = reported;
          } catch {
            // Keep the conservative reservation when metering cannot be read.
          }
          options.budget.reconcile(reserved.reservation.id, actualCostUsd);
        }
      }
    }
    return {
      status: "fallback",
      assignment: options.onFailure,
      reason: "classifier-failed",
      receiptId: routingV2Digest({ ...receiptBinding, assignment: options.onFailure, reason: "classifier-failed", trace }),
      trace,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
