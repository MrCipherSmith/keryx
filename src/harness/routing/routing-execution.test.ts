import { expect, test } from "bun:test";
import { normalizeRoutingConfig, type RoutingConfigLayer } from "./config";
import type { ModelRef } from "./model-class";
import { executeRoutingWithFallback, prepareRoutingCandidate } from "./routing-execution";
import { resolveRoutingForRuntime } from "./routing-runtime";
import type { RoutingRequest } from "./routing-request";
import { createRoutingSnapshot, type RoutingModelFacts } from "./snapshot";
import { RoutingBudgetLedger } from "./routing-budget";
import type { NormalizedEvent, NormalizedRequest, ProviderPort } from "../provider/types";

const ref = (providerId: string, modelId: string): ModelRef => ({ providerId, modelId });
const first = ref("alpha", "expert-a");
const second = ref("beta", "expert-b");

function facts(target: ModelRef): RoutingModelFacts {
  return { target, connected: true, credentialsAvailable: true, policyAllowed: true, parentAllowed: true, availability: "available", capabilities: ["tools"], contextLength: 100_000, cooldown: false, estimatedCostUsd: 0.1, observedLatencyMs: 10 };
}

function setup(selectionTimeoutMs = 3_000) {
  const layer: RoutingConfigLayer = {
    schemaVersion: 2,
    classes: { expert: { candidates: [{ target: first, enabled: true, priority: 2 }, { target: second, enabled: true, priority: 1 }], selection: "priority", fallbackClasses: [] } },
    categories: { coding: { mode: "class", modelClass: "expert" } },
    execution: { maxAttempts: 3, selectionTimeoutMs, maxEstimatedCostUsd: null, unknownCost: "allow" },
  };
  const config = normalizeRoutingConfig({ user: layer });
  const request: RoutingRequest = { requestId: "run", category: "coding", origin: "operator", baseline: first, requirements: { capabilities: [], inputTokensRequired: 10, outputTokensReserved: 10 } };
  const snapshot = createRoutingSnapshot({
    configDigest: config.configDigest,
    observedAt: "2026-11-04T00:00:00.000Z",
    catalogRevision: "catalog-1",
    policyRevision: "policy-1",
    capabilityRevision: "capability-1",
    authFailedProviderIds: [],
    baseline: first,
    models: [facts(first), facts(second)],
  });
  return {
    config,
    request,
    snapshot,
    budget: new RoutingBudgetLedger({ unknownCost: "allow" }),
    beforeIo: async () => ({ ok: true as const }),
    now: () => new Date("2026-11-04T00:00:01.000Z"),
  };
}

function requestFor(target: ModelRef, attemptId: string): NormalizedRequest {
  return { providerId: target.providerId, modelId: target.modelId, systemInstruction: "", messages: [], budget: { maxOutputTokens: 10, runReservation: 10 }, stream: true, requestId: attemptId, parentRunId: "parent" };
}

function provider(events: (attemptId: string) => readonly NormalizedEvent[]): ProviderPort {
  return {
    describe() { throw new Error("not used"); },
    async *stream(_request, options) {
      for (const event of events(options.attemptId)) yield event;
    },
  };
}

const errorEvent = (attemptId: string, kind: "rate_limit" | "overloaded" | "unavailable" | "authentication" | "cancelled", retryable = true): NormalizedEvent => ({
  kind: "provider_error",
  sequence: 1,
  attemptId,
  error: { kind, retryable, message: kind },
});

test("preparation falls back before dispatch and returns the replacement dependencies and receipt", async () => {
  const input = setup();
  const receipt = resolveRoutingForRuntime(input);
  const result = await prepareRoutingCandidate({
    ...input,
    receipt,
    signal: new AbortController().signal,
    prepare: async (target) => target.providerId === first.providerId
      ? { ok: false, reason: "credentials-missing" }
      : { ok: true, value: target.modelId },
  });
  expect(result).toMatchObject({
    ok: true,
    value: second.modelId,
    target: second,
    receipt: { previousDecisionId: receipt.decision.decisionId, fallbackReason: "credentials-missing" },
  });
});

test("preparation never widens an explicit model pin", async () => {
  const input = setup();
  const request: RoutingRequest = { ...input.request, userOverride: { mode: "model", target: first } };
  const receipt = resolveRoutingForRuntime({ ...input, request });
  const prepared: ModelRef[] = [];
  const result = await prepareRoutingCandidate({
    ...input,
    request,
    receipt,
    signal: new AbortController().signal,
    prepare: async (target) => {
      prepared.push(target);
      return { ok: false, reason: "model-unavailable" };
    },
  });
  expect(result.ok).toBe(false);
  expect(prepared).toEqual([first]);
});

