// RED tests for the Ollama ProviderPort adapter (flow 020, T5 / AC1 / AC3).
//
// Pins the `OllamaProvider` contract: a thin `fetch` + SSE adapter over the
// Ollama OpenAI-compatible `/v1/chat/completions` endpoint (`stream:true`).
// See `.metaproject/flows/020-2026-07-13-keryx-harness-ollama-cli/
// {context.md,acceptance-criteria.md}` (AC1-AC5) for the frozen scope this
// suite (+ `guard.loopback.test.ts` for AC2) covers.
//
// `src/harness/provider/ollama/ollama-provider.ts` does NOT exist yet (T6
// implements it to make this suite GREEN); until then the missing-module
// import is the expected RED failure for the WHOLE file (every test below
// fails identically at import time — this is NOT a per-test bug).
//
// MIRRORS the committed W14 Anthropic adapter pattern
// (`../anthropic/anthropic-provider.test.ts`): `fetch` is ALWAYS injected via
// `OllamaProviderDeps.fetch` (no test touches `globalThis.fetch`); the
// recorded SSE transcript fixtures (`fixtures/text-stream.recorded.sse`,
// `fixtures/tool-call-stream.recorded.sse` — REAL captures against a local
// Ollama server, see context.md "Baseline") are read once, synchronously; no
// `Date.now()` / `Math.random()` anywhere in this file.
//
// WIRE MAPPING PINNED (context.md "Ollama wire -> Normalized mapping"):
//   - POST `${baseUrl}/v1/chat/completions` with `{model, stream:true,
//     messages, tools?}`.
//   - The FIRST SSE `data:` chunk always yields `model_start` (the tool-call
//     fixture's first chunk carries NO `delta.role`, only `tool_calls` — so
//     `model_start` is keyed off "first chunk", not a required `role` field).
//   - `choices[0].delta.content` (non-empty) -> `text_delta`.
//   - `choices[0].delta.tool_calls[]` -> `tool_call_start` (+ optional
//     `tool_call_delta`) -> `tool_call_end`. Ollama sends the WHOLE
//     `arguments` string in ONE chunk (not fragmented like Anthropic): a
//     single-chunk tool call still yields start+end; IF a delta is emitted,
//     its `inputDelta` concatenates to the final `input`.
//   - `choices[0].finish_reason` (stop/tool_calls/length) is DEFERRED:
//     `usage_update` (from the trailing `usage`-bearing chunk) is emitted
//     BEFORE `model_end` (mirrors the dispatch-pinned sequence
//     `model_start, text_delta x N, usage_update, model_end`).
//   - HTTP/stream negatives map to the 9-kind taxonomy: 404 (model not
//     found) -> `invalid_request`; connection-refused / 5xx -> `unavailable`;
//     malformed/torn SSE -> `malformed`; `opts.signal` aborted -> `cancelled`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
// PINNED API (T6 implements exactly this surface; see subagent-result for the
// full signatures). `OllamaProvider implements ProviderPort`; constructed with
// an injected `fetch` + an optional explicit capability `grant`.
import type {
  OllamaCapabilityGrant,
  OllamaProviderDeps,
} from "./ollama-provider";
import { OllamaProvider } from "./ollama-provider";
import { validateAgainstSchema } from "../../../contracts/validator";
import { defaultRetryable } from "../provider-port";
import type {
  NormalizedError,
  NormalizedEvent,
  NormalizedEventKind,
  NormalizedRequest,
  NormalizedToolDefinition,
  StreamOptions,
} from "../types";

// Frozen schemas dir, computed relative to this file
// (src/harness/provider/ollama/ -> repo root).
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

const TEXT_FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "text-stream.recorded.sse");
const TOOL_FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "tool-call-stream.recorded.sse");

function loadTextFixture(): string {
  return readFileSync(TEXT_FIXTURE_PATH, "utf8");
}

