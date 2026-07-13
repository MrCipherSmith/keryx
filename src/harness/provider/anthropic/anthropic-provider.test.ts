// RED tests for RP-01 (flow 018, W14 / T5).
//
// Pins the `AnthropicProvider` contract: the first REAL `ProviderPort`
// implementation (Anthropic Messages API, `POST /v1/messages`, `stream:true`
// SSE) behind an explicit capability grant and a storage-off privacy/retention
// contract. See `.metaproject/flows/018-2026-07-13-keryx-harness-w14-real-provider/
// {context.md,acceptance-criteria.md}` for the frozen AC1-AC5 this suite covers.
//
// RP-01 implements `src/harness/provider/anthropic/anthropic-provider.ts`
// (`AnthropicProvider`, `AnthropicCapabilityGrant`, `AnthropicProviderDeps`,
// `AnthropicProviderDescriptorDocument`) to make this suite GREEN (T6); until
// then the missing-module import is the expected RED failure for the WHOLE
// file (every test below fails identically at import time — this is NOT a
// per-test bug).
//
// OFFLINE / DETERMINISTIC (hard requirement, context.md "Test determinism"):
// - `fetch` is ALWAYS injected via `AnthropicProviderDeps.fetch`; no test
//   touches `globalThis.fetch` except to prove it is untouched (see the
//   "never touches the global fetch" test below).
// - The recorded SSE transcript fixture
//   (`fixtures/text-tool-usage.sse`, hand-written to the real Anthropic
//   Messages-API wire format) is read once, synchronously, via
//   `import.meta.dir`. No live network anywhere in this file.
// - No `Date.now()` / `Math.random()`.
//
// ---------------------------------------------------------------------------
// KNOWN AC1 <-> W5/W6 ARCHITECTURE GAP (flag for orchestrator/reviewer,
// see subagent-result "concern"):
//
// AC1 says (verbatim): "...every yielded event validates via `assertEventValid`
// against the frozen event schema...". `assertEventValid` (`provider-port.ts`)
// is hardcoded to validate against `harness-event.schema.json` — the DURABLE
// event ENVELOPE (schemaVersion/eventId/runId/sessionId/correlationId/sequence/
// eventType/timestamp/source/reliability/payload, `additionalProperties:false`).
// A bare in-memory `NormalizedEvent` (kind/sequence/attemptId/text/...) has
// none of those required fields and carries several the envelope schema
// rejects as additional properties, so NO `ProviderPort.stream()` — including
// this REAL adapter, which AC1 itself requires to `implement ProviderPort`
// returning `AsyncIterable<NormalizedEvent>` — can ever produce a bare event
// that independently satisfies `harness-event.schema.json`. This is not new to
// RP-01: the W6 FakeProvider suite (`fake-provider.test.ts`, section "emitted
// NormalizedEvents vs. harness-event.schema.json") hit and documented the
// identical gap, and resolved it by (a) asserting a bare NormalizedEvent is
// correctly REJECTED, and (b) demonstrating the defensible bridging shape (a
// hand-built minimal envelope carrying the event's `attemptId`) that DOES
// validate. This suite mirrors that exact precedent below ("AC1 schema-gap
// bridging (mirrors W6 precedent)") instead of asserting the literally
// unsatisfiable claim. Flagged prominently for the orchestrator to decide
// whether AC1's wording should be amended via `keryx flow ac update`.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
// PINNED API (T6 implements exactly this surface; see subagent-result for the
// full signatures). `AnthropicProvider implements ProviderPort`; constructed
// with injected `fetch` + an optional explicit capability `grant`.
import type {
  AnthropicCapabilityGrant,
  AnthropicProviderDeps,
  AnthropicProviderDescriptorDocument,
} from "./anthropic-provider";
import { AnthropicProvider } from "./anthropic-provider";
import { assertEventValid, defaultRetryable } from "../provider-port";
import type { NormalizedError, NormalizedEvent, NormalizedEventKind, NormalizedRequest, StreamOptions } from "../types";
// Reused (not rewritten) to validate `descriptorDocument()` against the
// frozen `provider-descriptor.schema.json`, exactly as `provider-port.ts`
// reuses it for `assertRequestValid`/`assertEventValid`.
import { validateAgainstSchema } from "../../../contracts/validator";

