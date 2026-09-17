// flow 268 (AC5): an internal `timeoutMs` (resolved from
// `resolveProviderModelParams`, threaded through `StreamOptions`) aborts a
// stalled `OpenAiCompatEngine.stream()` call on its own, independent of
// whatever external `AbortSignal` the caller passes — and the external
// signal still independently aborts when the configured timeout has not yet
// elapsed. Neither path interferes with the other.

import { expect, test } from "bun:test";
import { OpenAiCompatEngine, type OpenAiCompatCapabilityGrant, type OpenAiCompatIdentity } from "./openai-compat-provider";
import type { NormalizedEvent, NormalizedRequest } from "../types";

const identity: OpenAiCompatIdentity = {
  providerId: "compat-fixture",
  providerRevision: "test",
  defaultBaseUrl: "http://localhost:43123",
  defaultModel: { modelId: "fixture-model", revision: "test" },
  providerLabel: "Compat fixture",
};

const grant: OpenAiCompatCapabilityGrant = {
  network: true,
  baseUrl: identity.defaultBaseUrl,
  allowLoopback: true,
};

const request: NormalizedRequest = {
  providerId: identity.providerId,
  modelId: identity.defaultModel.modelId,
  systemInstruction: "fixture",
  messages: [{ role: "user", content: "hello" }],
  budget: { maxOutputTokens: 32, runReservation: 32 },
  stream: true,
  requestId: "flow-268-ac5",
  parentRunId: "flow-268-ac5",
};

/** A `fetch` that never resolves on its own — only an abort settles it. */
function stallingFetch(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort);
      // Otherwise: never settles — simulates a stalled network call.
    });
  }) as unknown as typeof fetch;
}

async function collect(iterable: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("a configured timeoutMs aborts a stalled stream on its own (no external signal)", async () => {
  const provider = new OpenAiCompatEngine({ grant, fetch: stallingFetch() }, identity);
  const events = await collect(provider.stream(request, { attemptId: "a1", timeoutMs: 20 }));
  expect(events).toHaveLength(1);
  expect(events[0]?.kind).toBe("provider_error");
  expect(events[0]?.error?.kind).toBe("cancelled");
});

test("an external AbortSignal still independently aborts before the configured timeout elapses", async () => {
  const provider = new OpenAiCompatEngine({ grant, fetch: stallingFetch() }, identity);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  const events = await collect(
    provider.stream(request, { attemptId: "a2", signal: controller.signal, timeoutMs: 5_000 }),
  );
  expect(events).toHaveLength(1);
  expect(events[0]?.kind).toBe("provider_error");
  expect(events[0]?.error?.kind).toBe("cancelled");
});

test("an already-aborted external signal aborts immediately even with a long timeoutMs", async () => {
  const provider = new OpenAiCompatEngine({ grant, fetch: stallingFetch() }, identity);
  const controller = new AbortController();
  controller.abort();
  const events = await collect(
    provider.stream(request, { attemptId: "a3", signal: controller.signal, timeoutMs: 60_000 }),
  );
  expect(events).toHaveLength(1);
  expect(events[0]?.kind).toBe("provider_error");
  expect(events[0]?.error?.kind).toBe("cancelled");
});

test("neither timer interferes with a normal, fast-completing stream", async () => {
  const sseBody = [
    'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
    "",
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
  const fetchMock = (async () => new Response(sseBody, { status: 200 })) as unknown as typeof fetch;
  const provider = new OpenAiCompatEngine({ grant, fetch: fetchMock }, identity);
  const events = await collect(provider.stream(request, { attemptId: "a4", timeoutMs: 500 }));
  // The internal timer must NOT fire (and must be cleaned up) for a call that
  // finishes well within it — a normal completion, not a cancellation.
  expect(events.map((e) => e.kind)).toContain("model_start");
  expect(events.map((e) => e.kind)).toContain("model_end");
  expect(events.some((e) => e.kind === "provider_error")).toBe(false);
});

test("absent timeoutMs behaves exactly as before (caller-signal-only)", async () => {
  const provider = new OpenAiCompatEngine({ grant, fetch: stallingFetch() }, identity);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  const events = await collect(provider.stream(request, { attemptId: "a5", signal: controller.signal }));
  expect(events).toHaveLength(1);
  expect(events[0]?.error?.kind).toBe("cancelled");
});
