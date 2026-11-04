import { routingV2Digest, type NormalizedRoutingV2Config } from "./config-v2";
import type { RoutingReason } from "./decision";
import { modelRefKey, type ModelRef } from "./model-class";
import { resolveRoutingForRuntime, type RoutingDecisionReceipt } from "./routing-runtime";
import type { RoutingRequest } from "./routing-request";
import type { RoutingModelFacts, RoutingSnapshot } from "./snapshot";
import type { NormalizedEvent, NormalizedRequest, NormalizedUsage, ProviderPort } from "../provider/types";
import { RoutingBudgetLedger } from "./routing-budget";

export interface RoutingExecutionAttempt {
  readonly attemptId: string;
  readonly decisionId: string;
  readonly target: ModelRef;
  readonly outcome: "complete" | "failed" | "cancelled" | "interrupted" | "uncertain";
  readonly reason?: RoutingReason;
  readonly emittedVisibleOutput: boolean;
  readonly emittedToolCall: boolean;
}

export type RoutingExecutionResult =
  | { readonly status: "completed"; readonly receipt: RoutingDecisionReceipt; readonly receipts: readonly RoutingDecisionReceipt[]; readonly attempts: readonly RoutingExecutionAttempt[]; readonly usage?: NormalizedUsage }
  | { readonly status: "blocked"; readonly reason: RoutingReason; readonly receipt: RoutingDecisionReceipt; readonly receipts: readonly RoutingDecisionReceipt[]; readonly attempts: readonly RoutingExecutionAttempt[] }
  | { readonly status: "cancelled"; readonly reason: "cancelled"; readonly receipt: RoutingDecisionReceipt; readonly receipts: readonly RoutingDecisionReceipt[]; readonly attempts: readonly RoutingExecutionAttempt[] }
  | { readonly status: "interrupted"; readonly reason: RoutingReason; readonly receipt: RoutingDecisionReceipt; readonly receipts: readonly RoutingDecisionReceipt[]; readonly attempts: readonly RoutingExecutionAttempt[] };

export interface ExecuteRoutingWithFallbackInput {
  readonly request: RoutingRequest;
  readonly snapshot: RoutingSnapshot;
  readonly config: NormalizedRoutingV2Config;
  readonly providerFor: (target: ModelRef) => ProviderPort;
  readonly buildRequest: (target: ModelRef, attemptId: string) => NormalizedRequest;
  readonly beforeIo?: (target: ModelRef, decisionId: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: RoutingReason }>;
  readonly onEvent?: (event: NormalizedEvent, attempt: { readonly target: ModelRef; readonly decisionId: string }) => void | Promise<void>;
  readonly budget?: RoutingBudgetLedger;
  readonly actualCostUsd?: (input: { readonly target: ModelRef; readonly usage?: NormalizedUsage; readonly estimatedCostUsd: number | null }) => number;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
}

interface RuntimeSnapshotState {
  snapshot: RoutingSnapshot;
  readonly excluded: Set<string>;
}

function factsFor(snapshot: RoutingSnapshot, target: ModelRef): RoutingModelFacts | undefined {
  const key = modelRefKey(target);
  return snapshot.models.find((facts) => modelRefKey(facts.target) === key);
}

function providerReason(event: NormalizedEvent): RoutingReason {
  switch (event.error?.kind) {
    case "authentication": return "auth-failed";
    case "rate_limit": return "cooldown";
    case "unavailable":
    case "overloaded": return "model-unavailable";
    case "context_overflow": return "context-insufficient";
    case "cancelled": return "cancelled";
    default: return "uncertain-outcome";
  }
}

function isConfirmedRetryable(event: NormalizedEvent): boolean {
  if (event.kind !== "provider_error" || event.error === undefined) return false;
  return event.error.kind === "authentication"
    || event.error.kind === "rate_limit"
    || event.error.kind === "overloaded"
    || event.error.kind === "unavailable";
}

