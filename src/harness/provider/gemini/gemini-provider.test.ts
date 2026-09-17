// Tests for `GeminiProvider` (flow 183, T7 / AC2, AC4, AC5, AC6).
//
// Mirrors `AnthropicProvider`'s test conventions
// (`../anthropic/anthropic-provider.test.ts`): offline-only, `fetch` always
// injected, a hand-authored `.SYNTHETIC.`-caveated SSE fixture (see
// `../../../../fixtures/provider-breadth/gemini/manifest.json` for full
// provenance — no live API key was available, see AC2/description.md's
// "Known, explicit deviation from the docpack").
//
// OFFLINE / DETERMINISTIC: `fetch` is ALWAYS injected via
// `GeminiProviderDeps.fetch`; no test touches `globalThis.fetch` except to
// prove it is untouched. No `Date.now()` / `Math.random()`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { GeminiCapabilityGrant, GeminiProviderDeps } from "./gemini-provider";
import { GeminiProvider } from "./gemini-provider";
import { defaultRetryable } from "../provider-port";
import type { NormalizedError, NormalizedEvent, NormalizedEventKind, NormalizedRequest, StreamOptions } from "../types";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "text-tool-usage.sse");
const ERROR_FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "error-invalid-argument.json");

/** A credential value distinctive enough that any leak is unambiguous. */
const API_KEY = "AIzaFixtureDoNotLeak0000000000000000";

function loadFixtureText(fixturePath: string): string {
  return readFileSync(fixturePath, "utf8");
}

/** A minimal, valid in-memory NormalizedRequest for the Gemini adapter. */
function buildRequest(requestId: string, overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    providerId: "gemini",
    modelId: "gemini-2.5-flash",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "What is the weather in New York?" }],
    budget: { maxOutputTokens: 1024, runReservation: 1024 },
    stream: true,
    requestId,
    parentRunId: "run-fixture",
    ...overrides,
  };
}

function validGrant(baseUrl?: string): GeminiCapabilityGrant {
  return baseUrl === undefined ? { network: true, apiKey: API_KEY } : { network: true, apiKey: API_KEY, baseUrl };
}

interface CapturedCall {
  input: RequestInfo | URL;
  init?: RequestInit;
}

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

