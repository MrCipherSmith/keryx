// Incremental streaming + deadline tests for `AnthropicProvider` (flow 268, T22).
// `anthropic-provider.test.ts` covers normalization against fully-buffered
// SYNTHETIC fixtures, and `anthropic-negatives.hardening.test.ts` covers the
// H-01 red-team negatives. This file is the DEDICATED regression suite for
// the incremental-read rewrite itself, mirroring `../openai/openai-streaming
// .test.ts`'s conventions exactly: a caller must observe each parsed event as
// soon as it is available (not only once the connection closes), a stalled
// connection must fail closed on two independent deadlines, the flow-019
// abort contract (exactly one terminal `cancelled`, never a `model_end`)
// must survive the rewrite, and a terminal SSE `error` event (this task's
// new addition — Anthropic can abandon an in-progress stream with `event:
// error` instead of a normal `message_stop`, e.g. `overloaded_error` under
// load) must end the turn the same way `message_stop` does.
//
// Every stream body here is a hand-controlled `ReadableStream<Uint8Array>`
// (never a plain `new Response(fullString)`, which the existing suites
// already cover) so a chunk's arrival, or its absence, is exactly what each
// test asserts against.
import { describe, expect, test } from "bun:test";
import { AnthropicProvider, type AnthropicCapabilityGrant, type AnthropicProviderDeps } from "./anthropic-provider";
import type { NormalizedEvent, NormalizedRequest, StreamOptions } from "../types";

const API_KEY = "[REDACTED:secret]";

function buildRequest(requestId: string): NormalizedRequest {
  return {
    providerId: "anthropic",
    modelId: "claude-3-5-sonnet-20241022",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "What is the weather in New York?" }],
    budget: { maxOutputTokens: 1024, runReservation: 1024 },
    stream: true,
    requestId,
    parentRunId: requestId,
  };
}

function validGrant(): AnthropicCapabilityGrant {
  return { network: true, apiKey: API_KEY };
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
  test("message_start + content_block_delta yield model_start then text_delta while the connection stays open", async () => {
    const stream = controlledStream();
    stream.enqueue(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
    );
    // Deliberately never closed — a fully-buffered `response.text()` read
    // would hang forever here; the incremental reader must not.

    const deps: AnthropicProviderDeps = { fetch: fetchMockFor(stream.response), grant: validGrant() };
    const provider = new AnthropicProvider(deps);
    const iterator = provider.stream(buildRequest("req-a"), { attemptId: "att-a" })[Symbol.asyncIterator]();

    const first = await iterator.next();
    const second = await iterator.next();

    expect(first.done).toBe(false);
    expect((first.value as NormalizedEvent).kind).toBe("model_start");
    expect(second.done).toBe(false);
    expect(second.value).toMatchObject({ kind: "text_delta", text: "partial" });
  });
});

// --- (b) message_stop without closing still ends the turn ------------------

describe("AC1 — message_stop ends the turn even when the socket never closes", () => {
  test("model_start, text_delta, usage_update, model_end are yielded and the iterator finishes on its own", async () => {
    const stream = controlledStream();
    stream.enqueue(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":2}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    // Never closed: the adapter must stop reading on its own once it sees
    // `message_stop`, per AC1, rather than waiting for the socket to close.

    const deps: AnthropicProviderDeps = { fetch: fetchMockFor(stream.response), grant: validGrant() };
    const provider = new AnthropicProvider(deps);
    const events = await collectEvents(provider.stream(buildRequest("req-b"), { attemptId: "att-b" }));

    expect(events.map((e) => e.kind)).toEqual(["model_start", "text_delta", "usage_update", "model_end"]);
  });
});

// --- (b2) a terminal SSE `error` event without closing also ends the turn --

describe("AC1 — a terminal SSE error event ends the turn without message_stop", () => {
  test("event: error with overloaded_error maps to a single retryable overloaded provider_error, no model_end", async () => {
    const stream = controlledStream();
    stream.enqueue(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n' +
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    );
    // Never closed: the adapter must stop reading on its own once it sees the
    // terminal `error` event, mirroring `message_stop`.

    const deps: AnthropicProviderDeps = { fetch: fetchMockFor(stream.response), grant: validGrant() };
    const provider = new AnthropicProvider(deps);
    const events = await collectEvents(provider.stream(buildRequest("req-b2"), { attemptId: "att-b2" }));

    expect(events.map((e) => e.kind)).toEqual(["model_start", "provider_error"]);
    const trailing = lastEvent(events);
    expect(trailing.error?.kind).toBe("overloaded");
    expect(trailing.error?.retryable).toBe(true);
    expect(events.some((e) => e.kind === "model_end")).toBe(false);
  });
});

// --- (c) first-byte timeout --------------------------------------------------

describe("AC2 — first-byte timeout fails closed", () => {
  test("no byte ever arrives -> exactly one retryable unavailable provider_error, no model_end", async () => {
    const stream = controlledStream();
    // Never enqueue, never close: the body stalls before its first byte.

    const deps: AnthropicProviderDeps = {
      fetch: fetchMockFor(stream.response),
      grant: validGrant(),
      firstByteTimeoutMs: 20,
      idleTimeoutMs: 20,
    };
    const provider = new AnthropicProvider(deps);
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
    stream.enqueue('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n');
    // One byte arrives, then the connection stalls — never closed, never
    // fed another chunk.

    const deps: AnthropicProviderDeps = {
      fetch: fetchMockFor(stream.response),
      grant: validGrant(),
      firstByteTimeoutMs: 5_000,
      idleTimeoutMs: 20,
    };
    const provider = new AnthropicProvider(deps);
    const events = await collectEvents(provider.stream(buildRequest("req-d"), { attemptId: "att-d" }));

    expect(events.some((e) => e.kind === "model_start")).toBe(true);
    const trailing = lastEvent(events);
    expect(trailing.kind).toBe("provider_error");
    expect(trailing.error?.kind).toBe("unavailable");
    expect(trailing.error?.retryable).toBe(true);
    expect(events.some((e) => e.kind === "model_end")).toBe(false);
  });
});

// --- (f) zero-byte body regression (incremental read must not silently yield nothing) --

describe("AC1 — a 200 with literally zero bytes still fails closed", () => {
  test("the stream closes immediately with no chunk -> exactly one malformed provider_error, no model_start/model_end", async () => {
    const stream = controlledStream();
    stream.close();

    const deps: AnthropicProviderDeps = { fetch: fetchMockFor(stream.response), grant: validGrant() };
    const provider = new AnthropicProvider(deps);
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
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":2}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );

    const controller = new AbortController();
    const deps: AnthropicProviderDeps = { fetch: fetchMockFor(stream.response), grant: validGrant() };
    const provider = new AnthropicProvider(deps);
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
