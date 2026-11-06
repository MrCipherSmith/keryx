import { expect, test } from "bun:test";
import type { NormalizedEvent, NormalizedRequest, ProviderDescription, ProviderPort } from "../provider/types";
import { normalizeRoutingConfig } from "./config";
import type { ModelRef } from "./model-class";
import { RoutingBudgetLedger } from "./routing-budget";
import { createMeteredRoutingProvider, createRoutingExecutionProvider } from "./routing-provider";
import type { RoutingRequest } from "./routing-request";
import { createRoutingSnapshot, type RoutingModelFacts } from "./snapshot";
import { resolveRoutingForRuntime } from "./routing-runtime";

const first = { providerId: "alpha", modelId: "expert-a" };
const second = { providerId: "beta", modelId: "expert-b" };
const description: ProviderDescription = {
  descriptor: { providerId: "routing-test" },
  capabilities: { streaming: true, toolCalls: true, parallelToolCalls: true, structuredOutput: true, reasoningMetadata: true, promptCaching: false, vision: true, tokenCounting: true, modelListing: false },
};

function facts(target: ModelRef): RoutingModelFacts {
  return { target, connected: true, credentialsAvailable: true, policyAllowed: true, parentAllowed: true, availability: "available", capabilities: ["tools"], contextLength: 100_000, cooldown: false, estimatedCostUsd: 0.1, observedLatencyMs: 10 };
}

function setup(selectionTimeoutMs = 100) {
  const config = normalizeRoutingConfig({ user: {
    schemaVersion: 2,
    classes: { expert: { candidates: [{ target: first, enabled: true, priority: 2 }, { target: second, enabled: true, priority: 1 }], selection: "priority", fallbackClasses: [] } },
    categories: { coding: { mode: "class", modelClass: "expert" } },
    execution: { maxAttempts: 3, selectionTimeoutMs, maxEstimatedCostUsd: null, unknownCost: "allow" },
  } });
  const routingRequest: RoutingRequest = { requestId: "route", category: "coding", origin: "operator", baseline: first, requirements: { capabilities: [], inputTokensRequired: 1, outputTokensReserved: 1 } };
  const snapshot = createRoutingSnapshot({ configDigest: config.configDigest, observedAt: "2026-11-04T00:00:00.000Z", catalogRevision: "catalog", policyRevision: "policy", capabilityRevision: "capability", authFailedProviderIds: [], baseline: first, models: [facts(first), facts(second)] });
  return { config, routingRequest, snapshot };
}

function normalizedRequest(): NormalizedRequest {
  return { providerId: first.providerId, modelId: first.modelId, systemInstruction: "", messages: [], budget: { maxOutputTokens: 10, runReservation: 10 }, stream: true, requestId: "request", parentRunId: "parent" };
}

function provider(events: (attemptId: string) => readonly NormalizedEvent[]): ProviderPort {
  return { describe: () => description, async *stream(_request, options) { for (const event of events(options.attemptId)) yield event; } };
}

async function collect(port: ProviderPort): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of port.stream(normalizedRequest(), { attemptId: "outer" })) events.push(event);
  return events;
}

test("ProviderPort wrapper hides rejected pre-output attempt and preserves one outer stream", async () => {
  const { config, routingRequest, snapshot } = setup();
  const receipts: string[] = [];
  const attemptedProviders: string[] = [];
  const port = createRoutingExecutionProvider({
    description,
    config,
    budget: new RoutingBudgetLedger({ unknownCost: "allow" }),
    routeFor: async () => ({ request: routingRequest, snapshot }),
    beforeIo: async () => ({ ok: true }),
    providerFor: (target) => {
      attemptedProviders.push(target.providerId);
      return target.providerId === "alpha" ? provider((attemptId) => [
          { kind: "model_start", sequence: 1, attemptId },
          { kind: "provider_error", sequence: 2, attemptId, error: { kind: "rate_limit", retryable: true, retryAfterMs: 60_000, message: "slow" } },
        ])
      : provider((attemptId) => [
          { kind: "model_start", sequence: 1, attemptId },
          { kind: "text_delta", sequence: 2, attemptId, text: "ok" },
          { kind: "model_end", sequence: 3, attemptId },
        ]);
    },
    onReceipt: (receipt) => { receipts.push(receipt.receiptId); },
    now: () => new Date("2026-11-04T00:00:01.000Z"),
  });
  const events = await collect(port);
  expect(events.map((event) => event.kind)).toEqual(["model_start", "text_delta", "model_end"]);
  expect(events.map((event) => event.attemptId)).toEqual(["outer", "outer", "outer"]);
  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  expect(receipts).toHaveLength(2);
  await collect(port);
  expect(attemptedProviders).toEqual(["alpha", "beta", "beta"]);
});