function loadToolFixture(): string {
  return readFileSync(TOOL_FIXTURE_PATH, "utf8");
}

/** A minimal, valid in-memory NormalizedRequest for the Ollama adapter. */
function buildRequest(requestId: string, tools?: NormalizedToolDefinition[]): NormalizedRequest {
  const request: NormalizedRequest = {
    providerId: "ollama",
    modelId: "llama3.1:latest",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "Say something pleasant, or check the weather." }],
    budget: { maxOutputTokens: 1024, runReservation: 1024 },
    stream: true,
    requestId,
    parentRunId: "run-fixture",
  };
  if (tools !== undefined) {
    request.tools = tools;
  }
  return request;
}

const WEATHER_TOOL: NormalizedToolDefinition = {
  name: "get_weather",
  description: "Look up the current weather for a city.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

/** The narrow loopback-opt-in grant Ollama needs to reach its local server. */
function validGrant(overrides?: Partial<OllamaCapabilityGrant>): OllamaCapabilityGrant {
  return { network: true, baseUrl: "http://localhost:11434", allowLoopback: true, ...overrides };
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

function makeTextFetchMock(): { fetch: typeof fetch; calls: CapturedCall[] } {
  return makeFetchMock(
    () => new Response(loadTextFixture(), { status: 200, headers: { "content-type": "text/event-stream" } }),
  );
}

function makeToolFetchMock(): { fetch: typeof fetch; calls: CapturedCall[] } {
  return makeFetchMock(
    () => new Response(loadToolFixture(), { status: 200, headers: { "content-type": "text/event-stream" } }),
  );
}

function makeFragmentedToolFetchMock(): { fetch: typeof fetch; calls: CapturedCall[] } {
  const body = readFileSync(
    path.join(import.meta.dir, "fixtures", "tool-call-stream-fragmented.recorded.sse"),
    "utf8",
  );
  return makeFetchMock(
    () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
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

function lastEvent(events: NormalizedEvent[]): NormalizedEvent {
  const trailing = events[events.length - 1];
  if (trailing === undefined) {
    throw new Error("expected at least one collected event");
  }
  return trailing;
}

// --- AC1: recorded text-stream transcript normalizes correctly -------------

describe("AC1 — recorded text-stream SSE transcript normalizes to model_start, text_delta xN, usage_update, model_end", () => {
  test("stream() yields the exact NormalizedEventKind sequence with correct text/usage/attemptId/sequence", async () => {
    const { fetch: fetchMock, calls } = makeTextFetchMock();
    const deps: OllamaProviderDeps = { fetch: fetchMock, grant: validGrant() };
    const provider = new OllamaProvider(deps);
    const request = buildRequest("request-text");
    const opts: StreamOptions = { attemptId: "attempt-text" };

    const events = await collectEvents(provider.stream(request, opts));

    // 5 non-empty content deltas: "It", "'s", " a", " pleasure", ".".
    const expectedKinds: NormalizedEventKind[] = [
      "model_start",
      "text_delta",
      "text_delta",
      "text_delta",
      "text_delta",
      "text_delta",
      "usage_update",
      "model_end",
    ];
    expect(kinds(events)).toEqual(expectedKinds);

    events.forEach((evt, index) => {
      expect(evt.sequence).toBe(index);
      expect(evt.attemptId).toBe("attempt-text");
    });

    const textDeltas = events.slice(1, 6).map((evt) => evt.text);
    expect(textDeltas).toEqual(["It", "'s", " a", " pleasure", "."]);

    const usageEvent = events[6]!;
    expect(usageEvent.kind).toBe("usage_update");
    expect(usageEvent.usage).toEqual({
      inputTokens: 16,
      outputTokens: 6,
      totalTokens: 22,
      exact: true,
    });

    expect(events[7]!.kind).toBe("model_end");

    // Wire-request shape (OpenAI-compat, POST /v1/chat/completions, stream:true).
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const url = String(call.input);
    expect(url.endsWith("/v1/chat/completions")).toBe(true);
    expect(call.init?.method).toBe("POST");
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.model).toBe("llama3.1:latest");
    expect(Array.isArray(body.messages)).toBe(true);
  });

  test("determinism: replaying the same fixture twice (fresh OllamaProvider + fresh fetch mock) yields byte-identical NormalizedEvent snapshots", async () => {
    const request = buildRequest("request-determinism");
    const opts: StreamOptions = { attemptId: "attempt-determinism" };

    const first = await collectEvents(
      new OllamaProvider({ fetch: makeTextFetchMock().fetch, grant: validGrant() }).stream(request, opts),
    );
    const second = await collectEvents(
      new OllamaProvider({ fetch: makeTextFetchMock().fetch, grant: validGrant() }).stream(request, opts),
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
      throw new Error("OllamaProvider must not touch globalThis.fetch — fetch must be injected via deps.");
    }) as unknown as typeof fetch;

    try {
      const { fetch: fetchMock } = makeTextFetchMock();
      const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });
      const events = await collectEvents(provider.stream(buildRequest("request-offline"), { attemptId: "attempt-offline" }));
      expect(events.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(globalFetchCalled).toBe(false);
  });

  test("no provider SDK / provider-wire type crosses the ProviderPort boundary (thin fetch/SSE only)", () => {
    const modulePaths = [
      path.join(import.meta.dir, "ollama-provider.ts"),
      path.join(import.meta.dir, "normalize.ts"),
    ];
    const sdkImportPattern = /from ["']ollama["']|@ollama\/|ollama-js/i;
    for (const modulePath of modulePaths) {
      let source: string;
      try {
        source = readFileSync(modulePath, "utf8");
      } catch {
        // normalize.ts is an optional pinned module (may be inlined into
        // ollama-provider.ts per the dispatch) — a missing file is not itself
        // a violation.
        continue;
      }
      expect(sdkImportPattern.test(source)).toBe(false);
    }
  });
});

// --- AC1: recorded tool-call-stream transcript normalizes correctly --------

describe("AC1 — recorded tool-call-stream SSE transcript normalizes tool_call_start/[delta]/end", () => {
  test("stream() yields model_start, tool_call_start, [tool_call_delta], tool_call_end, usage_update, model_end with the FULL input JSON string", async () => {
    const { fetch: fetchMock } = makeToolFetchMock();
    const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });
    const request = buildRequest("request-tool", [WEATHER_TOOL]);
    const opts: StreamOptions = { attemptId: "attempt-tool" };

    const events = await collectEvents(provider.stream(request, opts));
    const eventKinds = kinds(events);

    // A single-chunk tool call still yields start+end; an OPTIONAL
    // tool_call_delta may appear between them (dispatch: "if a delta is
    // emitted, its inputDelta concatenates to input").
    const withoutDelta = eventKinds.filter((kind) => kind !== "tool_call_delta");
    expect(withoutDelta).toEqual(["model_start", "tool_call_start", "tool_call_end", "usage_update", "model_end"]);

    const startEvent = events.find((evt) => evt.kind === "tool_call_start")!;
    expect(startEvent.toolCallId).toBe("call_co2o5jvx");
    expect(startEvent.toolName).toBe("get_weather");
    // A tool_call_start never carries a resolved `input`.
    expect(startEvent.input).toBeUndefined();

    const deltaEvents = events.filter((evt) => evt.kind === "tool_call_delta");
    const endEvent = events.find((evt) => evt.kind === "tool_call_end")!;
    expect(endEvent.toolCallId).toBe("call_co2o5jvx");
    expect(typeof endEvent.input).toBe("string");
    expect(JSON.parse(endEvent.input as string)).toEqual({ city: "Paris" });

    // If deltas were emitted, their concatenation equals the final input.
    if (deltaEvents.length > 0) {
      const concatenated = deltaEvents.map((evt) => evt.inputDelta ?? "").join("");
      expect(concatenated).toBe(endEvent.input as string);
      for (const delta of deltaEvents) {
        expect(delta.toolCallId).toBe("call_co2o5jvx");
      }
    }

    const usageEvent = events.find((evt) => evt.kind === "usage_update")!;
    expect(usageEvent.usage).toEqual({
      inputTokens: 161,
      outputTokens: 17,
      totalTokens: 178,
      exact: true,
    });

    expect(events.some((evt) => evt.kind === "model_end")).toBe(true);

    // Sequence is monotonic starting at 0; every event carries opts.attemptId.
    events.forEach((evt, index) => {
      expect(evt.sequence).toBe(index);
      expect(evt.attemptId).toBe("attempt-tool");
    });
  });

  test("fragmented OpenAI/Z.AI tool_call argument chunks are ACCUMULATED into one full input", async () => {
    // Regression: emitting tool_call_end on every SSE chunk left empty/partial
    // inputs → agent "Missing required property" spam for search_code/read_wiki.
    const { fetch: fetchMock } = makeFragmentedToolFetchMock();
    const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });
    const events = await collectEvents(
      provider.stream(buildRequest("request-frag", [WEATHER_TOOL]), { attemptId: "attempt-frag" }),
    );

    const ends = events.filter((e) => e.kind === "tool_call_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.toolCallId).toBe("call_frag1");
    expect(JSON.parse(ends[0]!.input as string)).toEqual({ pattern: "wiki enrich" });

    const starts = events.filter((e) => e.kind === "tool_call_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.toolName).toBe("search_code");

    // Deltas concatenate to the final input (OpenAI-style streaming).
    const deltas = events.filter((e) => e.kind === "tool_call_delta");
    expect(deltas.map((d) => d.inputDelta ?? "").join("")).toBe(ends[0]!.input as string);
  });
});

// --- AC1: opts.signal cancels -----------------------------------------------

describe("AC1 — opts.signal cancels the in-flight attempt", () => {
  test("aborting mid-stream ends the stream with a cancelled provider_error and yields no further events", async () => {
    const controller = new AbortController();
    const { fetch: fetchMock } = makeTextFetchMock();
    const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });
    const opts: StreamOptions = { attemptId: "attempt-cancel", signal: controller.signal };

    const iterator = provider.stream(buildRequest("request-cancel"), opts)[Symbol.asyncIterator]();
    const events: NormalizedEvent[] = [];

    // Consume the first two events (model_start, text_delta) before
    // cancelling — the async generator suspends at each `yield`, so the abort
    // below is guaranteed to be observed before any further SSE bytes process.
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

    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
    const trailing = lastEvent(events);
    expect(trailing.kind).toBe("provider_error");
    const error = trailing.error as NormalizedError;
    expect(error.kind).toBe("cancelled");
    expect(defaultRetryable("cancelled")).toBe(false);
    expect(error.retryable).toBe(false);
    expect(error.message.length).toBeGreaterThan(0);

    expect(events.every((evt) => evt.attemptId === "attempt-cancel")).toBe(true);
  });
});

