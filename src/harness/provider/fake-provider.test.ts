// RED tests for F-01 (flow 008, W6 / T6).
//
// Pins the `FakeProvider` contract: an offline, deterministic `ProviderPort`
// implementation that replays a committed fake-provider transcript fixture
// (`src/harness/provider/fixtures/transcripts/*.json`) into the exact ordered
// `NormalizedEvent` sequence documented by
// `docs/requirements/keryx-project-agent-harness/provider-protocol.md`
// ("Normalized Events" / "Tool Call Semantics" / "Error Taxonomy") and by
// `.metaproject/flows/008-2026-07-12-keryx-harness-w6-fakes/context.md`
// ("Raw→normalized mapping (FakeProvider replay)").
//
// F-01 implements `src/harness/provider/fake-provider.ts` (`FakeProvider`,
// `FakeProviderTranscript`, `requestHashOf`) to make this suite GREEN; until
// then the missing-module import is the expected RED failure.
//
// Deterministic: no Date.now(), no network, no randomness. Fixtures are read
// once, synchronously, from the committed dir via `import.meta.dir`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { assertEventValid } from "./provider-port";
// PINNED API (see dispatch): F-01 exports these from "./fake-provider".
// - `FakeProvider` implements `ProviderPort`; constructor takes the in-memory
//   transcript list; `stream()` selects the transcript whose `requestHash`
//   matches the request-derived hash and replays it.
// - `requestHashOf(request)` is the stable canonical hash the port and the
//   fixtures are keyed by.
import { FakeProvider, type FakeProviderTranscript, requestHashOf } from "./fake-provider";
import type { NormalizedEvent, NormalizedRequest, StreamOptions } from "./types";

// Frozen schemas dir, computed relative to this file
// (src/harness/provider/ -> repo root).
const SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures", "transcripts");

// biome-ignore lint: fixture JSON has no static type; read raw and treat as unknown-shaped data.
function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

function loadTranscript(file: string): FakeProviderTranscript {
  return readJson(path.join(FIXTURES_DIR, file)) as FakeProviderTranscript;
}

// A minimal, valid in-memory NormalizedRequest. Its exact content is
// irrelevant to the scenarios under test — only that `requestHashOf` produces
// a stable digest of it, which we then stamp onto a cloned fixture transcript
// so `FakeProvider.stream()` can select it deterministically (see NOTE below).
function buildRequest(requestId: string): NormalizedRequest {
  return {
    providerId: "fake-provider",
    modelId: "fixture-model",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "fixture prompt" }],
    budget: { maxOutputTokens: 1000, runReservation: 1000 },
    stream: true,
    requestId,
    parentRunId: "run-fixture",
  };
}

// NOTE on requestHash selection: the 8 committed fixtures carry fixed
// placeholder `requestHash` values (`"aaaa...a"`, `"bbbb...b"`, …) that are
// NOT derived from any real canonical request — they exist only to satisfy
// `fake-provider-transcript.schema.json`'s `sha256` shape. Reverse-engineering
// a `NormalizedRequest` that happens to hash to one of those fixed strings is
// neither possible nor meaningful. Instead, each test below builds its own
// `NormalizedRequest`, computes `requestHashOf(request)` (the same function
// `FakeProvider` uses internally to match), and clones the on-disk fixture
// with that computed hash substituted for its placeholder — preserving the
// fixture's `events` (the actual behavior under test) while making selection
// deterministic without needing to know the hash algorithm in advance. This
// is the "test may construct a NormalizedRequest and set its fields so
// requestHashOf matches a fixture's requestHash" option from the dispatch,
// applied in the direction that doesn't require guessing a real digest.
function withMatchingHash(transcript: FakeProviderTranscript, request: NormalizedRequest): FakeProviderTranscript {
  return { ...transcript, requestHash: requestHashOf(request) };
}

async function replay(transcript: FakeProviderTranscript, request: NormalizedRequest, attemptId: string) {
  const provider = new FakeProvider([transcript]);
  const opts: StreamOptions = { attemptId };
  const events: NormalizedEvent[] = [];
  for await (const evt of provider.stream(request, opts)) {
    events.push(evt);
  }
  return events;
}

// Every scenario resolves via a fresh request + hash-matched transcript clone
// so selection never depends on the fixture's on-disk placeholder hash.
async function replayFixture(file: string, attemptId: string) {
  const transcript = loadTranscript(file);
  const request = buildRequest(`request-${file}`);
  const matched = withMatchingHash(transcript, request);
  return { transcript, request, events: await replay(matched, request, attemptId) };
}