function makeHappyPathFetchMock(): { fetch: typeof fetch; calls: CapturedCall[] } {
  return makeFetchMock(
    () =>
      new Response(loadFixtureText(FIXTURE_PATH), {
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
  "tool_call_end",
  "usage_update",
  "model_end",
];

// --- AC2 / AC5: ProviderPort conformance + normalization --------------------

describe("AC2 — recorded SSE transcript normalizes to the exact NormalizedEventKind sequence", () => {
  test("stream() yields model_start, 2x text_delta, tool_call_start, tool_call_end (whole-args, no delta), usage_update, model_end", async () => {
    const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
    const deps: GeminiProviderDeps = { fetch: fetchMock, grant: validGrant() };
    const provider = new GeminiProvider(deps);
    const request = buildRequest("request-happy-path");
    const opts: StreamOptions = { attemptId: "attempt-happy-path" };

    const events = await collectEvents(provider.stream(request, opts));

    expect(events).toHaveLength(7);
    expect(kinds(events)).toEqual(EXPECTED_KIND_SEQUENCE);

    events.forEach((evt, index) => {
      expect(evt.sequence).toBe(index);
      expect(evt.attemptId).toBe("attempt-happy-path");
    });

    expect(events[1]).toMatchObject({ kind: "text_delta", text: "The weather in " });
    expect(events[2]).toMatchObject({ kind: "text_delta", text: "NYC is: " });

    expect(events[3]).toMatchObject({
      kind: "tool_call_start",
      toolCallId: "call_01FixtureWeather0001",
      toolName: "get_weather",
    });

    const endEvent = events[4]!;
    expect(endEvent.kind).toBe("tool_call_end");
    expect(endEvent.toolCallId).toBe("call_01FixtureWeather0001");
    expect(typeof endEvent.input).toBe("string");
    // Gemini does NOT stream partial function-call args by default: the
    // whole args object arrives in the SAME chunk as the functionCall part,
    // so tool_call_end's input is immediately valid, complete JSON with no
    // preceding tool_call_delta.
    expect(JSON.parse(endEvent.input as string)).toEqual({ location: "New York, NY" });

    const usageEvent = events[5]!;
    expect(usageEvent.kind).toBe("usage_update");
    expect(usageEvent.usage).toEqual({
      inputTokens: 25,
      outputTokens: 42,
      totalTokens: 67,
      exact: true,
    });

    expect(events[6]!.kind).toBe("model_end");

    // Wire-request shape (Gemini streamGenerateContent, alt=sse).
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const url = String(call.input);
    expect(url).toContain("/v1beta/models/gemini-2.5-flash:streamGenerateContent");
    expect(url).toContain("alt=sse");
    expect(call.init?.method).toBe("POST");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("x-goog-api-key")).toBe(API_KEY);
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: "fixture system instruction" }] });
    expect(Array.isArray(body.contents)).toBe(true);
    // No `system` role anywhere in contents[] — the system prompt is carried
    // exclusively via the top-level systemInstruction field.
    const roles = (body.contents as Record<string, unknown>[]).map((c) => c.role);
    expect(roles.every((role) => role === "user" || role === "model")).toBe(true);
  });

  test("determinism: replaying the same fixture twice yields byte-identical NormalizedEvent snapshots", async () => {
    const request = buildRequest("request-determinism");
    const opts: StreamOptions = { attemptId: "attempt-determinism" };

    const first = await collectEvents(
      new GeminiProvider({ fetch: makeHappyPathFetchMock().fetch, grant: validGrant() }).stream(request, opts),
    );
    const second = await collectEvents(
      new GeminiProvider({ fetch: makeHappyPathFetchMock().fetch, grant: validGrant() }).stream(request, opts),
    );

    expect(first.length).toBeGreaterThan(0);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("never touches the global fetch (only the injected deps.fetch is called)", async () => {
    const originalFetch = globalThis.fetch;
    let globalFetchCalled = false;
    globalThis.fetch = (() => {
      globalFetchCalled = true;
      throw new Error("GeminiProvider must not touch globalThis.fetch — fetch must be injected via deps.");
    }) as unknown as typeof fetch;

    try {
      const { fetch: fetchMock } = makeHappyPathFetchMock();
      const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });
      const events = await collectEvents(provider.stream(buildRequest("request-offline"), { attemptId: "attempt-offline" }));
      expect(events.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(globalFetchCalled).toBe(false);
  });

  test("no vendor SDK import crosses the ProviderPort boundary (thin fetch/SSE only)", () => {
    const modulePath = path.join(import.meta.dir, "gemini-provider.ts");
    const source = readFileSync(modulePath, "utf8");
    const sdkImportPattern = /@google\/generative-ai|@google-cloud\/vertexai|from ["']google-genai["']|from ["']genai["']/;
    expect(sdkImportPattern.test(source)).toBe(false);
  });
});

// --- Tool-result round trip: functionResponse as a role:"user" message -----

describe("AC2 — tool results serialize as a role:\"user\" message with a functionResponse part (NOT a separate tool/function role)", () => {
  test("a linked assistant tool call + tool result produce a model turn with functionCall and a user turn with functionResponse", async () => {
    const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });
    const request = buildRequest("request-tool-round-trip", {
      messages: [
        { role: "user", content: "What is the weather in New York?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"location":"New York, NY"}' }],
        },
        { role: "tool", content: '{"tempF":72}', toolCallId: "call_1" },
      ],
    });

    await collectEvents(provider.stream(request, { attemptId: "attempt-tool-round-trip" }));

    const body = JSON.parse(String(calls[0]?.init?.body)) as { contents: Record<string, unknown>[] };
    // First message (plain user text), then the assistant functionCall turn,
    // then the tool result as role:"user" with functionResponse.
    expect(body.contents).toHaveLength(3);

    const modelTurn = body.contents[1]!;
    expect(modelTurn.role).toBe("model");
    const modelParts = modelTurn.parts as Record<string, unknown>[];
    expect(modelParts[0]?.functionCall).toMatchObject({ name: "get_weather", id: "call_1", args: { location: "New York, NY" } });

    const resultTurn = body.contents[2]!;
    // The tool result MUST be role:"user" — Gemini has no separate
    // tool/function role, a real structural difference from every other
    // adapter in this codebase.
    expect(resultTurn.role).toBe("user");
    const resultParts = resultTurn.parts as Record<string, unknown>[];
    expect(resultParts[0]?.functionResponse).toMatchObject({
      name: "get_weather",
      id: "call_1",
      response: { tempF: 72 },
    });
  });
});

