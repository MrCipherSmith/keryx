import type { NormalizedError, NormalizedEvent, NormalizedRequest, NormalizedUsage, ProviderDescription, ProviderPort, StreamOptions } from "../provider/types";
import type { NormalizedRoutingV2Config } from "./config-v2";
import type { RoutingReason } from "./decision";
import type { ModelRef } from "./model-class";
import type { RoutingBudgetLedger } from "./routing-budget";
import { executeRoutingWithFallback } from "./routing-execution-v2";
import type { RoutingDecisionReceipt } from "./routing-runtime";
import type { RoutingRequest } from "./routing-request";
import type { RoutingSnapshot } from "./snapshot";
import { appendRoutingJournal, type RoutingJournalLocation } from "./routing-journal";
import { RoutingFailureRegistry } from "./routing-failure-registry";

export interface RoutingExecutionProviderOptions {
  readonly description: ProviderDescription;
  readonly config: NormalizedRoutingV2Config;
  readonly budget: RoutingBudgetLedger;
  readonly routeFor: (request: NormalizedRequest, context: { readonly signal: AbortSignal }) => Promise<{ readonly request: RoutingRequest; readonly snapshot: RoutingSnapshot }>;
  readonly providerFor: (target: ModelRef) => ProviderPort;
  readonly beforeIo: (target: ModelRef, decisionId: string, context: { readonly signal: AbortSignal }) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: RoutingReason }>;
  readonly actualCostUsd?: (input: { readonly target: ModelRef; readonly usage?: NormalizedUsage; readonly estimatedCostUsd: number | null }) => number;
  readonly onReceipt?: (receipt: RoutingDecisionReceipt) => void | Promise<void>;
  readonly journal?: RoutingJournalLocation & { readonly kind?: "dispatch" | "preview" };
  readonly now?: () => Date;
  readonly failureRegistry?: RoutingFailureRegistry;
}

export interface MeteredRoutingProviderOptions {
  readonly provider: ProviderPort;
  readonly target: ModelRef;
  readonly receipt: RoutingDecisionReceipt;
  readonly budget: RoutingBudgetLedger;
  readonly selectionTimeoutMs: number;
  readonly beforeIo: (
    target: ModelRef,
    decisionId: string,
    context: { readonly signal: AbortSignal; readonly request: NormalizedRequest },
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: RoutingReason }>;
  readonly estimatedCostUsd: (request: NormalizedRequest) => number | null;
  readonly actualCostUsd?: (input: { readonly request: NormalizedRequest; readonly usage?: NormalizedUsage; readonly estimatedCostUsd: number | null }) => number;
  readonly journal?: RoutingJournalLocation & { readonly kind?: "dispatch" | "preview" };
  readonly onDenied?: (reason: RoutingReason, request: NormalizedRequest) => void | Promise<void>;
}

class EventQueue {
  readonly #events: NormalizedEvent[] = [];
  readonly #waiters: Array<(value: IteratorResult<NormalizedEvent>) => void> = [];
  #closed = false;