// Frozen schemas dir, computed relative to this file
// (src/harness/provider/anthropic/ -> repo root).
const SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);

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
 * `Response` (or sequence of responses) supplied by `handler`. Never touches
 * the network.
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

/** Fetch mock that always returns the recorded SSE fixture with a 200. */
function makeHappyPathFetchMock(): { fetch: typeof fetch; calls: CapturedCall[] } {
  return makeFetchMock(
    () =>
      new Response(loadFixtureText(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );
}

async function collectEvents(iterable: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const evt of iterable) {
    events.push(evt);
  }
  return events;
}

function kinds(events: NormalizedEvent[]): NormalizedEventKind[] {
  return events.map((evt) => evt.kind);
}

const EXPECTED_KIND_SEQUENCE: NormalizedEventKind[] = [
  "model_start",
  "text_delta",
  "text_delta",
  "tool_call_start",
  "tool_call_delta",
  "tool_call_delta",
  "tool_call_end",
  "usage_update",
  "model_end",
];

// --- AC1: ProviderPort conformance + normalization -------------------------

describe("AC1 — recorded SSE transcript normalizes to the exact NormalizedEventKind sequence", () => {
  test("stream() yields model_start, 2x text_delta, tool_call_start, 2x tool_call_delta, tool_call_end, usage_update, model_end with fields populated", async () => {
    const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
    const deps: AnthropicProviderDeps = { fetch: fetchMock, grant: validGrant() };
    const provider = new AnthropicProvider(deps);
    const request = buildRequest("request-happy-path");
    const opts: StreamOptions = { attemptId: "attempt-happy-path" };

    const events = await collectEvents(provider.stream(request, opts));

    expect(events).toHaveLength(9);
    expect(kinds(events)).toEqual(EXPECTED_KIND_SEQUENCE);

    // Sequence is monotonic starting at 0; every event carries opts.attemptId.
    events.forEach((evt, index) => {
      expect(evt.sequence).toBe(index);
      expect(evt.attemptId).toBe("attempt-happy-path");
    });

    expect(events[1]).toMatchObject({ kind: "text_delta", text: "The weather in " });
    expect(events[2]).toMatchObject({ kind: "text_delta", text: "NYC is: " });

    expect(events[3]).toMatchObject({
      kind: "tool_call_start",
      toolCallId: "toolu_01FixtureWeather0001",
      toolName: "get_weather",
    });
    // A tool_call_start never carries a resolved `input` (AC2 partial-call rule).
    expect(events[3]!.input).toBeUndefined();

    expect(events[4]).toMatchObject({
      kind: "tool_call_delta",
      toolCallId: "toolu_01FixtureWeather0001",
      inputDelta: '{"location": ',
    });
    expect(events[5]).toMatchObject({
      kind: "tool_call_delta",
      toolCallId: "toolu_01FixtureWeather0001",
      inputDelta: '"New York, NY"}',
    });

    const endEvent = events[6]!;
    expect(endEvent.kind).toBe("tool_call_end");
    expect(endEvent.toolCallId).toBe("toolu_01FixtureWeather0001");
    expect(typeof endEvent.input).toBe("string");
    // The two input_json_delta fragments concatenate into valid, executable JSON.
    expect(JSON.parse(endEvent.input as string)).toEqual({ location: "New York, NY" });

    const usageEvent = events[7]!;
    expect(usageEvent.kind).toBe("usage_update");
    // message_start.usage.input_tokens (25) merged with message_delta.usage.output_tokens (42).
    expect(usageEvent.usage).toEqual({
      inputTokens: 25,
      outputTokens: 42,
      totalTokens: 67,
      exact: true,
    });

    expect(events[8]!.kind).toBe("model_end");

    // Wire-request shape (Anthropic Messages API, POST /v1/messages, stream:true).
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const url = String(call.input);
    expect(url.endsWith("/v1/messages")).toBe(true);
    expect(call.init?.method).toBe("POST");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("x-api-key")).toBe(API_KEY);
    expect(headers.get("content-type")).toBe("application/json");
    const anthropicVersion = headers.get("anthropic-version");
    expect(typeof anthropicVersion === "string" && anthropicVersion.length > 0).toBe(true);
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.model).toBe("claude-3-5-sonnet-20241022");
  });

  test("no Anthropic SDK / provider-wire type crosses the ProviderPort boundary (thin fetch/SSE only)", () => {
    // NO SDK import anywhere in the adapter module tree. This assertion reads
    // the raw source text of the three pinned modules once T6 lands and greps
    // for any Anthropic-SDK import pattern; it is a source-text audit, not a
    // behavioral test, so it stays meaningful (and cheap) after GREEN.
    const modulePaths = [
      path.join(import.meta.dir, "anthropic-provider.ts"),
      path.join(import.meta.dir, "sse.ts"),
      path.join(import.meta.dir, "normalize.ts"),
    ];
    const sdkImportPattern = /@anthropic-ai\/sdk|from ["']anthropic["']/;
    for (const modulePath of modulePaths) {
      let source: string;
      try {
        source = readFileSync(modulePath, "utf8");
      } catch {
        // sse.ts / normalize.ts are optional pinned modules (may be inlined
        // into anthropic-provider.ts per the dispatch) — a missing file is
        // not itself a violation.
        continue;
      }
      expect(sdkImportPattern.test(source)).toBe(false);
    }
  });

  test("determinism: replaying the same fixture twice (fresh AnthropicProvider + fresh fetch mock) yields byte-identical NormalizedEvent snapshots", async () => {
    const request = buildRequest("request-determinism");
    const opts: StreamOptions = { attemptId: "attempt-determinism" };

    const first = await collectEvents(
      new AnthropicProvider({ fetch: makeHappyPathFetchMock().fetch, grant: validGrant() }).stream(request, opts),
    );
    const second = await collectEvents(
      new AnthropicProvider({ fetch: makeHappyPathFetchMock().fetch, grant: validGrant() }).stream(request, opts),
    );

    expect(first.length).toBeGreaterThan(0);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("never touches the global fetch (only the injected deps.fetch is called)", async () => {
    const originalFetch = globalThis.fetch;
    let globalFetchCalled = false;
    // biome-ignore lint: intentional structural network-call detector for this test only.
    globalThis.fetch = (() => {
      globalFetchCalled = true;
      throw new Error("AnthropicProvider must not touch globalThis.fetch — fetch must be injected via deps.");
    }) as unknown as typeof fetch;

    try {
      const { fetch: fetchMock } = makeHappyPathFetchMock();
      const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });
      const events = await collectEvents(provider.stream(buildRequest("request-offline"), { attemptId: "attempt-offline" }));
      expect(events.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(globalFetchCalled).toBe(false);
  });
});

// --- AC1: cancellation -------------------------------------------------------

describe("AC1 — opts.signal cancels the in-flight attempt", () => {
  test("aborting mid-stream ends the stream with a cancelled provider_error and yields no further events", async () => {
    const controller = new AbortController();
    const { fetch: fetchMock } = makeHappyPathFetchMock();
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });
    const opts: StreamOptions = { attemptId: "attempt-cancel", signal: controller.signal };

    const iterator = provider.stream(buildRequest("request-cancel"), opts)[Symbol.asyncIterator]();
    const events: NormalizedEvent[] = [];

    // Consume the first two events (model_start, text_delta) before cancelling
    // — the async generator suspends at each `yield`, so the abort below is
    // guaranteed to be observed before any further SSE bytes are processed.
    for (let i = 0; i < 2; i++) {
      const { value, done } = await iterator.next();
      expect(done).toBe(false);
      events.push(value as NormalizedEvent);
    }

    controller.abort();

    // Drain the remainder; the stream must terminate (no hang) with exactly
    // one trailing provider_error and no model_end / further text_delta.
    let result = await iterator.next();
    while (!result.done) {
      events.push(result.value as NormalizedEvent);
      result = await iterator.next();
    }

    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
    const trailing = events[events.length - 1]!;
    expect(trailing.kind).toBe("provider_error");
    const error = trailing.error as NormalizedError;
    expect(error.kind).toBe("cancelled");
    // defaultRetryable("cancelled") is unambiguously false (a deterministic
    // taxonomy row, not policy-conditional) — assert the concrete value.
    expect(defaultRetryable("cancelled")).toBe(false);
    expect(error.retryable).toBe(false);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.message.includes(API_KEY)).toBe(false);

    // Every event, including the trailing cancellation, carries the attempt id.
    expect(events.every((evt) => evt.attemptId === "attempt-cancel")).toBe(true);
  });
});