// --- AC2: cancellation -------------------------------------------------------

describe("AC2 — opts.signal cancels the in-flight attempt", () => {
  test("aborting mid-stream ends the stream with a cancelled provider_error and yields no further events", async () => {
    const controller = new AbortController();
    const { fetch: fetchMock } = makeHappyPathFetchMock();
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });
    const opts: StreamOptions = { attemptId: "attempt-cancel", signal: controller.signal };

    const iterator = provider.stream(buildRequest("request-cancel"), opts)[Symbol.asyncIterator]();
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

    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
    const trailing = events[events.length - 1]!;
    expect(trailing.kind).toBe("provider_error");
    const error = trailing.error as NormalizedError;
    expect(error.kind).toBe("cancelled");
    expect(defaultRetryable("cancelled")).toBe(false);
    expect(error.retryable).toBe(false);
    expect(error.message.length).toBeGreaterThan(0);
  });
});

// --- AC2: HTTP error taxonomy -------------------------------------------------

describe("AC2 — non-2xx HTTP responses classify per Google's {code,message,status} envelope", () => {
  test("400 INVALID_ARGUMENT -> invalid_request, not retryable", async () => {
    const { fetch: fetchMock } = makeFetchMock(
      () => new Response(loadFixtureText(ERROR_FIXTURE_PATH), { status: 400, headers: { "content-type": "application/json" } }),
    );
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-400"), { attemptId: "attempt-400" }));

    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.kind).toBe("provider_error");
    const error = evt.error as NormalizedError;
    expect(error.kind).toBe("invalid_request");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("invalid argument");
  });

  test("401 UNAUTHENTICATED -> authentication, not retryable", async () => {
    const body = JSON.stringify({ error: { code: 401, message: "invalid API key", status: "UNAUTHENTICATED" } });
    const { fetch: fetchMock } = makeFetchMock(() => new Response(body, { status: 401 }));
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-401"), { attemptId: "attempt-401" }));

    const error = events[0]!.error as NormalizedError;
    expect(error.kind).toBe("authentication");
    expect(error.retryable).toBe(false);
  });

  test("429 RESOURCE_EXHAUSTED -> rate_limit, retryable, no fabricated retryAfterMs", async () => {
    const body = JSON.stringify({ error: { code: 429, message: "quota exceeded", status: "RESOURCE_EXHAUSTED" } });
    const { fetch: fetchMock } = makeFetchMock(() => new Response(body, { status: 429 }));
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-429"), { attemptId: "attempt-429" }));

    const error = events[0]!.error as NormalizedError;
    expect(error.kind).toBe("rate_limit");
    expect(error.retryable).toBe(true);
    // Research found no confirmed Retry-After/RetryInfo field — this adapter
    // must not invent a backoff hint.
    expect(error.retryAfterMs).toBeUndefined();
  });

  test("503 UNAVAILABLE -> unavailable, retryable", async () => {
    const body = JSON.stringify({ error: { code: 503, message: "backend overloaded", status: "UNAVAILABLE" } });
    const { fetch: fetchMock } = makeFetchMock(() => new Response(body, { status: 503 }));
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-503"), { attemptId: "attempt-503" }));

    const error = events[0]!.error as NormalizedError;
    expect(error.kind).toBe("unavailable");
    expect(error.retryable).toBe(true);
  });
});

