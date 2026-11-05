import type { NormalizedRoutingV2Config } from "./config-v2";
import type { RoutingReason } from "./decision";
import { modelRefKey, type ModelRef } from "./model-class";
import { resolveRoutingForRuntime, type RoutingDecisionReceipt } from "./routing-runtime";
import type { RoutingRequest } from "./routing-request";
import { createRoutingSnapshot, type RoutingModelFacts, type RoutingSnapshot } from "./snapshot";
import type { NormalizedEvent, NormalizedRequest, NormalizedUsage, ProviderPort } from "../provider/types";
import type { RoutingBudgetLedger } from "./routing-budget";
import { appendRoutingJournal, type RoutingJournalLocation } from "./routing-journal";
import type { RoutingFailureRegistry } from "./routing-failure-registry";

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
  readonly beforeIo: (
    target: ModelRef,
    decisionId: string,
    context: { readonly signal: AbortSignal },
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: RoutingReason }>;
  readonly onEvent?: (event: NormalizedEvent, attempt: { readonly target: ModelRef; readonly decisionId: string }) => void | Promise<void>;
  /** One root-task ledger shared by classifier, parent, and every child attempt. */
  readonly budget: RoutingBudgetLedger;
  readonly actualCostUsd?: (input: { readonly target: ModelRef; readonly usage?: NormalizedUsage; readonly estimatedCostUsd: number | null }) => number;
  readonly onAttemptSettled?: (event: RoutingExecutionAttempt & { readonly usage?: NormalizedUsage }) => void;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
  readonly streamTimeoutMs?: number;
  /** Remaining aggregate selection budget when an outer snapshot builder already consumed time. */
  readonly selectionTimeoutMs?: number;
  readonly journal?: RoutingJournalLocation;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly failureRegistry?: RoutingFailureRegistry;
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
  if (event.error?.detail?.modelNotFound === true) return "model-unavailable";
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
  if (event.error.detail?.modelNotFound === true) return true;
  return event.error.kind === "authentication"
    || event.error.kind === "rate_limit"
    || event.error.kind === "overloaded"
    || event.error.kind === "unavailable";
}

function updateRuntimeSnapshot(state: RuntimeSnapshotState, target: ModelRef, reason: RoutingReason, observedAt: string): void {
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
  const authFailedProviderIds = reason === "auth-failed"
    ? [...new Set([...state.snapshot.authFailedProviderIds, target.providerId])]
    : state.snapshot.authFailedProviderIds;
  state.snapshot = createRoutingSnapshot({
    configDigest: state.snapshot.configDigest,
    observedAt,
    catalogRevision: state.snapshot.catalogRevision,
    policyRevision: state.snapshot.policyRevision,
    capabilityRevision: state.snapshot.capabilityRevision,
    authFailedProviderIds,
    baseline: state.snapshot.baseline,
    models,
  });
}

/** Select a candidate whose model-specific dependencies can be built before a turn starts. */
export async function prepareRoutingCandidate<T>(
  input: Pick<ExecuteRoutingWithFallbackInput, "request" | "snapshot" | "config" | "journal"> & {
    readonly receipt: RoutingDecisionReceipt;
    readonly signal: AbortSignal;
    /** Remaining selection budget supplied by an outer classifier/resolver. */
    readonly selectionTimeoutMs?: number;
    readonly prepare: (target: ModelRef, decisionId: string, signal: AbortSignal) => Promise<
      { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: RoutingReason }
    >;
  },
): Promise<
  { readonly ok: true; readonly value: T; readonly target: ModelRef; readonly receipt: RoutingDecisionReceipt }
  | { readonly ok: false; readonly reason: RoutingReason }