// --- AC2: storage-off / privacy-retention contract --------------------------

describe("AC2 — storage-off / privacy-retention contract", () => {
  test("describe() advertises a non-storing, non-continuing provider", () => {
    const { fetch: fetchMock } = makeHappyPathFetchMock();
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });
    const description = provider.describe();

    expect(description.descriptor.providerId).toBe("anthropic");
    expect(description.capabilities.streaming).toBe(true);
  });

  test("descriptorDocument() validates against the frozen provider-descriptor.schema.json with storage/retention/continuation = false", () => {
    // Bridges the in-memory `ProviderDescription` (returned by `describe()`,
    // per the frozen W5 `ProviderPort` interface) to the DURABLE descriptor
    // document shape `provider-descriptor.schema.json` actually validates
    // (schemaVersion/providerId/providerRevision/models/capabilities/
    // remoteState) — the same kind of bridging gap documented for
    // harness-event.schema.json below, but here RP-01's own AC2 evidence
    // requirement ("pinned research and provider fixtures pass; storage off
    // by default") is best satisfied by the adapter owning a small pure
    // method that produces this exact validating document, rather than
    // requiring `describe()` itself to change its frozen W5 return shape.
    const { fetch: fetchMock } = makeHappyPathFetchMock();
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });
    const doc: AnthropicProviderDescriptorDocument = provider.descriptorDocument();

    expect(doc.providerId).toBe("anthropic");
    expect(doc.remoteState).toEqual({ storage: false, retention: false, continuation: false });

    const result = validateAgainstSchema("provider-descriptor.schema.json", doc, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("the credential (apiKey) never appears in any yielded event, including provider_error messages", async () => {
    const { fetch: fetchMock } = makeHappyPathFetchMock();
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });
    const events = await collectEvents(provider.stream(buildRequest("request-redaction"), { attemptId: "attempt-redaction" }));

    for (const evt of events) {
      const serialized = JSON.stringify(evt);
      expect(serialized.includes(API_KEY)).toBe(false);
    }
  });

  // Proves the redaction SCRUB itself (not merely its absence): the provider
  // error BODY echoes the real apiKey back (the classic "provider echoes your
  // request incl. auth" leak, e.g. an authentication_error detail message
  // quoting the bad/received key), and the adapter's exact-match `redact()`
  // must strip it before the error ever leaves the module. Every other AC2/AC4
  // test only asserts absence on paths where the key was never present in the
  // body in the first place.
  test("an apiKey echoed back inside a provider HTTP-error body is stripped from NormalizedError.message", async () => {
    const echoingBody = {
      type: "error",
      error: {
        type: "authentication_error",
        message: `invalid x-api-key: ${API_KEY}`,
      },
    };
    const { fetch: fetchMock, calls } = makeFetchMock(
      () =>
        new Response(JSON.stringify(echoingBody), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(
      provider.stream(buildRequest("request-echoed-key"), { attemptId: "attempt-echoed-key" }),
    );

    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.kind).toBe("provider_error");
    const error = evt.error as NormalizedError;
    expect(error.kind).toBe("authentication");
    expect(error.retryable).toBe(false);
    // The scrub actually fired: the real secret is gone...
    expect(error.message.includes(API_KEY)).toBe(false);
    // ...but the non-secret provider context (and the redaction marker) survives.
    expect(error.message.includes("invalid x-api-key")).toBe(true);
    expect(error.message.includes("[redacted]")).toBe(true);
    // Belt-and-suspenders: the key is absent from the fully serialized event too.
    expect(JSON.stringify(evt).includes(API_KEY)).toBe(false);
  });

  test("an apiKey echoed inside a thrown network-failure cause is stripped from NormalizedError.message", async () => {
    const { fetch: fetchMock, calls } = makeFetchMock(() => {
      throw new Error(`network error contacting host, saw credential ${API_KEY} in transit log`);
    });
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(
      provider.stream(buildRequest("request-echoed-key-network"), { attemptId: "attempt-echoed-key-network" }),
    );

    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.kind).toBe("provider_error");
    const error = evt.error as NormalizedError;
    expect(error.kind).toBe("unavailable");
    expect(error.retryable).toBe(true);
    expect(error.message.includes(API_KEY)).toBe(false);
    expect(error.message.includes("[redacted]")).toBe(true);
    expect(JSON.stringify(evt).includes(API_KEY)).toBe(false);
  });
});

