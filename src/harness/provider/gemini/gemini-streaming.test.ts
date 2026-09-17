// Incremental streaming + deadline tests for `GeminiProvider` (flow 268, T22).
// `gemini-provider.test.ts` covers normalization against fully-buffered
// SYNTHETIC fixtures and HTTP/terminal negatives. This file is the DEDICATED
// regression suite for the incremental-read rewrite itself, mirroring
// `../openai/openai-streaming.test.ts`'s and `../anthropic/anthropic-
// streaming.test.ts`'s conventions: a caller must observe each parsed event
// as soon as it is available (not only once the connection closes), a
// stalled connection must fail closed on two independent deadlines, and the
// flow-019 abort contract (exactly one terminal `cancelled`, never a
// `model_end`) must survive the rewrite.
//
// TERMINAL DETECTION NOTE (see the module header comment in
// `gemini-provider.ts` for the full rationale): unlike Anthropic's dedicated
// `message_stop` event or OpenAI's `response.completed`, every
// `GenerateContentResponse` chunk on this legacy `generateContent` endpoint
// shares the SAME JSON shape — completion is signalled by a `finishReason`
// field appearing on the first candidate of the terminal chunk, not by a
// distinct event type. Test (b) below proves that field IS detected
// incrementally, per-record, exactly like the other two adapters' dedicated
// terminal events — the read loop stops as soon as it sees `finishReason`,
// never waiting for the socket to close.
//
// Every stream body here is a hand-controlled `ReadableStream<Uint8Array>`
// (never a plain `new Response(fullString)`, which the existing suite
// already covers) so a chunk's arrival, or its absence, is exactly what each
// test asserts against.
import { describe, expect, test } from "bun:test";
import { GeminiProvider, type GeminiCapabilityGrant, type GeminiProviderDeps } from "./gemini-provider";
import type { NormalizedEvent, NormalizedRequest, StreamOptions } from "../types";

const API_KEY = "[REDACTED:secret]";

function buildRequest(requestId: string): NormalizedRequest {
  return {
    providerId: "gemini",
    modelId: "gemini-2.5-flash",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "What is the weather in New York?" }],
    budget: { maxOutputTokens: 1024, runReservation: 1024 },
    stream: true,
    requestId,
    parentRunId: requestId,
  };
}

function validGrant(): GeminiCapabilityGrant {
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

/** One `data:`-framed `GenerateContentResponse` chunk. */
function sseChunk(json: Record<string, unknown>): string {
  return `data: ${JSON.stringify(json)}\n\n`;
}

// --- (a) a chunk observed before the stream ever closes ---------------------

describe("AC1 — a text chunk is yielded before the underlying stream closes", () => {
  test("one chunk with a text part yields model_start then text_delta while the connection stays open", async () => {
    const stream = controlledStream();
    stream.enqueue(sseChunk({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }));
    // Deliberately never closed — a fully-buffered `response.text()` read
    // would hang forever here; the incremental reader must not.

    const deps: GeminiProviderDeps = { fetch: fetchMockFor(stream.response), grant: validGrant() };
    const provider = new GeminiProvider(deps);
    const iterator = provider.stream(buildRequest("req-a"), { attemptId: "att-a" })[Symbol.asyncIterator]();

    const first = await iterator.next();
    const second = await iterator.next();

    expect(first.done).toBe(false);
    expect((first.value as NormalizedEvent).kind).toBe("model_start");
    expect(second.done).toBe(false);
    expect(second.value).toMatchObject({ kind: "text_delta", text: "partial" });
  });
});

// --- (b) a finishReason chunk without closing still ends the turn ----------

describe("AC1 — a finishReason chunk ends the turn even when the socket never closes", () => {
  test("model_start, text_delta, usage_update, model_end are yielded and the iterator finishes on its own", async () => {
    const stream = controlledStream();
    stream.enqueue(sseChunk({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] }));
    stream.enqueue(
      sseChunk({
        candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      }),
    );
    // Never closed: the adapter must stop reading on its own once it sees a
    // `finishReason`, per AC1, rather than waiting for the socket to close —
    // this endpoint has no distinct terminal-event type, unlike Anthropic's
    // `message_stop` / OpenAI's `response.completed`.

    const deps: GeminiProviderDeps = { fetch: fetchMockFor(stream.response), grant: validGrant() };
    const provider = new GeminiProvider(deps);
    const events = await collectEvents(provider.stream(buildRequest("req-b"), { attemptId: "att-b" }));

    expect(events.map((e) => e.kind)).toEqual(["model_start", "text_delta", "usage_update", "model_end"]);
  });
});

// --- (c) first-byte timeout --------------------------------------------------

describe("AC2 — first-byte timeout fails closed", () => {
  test("no byte ever arrives -> exactly one retryable unavailable provider_error, no model_end", async () => {
    const stream = controlledStream();
    // Never enqueue, never close: the body stalls before its first byte.

    const deps: GeminiProviderDeps = {
      fetch: fetchMockFor(stream.response),
      grant: validGrant(),
      firstByteTimeoutMs: 20,
      idleTimeoutMs: 20,
    };
    const provider = new GeminiProvider(deps);
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
  test("one chunk then silence, no finishReason ever reported -> exactly one retryable unavailable provider_error, no model_end", async () => {
    const stream = controlledStream();
    stream.enqueue(sseChunk({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }));
    // One byte arrives, then the connection stalls — never closed, never
    // fed another chunk, no finishReason ever reported. This endpoint has no
    // way to detect completion other than a finishReason or the connection
    // closing, so a stall here can ONLY be caught by the idle-timeout
    // deadline (module-header rationale).

    const deps: GeminiProviderDeps = {
      fetch: fetchMockFor(stream.response),
      grant: validGrant(),
      firstByteTimeoutMs: 5_000,
      idleTimeoutMs: 20,
    };
    const provider = new GeminiProvider(deps);
    const events = await collectEvents(provider.stream(buildRequest("req-d"), { attemptId: "att-d" }));

    expect(events.some((e) => e.kind === "text_delta")).toBe(true);
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

    const deps: GeminiProviderDeps = { fetch: fetchMockFor(stream.response), grant: validGrant() };
    const provider = new GeminiProvider(deps);
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
    stream.enqueue(sseChunk({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] }));
    stream.enqueue(
      sseChunk({
        candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      }),
    );

    const controller = new AbortController();
    const deps: GeminiProviderDeps = { fetch: fetchMockFor(stream.response), grant: validGrant() };
    const provider = new GeminiProvider(deps);
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
