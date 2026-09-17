// Incremental streaming + deadline tests for `OpenAiCompatEngine` (flow 268,
// T5). `openai-compat-provider.test.ts` covers HTTP negatives and error-body
// shapes; `ollama-provider.test.ts` covers the full normalization contract
// against a fully-buffered fixture. This file is the DEDICATED regression
// suite for the incremental-read rewrite itself: a caller must observe each
// parsed event as soon as it is available (not only once the connection
// closes), a stalled connection must fail closed on two independent
// deadlines, and the flow-019 abort contract (exactly one terminal
// `cancelled`, never a `model_end`) must survive the rewrite.
//
// Every stream body here is a hand-controlled `ReadableStream<Uint8Array>`
// (never a plain `new Response(fullString)`, which several existing suites
// already cover) so a chunk's arrival, or its absence, is exactly what each
// test asserts against.
import { describe, expect, test } from "bun:test";
import { OpenAiCompatEngine, type OpenAiCompatProviderDeps, type OpenAiCompatCapabilityGrant, type OpenAiCompatIdentity } from "./openai-compat-provider";
import type { NormalizedEvent, NormalizedRequest, StreamOptions } from "../types";

const identity: OpenAiCompatIdentity = {
  providerId: "compat-streaming-fixture",
  providerRevision: "test",
  defaultBaseUrl: "http://localhost:43124",
  defaultModel: { modelId: "fixture-model", revision: "test" },
  providerLabel: "Compat streaming fixture",
};

const grant: OpenAiCompatCapabilityGrant = { network: true, baseUrl: identity.defaultBaseUrl, allowLoopback: true };

function buildRequest(requestId: string): NormalizedRequest {
  return {
    providerId: identity.providerId,
    modelId: identity.defaultModel.modelId,
    systemInstruction: "fixture",
    messages: [{ role: "user", content: "hello" }],
    budget: { maxOutputTokens: 32, runReservation: 32 },
    stream: true,
    requestId,
    parentRunId: requestId,
  };
}

/** A `ReadableStream<Uint8Array>` the test can feed bytes into on its own schedule. */
interface ControlledStream {
  readonly response: Response;
  enqueue(text: string): void;
  close(): void;
}

function controlledStream(): ControlledStream {
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
    },
  });
  const encoder = new TextEncoder();
  const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  return {
    response,
    enqueue: (text: string) => ctrl.enqueue(encoder.encode(text)),
    close: () => ctrl.close(),
  };
}

function fetchMockFor(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

async function collectEvents(iterable: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const evt of iterable) {
    events.push(evt);
  }
  return events;
}

function lastEvent(events: NormalizedEvent[]): NormalizedEvent {
  const trailing = events[events.length - 1];
  if (trailing === undefined) throw new Error("expected at least one collected event");
  return trailing;
}

// --- (a) a chunk observed before the stream ever closes ---------------------