// --- AC3: capability gate + guarded egress (fail-closed) --------------------

describe("AC3 — capability gate: live fetch fires ONLY with an explicit grant", () => {
  test("no grant -> fail-closed NormalizedError, fetch is NEVER invoked", async () => {
    const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
    const deps: AnthropicProviderDeps = { fetch: fetchMock };
    const provider = new AnthropicProvider(deps);

    const events = await collectEvents(provider.stream(buildRequest("request-no-grant"), { attemptId: "attempt-no-grant" }));

    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.kind).toBe("provider_error");
    const error = evt.error as NormalizedError;
    expect(typeof error.kind).toBe("string");
    expect(error.retryable).toBe(false);
    expect(error.message.length).toBeGreaterThan(0);
  });
});

describe("AC3 — guarded egress: private/loopback/link-local/metadata base URLs are denied fail-closed", () => {
  const deniedBaseUrls = [
    "http://169.254.169.254/", // cloud metadata
    "http://127.0.0.1/", // loopback
    "http://[::1]/", // IPv6 loopback
    "http://localhost/",
  ];

  for (const baseUrl of deniedBaseUrls) {
    test(`baseUrl=${baseUrl} -> fail-closed NormalizedError, no fetch to that host`, async () => {
      const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
      const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant(baseUrl) });

      const events = await collectEvents(provider.stream(buildRequest("request-egress-deny"), { attemptId: "attempt-egress-deny" }));

      expect(calls).toHaveLength(0);
      expect(events).toHaveLength(1);
      const evt = events[0]!;
      expect(evt.kind).toBe("provider_error");
      const error = evt.error as NormalizedError;
      expect(error.retryable).toBe(false);
      expect(error.message.includes(API_KEY)).toBe(false);
    });
  }

  test("baseUrl=https://api.anthropic.com (public) is permitted — fetch IS invoked", async () => {
    const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant("https://api.anthropic.com") });

    const events = await collectEvents(provider.stream(buildRequest("request-egress-allow"), { attemptId: "attempt-egress-allow" }));

    expect(calls).toHaveLength(1);
    expect(events.some((evt) => evt.kind === "model_start")).toBe(true);
  });
});

