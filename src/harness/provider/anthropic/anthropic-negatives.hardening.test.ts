// H-01 CONSOLIDATED PROVIDER RED-TEAM FAMILY (flow 019, T5 / H-01).
//
// The provider negative families deferred from W15 (flow 018 H-01) because
// they depended on the REAL W14 `AnthropicProvider` adapter
// (`./anthropic-provider.ts`), now run offline/deterministically over that
// real adapter. See `.metaproject/flows/019-2026-07-13-keryx-harness-release1-
// boundary/{context.md,acceptance-criteria.md}` (AC1) for the frozen scope.
//
// SCOPE / NON-DUPLICATION: `anthropic-provider.test.ts` (W14 / T6) already
// covers, and this suite deliberately does NOT re-assert: 401/400/429(+valid
// retry-after)/529/5xx HTTP negatives, a garbled-JSON `data:` line, a
// post-tool-call truncated stream, an apiKey echoed in a 401 body / thrown
// network error, plain-form egress-deny hosts (127.0.0.1, ::1, 169.254.169.254,
// localhost), "no grant" capability-gate, and mid-stream cancellation on a
// fully-buffered happy-path fixture. This suite adds the genuinely
// DEFERRED/CONSOLIDATED gaps:
//   1. Timeout — a deadline-driven abort that fires AFTER `fetch()` has
//      already resolved (body-level stall), distinct from W14's fetch()-level
//      abort case.
//   2. Rate-limit variants — 429 with NO `retry-after` header, and 429 with a
//      NON-NUMERIC `retry-after` header (NaN-safety).
//   3. Truncation mid-tool-call — a torn SSE cut inside an `input_json_delta`
//      fragment (W14's truncation case cuts AFTER the tool's
//      `content_block_stop`; this one cuts WHILE the tool call is still
//      open).
//   4. Malformed variants — an unknown/unexpected SSE event type, and a
//      zero-byte response body (both undertested by W14's single
//      garbled-JSON case).
//   5. Egress-deny — ENCODED SSRF bypass forms of the base URL host (decimal,
//      hex, octal loopback; hex-encoded metadata) that are lexically
//      different tokens from the plain forms W14 already tests, exercised
//      through the real `new URL(...).hostname` + `isPrivateEgressHost` path
//      inside the adapter.
//
// Every case below drives the REAL `AnthropicProvider.stream()` to a terminal
// state (or, for the two "[FINDING]" cases, pins the adapter's ACTUAL
// terminal/non-terminal behavior) and asserts a concrete outcome — never just
// constructs the provider. OFFLINE: `fetch` is always the injected mock
// (`as unknown as typeof fetch`); no `Date.now`/`Math.random`; cancellation is
// driven by a real `AbortController` under test control, never a wall-clock
// timer.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { AnthropicCapabilityGrant, AnthropicProviderDeps } from "./anthropic-provider";
import { AnthropicProvider } from "./anthropic-provider";
import type { NormalizedError, NormalizedEvent, NormalizedRequest, StreamOptions } from "../types";

// --- Mirrored W14 fixtures/helpers (not exported by anthropic-provider.test.ts,
// so mirrored here verbatim rather than imported; kept in lockstep by the
// "READ FIRST" comment above). ---------------------------------------------

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "text-tool-usage.sse");

/** A credential value distinctive enough that any leak is unambiguous. */
const API_KEY = "sk-ant-test-DO-NOT-LEAK-0000000000000000";

function loadFixtureText(): string {
  return readFileSync(FIXTURE_PATH, "utf8");
}

/** A minimal, valid in-memory NormalizedRequest for the Anthropic adapter. */
function buildRequest(requestId: string): NormalizedRequest {
  return {
    providerId: "anthropic",
    modelId: "claude-3-5-sonnet-20241022",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "What is the weather in New York?" }],
    budget: { maxOutputTokens: 1024, runReservation: 1024 },
    stream: true,
    requestId,
    parentRunId: "run-fixture",
  };
}

function validGrant(baseUrl?: string): AnthropicCapabilityGrant {
  return baseUrl === undefined ? { network: true, apiKey: API_KEY } : { network: true, apiKey: API_KEY, baseUrl };
}

interface CapturedCall {
  input: RequestInfo | URL;
  init?: RequestInit;
}