describe("AC1 — a text chunk is yielded before the underlying stream closes", () => {
  test("one enqueued content chunk yields text_delta while the connection stays open", async () => {
    const stream = controlledStream();
    stream.enqueue('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    // Deliberately never closed — a fully-buffered `response.text()` read
    // would hang forever here; the incremental reader must not.

    const deps: OpenAiCompatProviderDeps = { fetch: fetchMockFor(stream.response), grant };
    const provider = new OpenAiCompatEngine(deps, identity);
    const iterator = provider.stream(buildRequest("req-a"), { attemptId: "att-a" })[Symbol.asyncIterator]();

    const first = await iterator.next();
    const second = await iterator.next();

    expect(first.done).toBe(false);
    expect((first.value as NormalizedEvent).kind).toBe("model_start");
    expect(second.done).toBe(false);
    expect(second.value).toMatchObject({ kind: "text_delta", text: "partial" });
  });
});

// --- (b) [DONE] without closing still yields model_end and ends the turn ----

describe("AC1 — [DONE] ends the turn even when the socket never closes", () => {
  test("model_start, text_delta, model_end are yielded and the iterator finishes on its own", async () => {
    const stream = controlledStream();
    stream.enqueue(
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
    );
    // Never closed: the adapter must stop reading on its own once it sees
    // `[DONE]`, per AC1, rather than waiting for the socket to close.

    const deps: OpenAiCompatProviderDeps = { fetch: fetchMockFor(stream.response), grant };
    const provider = new OpenAiCompatEngine(deps, identity);
    const events = await collectEvents(provider.stream(buildRequest("req-b"), { attemptId: "att-b" }));

    expect(events.map((e) => e.kind)).toEqual(["model_start", "text_delta", "model_end"]);
  });
});

// --- (c) first-byte timeout --------------------------------------------------

describe("AC2 — first-byte timeout fails closed", () => {
  test("no byte ever arrives -> exactly one retryable unavailable provider_error, no model_end", async () => {
    const stream = controlledStream();
    // Never enqueue, never close: the body stalls before its first byte.

    const deps: OpenAiCompatProviderDeps = { fetch: fetchMockFor(stream.response), grant, firstByteTimeoutMs: 20, idleTimeoutMs: 20 };
    const provider = new OpenAiCompatEngine(deps, identity);
    const events = await collectEvents(provider.stream(buildRequest("req-c"), { attemptId: "att-c" }));

    expect(events).toHaveLength(1);
    const trailing = lastEvent(events);
    expect(trailing.kind).toBe("provider_error");
    expect(trailing.error?.kind).toBe("unavailable");
    expect(trailing.error?.retryable).toBe(true);
    expect(events.some((e) => e.kind === "model_end")).toBe(false);
  });
});

// --- (d) idle timeout ---------------------------------------------------------

describe("AC2 — idle timeout fails closed", () => {
  test("one chunk then silence -> exactly one retryable unavailable provider_error, no model_end", async () => {
    const stream = controlledStream();
    stream.enqueue('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    // One byte arrives, then the connection stalls — never closed, never
    // fed another chunk.

    const deps: OpenAiCompatProviderDeps = { fetch: fetchMockFor(stream.response), grant, firstByteTimeoutMs: 5_000, idleTimeoutMs: 20 };
    const provider = new OpenAiCompatEngine(deps, identity);
    const events = await collectEvents(provider.stream(buildRequest("req-d"), { attemptId: "att-d" }));

    expect(events.some((e) => e.kind === "text_delta")).toBe(true);
    const trailing = lastEvent(events);
    expect(trailing.kind).toBe("provider_error");
    expect(trailing.error?.kind).toBe("unavailable");
    expect(trailing.error?.retryable).toBe(true);
    expect(events.some((e) => e.kind === "model_end")).toBe(false);
  });
});

// --- zero-byte body regression (incremental read must not silently yield nothing) --

describe("AC1 — a 200 with literally zero bytes still fails closed", () => {
  test("the stream closes immediately with no chunk -> exactly one malformed provider_error, no model_start/model_end", async () => {
    const stream = controlledStream();
    stream.close();

    const deps: OpenAiCompatProviderDeps = { fetch: fetchMockFor(stream.response), grant };
    const provider = new OpenAiCompatEngine(deps, identity);
    const events = await collectEvents(provider.stream(buildRequest("req-zero"), { attemptId: "att-zero" }));

    expect(events).toHaveLength(1);
    const trailing = lastEvent(events);
    expect(trailing.kind).toBe("provider_error");
    expect(trailing.error?.kind).toBe("malformed");
    expect(events.some((e) => e.kind === "model_start")).toBe(false);
    expect(events.some((e) => e.kind === "model_end")).toBe(false);
  });
});

// --- (e) abort mid-stream -----------------------------------------------------

describe("AC2 — opts.signal aborted mid-drain still yields exactly one cancelled, no model_end", () => {
  test("aborting between two already-parsed events ends the stream with a single cancelled provider_error", async () => {
    const stream = controlledStream();
    stream.enqueue(
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
    );

    const controller = new AbortController();
    const deps: OpenAiCompatProviderDeps = { fetch: fetchMockFor(stream.response), grant };
    const provider = new OpenAiCompatEngine(deps, identity);
    const opts: StreamOptions = { attemptId: "att-e", signal: controller.signal };
    const iterator = provider.stream(buildRequest("req-e"), opts)[Symbol.asyncIterator]();

    const events: NormalizedEvent[] = [];
    for (let i = 0; i < 2; i++) {
      const { value, done } = await iterator.next();
      expect(done).toBe(false);
      events.push(value as NormalizedEvent);
    }

    controller.abort();

    let result = await iterator.next();
    while (!result.done) {
      events.push(result.value as NormalizedEvent);
      result = await iterator.next();
    }

    expect(events.some((e) => e.kind === "model_end")).toBe(false);
    const cancelledEvents = events.filter((e) => e.kind === "provider_error" && e.error?.kind === "cancelled");
    expect(cancelledEvents).toHaveLength(1);
    const trailing = lastEvent(events);
    expect(trailing.kind).toBe("provider_error");
    expect(trailing.error?.kind).toBe("cancelled");
    expect(trailing.error?.retryable).toBe(false);
  });
});