// --- AC4: provider negatives -> fail-closed (taxonomy) -----------------------

interface HttpNegativeCase {
  name: string;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  expectedKind: NormalizedError["kind"];
  expectedRetryable: boolean;
  expectedRetryAfterMs?: number;
}

const HTTP_NEGATIVE_CASES: HttpNegativeCase[] = [
  {
    name: "401 authentication_error -> authentication (non-retryable)",
    status: 401,
    body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
    expectedKind: "authentication",
    expectedRetryable: false,
  },
  {
    name: "400 invalid_request_error -> invalid_request (non-retryable)",
    status: 400,
    body: { type: "error", error: { type: "invalid_request_error", message: "messages: at least one message is required" } },
    expectedKind: "invalid_request",
    expectedRetryable: false,
  },
  {
    name: "429 rate_limit_error (+retry-after) -> rate_limit (retryable, retryAfterMs from header)",
    status: 429,
    body: { type: "error", error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" } },
    headers: { "retry-after": "12" },
    expectedKind: "rate_limit",
    expectedRetryable: true,
    expectedRetryAfterMs: 12000,
  },
  {
    name: "529 overloaded_error -> overloaded (retryable)",
    status: 529,
    body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    expectedKind: "overloaded",
    expectedRetryable: true,
  },
  {
    name: "500 api_error -> unavailable (retryable; defaultRetryable('unavailable') is policy-conditional, adapter treats 5xx as transient)",
    status: 500,
    body: { type: "error", error: { type: "api_error", message: "Internal server error" } },
    expectedKind: "unavailable",
    expectedRetryable: true,
  },
];

describe("AC4 — non-2xx HTTP responses map to the correct ProviderErrorKind", () => {
  for (const testCase of HTTP_NEGATIVE_CASES) {
    test(testCase.name, async () => {
      const { fetch: fetchMock, calls } = makeFetchMock(
        () =>
          new Response(JSON.stringify(testCase.body), {
            status: testCase.status,
            headers: { "content-type": "application/json", ...testCase.headers },
          }),
      );
      const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });

      const events = await collectEvents(provider.stream(buildRequest(`request-${testCase.status}`), { attemptId: `attempt-${testCase.status}` }));

      expect(calls).toHaveLength(1);
      expect(events).toHaveLength(1);
      const evt = events[0]!;
      expect(evt.kind).toBe("provider_error");
      const error = evt.error as NormalizedError;
      expect(error.kind).toBe(testCase.expectedKind);
      expect(error.retryable).toBe(testCase.expectedRetryable);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.message.includes(API_KEY)).toBe(false);
      if (testCase.expectedRetryAfterMs !== undefined) {
        expect(error.retryAfterMs).toBe(testCase.expectedRetryAfterMs);
      }
      // No negative yields a partial-but-"complete" attempt.
      expect(events.some((e) => e.kind === "model_end")).toBe(false);
    });
  }
});