function expectSequential(events: NormalizedEvent[]): void {
  events.forEach((evt, index) => {
    expect(evt.sequence).toBe(index);
  });
}

function expectAllSameAttempt(events: NormalizedEvent[], attemptId: string): void {
  expect(events.every((evt) => evt.attemptId === attemptId)).toBe(true);
}

// --- 1. Per-fixture snapshot ---------------------------------------------------

describe("FakeProvider replays each committed transcript into the expected NormalizedEvent sequence", () => {
  test("text-deltas.json -> model_start, 3x text_delta, model_end (no usage_update: finish payload carries no usage)", async () => {
    const { events } = await replayFixture("text-deltas.json", "attempt-text-deltas");
    expect(events).toHaveLength(5);
    expectSequential(events);
    expectAllSameAttempt(events, "attempt-text-deltas");

    expect(events[0]!.kind).toBe("model_start");
    expect(events[1]).toMatchObject({ kind: "text_delta", text: "The quick brown fox" });
    expect(events[2]).toMatchObject({ kind: "text_delta", text: " jumps over the " });
    expect(events[3]).toMatchObject({ kind: "text_delta", text: "lazy dog." });
    expect(events[4]!.kind).toBe("model_end");
    expect(events[4]!.usage).toBeUndefined();
  });

  test("tool-call.json -> model_start, tool_call_start, tool_call_end (input = raw JSON string, executable), model_end", async () => {
    const { transcript, events } = await replayFixture("tool-call.json", "attempt-tool-call");
    expect(events).toHaveLength(4);
    expectSequential(events);
    expectAllSameAttempt(events, "attempt-tool-call");

    const rawEvent = transcript.events[0]!;
    const rawPayload = rawEvent.payload ?? {};

    expect(events[0]!.kind).toBe("model_start");
    expect(events[1]).toMatchObject({
      kind: "tool_call_start",
      toolCallId: "call-001",
      toolName: "file_read",
    });
    // tool_call_start never carries a resolved `input` (AC2 partial-call rule).
    expect(events[1]!.input).toBeUndefined();

    const endEvent = events[2]!;
    expect(endEvent.kind).toBe("tool_call_end");
    expect(endEvent.toolCallId).toBe("call-001");
    expect(typeof endEvent.input).toBe("string");
    // Exact raw-JSON round trip: the complete input parses back to the raw payload.
    expect(JSON.parse(endEvent.input as string)).toEqual(rawPayload.input);
    expect(endEvent.input).toBe(JSON.stringify(rawPayload.input));

    expect(events[3]!.kind).toBe("model_end");
  });

  test("finish-usage.json -> model_start, text_delta, usage_update (exact provider-reported counts), model_end", async () => {
    const { events } = await replayFixture("finish-usage.json", "attempt-finish-usage");
    expect(events).toHaveLength(4);
    expectSequential(events);
    expectAllSameAttempt(events, "attempt-finish-usage");

    expect(events[0]!.kind).toBe("model_start");
    expect(events[1]).toMatchObject({ kind: "text_delta", text: "Response content here." });

    const usageEvent = events[2]!;
    expect(usageEvent.kind).toBe("usage_update");
    expect(usageEvent.usage).toEqual({
      inputTokens: 42,
      outputTokens: 18,
      totalTokens: 60,
      exact: true,
    });

    expect(events[3]!.kind).toBe("model_end");
  });

  test("provider-error.json -> model_start, text_delta, provider_error (rate_limit, retryable=true); no model_end (attempt fails, does not complete)", async () => {
    const { events } = await replayFixture("provider-error.json", "attempt-provider-error");
    expect(events).toHaveLength(3);
    expectSequential(events);
    expectAllSameAttempt(events, "attempt-provider-error");

    expect(events[0]!.kind).toBe("model_start");
    expect(events[1]).toMatchObject({ kind: "text_delta", text: "Partial response before error" });

    const errorEvent = events[2]!;
    expect(errorEvent.kind).toBe("provider_error");
    expect(errorEvent.error).toEqual({
      kind: "rate_limit",
      retryable: true,
      message: "Rate limit exceeded: 100 requests per minute",
    });
    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
  });

  test("malformed-event.json -> model_start, provider_error (kind='malformed'); partial trail preserved, no tool_call_start/tool_call_end/model_end for the broken call", async () => {
    // The raw `tool_call` event's `input` is a plain string ("this is not
    // valid JSON for a tool call"), not the object shape every other
    // tool-call fixture uses. Per provider-protocol.md ("A malformed stream
    // must produce a typed provider error and preserve the partial event
    // trail") and context.md ("malformed event → typed provider_error
    // preserving the partial event trail so far"), FakeProvider cannot
    // normalize this raw event into a coherent tool_call_start/tool_call_end
    // pair, so it emits a single provider_error in place of it and stops
    // (the trailing raw `finish` in this fixture is never reached — an
    // errored attempt does not complete). This is the FakeProvider design
    // decision this suite pins for F-01; flag any deviation in the
    // subagent-result if the impl takes a different (also defensible) path
    // (e.g. still emitting tool_call_start before the error).
    const { events } = await replayFixture("malformed-event.json", "attempt-malformed");
    expect(events).toHaveLength(2);
    expectSequential(events);
    expectAllSameAttempt(events, "attempt-malformed");

    expect(events[0]!.kind).toBe("model_start");

    const errorEvent = events[1]!;
    expect(errorEvent.kind).toBe("provider_error");
    expect(errorEvent.error).toBeDefined();
    expect(errorEvent.error!.kind).toBe("malformed");
    expect(typeof errorEvent.error!.retryable).toBe("boolean");
    expect(errorEvent.error!.message.length).toBeGreaterThan(0);

    expect(events.some((evt) => evt.kind === "tool_call_end")).toBe(false);
    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
  });

  test("unknown-extension.json -> unknownExtensions preserved verbatim, namespaced, on both the text_delta and the model_end", async () => {
    const { events } = await replayFixture("unknown-extension.json", "attempt-unknown-extension");
    expect(events).toHaveLength(3);
    expectSequential(events);
    expectAllSameAttempt(events, "attempt-unknown-extension");

    expect(events[0]!.kind).toBe("model_start");

    const textEvent = events[1]!;
    expect(textEvent.kind).toBe("text_delta");
    expect(textEvent.text).toBe("Response with extension");
    expect(textEvent.unknownExtensions).toEqual({
      "provider.trace_id": "trace-12345-abcde",
      "provider.region": "us-west-2",
    });

    const endEvent = events[2]!;
    expect(endEvent.kind).toBe("model_end");
    expect(endEvent.unknownExtensions).toEqual({
      "provider.request_id": "req-67890-fghij",
    });
    // No usage in this fixture's `finish` payload -> no usage_update between them.
    expect(events.some((evt) => evt.kind === "usage_update")).toBe(false);
  });

  test("cancellation.json -> model_start, 2x text_delta, then the stream ends: no model_end, no provider_error (no `finish`/`error` raw event ever arrives)", async () => {
    // NOTE on attempt-outcome representation: the pinned FakeProvider API
    // (`ProviderPort.stream(): AsyncIterable<NormalizedEvent>`) has no
    // separate return channel for an `Attempt`/`AttemptOutcome` — cancellation
    // can only be observed through the yielded event trail itself. This
    // fixture has no trailing `finish` or `error` raw event, modeling a
    // stream that stops mid-flight (e.g. an aborted signal). This suite
    // therefore asserts the only outcome-related behavior the pinned API can
    // expose: the async generator terminates having yielded neither
    // `model_end` nor `provider_error`. If F-01 exposes a richer cancellation
    // signal (e.g. a resolved `Attempt`), note the delta in the
    // subagent-result.
    const { events } = await replayFixture("cancellation.json", "attempt-cancellation");
    expect(events).toHaveLength(3);
    expectSequential(events);
    expectAllSameAttempt(events, "attempt-cancellation");

    expect(events[0]!.kind).toBe("model_start");
    expect(events[1]).toMatchObject({ kind: "text_delta", text: "Partial response before " });
    expect(events[2]).toMatchObject({ kind: "text_delta", text: "cancellation signal received" });

    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
    expect(events.some((evt) => evt.kind === "provider_error")).toBe(false);
  });

  test("retry-boundary.json -> model_start, text_delta, provider_error (overloaded, retryable=true)", async () => {
    const { events } = await replayFixture("retry-boundary.json", "attempt-retry-boundary");
    expect(events).toHaveLength(3);
    expectSequential(events);
    expectAllSameAttempt(events, "attempt-retry-boundary");

    expect(events[0]!.kind).toBe("model_start");
    expect(events[1]).toMatchObject({ kind: "text_delta", text: "Processing request" });

    const errorEvent = events[2]!;
    expect(errorEvent.kind).toBe("provider_error");
    expect(errorEvent.error).toBeDefined();
    expect(errorEvent.error!.kind).toBe("overloaded");
    expect(errorEvent.error!.retryable).toBe(true);
    expect(errorEvent.error!.message).toBe("Provider temporarily overloaded, please retry");
  });
});