test("preparation honors a caller-provided remaining selection budget", async () => {
  const input = setup(100);
  const receipt = resolveRoutingForRuntime(input);
  const result = await prepareRoutingCandidate({
    ...input,
    receipt,
    selectionTimeoutMs: 5,
    signal: new AbortController().signal,
    prepare: async (_target, _decisionId, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ ok: false, reason: "model-unavailable" }), { once: true });
    }),
  });
  expect(result).toEqual({ ok: false, reason: "uncertain-outcome" });
});

test("preparation performs no work with zero remaining budget or an already-cancelled caller", async () => {
  const input = setup(100);
  const receipt = resolveRoutingForRuntime(input);
  let prepareCalls = 0;
  const prepare = async () => {
    prepareCalls += 1;
    return { ok: true as const, value: "prepared" };
  };
  const timedOut = await prepareRoutingCandidate({ ...input, receipt, selectionTimeoutMs: 0, signal: new AbortController().signal, prepare });
  const controller = new AbortController();
  controller.abort("stop");
  const cancelled = await prepareRoutingCandidate({ ...input, receipt, selectionTimeoutMs: 100, signal: controller.signal, prepare });
  expect(timedOut).toEqual({ ok: false, reason: "uncertain-outcome" });
  expect(cancelled).toEqual({ ok: false, reason: "cancelled" });
  expect(prepareCalls).toBe(0);
});

test("confirmed 429 before output selects the next model and links receipts", async () => {
  const input = setup();
  const delivered: NormalizedEvent[] = [];
  const result = await executeRoutingWithFallback({
    ...input,
    buildRequest: requestFor,
    onEvent: (event) => { delivered.push(event); },
    providerFor: (target) => target.providerId === "alpha"
      ? provider((attemptId) => [errorEvent(attemptId, "rate_limit")])
      : provider((attemptId) => [{ kind: "model_end", sequence: 1, attemptId }]),
  });
  expect(result.status).toBe("completed");
  expect(result.attempts.map((attempt) => attempt.target)).toEqual([first, second]);
  expect(result.receipts[1]?.previousDecisionId).toBe(result.receipts[0]?.decision.decisionId);
  expect(result.receipts[1]?.fallbackReason).toBe("cooldown");
  expect(delivered.some((event) => event.kind === "provider_error")).toBe(false);
});

test("confirmed unavailable model falls back even when the failed pair is not retryable", async () => {
  const input = setup();
  const result = await executeRoutingWithFallback({
    ...input,
    buildRequest: requestFor,
    providerFor: (target) => target.providerId === "alpha"
      ? provider((attemptId) => [errorEvent(attemptId, "unavailable", false)])
      : provider((attemptId) => [{ kind: "model_end", sequence: 1, attemptId }]),
  });
  expect(result.status).toBe("completed");
  expect(result.attempts.map((attempt) => attempt.target)).toEqual([first, second]);
});

test("confirmed normalized model-not-found falls back to another pair", async () => {
  const input = setup();
  const result = await executeRoutingWithFallback({
    ...input,
    buildRequest: requestFor,
    providerFor: (target) => target.providerId === "alpha"
      ? provider((attemptId) => [{
          kind: "provider_error",
          sequence: 1,
          attemptId,
          error: { kind: "invalid_request", retryable: false, message: "model not found", detail: { modelNotFound: true } },
        }])
      : provider((attemptId) => [{ kind: "model_end", sequence: 1, attemptId }]),
  });
  expect(result.status).toBe("completed");
  expect(result.attempts.map((attempt) => attempt.target)).toEqual([first, second]);
});

test("visible output makes provider failure terminal without replay", async () => {
  const input = setup();
  const result = await executeRoutingWithFallback({
    ...input,
    buildRequest: requestFor,
    providerFor: () => provider((attemptId) => [
      { kind: "text_delta", sequence: 1, attemptId, text: "visible" },
      { ...errorEvent(attemptId, "overloaded"), sequence: 2 },
    ]),
  });
  expect(result.status).toBe("interrupted");
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0]?.emittedVisibleOutput).toBe(true);
});

test("tool-call activity makes failure terminal without replay", async () => {
  const input = setup();
  const result = await executeRoutingWithFallback({
    ...input,
    buildRequest: requestFor,
    providerFor: () => provider((attemptId) => [
      { kind: "tool_call_start", sequence: 1, attemptId, toolCallId: "t", toolName: "write" },
      { ...errorEvent(attemptId, "overloaded"), sequence: 2 },
    ]),
  });
  expect(result.status).toBe("interrupted");
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0]?.emittedToolCall).toBe(true);
});