describe("AC4 — malformed / torn SSE and truncated streams fail closed", () => {
  test("garbled non-JSON data line -> single provider_error(kind='malformed'), partial trail preserved, no model_end", async () => {
    const garbled = 'event: message_start\ndata: {"type":"message_start", this is not valid JSON\n\n';
    const { fetch: fetchMock } = makeFetchMock(() => new Response(garbled, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-malformed"), { attemptId: "attempt-malformed" }));

    expect(events.length).toBeGreaterThan(0);
    const trailing = events[events.length - 1]!;
    expect(trailing.kind).toBe("provider_error");
    const error = trailing.error as NormalizedError;
    expect(error.kind).toBe("malformed");
    expect(error.retryable).toBe(false);
    expect(error.message.length).toBeGreaterThan(0);
    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
  });

  test("truncated stream (connection ends before message_stop) -> provider_error(kind='malformed'), no partial-but-complete attempt", async () => {
    const full = loadFixtureText();
    // Cut right after the tool call's content_block_stop, well before
    // message_delta/message_stop ever arrive — models a connection dropped
    // mid-stream.
    const cutIndex = full.indexOf('event: message_delta');
    expect(cutIndex).toBeGreaterThan(0);
    const truncated = full.slice(0, cutIndex);

    const { fetch: fetchMock } = makeFetchMock(() => new Response(truncated, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-truncated"), { attemptId: "attempt-truncated" }));

    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
    const trailing = events[events.length - 1]!;
    expect(trailing.kind).toBe("provider_error");
    const error = trailing.error as NormalizedError;
    expect(error.kind).toBe("malformed");
    expect(error.message.includes(API_KEY)).toBe(false);
  });
});

// --- AC1 schema-gap bridging (mirrors W6 precedent) --------------------------

describe("emitted NormalizedEvents vs. harness-event.schema.json (same gap W6 FakeProvider documented)", () => {
  test("a bare NormalizedEvent yielded by AnthropicProvider has no 1:1 mapping to the durable harness-event envelope and is correctly rejected", async () => {
    const { fetch: fetchMock } = makeHappyPathFetchMock();
    const provider = new AnthropicProvider({ fetch: fetchMock, grant: validGrant() });
    const events = await collectEvents(provider.stream(buildRequest("request-schema-gap"), { attemptId: "attempt-schema-gap" }));
    const bareEvent = events[1]!; // a text_delta NormalizedEvent

    const result = assertEventValid(bareEvent, SCHEMA_DIR);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("a hand-built minimal envelope wrapping the event's attemptId validates against harness-event.schema.json", () => {
    const envelope = {
      schemaVersion: 1,
      eventId: "event-anthropic-fixture-1",
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