test("ProviderPort wrapper enforces one aggregate ledger across stream calls", async () => {
  const { config, routingRequest, snapshot } = setup();
  const port = createRoutingExecutionProvider({
    description,
    config,
    budget: new RoutingBudgetLedger({ taskUsd: 0.15, unknownCost: "allow" }),
    routeFor: async () => ({ request: routingRequest, snapshot }),
    beforeIo: async () => ({ ok: true }),
    providerFor: () => provider((attemptId) => [{ kind: "model_end", sequence: 1, attemptId }]),
    now: () => new Date("2026-11-04T00:00:01.000Z"),
  });
  expect((await collect(port)).at(-1)?.kind).toBe("model_end");
  const secondRun = await collect(port);
  expect(secondRun).toHaveLength(1);
  expect(secondRun[0]?.kind).toBe("provider_error");
});

test("ProviderPort wrapper bounds asynchronous route selection", async () => {
  const { config } = setup(5);
  const port = createRoutingExecutionProvider({
    description,
    config,
    budget: new RoutingBudgetLedger({ unknownCost: "allow" }),
    routeFor: async (_request, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    beforeIo: async () => ({ ok: true }),
    providerFor: () => { throw new Error("must not run"); },
  });
  const events = await collect(port);
  expect(events).toHaveLength(1);
  expect(events[0]?.error).toMatchObject({ kind: "unknown", retryable: false });
});

test("ProviderPort wrapper never performs I/O when attempt authorization refuses candidates", async () => {
  const { config, routingRequest, snapshot } = setup();
  let providerCalls = 0;
  const port = createRoutingExecutionProvider({
    description,
    config,
    budget: new RoutingBudgetLedger({ unknownCost: "allow" }),
    routeFor: async () => ({ request: routingRequest, snapshot }),
    beforeIo: async () => ({ ok: false, reason: "policy-denied" }),
    providerFor: () => {
      providerCalls += 1;
      return provider(() => []);
    },
    now: () => new Date("2026-11-04T00:00:01.000Z"),
  });
  const events = await collect(port);
  expect(providerCalls).toBe(0);
  expect(events.at(-1)?.kind).toBe("provider_error");
});

test("ProviderPort wrapper applies backpressure and closes the active provider iterator when the consumer stops", async () => {
  const { config, routingRequest, snapshot } = setup();
  let produced = 0;
  let providerClosed = false;
  const streamingProvider: ProviderPort = {
    describe: () => description,
    async *stream(_request, options) {
      try {
        produced += 1;
        yield { kind: "model_start", sequence: 1, attemptId: options.attemptId };
        produced += 1;
        yield { kind: "text_delta", sequence: 2, attemptId: options.attemptId, text: "first" };
        produced += 1;
        yield { kind: "text_delta", sequence: 3, attemptId: options.attemptId, text: "second" };
        produced += 1;
        yield { kind: "model_end", sequence: 4, attemptId: options.attemptId };
      } finally {
        providerClosed = true;
      }
    },
  };
  const port = createRoutingExecutionProvider({
    description,
    config,
    budget: new RoutingBudgetLedger({ unknownCost: "allow" }),
    routeFor: async () => ({ request: routingRequest, snapshot }),
    beforeIo: async () => ({ ok: true }),
    providerFor: () => streamingProvider,
  });

  const iterator = port.stream(normalizedRequest(), { attemptId: "outer" })[Symbol.asyncIterator]();
  expect((await iterator.next()).value?.kind).toBe("model_start");
  await Promise.resolve();
  expect(produced).toBe(2);

  await iterator.return?.();
  expect(providerClosed).toBe(true);
  expect(produced).toBe(2);
});

test("observer failures do not append provider_error after a successful model_end", async () => {
  const { config, routingRequest, snapshot } = setup();
  const port = createRoutingExecutionProvider({
    description,
    config,
    budget: new RoutingBudgetLedger({ unknownCost: "allow" }),
    routeFor: async () => ({ request: routingRequest, snapshot }),
    beforeIo: async () => ({ ok: true }),
    providerFor: () => provider((attemptId) => [{ kind: "model_end", sequence: 1, attemptId }]),
    onAttemptSettled: () => { throw new Error("attempt observer failed"); },
    onReceipt: () => { throw new Error("receipt observer failed"); },
  });

  const events = await collect(port);
  expect(events.map((event) => event.kind)).toEqual(["model_end"]);
});

test("precommit buffering fails closed at its fixed capacity", async () => {
  const { config, routingRequest, snapshot } = setup();
  const port = createRoutingExecutionProvider({
    description,
    config,
    budget: new RoutingBudgetLedger({ unknownCost: "allow" }),
    routeFor: async () => ({ request: routingRequest, snapshot }),
    beforeIo: async () => ({ ok: true }),
    providerFor: () => provider((attemptId) => [
      ...Array.from({ length: 33 }, (_, index): NormalizedEvent => ({
        kind: "usage_update",
        sequence: index + 1,
        attemptId,
        usage: { exact: true, outputTokens: index + 1 },
      })),
      { kind: "text_delta", sequence: 34, attemptId, text: "must not commit" },
      { kind: "model_end", sequence: 35, attemptId },
    ]),
  });

  const events = await collect(port);
  expect(events).toHaveLength(1);
  expect(events[0]?.kind).toBe("provider_error");
  expect(events[0]?.error?.kind).toBe("unknown");
});

test("fixed-target wrapper meters all rounds against the classifier ledger", async () => {
  const { config, routingRequest, snapshot } = setup();
  const receipt = resolveRoutingForRuntime({ request: routingRequest, snapshot, config });
  let providerCalls = 0;
  const metered = createMeteredRoutingProvider({
    provider: provider((attemptId) => {
      providerCalls += 1;
      return [{ kind: "model_end", sequence: 1, attemptId }];
    }),
    target: first,
    receipt,
    budget: new RoutingBudgetLedger({ taskUsd: 0.15, unknownCost: "allow" }),
    selectionTimeoutMs: 100,
    beforeIo: async () => ({ ok: true }),
    estimatedCostUsd: () => 0.1,
  });
  expect((await collect(metered)).at(-1)?.kind).toBe("model_end");
  expect((await collect(metered)).at(-1)?.kind).toBe("provider_error");
  expect(providerCalls).toBe(1);
});

test("fixed-target wrapper denies an exhausted selection deadline before authorization or provider I/O", async () => {
  const { config, routingRequest, snapshot } = setup();
  const receipt = resolveRoutingForRuntime({ request: routingRequest, snapshot, config });
  let authorizationCalls = 0;
  let providerCalls = 0;
  const denials: string[] = [];
  const metered = createMeteredRoutingProvider({
    provider: provider(() => {
      providerCalls += 1;
      return [];
    }),
    target: first,
    receipt,
    budget: new RoutingBudgetLedger({ unknownCost: "allow" }),
    selectionTimeoutMs: 0,
    beforeIo: async () => {
      authorizationCalls += 1;
      return { ok: true };
    },
    onDenied: (reason) => { denials.push(reason); },
    estimatedCostUsd: () => 0.1,
  });

  const events = await collect(metered);
  expect(events[0]?.error?.kind).toBe("unknown");
  expect(authorizationCalls).toBe(0);
  expect(providerCalls).toBe(0);
  expect(denials).toEqual(["uncertain-outcome"]);
});

test("fixed-target wrapper reauthorizes every stream before provider I/O", async () => {
  const { config, routingRequest, snapshot } = setup();
  const receipt = resolveRoutingForRuntime({ request: routingRequest, snapshot, config });
  let providerCalls = 0;
  const denials: string[] = [];
  const metered = createMeteredRoutingProvider({
    provider: provider(() => {
      providerCalls += 1;
      return [];
    }),
    target: first,
    receipt,
    budget: new RoutingBudgetLedger({ unknownCost: "allow" }),
    selectionTimeoutMs: 100,
    beforeIo: async () => ({ ok: false, reason: "policy-denied" }),
    onDenied: (reason) => { denials.push(reason); },
    estimatedCostUsd: () => 0.1,
  });
  expect((await collect(metered))[0]?.kind).toBe("provider_error");
  expect(providerCalls).toBe(0);
  expect(denials).toEqual(["policy-denied"]);
});