// --- AC4 (SECURITY): SSRF / egress guard ------------------------------------

describe("AC4 (SECURITY) — private/loopback/link-local/metadata egress is denied fail-closed, same as the other adapters", () => {
  const deniedBaseUrls = [
    "http://127.0.0.1:8080",
    "http://localhost:8080",
    "http://169.254.169.254/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
  ];

  for (const baseUrl of deniedBaseUrls) {
    test(`baseUrl=${baseUrl} -> fail-closed provider_error, fetch NEVER called`, async () => {
      const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
      const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant(baseUrl) });

      const events = await collectEvents(provider.stream(buildRequest("request-egress-deny"), { attemptId: "attempt-egress-deny" }));

      expect(calls).toHaveLength(0);
      expect(events).toHaveLength(1);
      const evt = events[0]!;
      expect(evt.kind).toBe("provider_error");
      const error = evt.error as NormalizedError;
      expect(error.retryable).toBe(false);
    });
  }

  test("public baseUrl is permitted -> fetch IS invoked", async () => {
    const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-egress-allow"), { attemptId: "attempt-egress-allow" }));

    expect(calls).toHaveLength(1);
    expect(events.some((evt) => evt.kind === "provider_error")).toBe(false);
  });
});

// --- No-grant fail-closed ----------------------------------------------------

describe("AC2 — no valid grant fails closed without ever calling fetch", () => {
  test("grant undefined -> authentication provider_error, fetch never called", async () => {
    const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
    const provider = new GeminiProvider({ fetch: fetchMock });

    const events = await collectEvents(provider.stream(buildRequest("request-no-grant"), { attemptId: "attempt-no-grant" }));

    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    const error = events[0]!.error as NormalizedError;
    expect(error.kind).toBe("authentication");
  });

  test("grant with empty apiKey -> authentication provider_error, fetch never called", async () => {
    const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
    const provider = new GeminiProvider({ fetch: fetchMock, grant: { network: true, apiKey: "" } });

    const events = await collectEvents(provider.stream(buildRequest("request-empty-key"), { attemptId: "attempt-empty-key" }));

    expect(calls).toHaveLength(0);
    const error = events[0]!.error as NormalizedError;
    expect(error.kind).toBe("authentication");
  });
});

// --- Credential redaction -----------------------------------------------------

describe("AC2 — the apiKey never leaks into any yielded error message", () => {
  test("a network-level fetch failure's error message is redacted of the apiKey", async () => {
    const { fetch: fetchMock } = makeFetchMock(() => {
      throw new Error(`connection reset while using key ${API_KEY}`);
    });
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-leak-check"), { attemptId: "attempt-leak-check" }));

    const error = events[0]!.error as NormalizedError;
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain("[redacted]");
  });
});

// --- AC5: describe() capability matrix ---------------------------------------

describe("AC5 — describe() capability matrix matches only research-confirmed claims", () => {
  test("capabilities match the researched, per-vendor matrix (no unconfirmed guesses)", () => {
    const provider = new GeminiProvider({ fetch: makeHappyPathFetchMock().fetch });
    const description = provider.describe();

    expect(description.descriptor.providerId).toBe("gemini");
    expect(description.capabilities).toEqual({
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      structuredOutput: true,
      reasoningMetadata: true,
      promptCaching: true,
      vision: true,
      tokenCounting: false,
      modelListing: false,
    });
  });

  test("descriptorDocument() validates the storage-off remote-state contract", () => {
    const provider = new GeminiProvider({ fetch: makeHappyPathFetchMock().fetch });
    const doc = provider.descriptorDocument();

    expect(doc.providerId).toBe("gemini");
    expect(doc.remoteState).toEqual({ storage: false, retention: false, continuation: false });
    expect(doc.capabilities.parallelToolCalls).toBe(true);
  });
});