// --- 2. Determinism -------------------------------------------------------------

describe("FakeProvider replay is deterministic", () => {
  test("replaying the same transcript twice (fresh FakeProvider instances) yields byte-identical NormalizedEvent snapshots", async () => {
    const transcript = loadTranscript("tool-call.json");
    const request = buildRequest("request-determinism");
    const matched = withMatchingHash(transcript, request);

    const first = await replay(matched, request, "attempt-determinism");
    const second = await replay(matched, request, "attempt-determinism");

    expect(first.length).toBeGreaterThan(0);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("replaying every fixture twice is byte-identical, per fixture", async () => {
    const files = [
      "text-deltas.json",
      "tool-call.json",
      "finish-usage.json",
      "provider-error.json",
      "malformed-event.json",
      "unknown-extension.json",
      "cancellation.json",
      "retry-boundary.json",
    ];
    for (const file of files) {
      const transcript = loadTranscript(file);
      const request = buildRequest(`request-det-${file}`);
      const matched = withMatchingHash(transcript, request);
      const first = await replay(matched, request, "attempt-det");
      const second = await replay(matched, request, "attempt-det");
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    }
  });
});

// --- 3. Offline ------------------------------------------------------------------

describe("FakeProvider performs no network I/O", () => {
  test("replaying a transcript never invokes global fetch", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    // biome-ignore lint: intentional structural network-call detector for this test only.
    globalThis.fetch = (() => {
      called = true;
      throw new Error("FakeProvider must not perform network I/O (fetch was invoked)");
    }) as unknown as typeof fetch;

    try {
      const transcript = loadTranscript("text-deltas.json");
      const request = buildRequest("request-offline");
      const matched = withMatchingHash(transcript, request);
      const events = await replay(matched, request, "attempt-offline");
      expect(events.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(called).toBe(false);
  });
});

// --- 4. Schema validity of emitted events ----------------------------------------

describe("emitted NormalizedEvents vs. harness-event.schema.json", () => {
  test("a bare NormalizedEvent has no 1:1 mapping to the durable harness-event envelope and is correctly rejected", async () => {
    // harness-event.schema.json describes the DURABLE event envelope
    // (schemaVersion/eventId/runId/sessionId/correlationId/sequence/eventType/
    // timestamp/source/reliability/payload), which is a different shape from
    // the in-memory NormalizedEvent this suite replays (kind/sequence/
    // attemptId/text/toolCallId/...). There is no 1:1 mapping at this layer —
    // constructing a durable envelope from a NormalizedEvent is a harness
    // event-emission concern outside FakeProvider/F-01's scope. This test
    // documents that gap precisely: passing a bare NormalizedEvent directly
    // is expected to fail validation (missing eventId/runId/sessionId/
    // correlationId/timestamp/source/reliability; `kind`/`attemptId`/`text`/
    // etc. are also rejected as additional properties).
    const { events } = await replayFixture("text-deltas.json", "attempt-schema-gap");
    const bareEvent = events[1]!; // a text_delta NormalizedEvent
    const result = assertEventValid(bareEvent, SCHEMA_DIR);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("a hand-built minimal envelope wrapping a model NormalizedEvent's attemptId validates against harness-event.schema.json", () => {
    // Demonstrates the defensible bridging shape a later harness
    // event-emission layer would use: the envelope's `model` payload variant
    // only requires `kind`/`modelAttemptId`, which a NormalizedEvent's
    // `attemptId` maps onto directly.
    const envelope = {
      schemaVersion: 1,
      eventId: "event-fixture-1",
      runId: "run-fixture",
      sessionId: "session-fixture",
      correlationId: "correlation-fixture",
      sequence: 0,
      eventType: "model_start",
      timestamp: "2026-01-01T00:00:00Z",
      source: "provider",
      reliability: "exact",
      payload: { kind: "model", modelAttemptId: "attempt-schema-gap" },
    };
    const result = assertEventValid(envelope, SCHEMA_DIR);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