test("unknown remote outcome never invokes fallback", async () => {
  const input = setup();
  const throwing: ProviderPort = {
    describe() { throw new Error("not used"); },
    async *stream() { throw new Error("transport reset"); },
  };
  const result = await executeRoutingWithFallback({ ...input, buildRequest: requestFor, providerFor: () => throwing });
  expect(result.status).toBe("interrupted");
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0]?.reason).toBe("uncertain-outcome");
});

test("provider cancellation is terminal and does not invoke fallback", async () => {
  const input = setup();
  const result = await executeRoutingWithFallback({ ...input, buildRequest: requestFor, providerFor: () => provider((attemptId) => [errorEvent(attemptId, "cancelled", false)]) });
  expect(result.status).toBe("cancelled");
  expect(result.attempts).toHaveLength(1);
});

test("caller cancellation stops before provider I/O and never invokes fallback", async () => {
  const input = setup();
  const controller = new AbortController();
  controller.abort("stop");
  let providerCalls = 0;
  const result = await executeRoutingWithFallback({
    ...input,
    signal: controller.signal,
    buildRequest: requestFor,
    providerFor: () => {
      providerCalls += 1;
      return provider(() => []);
    },
  });
  expect(result.status).toBe("cancelled");
  expect(providerCalls).toBe(0);
  expect(result.attempts).toHaveLength(0);
});

test("maxAttempts stops before another provider pair is invoked", async () => {
  const input = setup();
  const providers: string[] = [];
  const result = await executeRoutingWithFallback({
    ...input,
    maxAttempts: 1,
    buildRequest: requestFor,
    providerFor: (target) => {
      providers.push(target.providerId);
      return provider((attemptId) => [errorEvent(attemptId, "rate_limit")]);
    },
  });
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toBe("attempts-exhausted");
  expect(providers).toEqual(["alpha"]);
});

test("selection timeout aborts pre-I/O revalidation before provider invocation", async () => {
  const input = setup(5);
  let providerCalls = 0;
  const result = await executeRoutingWithFallback({
    ...input,
    buildRequest: requestFor,
    beforeIo: async (_target, _decisionId, { signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ ok: false, reason: "model-unavailable" }), { once: true });
    }),
    providerFor: () => {
      providerCalls += 1;
      return provider(() => []);
    },
  });
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toBe("uncertain-outcome");
  expect(providerCalls).toBe(0);
});

test("selection deadline includes initial resolution before revalidation", async () => {
  const input = setup(10);
  let clockReads = 0;
  let checks = 0;
  const result = await executeRoutingWithFallback({
    ...input,
    monotonicNow: () => clockReads++ === 0 ? 0 : 11,
    beforeIo: async () => {
      checks += 1;
      return { ok: true };
    },
    buildRequest: requestFor,
    providerFor: () => provider(() => []),
  });
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toBe("uncertain-outcome");
  expect(checks).toBe(0);
});

test("selection timeout is one aggregate budget across fallback candidates", async () => {
  const input = setup(10);
  let clock = 0;
  let checks = 0;
  let providerCalls = 0;
  const result = await executeRoutingWithFallback({
    ...input,
    monotonicNow: () => clock,
    beforeIo: async () => {
      checks += 1;
      clock += checks === 1 ? 6 : 5;
      return checks === 1 ? { ok: false, reason: "model-unavailable" } : { ok: true };
    },
    buildRequest: requestFor,
    providerFor: () => {
      providerCalls += 1;
      return provider(() => []);
    },
  });
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toBe("uncertain-outcome");
  expect(checks).toBe(2);
  expect(providerCalls).toBe(0);
});

test("provider I/O time does not consume the selection-only deadline", async () => {
  const input = setup(10);
  let clock = 0;
  let providerCalls = 0;
  const result = await executeRoutingWithFallback({
    ...input,
    monotonicNow: () => clock,
    buildRequest: requestFor,
    providerFor: (target) => provider((attemptId) => {
      providerCalls += 1;
      if (target.providerId === "alpha") {
        clock += 1_000;
        return [errorEvent(attemptId, "rate_limit")];
      }
      return [{ kind: "model_end", sequence: 1, attemptId }];
    }),
  });
  expect(result.status).toBe("completed");
  expect(providerCalls).toBe(2);
});