// --- Reasoning metadata: thought:true parts map to reasoning_delta ----------

describe("AC5 — a thought:true content part maps to reasoning_delta, never text_delta", () => {
  test("a chunk carrying a thought part yields reasoning_delta with that text", async () => {
    const sse =
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Let me think about this...","thought":true}]},"index":0}]}\n\n' +
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"The answer is 4."}]},"finishReason":"STOP","index":0}]}\n\n';
    const { fetch: fetchMock } = makeFetchMock(
      () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-thought"), { attemptId: "attempt-thought" }));

    const reasoningEvent = events.find((evt) => evt.kind === "reasoning_delta");
    expect(reasoningEvent).toBeDefined();
    expect(reasoningEvent?.text).toBe("Let me think about this...");
    const textEvent = events.find((evt) => evt.kind === "text_delta");
    expect(textEvent?.text).toBe("The answer is 4.");
  });
});

// --- Truncated / malformed stream handling -----------------------------------

describe("AC2 — a stream that never reports finishReason is malformed (truncated), no model_end", () => {
  test("a torn/truncated SSE body yields a trailing malformed provider_error and no model_end", async () => {
    // No finishReason anywhere — simulates a connection cut mid-stream.
    const sse = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]},"index":0}]}\n\n';
    const { fetch: fetchMock } = makeFetchMock(
      () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-truncated"), { attemptId: "attempt-truncated" }));

    expect(events.some((evt) => evt.kind === "model_end")).toBe(false);
    const trailing = events[events.length - 1]!;
    expect(trailing.kind).toBe("provider_error");
    const error = trailing.error as NormalizedError;
    expect(error.kind).toBe("malformed");
  });

  test("empty response body fails closed as malformed, no model_end", async () => {
    const { fetch: fetchMock } = makeFetchMock(
      () => new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(provider.stream(buildRequest("request-empty-body"), { attemptId: "attempt-empty-body" }));

    expect(events).toHaveLength(1);
    const error = events[0]!.error as NormalizedError;
    expect(error.kind).toBe("malformed");
  });
});

// --- AC10 (flow 268, T15): thinkingConfig request shape ---------------------