  push(event: NormalizedEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#events.push(event);
    else waiter({ done: false, value: event });
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<NormalizedEvent>> {
    const event = this.#events.shift();
    if (event !== undefined) return Promise.resolve({ done: false, value: event });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

function normalizedError(reason: RoutingReason): NormalizedError {
  const kind: NormalizedError["kind"] = reason === "cancelled" ? "cancelled"
    : reason === "auth-failed" || reason === "credentials-missing" ? "authentication"
      : reason === "cooldown" ? "rate_limit"
        : reason === "model-unavailable" || reason === "attempts-exhausted" ? "unavailable"
          : reason === "uncertain-outcome" ? "unknown"
            : "invalid_request";
  return { kind, retryable: false, message: `routing execution stopped: ${reason}` };
}

function selectionAbort(signal: AbortSignal | undefined, timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
  readonly timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timeout = false;
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new Error("routing selection timeout"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    },
    timedOut: () => timeout,
  };
}

function abortWait(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** ProviderPort boundary that safely hides rejected pre-output attempts from existing agent loops. */
export function createRoutingExecutionProvider(options: RoutingExecutionProviderOptions): ProviderPort {
  const failureRegistry = options.failureRegistry ?? new RoutingFailureRegistry();
  return {
    describe: () => options.description,
    async *stream(normalizedRequest: NormalizedRequest, streamOptions: StreamOptions): AsyncIterable<NormalizedEvent> {
      const outerSignal = streamOptions.signal ?? normalizedRequest.signal;
      const selectionStartedAt = performance.now();
      const selection = selectionAbort(outerSignal, options.config.execution.selectionTimeoutMs);
      let routed: { readonly request: RoutingRequest; readonly snapshot: RoutingSnapshot };
      try {
        routed = await Promise.race([
          options.routeFor(normalizedRequest, { signal: selection.signal }),
          abortWait(selection.signal),
        ]);
        if (outerSignal?.aborted) throw outerSignal.reason;
        if (selection.timedOut()) throw new Error("routing selection timeout");
      } catch {
        const reason: RoutingReason = outerSignal?.aborted ? "cancelled" : selection.timedOut() ? "uncertain-outcome" : "config-invalid";
        yield { kind: "provider_error", sequence: 1, attemptId: streamOptions.attemptId, error: normalizedError(reason) };
        return;
      } finally {
        selection.cleanup();
      }

      routed = { ...routed, snapshot: failureRegistry.apply(routed.snapshot, options.now?.() ?? new Date()) };
      const selectionRemainingMs = Math.max(0, options.config.execution.selectionTimeoutMs - Math.max(0, performance.now() - selectionStartedAt));

      yield* executeProviderRoute(options, failureRegistry, routed, normalizedRequest, streamOptions, outerSignal, selectionRemainingMs);
    },
  };
}

/** Fixed-target boundary for consumers that cannot safely switch durable model identity yet. */
export function createMeteredRoutingProvider(options: MeteredRoutingProviderOptions): ProviderPort {
  let attemptNumber = 0;
  return {
    describe: () => options.provider.describe(),
    async *stream(request: NormalizedRequest, streamOptions: StreamOptions): AsyncIterable<NormalizedEvent> {
      const signal = streamOptions.signal ?? request.signal;
      const selectedRequest = { ...request, providerId: options.target.providerId, modelId: options.target.modelId };
      const deny = async (reason: RoutingReason): Promise<NormalizedEvent> => {
        try { await options.onDenied?.(reason, selectedRequest); } catch { /* Denial remains fail-closed if audit notification fails. */ }
        return { kind: "provider_error", sequence: 1, attemptId: streamOptions.attemptId, error: normalizedError(reason) };
      };
      const selection = selectionAbort(signal, options.selectionTimeoutMs);
      try {
        const authorization = await Promise.race([
          options.beforeIo(options.target, options.receipt.decision.decisionId, { signal: selection.signal, request: selectedRequest }),
          abortWait(selection.signal),
        ]);
        if (signal?.aborted) throw signal.reason;
        if (selection.timedOut()) throw new Error("routing selection timeout");
        if (!authorization.ok) {
          yield await deny(authorization.reason);
          return;
        }
      } catch {
        const reason: RoutingReason = signal?.aborted ? "cancelled" : selection.timedOut() ? "uncertain-outcome" : "config-invalid";
        yield await deny(reason);
        return;
      } finally {
        selection.cleanup();
      }

      const estimate = options.estimatedCostUsd(selectedRequest);
      const reservation = options.budget.reserve({ estimatedCostUsd: estimate, purpose: "execution" });
      if (!reservation.ok) {
        yield await deny(reservation.reason);
        return;
      }
      attemptNumber += 1;
      if (options.journal !== undefined) appendRoutingJournal(options.journal, { kind: "attempt", decisionId: options.receipt.decision.decisionId, attempt: attemptNumber, outcome: "started" });

      let usage: NormalizedUsage | undefined;
      let outcome: "completed" | "interrupted" | "cancelled" = "interrupted";
      try {
        for await (const event of options.provider.stream(selectedRequest, streamOptions)) {
          if (event.kind === "usage_update" && event.usage !== undefined) usage = event.usage;
          if (event.kind === "model_end") outcome = "completed";
          if (event.kind === "provider_error" && event.error?.kind === "cancelled") outcome = "cancelled";
          yield event;
        }
      } finally {
        if (signal?.aborted) outcome = "cancelled";
        let actual = estimate ?? 0;
        try {
          const reported = options.actualCostUsd?.({ request: selectedRequest, ...(usage === undefined ? {} : { usage }), estimatedCostUsd: estimate });
          if (reported !== undefined && Number.isFinite(reported) && reported >= 0) actual = reported;
        } catch {
          // Keep the conservative reservation when metering cannot be read.
        }
        options.budget.reconcile(reservation.reservation.id, actual);
        if (options.journal !== undefined) appendRoutingJournal(options.journal, {
          kind: "attempt",
          decisionId: options.receipt.decision.decisionId,
          attempt: attemptNumber,
          outcome,
          ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
          ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        });
      }
    },
  };
}

async function* executeProviderRoute(
  options: RoutingExecutionProviderOptions,
  failureRegistry: RoutingFailureRegistry,
  routed: { readonly request: RoutingRequest; readonly snapshot: RoutingSnapshot },
  normalizedRequest: NormalizedRequest,
  streamOptions: StreamOptions,
  outerSignal: AbortSignal | undefined,
  selectionRemainingMs: number,
): AsyncIterable<NormalizedEvent> {
  const queue = new EventQueue();
  let sequence = 0;
  let terminalErrorEmitted = false;
  let currentDecisionId: string | undefined;
  let buffered: NormalizedEvent[] = [];
  const emit = (event: NormalizedEvent): void => {
    queue.push({ ...event, sequence: ++sequence, attemptId: streamOptions.attemptId });
  };
  const flush = (): void => {
    for (const event of buffered) emit(event);
    buffered = [];
  };

  const execution = executeRoutingWithFallback({
    request: routed.request,
    snapshot: routed.snapshot,
    config: options.config,
    budget: options.budget,
    providerFor: options.providerFor,
    beforeIo: options.beforeIo,
    buildRequest: (target) => ({ ...normalizedRequest, providerId: target.providerId, modelId: target.modelId }),
    ...(outerSignal === undefined ? {} : { signal: outerSignal }),
    ...(streamOptions.timeoutMs === undefined ? {} : { streamTimeoutMs: streamOptions.timeoutMs }),
    selectionTimeoutMs: selectionRemainingMs,
    ...(options.actualCostUsd === undefined ? {} : { actualCostUsd: options.actualCostUsd }),
    ...(options.journal === undefined ? {} : { journal: options.journal }),
    ...(options.now === undefined ? {} : { now: options.now }),
    failureRegistry,
    onEvent: (event, attempt) => {
      if (currentDecisionId !== attempt.decisionId) {
        currentDecisionId = attempt.decisionId;
        buffered = [];
      }
      if (event.kind === "provider_error") {
        buffered = [];
        terminalErrorEmitted = true;
        emit(event);
        return;
      }
      const commitsAttempt = event.kind === "model_end"
        || event.kind === "tool_call_start" || event.kind === "tool_call_delta" || event.kind === "tool_call_end"
        || ((event.kind === "text_delta" || event.kind === "reasoning_delta") && (event.text?.length ?? 0) > 0);
      if (!commitsAttempt) {
        buffered.push(event);
        return;
      }
      flush();
      emit(event);
    },
  }).then(async (result) => {
    for (const receipt of result.receipts) await options.onReceipt?.(receipt);
    if (result.status !== "completed" && !terminalErrorEmitted) {
      buffered = [];
      emit({ kind: "provider_error", sequence: 0, attemptId: streamOptions.attemptId, error: normalizedError(result.reason) });
    }
  }).catch(() => {
    if (!terminalErrorEmitted) {
      buffered = [];
      emit({ kind: "provider_error", sequence: 0, attemptId: streamOptions.attemptId, error: normalizedError("uncertain-outcome") });
    }
  }).finally(() => queue.close());

  while (true) {
    const item = await queue.next();
    if (item.done) break;
    yield item.value;
  }
  await execution;
}