> {
  const state: RuntimeSnapshotState = { snapshot: input.snapshot, excluded: new Set() };
  const requestedSelectionTimeoutMs = input.selectionTimeoutMs;
  const selectionTimeoutMs = requestedSelectionTimeoutMs === undefined
    ? input.config.execution.selectionTimeoutMs
    : Number.isFinite(requestedSelectionTimeoutMs)
      ? Math.max(0, Math.ceil(Math.min(input.config.execution.selectionTimeoutMs, requestedSelectionTimeoutMs)))
      : 0;
  if (input.signal.aborted) return { ok: false, reason: "cancelled" };
  if (selectionTimeoutMs <= 0) return { ok: false, reason: "uncertain-outcome" };
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(selectionTimeoutMs)]);
  let receipt = input.receipt;
  for (let attempt = 0; attempt < input.config.execution.maxAttempts; attempt += 1) {
    if (signal.aborted) return { ok: false, reason: input.signal.aborted ? "cancelled" : "uncertain-outcome" };
    if (receipt.decision.status !== "selected") {
      return { ok: false, reason: receipt.decision.status === "blocked" ? receipt.decision.reason : "classifier-failed" };
    }
    const { selection: target, decisionId } = receipt.decision;
    let prepared;
    try {
      prepared = await Promise.race([input.prepare(target, decisionId, signal), abortPromise(signal)]);
    } catch {
      return { ok: false, reason: input.signal.aborted ? "cancelled" : signal.aborted ? "uncertain-outcome" : "config-invalid" };
    }
    if (signal.aborted) return { ok: false, reason: input.signal.aborted ? "cancelled" : "uncertain-outcome" };
    if (prepared.ok) return { ...prepared, target, receipt };
    if (prepared.reason === "cancelled" || prepared.reason === "config-invalid") return prepared;
    if (attempt + 1 >= input.config.execution.maxAttempts) return { ok: false, reason: "attempts-exhausted" };
    updateRuntimeSnapshot(state, target, prepared.reason, state.snapshot.observedAt);
    try {
      receipt = resolveRoutingForRuntime({
        request: input.request,
        snapshot: state.snapshot,
        config: input.config,
        previousDecisionId: decisionId,
        fallbackReason: prepared.reason,
        ...(input.journal === undefined ? {} : { journal: { ...input.journal, kind: "dispatch" } }),
      });
    } catch {
      return { ok: false, reason: "config-invalid" };
    }
  }
  return { ok: false, reason: "attempts-exhausted" };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

type RevalidationResult =
  | { readonly status: "ok" }
  | { readonly status: "rejected"; readonly reason: RoutingReason }
  | { readonly status: "cancelled" }
  | { readonly status: "timeout" }
  | { readonly status: "error" };

async function revalidateBeforeIo(
  input: ExecuteRoutingWithFallbackInput,
  target: ModelRef,
  decisionId: string,
  timeoutMs: number,
): Promise<RevalidationResult> {
  if (input.signal?.aborted) return { status: "cancelled" };
  if (timeoutMs <= 0) return { status: "timeout" };
  const controller = new AbortController();
  const cancel = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("routing selection timeout"));
  }, timeoutMs);
  try {
    const result = await Promise.race([
      input.beforeIo(target, decisionId, { signal: controller.signal }),
      abortPromise(controller.signal),
    ]);
    if (input.signal?.aborted) return { status: "cancelled" };
    if (timedOut) return { status: "timeout" };
    return result.ok ? { status: "ok" } : { status: "rejected", reason: result.reason };
  } catch {
    if (input.signal?.aborted) return { status: "cancelled" };
    return timedOut ? { status: "timeout" } : { status: "error" };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
  }
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

function journalAttempt(
  input: ExecuteRoutingWithFallbackInput,
  decisionId: string,
  attempt: number,
  outcome: "started" | "completed" | "rejected" | "interrupted" | "cancelled",
  usage?: NormalizedUsage,
): void {
  if (input.journal === undefined) return;
  appendRoutingJournal(input.journal, {
    kind: "attempt",
    decisionId,
    attempt,
    outcome,
    ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  });
}

/**
 * Executes frozen decisions and re-resolves only after a confirmed, replay-safe
 * failure. Output, tool-call activity, cancellation, and uncertain transport
 * outcomes are terminal and never invoke fallback.
 */