describe("AC10 — generationConfig.thinkingConfig is set per model family and requested effort", () => {
  async function generationConfigFor(overrides: Partial<NormalizedRequest>): Promise<Record<string, unknown>> {
    const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });
    await collectEvents(
      provider.stream(buildRequest(`request-${JSON.stringify(overrides)}`, overrides), { attemptId: "attempt-thinking-config" }),
    );
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    return body.generationConfig as Record<string, unknown>;
  }

  test("gemini-3* model + effort low -> thinkingLevel low", async () => {
    const generationConfig = await generationConfigFor({ modelId: "gemini-3-pro-preview", options: { reasoning: "low" } });
    expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "low" });
  });

  test("gemini-3* model + effort medium -> thinkingLevel high (no confirmed 'medium' thinkingLevel)", async () => {
    const generationConfig = await generationConfigFor({ modelId: "gemini-3-pro-preview", options: { reasoning: "medium" } });
    expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "high" });
  });

  test("gemini-3* model + effort high -> thinkingLevel high", async () => {
    const generationConfig = await generationConfigFor({ modelId: "gemini-3-flash", options: { reasoning: "high" } });
    expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "high" });
  });

  test("gemini-2.5* model + effort low -> thinkingBudget 1024", async () => {
    const generationConfig = await generationConfigFor({ modelId: "gemini-2.5-flash", options: { reasoning: "low" } });
    expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 1024 });
  });

  test("gemini-2.5* model + effort medium -> thinkingBudget 8192", async () => {
    const generationConfig = await generationConfigFor({ modelId: "gemini-2.5-flash", options: { reasoning: "medium" } });
    expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 8192 });
  });

  test("gemini-2.5* model + effort high -> thinkingBudget 24576", async () => {
    const generationConfig = await generationConfigFor({ modelId: "gemini-2.5-flash", options: { reasoning: "high" } });
    expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 24576 });
  });

  test('flow 268 T16: gemini-3* model + effort "minimal" -> thinkingLevel "low" (nearest supported)', async () => {
    const generationConfig = await generationConfigFor({ modelId: "gemini-3-pro-preview", options: { reasoning: "minimal" } });
    expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "low" });
  });

  test('flow 268 T16: gemini-3* model + effort "xhigh"/"max" -> thinkingLevel "high" (nearest supported)', async () => {
    const xhigh = await generationConfigFor({ modelId: "gemini-3-pro-preview", options: { reasoning: "xhigh" } });
    expect(xhigh.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "high" });
    const max = await generationConfigFor({ modelId: "gemini-3-flash", options: { reasoning: "max" } });
    expect(max.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "high" });
  });

  test('flow 268 T16: gemini-2.5* model + effort "minimal" -> thinkingBudget 1024 (nearest supported: low)', async () => {
    const generationConfig = await generationConfigFor({ modelId: "gemini-2.5-flash", options: { reasoning: "minimal" } });
    expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 1024 });
  });

  test('flow 268 T16: gemini-2.5* model + effort "xhigh"/"max" -> thinkingBudget 24576 (nearest supported: high)', async () => {
    const xhigh = await generationConfigFor({ modelId: "gemini-2.5-flash", options: { reasoning: "xhigh" } });
    expect(xhigh.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 24576 });
    const max = await generationConfigFor({ modelId: "gemini-2.5-flash", options: { reasoning: "max" } });
    expect(max.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 24576 });
  });

  test("a model id outside both known families falls back to the thinkingBudget family", async () => {
    const generationConfig = await generationConfigFor({ modelId: "gemini-1.5-pro", options: { reasoning: "high" } });
    expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 24576 });
  });

  test("no effort requested (options undefined) -> no thinkingConfig key at all", async () => {
    const generationConfig = await generationConfigFor({});
    expect(Object.prototype.hasOwnProperty.call(generationConfig, "thinkingConfig")).toBe(false);
  });

  test("effort 'off' -> no thinkingConfig key at all", async () => {
    const generationConfig = await generationConfigFor({ options: { reasoning: "off" } });
    expect(Object.prototype.hasOwnProperty.call(generationConfig, "thinkingConfig")).toBe(false);
  });
});

// --- AC10: thoughtSignature capture from the SSE stream ---------------------