// --- AC1: describe()/descriptorDocument() (local, stateless) ----------------

describe("AC1 — describe()/descriptorDocument() advertise storage/retention/continuation = false", () => {
  test("describe() advertises the ollama provider identity", () => {
    const { fetch: fetchMock } = makeTextFetchMock();
    const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });
    const description = provider.describe();

    expect(description.descriptor.providerId).toBe("ollama");
    expect(description.capabilities.streaming).toBe(true);
  });

  test("descriptorDocument() validates against the frozen provider-descriptor.schema.json with storage/retention/continuation = false", () => {
    const { fetch: fetchMock } = makeTextFetchMock();
    const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });
    const doc = provider.descriptorDocument();

    expect(doc.providerId).toBe("ollama");
    expect(doc.remoteState).toEqual({ storage: false, retention: false, continuation: false });

    const result = validateAgainstSchema("provider-descriptor.schema.json", doc, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// --- AC3: provider negatives fail-closed (9-kind taxonomy) ------------------

describe("AC3 — provider negatives map to the correct ProviderErrorKind, fail-closed, no spurious model_end", () => {
  test("HTTP 404 (model not found) -> invalid_request (non-retryable)", async () => {
    const { fetch: fetchMock, calls } = makeFetchMock(
      () =>
        new Response(JSON.stringify({ error: { message: "model 'ghost:latest' not found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-404"), { attemptId: "attempt-404" }));

    expect(calls).toHaveLength(1);
    const trailing = lastEvent(events);
    expect(trailing.kind).toBe("provider_error");
    const error = trailing.error as NormalizedError;
    expect(error.kind).toBe("invalid_request");
    expect(error.retryable).toBe(false);
    expect(error.message.length).toBeGreaterThan(0);
    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
  });

  test("HTTP 500 -> unavailable (retryable)", async () => {
    const { fetch: fetchMock, calls } = makeFetchMock(
      () =>
        new Response(JSON.stringify({ error: { message: "internal server error" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-500"), { attemptId: "attempt-500" }));

    expect(calls).toHaveLength(1);
    const trailing = lastEvent(events);
    expect(trailing.kind).toBe("provider_error");
    const error = trailing.error as NormalizedError;
    expect(error.kind).toBe("unavailable");
    expect(error.retryable).toBe(true);
    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
  });

  test("connection refused (fetch throws) -> unavailable (retryable), fetch attempted once", async () => {
    const { fetch: fetchMock, calls } = makeFetchMock(() => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    });
    const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(
      provider.stream(buildRequest("request-connrefused"), { attemptId: "attempt-connrefused" }),
    );

    expect(calls).toHaveLength(1);
    const trailing = lastEvent(events);
    expect(trailing.kind).toBe("provider_error");
    const error = trailing.error as NormalizedError;
    expect(error.kind).toBe("unavailable");
    expect(error.retryable).toBe(true);
    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
  });

  test("malformed / torn SSE body -> malformed (non-retryable), partial trail preserved, no model_end", async () => {
    const garbled = 'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant", this is not valid JSON\n\n';
    const { fetch: fetchMock } = makeFetchMock(
      () => new Response(garbled, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(
      provider.stream(buildRequest("request-malformed"), { attemptId: "attempt-malformed" }),
    );

    expect(events.length).toBeGreaterThan(0);
    const trailing = lastEvent(events);
    expect(trailing.kind).toBe("provider_error");
    const error = trailing.error as NormalizedError;
    expect(error.kind).toBe("malformed");
    expect(error.retryable).toBe(false);
    expect(error.message.length).toBeGreaterThan(0);
    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
  });

  test("signal already aborted before streaming starts -> cancelled (non-retryable), no model_end", async () => {
    const controller = new AbortController();
    controller.abort();
    // Whether or not the adapter still attempts fetch() with an already-aborted
    // signal is an implementation detail; either way the terminal outcome must
    // be a fail-closed `cancelled` error, never a hang or an uncaught throw.
    const { fetch: fetchMock } = makeFetchMock(() => {
      throw new Error("signal already aborted");
    });
    const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(
      provider.stream(buildRequest("request-preaborted"), { attemptId: "attempt-preaborted", signal: controller.signal }),
    );

    const trailing = lastEvent(events);
    expect(trailing.kind).toBe("provider_error");
    const error = trailing.error as NormalizedError;
    expect(error.kind).toBe("cancelled");
    expect(error.retryable).toBe(false);
    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
  });
});

// --- flow 047: optional bearer credential (OpenRouter / authenticated gateways) --

test("sends Authorization: Bearer when the grant carries an apiKey", async () => {
  const { fetch: fetchMock, calls } = makeTextFetchMock();
  const provider = new OllamaProvider({
    fetch: fetchMock,
    grant: validGrant({ apiKey: "sk-or-test", baseUrl: "https://openrouter.ai/api", allowLoopback: false }),
  });
  await collectEvents(provider.stream(buildRequest("request-auth"), { attemptId: "attempt-auth" }));
  const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
  expect(headers?.authorization).toBe("Bearer sk-or-test");
});

test("sends extra grant headers alongside the bearer credential", async () => {
  const { fetch: fetchMock, calls } = makeTextFetchMock();
  const provider = new OllamaProvider({
    fetch: fetchMock,
    grant: validGrant({
      apiKey: "sk-or-test",
      baseUrl: "https://openrouter.ai/api",
      allowLoopback: false,
      headers: { "http-referer": "https://keryx.dev" },
    }),
  });
  await collectEvents(provider.stream(buildRequest("request-hdrs"), { attemptId: "attempt-hdrs" }));
  const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
  expect(headers?.["http-referer"]).toBe("https://keryx.dev");
});

test("sends NO Authorization header for a keyless (local ollama) grant", async () => {
  const { fetch: fetchMock, calls } = makeTextFetchMock();
  const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });
  await collectEvents(provider.stream(buildRequest("request-noauth"), { attemptId: "attempt-noauth" }));
  const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
  expect(headers?.authorization).toBeUndefined();
});

// --- flow 049: OpenAI-compatible tool-message serialization -------------------

test("serializes a normalized role:tool message as a framed user message (no bare tool role)", async () => {
  const { fetch: fetchMock, calls } = makeTextFetchMock();
  const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });
  const request: NormalizedRequest = {
    ...buildRequest("request-tool-msg"),
    messages: [
      { role: "user", content: "check health" },
      { role: "tool", content: "gate: warn" },
    ],
  };
  await collectEvents(provider.stream(request, { attemptId: "attempt-tool-msg" }));

  const body = JSON.parse((calls[0]?.init?.body as string) ?? "{}") as {
    messages: Array<{ role: string; content: string }>;
  };
  expect(body.messages.map((m) => m.role)).not.toContain("tool");
  const framed = body.messages.find((m) => m.content.includes("gate: warn"));
  expect(framed?.role).toBe("user");
  expect(framed?.content).toContain("Tool result:");
});

// --- flow 056: reasoning_delta surfacing (OpenRouter/DeepSeek) ----------------

function reasoningFetchMock(sse: string): { fetch: typeof fetch; calls: CapturedCall[] } {
  return makeFetchMock(
    () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
  );
}

test("flow 056: delta.reasoning is surfaced as reasoning_delta, before the answer text_delta", async () => {
  const sse =
    'data: {"choices":[{"delta":{"reasoning":"thinking hard"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"Answer."}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  const { fetch: fetchMock } = reasoningFetchMock(sse);
  const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });
  const events = await collectEvents(provider.stream(buildRequest("req-reasoning"), { attemptId: "att-r" }));
  const kinds = events.map((e) => e.kind);
  const rIdx = kinds.indexOf("reasoning_delta");
  const tIdx = kinds.indexOf("text_delta");
  expect(rIdx).toBeGreaterThanOrEqual(0);
  expect(tIdx).toBeGreaterThan(rIdx); // reasoning precedes the answer
  expect(events[rIdx]?.text).toBe("thinking hard");
});

test("flow 056: delta.reasoning_content (DeepSeek field name) is also surfaced", async () => {
  const sse =
    'data: {"choices":[{"delta":{"reasoning_content":"deepseek cot"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
    "data: [DONE]\n\n";
  const { fetch: fetchMock } = reasoningFetchMock(sse);
  const provider = new OllamaProvider({ fetch: fetchMock, grant: validGrant() });
  const events = await collectEvents(provider.stream(buildRequest("req-ds"), { attemptId: "att-ds" }));
  const reasoning = events.find((e) => e.kind === "reasoning_delta");
  expect(reasoning?.text).toBe("deepseek cot");
});