export async function executeRoutingWithFallback(input: ExecuteRoutingWithFallbackInput): Promise<RoutingExecutionResult> {
  const maxAttempts = input.maxAttempts ?? input.config.execution.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("routing maxAttempts must be an integer from 1 to 10");
  const budget = input.budget;
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const selectionTimeoutMs = input.selectionTimeoutMs ?? input.config.execution.selectionTimeoutMs;
  let selectionDeadlineMs = monotonicNow() + Math.max(0, selectionTimeoutMs);
  const selectionRemainingMs = (): number => Math.max(0, selectionDeadlineMs - monotonicNow());
  const selectionExpired = (): boolean => selectionRemainingMs() <= 0;
  const state: RuntimeSnapshotState = { snapshot: input.snapshot, excluded: new Set() };
  const attempts: RoutingExecutionAttempt[] = [];
  const receipts: RoutingDecisionReceipt[] = [];
  let receipt = resolveRoutingForRuntime({
    request: input.request,
    snapshot: state.snapshot,
    config: input.config,
    ...(input.journal === undefined ? {} : { journal: { ...input.journal, kind: "dispatch" as const } }),
  });
  receipts.push(receipt);
  if (selectionExpired()) return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);

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
    const selectionAllowanceMs = selectionRemainingMs();
    let revalidation = await revalidateBeforeIo(input, target, receipt.decision.decisionId, selectionAllowanceMs);
    if (selectionExpired() && revalidation.status !== "cancelled") revalidation = { status: "timeout" };
    if (revalidation.status === "cancelled") return terminal("cancelled", "cancelled", receipt, receipts, attempts);
    if (revalidation.status === "timeout") return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);
    if (revalidation.status === "error") return terminal("blocked", "config-invalid", receipt, receipts, attempts);
    if (revalidation.status === "rejected") {
      const previousDecisionId = receipt.decision.decisionId;
      updateRuntimeSnapshot(state, target, revalidation.reason, (input.now?.() ?? new Date()).toISOString());
      if (selectionExpired()) return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);
      receipt = resolveRoutingForRuntime({ request: input.request, snapshot: state.snapshot, config: input.config, previousDecisionId, fallbackReason: revalidation.reason, ...(input.journal === undefined ? {} : { journal: { ...input.journal, kind: "dispatch" as const } }) });
      receipts.push(receipt);
      if (selectionExpired()) return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);
      continue;
    }

    const facts = factsFor(state.snapshot, target);
    if (selectionExpired()) return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);
    const estimate = facts?.estimatedCostUsd ?? null;
    const reserved = budget.reserve({ estimatedCostUsd: estimate, purpose: "execution" });
    if (selectionExpired()) {
      if (reserved.ok) budget.release(reserved.reservation.id);
      return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);
    }
    if (!reserved.ok) {
      const previousDecisionId = receipt.decision.decisionId;
      updateRuntimeSnapshot(state, target, reserved.reason, (input.now?.() ?? new Date()).toISOString());
      if (selectionExpired()) return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);
      receipt = resolveRoutingForRuntime({ request: input.request, snapshot: state.snapshot, config: input.config, previousDecisionId, fallbackReason: reserved.reason, ...(input.journal === undefined ? {} : { journal: { ...input.journal, kind: "dispatch" as const } }) });
      receipts.push(receipt);
      if (selectionExpired()) return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);
      continue;
    }
    const reservationId = reserved.reservation.id;
    const attemptNumber = attempts.length + 1;
    const attemptId = `${input.request.requestId}:routing:${attemptNumber}`;
    let request: NormalizedRequest;
    let provider: ProviderPort;
    try {
      request = { ...input.buildRequest(target, attemptId), providerId: target.providerId, modelId: target.modelId, ...(input.signal !== undefined ? { signal: input.signal } : {}) };
      provider = input.providerFor(target);
    } catch {
      budget.release(reservationId);
      return terminal("blocked", "config-invalid", receipt, receipts, attempts);
    }
    if (selectionExpired()) {
      budget.release(reservationId);
      return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);
    }
    if (input.signal?.aborted) {
      budget.release(reservationId);
      return terminal("cancelled", "cancelled", receipt, receipts, attempts);
    }
    try {
      journalAttempt(input, receipt.decision.decisionId, attemptNumber, "started");
    } catch {
      budget.release(reservationId);
      return terminal("blocked", "config-invalid", receipt, receipts, attempts);
    }
    if (selectionExpired()) {
      budget.release(reservationId);
      return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);
    }

    let visible = false;
    let toolCall = false;
    let usage: NormalizedUsage | undefined;
    let providerError: NormalizedEvent | undefined;
    let completed = false;
    const settleAttempt = (attempt: RoutingExecutionAttempt): void => {
      attempts.push(attempt);
      try {
        input.onAttemptSettled?.({ ...attempt, ...(usage !== undefined ? { usage } : {}) });
      } catch {
        // Attempt observation is non-authoritative and cannot alter execution outcome.
      }
    };
    let iterator: AsyncIterator<NormalizedEvent>;
    try {
      iterator = provider.stream(request, {
        attemptId,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        ...(input.streamTimeoutMs === undefined ? {} : { timeoutMs: input.streamTimeoutMs }),
      })[Symbol.asyncIterator]();
    } catch {
      reconcileBudget(input, budget, reservationId, target, usage, estimate);
      settleAttempt({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "uncertain", reason: "uncertain-outcome", emittedVisibleOutput: false, emittedToolCall: false });
      journalAttempt(input, receipt.decision.decisionId, attemptNumber, "interrupted", usage);
      return terminal("interrupted", "uncertain-outcome", receipt, receipts, attempts);
    }
    if (selectionExpired()) {
      budget.release(reservationId);
      try {
        await iterator.return?.();
      } catch {
        // The iterator has not started; cleanup failure cannot authorize provider I/O.
      }
      return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);
    }
    const cancellation = input.signal === undefined ? undefined : abortPromise(input.signal);
    const providerIoStartedAt = monotonicNow();
    let providerIoFinished = false;
    const finishProviderIo = (): void => {
      if (providerIoFinished) return;
      providerIoFinished = true;
      selectionDeadlineMs += Math.max(0, monotonicNow() - providerIoStartedAt);
    };
    try {
      while (true) {
        const item = cancellation === undefined ? await iterator.next() : await Promise.race([iterator.next(), cancellation]);
        if (item.done) break;
        const event = item.value;
        if ((event.kind === "text_delta" || event.kind === "reasoning_delta") && (event.text?.length ?? 0) > 0) visible = true;
        if (event.kind === "tool_call_start" || event.kind === "tool_call_delta" || event.kind === "tool_call_end") toolCall = true;
        if (event.kind === "usage_update" && event.usage !== undefined) usage = event.usage;
        if (event.kind !== "provider_error") await input.onEvent?.(event, { target, decisionId: receipt.decision.decisionId });
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
      finishProviderIo();
      try {
        await iterator.return?.();
      } catch {
        // The original outcome is already uncertain; iterator cleanup cannot make replay safe.
      }
      reconcileBudget(input, budget, reservationId, target, usage, estimate);
      if (input.signal?.aborted) {
        settleAttempt({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "cancelled", reason: "cancelled", emittedVisibleOutput: visible, emittedToolCall: toolCall });
        journalAttempt(input, receipt.decision.decisionId, attemptNumber, "cancelled", usage);
        return terminal("cancelled", "cancelled", receipt, receipts, attempts);
      }
      settleAttempt({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: visible || toolCall ? "interrupted" : "uncertain", reason: "uncertain-outcome", emittedVisibleOutput: visible, emittedToolCall: toolCall });
      journalAttempt(input, receipt.decision.decisionId, attemptNumber, "interrupted", usage);
      return terminal("interrupted", "uncertain-outcome", receipt, receipts, attempts);
    }

    finishProviderIo();
    reconcileBudget(input, budget, reservationId, target, usage, estimate);
    if (completed) {
      settleAttempt({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "complete", emittedVisibleOutput: visible, emittedToolCall: toolCall });
      journalAttempt(input, receipt.decision.decisionId, attemptNumber, "completed", usage);
      return { status: "completed", receipt, receipts, attempts, ...(usage !== undefined ? { usage } : {}) };
    }
    if (input.signal?.aborted) {
      settleAttempt({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "cancelled", reason: "cancelled", emittedVisibleOutput: visible, emittedToolCall: toolCall });
      journalAttempt(input, receipt.decision.decisionId, attemptNumber, "cancelled", usage);
      return terminal("cancelled", "cancelled", receipt, receipts, attempts);
    }
    if (providerError === undefined) {
      settleAttempt({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: visible || toolCall ? "interrupted" : "uncertain", reason: "uncertain-outcome", emittedVisibleOutput: visible, emittedToolCall: toolCall });
      journalAttempt(input, receipt.decision.decisionId, attemptNumber, "interrupted", usage);
      return terminal("interrupted", "uncertain-outcome", receipt, receipts, attempts);
    }

    const reason = providerReason(providerError);
    const emitTerminalError = async (): Promise<boolean> => {
      try {
        await input.onEvent?.(providerError, { target, decisionId: receipt.decision.decisionId });
        return true;
      } catch {
        return false;
      }
    };
    if (reason === "cancelled") {
      if (!await emitTerminalError()) {
        settleAttempt({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "uncertain", reason: "uncertain-outcome", emittedVisibleOutput: visible, emittedToolCall: toolCall });
        journalAttempt(input, receipt.decision.decisionId, attemptNumber, "interrupted", usage);
        return terminal("interrupted", "uncertain-outcome", receipt, receipts, attempts);
      }
      settleAttempt({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "cancelled", reason, emittedVisibleOutput: visible, emittedToolCall: toolCall });
      journalAttempt(input, receipt.decision.decisionId, attemptNumber, "cancelled", usage);
      return terminal("cancelled", "cancelled", receipt, receipts, attempts);
    }
    if (visible || toolCall || !isConfirmedRetryable(providerError)) {
      if (!await emitTerminalError()) {
        settleAttempt({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "uncertain", reason: "uncertain-outcome", emittedVisibleOutput: visible, emittedToolCall: toolCall });
        journalAttempt(input, receipt.decision.decisionId, attemptNumber, "interrupted", usage);
        return terminal("interrupted", "uncertain-outcome", receipt, receipts, attempts);
      }
      settleAttempt({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "interrupted", reason, emittedVisibleOutput: visible, emittedToolCall: toolCall });
      journalAttempt(input, receipt.decision.decisionId, attemptNumber, "interrupted", usage);
      return terminal("interrupted", reason, receipt, receipts, attempts);
    }

    settleAttempt({ attemptId, decisionId: receipt.decision.decisionId, target, outcome: "failed", reason, emittedVisibleOutput: false, emittedToolCall: false });
    journalAttempt(input, receipt.decision.decisionId, attemptNumber, "rejected", usage);
    if (selectionExpired()) return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);
    const previousDecisionId = receipt.decision.decisionId;
    const failureObservedAt = input.now?.() ?? new Date();
    if (providerError.error?.detail?.modelNotFound === true) input.failureRegistry?.recordModelNotFound(target, state.snapshot.catalogRevision);
    else if (providerError.error?.kind === "rate_limit") input.failureRegistry?.recordRateLimit(target, state.snapshot.catalogRevision, providerError.error.retryAfterMs, failureObservedAt);
    else if (providerError.error?.kind === "authentication") input.failureRegistry?.recordAuthFailure(target.providerId);
    updateRuntimeSnapshot(state, target, reason, failureObservedAt.toISOString());
    if (selectionExpired()) return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);
    receipt = resolveRoutingForRuntime({ request: input.request, snapshot: state.snapshot, config: input.config, previousDecisionId, fallbackReason: reason, ...(input.journal === undefined ? {} : { journal: { ...input.journal, kind: "dispatch" as const } }) });
    receipts.push(receipt);
    if (selectionExpired()) return terminal("blocked", "uncertain-outcome", receipt, receipts, attempts);
  }
}