describe("AC10 — a thoughtSignature on any response part is captured as reasoning_replay, whether or not effort was requested", () => {
  test("a thought part, a functionCall part WITH thoughtSignature, and a parallel functionCall part WITHOUT one", async () => {
    const sse =
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Reasoning about two cities...","thought":true}]},"index":0}]}\n\n' +
      'data: {"candidates":[{"content":{"role":"model","parts":[' +
      '{"functionCall":{"name":"get_weather","id":"call_ny","args":{"location":"New York, NY"}},"thoughtSignature":"sig-ny-base64"},' +
      '{"functionCall":{"name":"get_weather","id":"call_sf","args":{"location":"San Francisco, CA"}}}' +
      ']},"finishReason":"STOP","index":0}]}\n\n';
    const { fetch: fetchMock, calls } = makeFetchMock(
      () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });
    // No `options.reasoning` set: proves the signature is captured even when
    // `includeThoughts`/an effort was never requested on the wire.
    const request = buildRequest("request-thought-signature");

    const events = await collectEvents(provider.stream(request, { attemptId: "attempt-thought-signature" }));

    const requestBody = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(requestBody.generationConfig as Record<string, unknown>, "thinkingConfig")).toBe(
      false,
    );

    const reasoningDelta = events.find((evt) => evt.kind === "reasoning_delta");
    expect(reasoningDelta?.text).toBe("Reasoning about two cities...");

    const replayEvents = events.filter((evt) => evt.kind === "reasoning_replay");
    expect(replayEvents).toHaveLength(1);
    const replay = replayEvents[0]!.replay!;
    expect(replay.providerId).toBe("gemini");
    expect(replay.kind).toBe("thought_signature");
    expect(replay.data).toEqual({
      target: "functionCall",
      functionCallIndex: 0,
      toolCallId: "call_ny",
      signature: "sig-ny-base64",
    });

    // Ordinary tool-call normalization is unaffected by signature capture.
    const toolStarts = events.filter((evt) => evt.kind === "tool_call_start");
    expect(toolStarts.map((evt) => evt.toolCallId)).toEqual(["call_ny", "call_sf"]);
    expect(events.filter((evt) => evt.kind === "tool_call_end")).toHaveLength(2);
  });

  test("a thoughtSignature on a text part is captured with target \"text\"", async () => {
    const sse =
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"The answer is 4.","thoughtSignature":"sig-text-base64"}]},"finishReason":"STOP","index":0}]}\n\n';
    const { fetch: fetchMock } = makeFetchMock(
      () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(
      provider.stream(buildRequest("request-text-signature"), { attemptId: "attempt-text-signature" }),
    );

    const replayEvents = events.filter((evt) => evt.kind === "reasoning_replay");
    expect(replayEvents).toHaveLength(1);
    expect(replayEvents[0]!.replay!.data).toEqual({ target: "text", signature: "sig-text-base64" });
  });

  test("no thoughtSignature anywhere in the stream -> no reasoning_replay events at all", async () => {
    const { fetch: fetchMock } = makeHappyPathFetchMock();
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });

    const events = await collectEvents(
      provider.stream(buildRequest("request-no-signature"), { attemptId: "attempt-no-signature" }),
    );

    expect(events.some((evt) => evt.kind === "reasoning_replay")).toBe(false);
  });
});

// --- AC10: toGeminiContents replays a captured thoughtSignature verbatim ----