function updateRuntimeSnapshot(state: RuntimeSnapshotState, target: ModelRef, reason: RoutingReason): void {
  state.excluded.add(modelRefKey(target));
  const models = state.snapshot.models.map((facts) => {
    const sameTarget = modelRefKey(facts.target) === modelRefKey(target);
    const sameCredential = reason === "auth-failed" && facts.target.providerId === target.providerId;
    if (!sameTarget && !sameCredential) return facts;
    if (sameCredential) return { ...facts, credentialsAvailable: false };
    if (reason === "cooldown") return { ...facts, cooldown: true };
    if (reason === "policy-denied") return { ...facts, policyAllowed: false };
    if (reason === "credentials-missing") return { ...facts, credentialsAvailable: false };
    return { ...facts, availability: "unavailable" as const };
  });
  state.snapshot = {
    ...state.snapshot,
    models,
    snapshotDigest: routingV2Digest({ base: state.snapshot.snapshotDigest, excluded: [...state.excluded].sort(), reason }),
  };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function reconcileBudget(
  input: ExecuteRoutingWithFallbackInput,
  budget: RoutingBudgetLedger,
  reservationId: string | undefined,
  target: ModelRef,
  usage: NormalizedUsage | undefined,
  estimate: number | null,
): void {
  if (reservationId === undefined) return;
  let actual = estimate ?? 0;
  if (input.actualCostUsd !== undefined) {
    try {
      actual = input.actualCostUsd({ target, ...(usage !== undefined ? { usage } : {}), estimatedCostUsd: estimate });
    } catch {
      // A metering adapter failure must not release consumed capacity.
    }
  }
  if (!Number.isFinite(actual) || actual < 0) actual = estimate ?? 0;
  budget.reconcile(reservationId, actual);
}

function terminal(
  status: "blocked" | "cancelled" | "interrupted",
  reason: RoutingReason,
  receipt: RoutingDecisionReceipt,
  receipts: readonly RoutingDecisionReceipt[],
  attempts: readonly RoutingExecutionAttempt[],
): RoutingExecutionResult {
  if (status === "cancelled") return { status, reason: "cancelled", receipt, receipts, attempts };
  if (status === "blocked") return { status, reason, receipt, receipts, attempts };
  return { status: "interrupted", reason, receipt, receipts, attempts };
}

/**
 * Executes frozen decisions and re-resolves only after a confirmed, replay-safe
 * failure. Output, tool-call activity, cancellation, and uncertain transport
 * outcomes are terminal and never invoke fallback.
 */
export async function executeRoutingWithFallback(input: ExecuteRoutingWithFallbackInput): Promise<RoutingExecutionResult> {
  const maxAttempts = input.maxAttempts ?? input.config.execution.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("routing maxAttempts must be an integer from 1 to 10");
  const budget = input.budget ?? new RoutingBudgetLedger({
    ...(input.request.requirements.maxEstimatedCostUsd === undefined ? {} : { taskUsd: input.request.requirements.maxEstimatedCostUsd }),
    configUsd: input.config.execution.maxEstimatedCostUsd,
    unknownCost: input.config.execution.unknownCost,
  });
  const state: RuntimeSnapshotState = { snapshot: input.snapshot, excluded: new Set() };
  const attempts: RoutingExecutionAttempt[] = [];
  const receipts: RoutingDecisionReceipt[] = [];
  let receipt = resolveRoutingForRuntime({ request: input.request, snapshot: state.snapshot, config: input.config });
  receipts.push(receipt);

  while (true) {
    if (input.signal?.aborted) return terminal("cancelled", "cancelled", receipt, receipts, attempts);
    if (receipt.decision.status !== "selected") {
      const reason = receipt.decision.status === "blocked" ? receipt.decision.reason : "classifier-failed";
      return terminal("blocked", reason, receipt, receipts, attempts);
    }
    if (attempts.length >= maxAttempts) return terminal("blocked", "attempts-exhausted", receipt, receipts, attempts);

    const target = receipt.decision.selection;
    const key = modelRefKey(target);
    if (state.excluded.has(key)) return terminal("blocked", "attempts-exhausted", receipt, receipts, attempts);
    if (input.beforeIo !== undefined) {
      let check: { readonly ok: true } | { readonly ok: false; readonly reason: RoutingReason };
      try {
        check = await input.beforeIo(target, receipt.decision.decisionId);
      } catch {
        return terminal("blocked", "config-invalid", receipt, receipts, attempts);
      }
      if (!check.ok) {
        const previousDecisionId = receipt.decision.decisionId;
        updateRuntimeSnapshot(state, target, check.reason);
        receipt = resolveRoutingForRuntime({ request: input.request, snapshot: state.snapshot, config: input.config, previousDecisionId, fallbackReason: check.reason });
        receipts.push(receipt);
        continue;
      }
    }

    const facts = factsFor(state.snapshot, target);
    const estimate = facts?.estimatedCostUsd ?? null;
    const reserved = budget.reserve({ estimatedCostUsd: estimate, purpose: "execution" });
    if (!reserved.ok) {
      const previousDecisionId = receipt.decision.decisionId;
      updateRuntimeSnapshot(state, target, reserved.reason);
      receipt = resolveRoutingForRuntime({ request: input.request, snapshot: state.snapshot, config: input.config, previousDecisionId, fallbackReason: reserved.reason });
      receipts.push(receipt);
      continue;
    }
    const reservationId = reserved.reservation.id;
    const attemptId = `${input.request.requestId}:routing:${attempts.length + 1}`;
    let request: NormalizedRequest;
    let provider: ProviderPort;
    try {
      request = { ...input.buildRequest(target, attemptId), providerId: target.providerId, modelId: target.modelId, ...(input.signal !== undefined ? { signal: input.signal } : {}) };
      provider = input.providerFor(target);
    } catch {
      budget.release(reservationId);
      return terminal("blocked", "config-invalid", receipt, receipts, attempts);
    }
    if (input.signal?.aborted) {
      budget.release(reservationId);
      return terminal("cancelled", "cancelled", receipt, receipts, attempts);
    }

    let visible = false;
    let toolCall = false;
    let usage: NormalizedUsage | undefined;
    let providerError: NormalizedEvent | undefined;
    let completed = false;
    let iterator: AsyncIterator<NormalizedEvent>;
    try {
      iterator = provider.stream(request, { attemptId, ...(input.signal !== undefined ? { signal: input.signal } : {}) })[Symbol.asyncIterator]();
    } catch {
      reconcileBudget(input, budget, reservationId, target, usage, estimate);
      attempts.push({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "uncertain", reason: "uncertain-outcome", emittedVisibleOutput: false, emittedToolCall: false });
      return terminal("interrupted", "uncertain-outcome", receipt, receipts, attempts);
    }
    const cancellation = input.signal === undefined ? undefined : abortPromise(input.signal);
    try {
      while (true) {
        const item = cancellation === undefined ? await iterator.next() : await Promise.race([iterator.next(), cancellation]);
        if (item.done) break;
        const event = item.value;
        if ((event.kind === "text_delta" || event.kind === "reasoning_delta") && (event.text?.length ?? 0) > 0) visible = true;
        if (event.kind === "tool_call_start" || event.kind === "tool_call_delta" || event.kind === "tool_call_end") toolCall = true;
        if (event.kind === "usage_update" && event.usage !== undefined) usage = event.usage;
        await input.onEvent?.(event, { target, decisionId: receipt.decision.decisionId });
        if (event.kind === "model_end") {
          completed = true;
          break;
        }
        if (event.kind === "provider_error") {
          providerError = event;
          break;
        }
      }
    } catch {
      try {
        await iterator.return?.();
      } catch {
        // The original outcome is already uncertain; iterator cleanup cannot make replay safe.
      }
      reconcileBudget(input, budget, reservationId, target, usage, estimate);
      if (input.signal?.aborted) {
        attempts.push({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "cancelled", reason: "cancelled", emittedVisibleOutput: visible, emittedToolCall: toolCall });
        return terminal("cancelled", "cancelled", receipt, receipts, attempts);
      }
      attempts.push({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: visible || toolCall ? "interrupted" : "uncertain", reason: "uncertain-outcome", emittedVisibleOutput: visible, emittedToolCall: toolCall });
      return terminal("interrupted", "uncertain-outcome", receipt, receipts, attempts);
    }

    reconcileBudget(input, budget, reservationId, target, usage, estimate);
    if (completed) {
      attempts.push({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "complete", emittedVisibleOutput: visible, emittedToolCall: toolCall });
      return { status: "completed", receipt, receipts, attempts, ...(usage !== undefined ? { usage } : {}) };
    }
    if (input.signal?.aborted) {
      attempts.push({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "cancelled", reason: "cancelled", emittedVisibleOutput: visible, emittedToolCall: toolCall });
      return terminal("cancelled", "cancelled", receipt, receipts, attempts);
    }
    if (providerError === undefined) {
      attempts.push({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: visible || toolCall ? "interrupted" : "uncertain", reason: "uncertain-outcome", emittedVisibleOutput: visible, emittedToolCall: toolCall });
      return terminal("interrupted", "uncertain-outcome", receipt, receipts, attempts);
    }

    const reason = providerReason(providerError);
    if (reason === "cancelled") {
      attempts.push({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "cancelled", reason, emittedVisibleOutput: visible, emittedToolCall: toolCall });
      return terminal("cancelled", "cancelled", receipt, receipts, attempts);
    }
    if (visible || toolCall || !isConfirmedRetryable(providerError)) {
      attempts.push({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "interrupted", reason, emittedVisibleOutput: visible, emittedToolCall: toolCall });
      return terminal("interrupted", reason, receipt, receipts, attempts);
    }

    attempts.push({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "failed", reason, emittedVisibleOutput: false, emittedToolCall: false });
    const previousDecisionId = receipt.decision.decisionId;
    updateRuntimeSnapshot(state, target, reason);
    receipt = resolveRoutingForRuntime({ request: input.request, snapshot: state.snapshot, config: input.config, previousDecisionId, fallbackReason: reason });
    receipts.push(receipt);
  }
}