/**
 * Build an offline `fetch` mock that records every call and resolves with the
 * `Response` supplied by `handler`. Never touches the network.
 */
function makeFetchMock(handler: (call: CapturedCall) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: CapturedCall = init === undefined ? { input } : { input, init };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fn as unknown as typeof fetch, calls };
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
  if (trailing === undefined) {
    throw new Error("expected at least one collected event");
  }
  return trailing;
}

// ---------------------------------------------------------------------------
// 1. TIMEOUT (the key deferred gap)
// ---------------------------------------------------------------------------

describe("H-01 red-team — timeout: deadline-driven abort AFTER fetch() has already resolved", () => {
  test("a stalled response body aborted mid-read via a deadline AbortSignal fails closed: stream() RESOLVES to events ending in a terminal provider_error(cancelled), never throwing an uncaught error", async () => {
    // Models a request deadline: `fetch()` resolves quickly with headers (a
    // real connection was established), but the body never closes — exactly
    // the shape of a server that accepted the request and then hung. A
    // deadline timer (represented here by a directly-controlled
    // AbortController, per the "no Date.now/Math.random" determinism rule)
    // fires the SAME `opts.signal` the adapter already wires into
    // `fetch()`'s `RequestInit.signal`.
    const controller = new AbortController();
    const stalledBody = new ReadableStream<Uint8Array>({
      start(ctrl) {
        // Mirrors real fetch/undici semantics: aborting the signal that was
        // passed into the request also errors any in-flight body read.
        controller.signal.addEventListener("abort", () => {
          ctrl.error(new DOMException("The operation was aborted.", "AbortError"));
        });
        // Deliberately never enqueue/close — the body stalls until aborted.
      },
    });
    const { fetch: fetchMock, calls } = makeFetchMock(
      () => new Response(stalledBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });
    const opts: StreamOptions = { attemptId: "attempt-timeout", signal: controller.signal };

    const collectPromise = collectEvents(provider.stream(buildRequest("request-timeout"), opts));
    // Fire the deadline once `fetch()` has had a chance to resolve and the
    // adapter has moved on to reading the (stalled) body.
    queueMicrotask(() => controller.abort());

    // FAIL-CLOSED GUARANTEE (H-01 T5 fix): the happy-path body read
    // (`await response.text()`) is now wrapped in a try/catch that mirrors the
    // earlier `this.deps.fetch(url, init)` abort handling. Because the
    // stall/abort here happens on the body read AFTER `fetch()` already
    // resolved, the rejection from `response.text()` is caught and mapped to the
    // SAME terminal `provider_error(kind:"cancelled")` event the fetch()-level
    // abort path yields — the generator RESOLVES (never throws), and a plain
    // `for await` caller observes a well-formed terminal event. No model_end.
    const events = await collectPromise;
    expect(calls).toHaveLength(1);
    const trailing = lastEvent(events);
    expect(trailing.kind).toBe("provider_error");
    const error = trailing.error as NormalizedError;
    expect(error.kind).toBe("cancelled");
    expect(error.retryable).toBe(false);
    expect(events.some((e) => e.kind === "model_end")).toBe(false);
    expect(error.message.includes(API_KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. RATE-LIMIT VARIANTS (429 without / with a non-numeric retry-after)
// ---------------------------------------------------------------------------

describe("H-01 red-team — rate-limit variants beyond W14's single 429(+valid retry-after) case", () => {
  test("429 with NO retry-after header -> rate_limit, retryable, retryAfterMs absent (not a crash, not present)", async () => {
    const { fetch: fetchMock, calls } = makeFetchMock(
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-429-no-header"), { attemptId: "attempt-429-no-header" }));

    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    const evt = events[0];
    if (evt === undefined) throw new Error("expected exactly one event");
    expect(evt.kind).toBe("provider_error");
    const error = evt.error as NormalizedError;
    expect(error.kind).toBe("rate_limit");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBeUndefined();
    expect(Number.isNaN(error.retryAfterMs)).toBe(false);
    expect(events.some((e) => e.kind === "model_end")).toBe(false);
  });

  test("429 with a NON-NUMERIC retry-after header -> fail-closed rate_limit, no NaN retryAfterMs", async () => {
    const { fetch: fetchMock, calls } = makeFetchMock(
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "soon" },
        }),
    );
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-429-nan-header"), { attemptId: "attempt-429-nan-header" }));

    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    const evt = events[0];
    if (evt === undefined) throw new Error("expected exactly one event");
    expect(evt.kind).toBe("provider_error");
    const error = evt.error as NormalizedError;
    expect(error.kind).toBe("rate_limit");
    expect(error.retryable).toBe(true);
    // The non-numeric header must never become `NaN * 1000 = NaN` on the wire.
    expect(error.retryAfterMs).toBeUndefined();
    expect(Number.isNaN(error.retryAfterMs)).toBe(false);
    expect(events.some((e) => e.kind === "model_end")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. TRUNCATION MID-TOOL-CALL (torn stream WHILE a tool call is still open)
// ---------------------------------------------------------------------------

describe("H-01 red-team — truncation mid-tool-call (torn SSE inside input_json_delta)", () => {
  test("connection drops mid input_json_delta fragment -> malformed provider_error, no tool_call_end with the partial input treated as complete, no model_end", async () => {
    const full = loadFixtureText();
    // Cut INSIDE the second `input_json_delta` data line's JSON string body,
    // well before its closing quote/brace and the blank-line record
    // terminator — this differs from W14's truncation case (which cuts AFTER
    // the tool's `content_block_stop`, once the tool call is already
    // logically closed). Here the tool call is still OPEN when the stream
    // tears.
    const marker = '"partial_json":"\\"New York, NY\\"}"}}';
    const markerIndex = full.indexOf(marker);
    expect(markerIndex).toBeGreaterThan(0);
    const cutIndex = markerIndex + 25;
    const truncated = full.slice(0, cutIndex);
    // Sanity: the cut really does land inside an unterminated data line (no
    // trailing blank-line record terminator survives the cut).
    expect(truncated.endsWith("\n\n")).toBe(false);

    const { fetch: fetchMock } = makeFetchMock(
      () => new Response(truncated, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-truncated-mid-tool-call"), { attemptId: "attempt-truncated-mid-tool-call" }));

    // The tool call genuinely started (proving this is a MID-tool-call tear,
    // not a pre-tool-call one) ...
    expect(events.some((e) => e.kind === "tool_call_start")).toBe(true);
    expect(events.some((e) => e.kind === "tool_call_delta")).toBe(true);
    // ... but never closed: the partial `input_json_delta` fragment must
    // never be surfaced as a completed `tool_call_end` (which would make a
    // downstream `toolCallExecutable()` gate treat unfinished JSON as safe
    // to parse/execute).
    expect(events.some((e) => e.kind === "tool_call_end")).toBe(false);
    expect(events.some((e) => e.kind === "model_end")).toBe(false);

    const trailing = lastEvent(events);
    expect(trailing.kind).toBe("provider_error");
    const error = trailing.error as NormalizedError;
    expect(error.kind).toBe("malformed");
    expect(error.retryable).toBe(false);
    expect(error.message.includes(API_KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. MALFORMED VARIANTS (unknown SSE event type; zero-byte response body)
// ---------------------------------------------------------------------------

describe("H-01 red-team — malformed variants beyond W14's single garbled-JSON case", () => {
  test("an unrecognized/future SSE event type mid-stream is safely ignored (forward-compatible, documented in-code), the stream still completes normally", async () => {
    // Distinguishes a genuinely NOVEL, unmapped event `type` (never `ping`,
    // already exercised implicitly by the shared fixture, nor any of the
    // switch's named cases) from a malformed/corrupt record. The adapter's
    // `switch` `default:` branch (anthropic-provider.ts) documents this as
    // intentional forward compatibility ("any unknown event carries no
    // neutral mapping"): it must NOT corrupt or abort an otherwise-valid
    // stream. This is confirmed, not a "fail-closed" family member — pinning
    // it here (rather than skipping it) closes the "unknown event type"
    // dispatch item without mis-asserting a fail-closed outcome the adapter
    // does not, and by design should not, produce.
    const full = loadFixtureText();
    const insertBefore = "event: message_stop";
    const insertionIndex = full.indexOf(insertBefore);
    expect(insertionIndex).toBeGreaterThan(0);
    const novelRecord =
      'event: content_block_reasoning_delta\ndata: {"type":"content_block_reasoning_delta","index":9,"delta":{"type":"reasoning_delta","text":"unmapped-future-field"}}\n\n';
    const withUnknownEvent = full.slice(0, insertionIndex) + novelRecord + full.slice(insertionIndex);

    const { fetch: fetchMock } = makeFetchMock(
      () => new Response(withUnknownEvent, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-unknown-event"), { attemptId: "attempt-unknown-event" }));

    expect(events.some((e) => e.kind === "model_end")).toBe(true);
    expect(events.some((e) => e.kind === "provider_error")).toBe(false);
    // The unmapped event's payload never leaks into a normalized event.
    for (const evt of events) {
      expect(JSON.stringify(evt).includes("unmapped-future-field")).toBe(false);
    }
  });

  test("a 200 OK with a zero-byte response body fails closed: exactly one terminal provider_error(kind:\"malformed\"), no model_start, no model_end — not a silent-success empty iterable", async () => {
    const { fetch: fetchMock, calls } = makeFetchMock(
      () => new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-empty-body"), { attemptId: "attempt-empty-body" }));

    expect(calls).toHaveLength(1);
    // FAIL-CLOSED GUARANTEE (H-01 T5 fix): an empty SSE body parses to zero
    // records; the adapter now detects the zero-byte body BEFORE the parse loop
    // and yields a single terminal `provider_error(kind:"malformed")` instead of
    // returning an empty async iterable. A `for await` caller can no longer
    // mistake an empty/unparseable response for a legitimate no-output attempt.
    expect(events).toHaveLength(1);
    const evt = events[0];
    if (evt === undefined) throw new Error("expected exactly one event");
    expect(evt.kind).toBe("provider_error");
    const error = evt.error as NormalizedError;
    expect(error.kind).toBe("malformed");
    expect(error.retryable).toBe(false);
    expect(error.message.includes(API_KEY)).toBe(false);
    expect(events.some((e) => e.kind === "model_start")).toBe(false);
    expect(events.some((e) => e.kind === "model_end")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. EGRESS-DENY (ENCODED SSRF bypass forms of the base URL host)
// ---------------------------------------------------------------------------

describe("H-01 red-team — egress-deny: ENCODED SSRF forms of the base URL, beyond W14's plain-form cases", () => {
  // W14 already covers the plain forms (127.0.0.1, [::1], 169.254.169.254,
  // localhost). These are lexically distinct ENCODED tokens for the same
  // denied addresses, run through the real `new URL(baseUrl).hostname` +
  // `isPrivateEgressHost` path inside the adapter (guard.ts's
  // `decodeEncodedIPv4`/`PRIVATE_EGRESS_PATTERNS`).
  const encodedDeniedBaseUrls: Array<{ baseUrl: string; label: string }> = [
    { baseUrl: "http://2130706433/", label: "decimal-encoded loopback (== 127.0.0.1)" },
    { baseUrl: "http://0x7f000001/", label: "hex-encoded loopback (== 127.0.0.1)" },
    { baseUrl: "http://017700000001/", label: "octal-encoded loopback (== 127.0.0.1)" },
    { baseUrl: "http://0xA9FEA9FE/", label: "hex-encoded cloud metadata (== 169.254.169.254)" },
  ];

  for (const { baseUrl, label } of encodedDeniedBaseUrls) {
    test(`baseUrl=${baseUrl} (${label}) -> fail-closed NormalizedError, fetch is NEVER invoked, no credential leak`, async () => {
      const { fetch: fetchMock, calls } = makeFetchMock(
        () => new Response(loadFixtureText(), { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
      const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant(baseUrl) });

      const events = await collectEvents(provider.stream(buildRequest("request-egress-deny-encoded"), { attemptId: "attempt-egress-deny-encoded" }));

      expect(calls).toHaveLength(0);
      expect(events).toHaveLength(1);
      const evt = events[0];
      if (evt === undefined) throw new Error("expected exactly one event");
      expect(evt.kind).toBe("provider_error");
      const error = evt.error as NormalizedError;
      expect(error.retryable).toBe(false);
      expect(error.message.includes(API_KEY)).toBe(false);
    });
  }
});