describe("AC10 — toGeminiContents reattaches a captured thoughtSignature to the exact part it arrived on", () => {
  test("functionCall-target items match by toolCallId, or by functionCallIndex when toolCallId is absent; text-target attaches to the text part; a foreign providerId item is ignored", async () => {
    const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });
    const request = buildRequest("request-replay-roundtrip", {
      messages: [
        { role: "user", content: "What is the weather in NY and SF?" },
        {
          role: "assistant",
          content: "Let me check both.",
          toolCalls: [
            { id: "call_ny", name: "get_weather", arguments: '{"location":"New York, NY"}' },
            { id: "call_sf", name: "get_weather", arguments: '{"location":"San Francisco, CA"}' },
          ],
          reasoning: {
            text: "Reasoning...",
            replay: [
              { providerId: "gemini", kind: "thought_signature", data: { target: "text", signature: "sig-text" } },
              {
                providerId: "gemini",
                kind: "thought_signature",
                data: { target: "functionCall", toolCallId: "call_ny", signature: "sig-ny" },
              },
              // No toolCallId here — resolved via functionCallIndex against
              // `message.toolCalls[1]` (call_sf).
              {
                providerId: "gemini",
                kind: "thought_signature",
                data: { target: "functionCall", functionCallIndex: 1, signature: "sig-sf" },
              },
              // A different provider's replay item — must never attach
              // anywhere (the "ignore foreign providerId" contract).
              { providerId: "openai", kind: "encrypted_content", data: { target: "text", signature: "should-be-ignored" } },
            ],
          },
        },
        { role: "tool", content: '{"tempF":72}', toolCallId: "call_ny" },
        { role: "tool", content: '{"tempF":65}', toolCallId: "call_sf" },
      ],
    });

    await collectEvents(provider.stream(request, { attemptId: "attempt-replay-roundtrip" }));

    const body = JSON.parse(String(calls[0]?.init?.body)) as { contents: Record<string, unknown>[] };
    const modelTurn = body.contents.find((c) => c.role === "model")!;
    const parts = modelTurn.parts as Record<string, unknown>[];

    const textParts = parts.filter((p) => typeof p.text === "string");
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.text).toBe("Let me check both.");
    expect(textParts[0]?.thoughtSignature).toBe("sig-text");

    const nyPart = parts.find((p) => (p.functionCall as Record<string, unknown> | undefined)?.id === "call_ny")!;
    expect((nyPart.functionCall as Record<string, unknown>).thoughtSignature).toBe("sig-ny");

    const sfPart = parts.find((p) => (p.functionCall as Record<string, unknown> | undefined)?.id === "call_sf")!;
    expect((sfPart.functionCall as Record<string, unknown>).thoughtSignature).toBe("sig-sf");
  });

  test("a functionCall-target item whose call was dropped by linkToolCalls is silently omitted, never invents a part", async () => {
    const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });
    const request = buildRequest("request-replay-unresolvable", {
      messages: [
        { role: "user", content: "What is the weather?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_ny", name: "get_weather", arguments: '{"location":"New York, NY"}' }],
          reasoning: {
            replay: [
              {
                providerId: "gemini",
                kind: "thought_signature",
                data: { target: "functionCall", toolCallId: "call_missing", signature: "sig-orphan" },
              },
            ],
          },
        },
        { role: "tool", content: '{"tempF":72}', toolCallId: "call_ny" },
      ],
    });

    await collectEvents(provider.stream(request, { attemptId: "attempt-replay-unresolvable" }));

    const body = JSON.parse(String(calls[0]?.init?.body)) as { contents: Record<string, unknown>[] };
    const modelTurn = body.contents.find((c) => c.role === "model")!;
    const parts = modelTurn.parts as Record<string, unknown>[];
    expect(parts).toHaveLength(1);
    expect((parts[0]!.functionCall as Record<string, unknown>).thoughtSignature).toBeUndefined();
  });

  test("a text-target item on a tool-call round with no visible text is carried on a trailing empty text part", async () => {
    const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });
    const request = buildRequest("request-replay-empty-text", {
      messages: [
        { role: "user", content: "What is the weather?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_ny", name: "get_weather", arguments: '{"location":"New York, NY"}' }],
          reasoning: {
            replay: [{ providerId: "gemini", kind: "thought_signature", data: { target: "text", signature: "sig-empty-text" } }],
          },
        },
        { role: "tool", content: '{"tempF":72}', toolCallId: "call_ny" },
      ],
    });

    await collectEvents(provider.stream(request, { attemptId: "attempt-replay-empty-text" }));

    const body = JSON.parse(String(calls[0]?.init?.body)) as { contents: Record<string, unknown>[] };
    const modelTurn = body.contents.find((c) => c.role === "model")!;
    const parts = modelTurn.parts as Record<string, unknown>[];
    const emptyTextPart = parts.find((p) => p.text === "");
    expect(emptyTextPart).toBeDefined();
    expect(emptyTextPart?.thoughtSignature).toBe("sig-empty-text");
  });

  test("a message with no reasoning.replay at all builds exactly as before (no thoughtSignature field anywhere)", async () => {
    const { fetch: fetchMock, calls } = makeHappyPathFetchMock();
    const provider = new GeminiProvider({ fetch: fetchMock, grant: validGrant() });
    const request = buildRequest("request-no-reasoning", {
      messages: [
        { role: "user", content: "What is the weather in New York?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"location":"New York, NY"}' }],
        },
        { role: "tool", content: '{"tempF":72}', toolCallId: "call_1" },
      ],
    });

    await collectEvents(provider.stream(request, { attemptId: "attempt-no-reasoning" }));

    const body = JSON.parse(String(calls[0]?.init?.body)) as { contents: Record<string, unknown>[] };
    for (const entry of body.contents) {
      for (const part of entry.parts as Record<string, unknown>[]) {
        expect(Object.prototype.hasOwnProperty.call(part, "thoughtSignature")).toBe(false);
        if (typeof part.functionCall === "object" && part.functionCall !== null) {
          expect(Object.prototype.hasOwnProperty.call(part.functionCall, "thoughtSignature")).toBe(false);
        }
      }
    }
  });
});
