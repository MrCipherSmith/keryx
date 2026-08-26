// Tests for `OpenAiProvider` (flow 183, T6 / AC1, AC4, AC5, AC6).
//
// AC1 in this flow is explicitly "not fully met" (no `OPENAI_API_KEY` in this
// environment — see `.metaproject/flows/183-.../acceptance-criteria.md`): this
// suite verifies build/stream/normalize behavior against `.SYNTHETIC.`-
// caveated fixtures hand-authored from live-researched OpenAI Responses API
// documentation (see each fixture's own header comment and
// `fixtures/provider-breadth/openai/manifest.json`), NOT a real API call.
//
// Mirrors `AnthropicProvider`'s test structure/conventions
// (`../anthropic/anthropic-provider.test.ts`): offline, deterministic,
// `fetch` always injected, never touches the global.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { OpenAiCapabilityGrant, OpenAiProviderDeps } from "./openai-provider";
import { OpenAiProvider } from "./openai-provider";
import type { NormalizedEvent, NormalizedEventKind, NormalizedRequest, StreamOptions } from "../types";

const TEXT_FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "text-stream.SYNTHETIC.sse");
const TOOL_FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "tool-call-stream.SYNTHETIC.sse");
const ERROR_FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "error-context-overflow.SYNTHETIC.sse");

/** A credential value distinctive enough that any leak is unambiguous. */
const API_KEY = "sk-openai-test-DO-NOT-LEAK-0000000000000000";

function loadFixtureText(fixturePath: string): string {
  return readFileSync(fixturePath, "utf8");
}

function buildRequest(requestId: string): NormalizedRequest {
  return {
    providerId: "openai",
    modelId: "gpt-4.1",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "What is the weather in New York?" }],
    tools: [
      {
        name: "get_weather",
        description: "Get the weather for a location.",
        inputSchema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
      },
    ],
    budget: { maxOutputTokens: 1024, runReservation: 1024 },
    stream: true,
    requestId,
    parentRunId: "run-fixture",
  };
}

function validGrant(baseUrl?: string): OpenAiCapabilityGrant {
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

function makeFixtureFetchMock(fixturePath: string): { fetch: typeof fetch; calls: CapturedCall[] } {
  return makeFetchMock(
    () =>
      new Response(loadFixtureText(fixturePath), {
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

// --- AC1: normalization against SYNTHETIC fixtures --------------------------

describe("AC1 — clean text-stream SYNTHETIC fixture normalizes to the exact NormalizedEventKind sequence", () => {
  test("stream() yields model_start, 2x text_delta, usage_update, model_end", async () => {
    const { fetch: fetchMock, calls } = makeFixtureFetchMock(TEXT_FIXTURE_PATH);
    const deps: OpenAiProviderDeps = { fetch: fetchMock, grant: validGrant() };
    const provider = new OpenAiProvider(deps);
    const request = buildRequest("request-text");
    const opts: StreamOptions = { attemptId: "attempt-text" };

    const events = await collectEvents(provider.stream(request, opts));

    expect(kinds(events)).toEqual(["model_start", "text_delta", "text_delta", "usage_update", "model_end"]);
    events.forEach((evt, index) => {
      expect(evt.sequence).toBe(index);
      expect(evt.attemptId).toBe("attempt-text");
    });

    expect(events[1]).toMatchObject({ kind: "text_delta", text: "The weather in " });
    expect(events[2]).toMatchObject({ kind: "text_delta", text: "NYC is sunny." });

    const usageEvent = events[3]!;
    expect(usageEvent.usage).toEqual({ inputTokens: 25, outputTokens: 9, totalTokens: 34, exact: true });

    // Wire-request shape (Responses API, POST /v1/responses, stream:true).
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(String(call.input).endsWith("/v1/responses")).toBe(true);
    expect(call.init?.method).toBe("POST");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.model).toBe("gpt-4.1");
    // instructions carries systemInstruction, NOT folded into input[].
    expect(body.instructions).toBe("fixture system instruction");
    expect(Array.isArray(body.input)).toBe(true);
    const inputArray = body.input as Record<string, unknown>[];
    expect(inputArray[0]).toMatchObject({ type: "message", role: "user" });
  });
});

describe("AC1 — tool-call round-trip SYNTHETIC fixture normalizes correctly, keyed on call_id", () => {
  test("stream() yields tool_call_start/delta/end keyed by call_id (not the item's own id)", async () => {
    const { fetch: fetchMock } = makeFixtureFetchMock(TOOL_FIXTURE_PATH);
    const deps: OpenAiProviderDeps = { fetch: fetchMock, grant: validGrant() };
    const provider = new OpenAiProvider(deps);
    const request = buildRequest("request-tool");
    const opts: StreamOptions = { attemptId: "attempt-tool" };

    const events = await collectEvents(provider.stream(request, opts));

    expect(kinds(events)).toEqual([
      "model_start",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_end",
      "usage_update",
      "model_end",
    ]);

    // The item's own `id` (fc_fixture0000000000000001) is NEVER the correlation
    // key — only `call_id` (call_fixtureWeather0001) is.
    expect(events[1]).toMatchObject({
      kind: "tool_call_start",
      toolCallId: "call_fixtureWeather0001",
      toolName: "get_weather",
    });
    expect(events[2]).toMatchObject({ kind: "tool_call_delta", toolCallId: "call_fixtureWeather0001" });
    expect(events[3]).toMatchObject({ kind: "tool_call_delta", toolCallId: "call_fixtureWeather0001" });

    const endEvent = events[4]!;
    expect(endEvent.kind).toBe("tool_call_end");
    expect(endEvent.toolCallId).toBe("call_fixtureWeather0001");
    expect(JSON.parse(endEvent.input as string)).toEqual({ location: "New York, NY" });
  });
});

describe("AC1 — the documented empty-message context-overflow bug never surfaces an empty string", () => {
  test("terminal error event with empty message + context_length_exceeded code -> classified, non-empty message", async () => {
    const { fetch: fetchMock } = makeFixtureFetchMock(ERROR_FIXTURE_PATH);
    const deps: OpenAiProviderDeps = { fetch: fetchMock, grant: validGrant() };
    const provider = new OpenAiProvider(deps);
    const request = buildRequest("request-error");
    const opts: StreamOptions = { attemptId: "attempt-error" };

    const events = await collectEvents(provider.stream(request, opts));

    expect(events).toHaveLength(1);
    const errorEvent = events[0]!;
    expect(errorEvent.kind).toBe("provider_error");
    expect(errorEvent.error?.kind).toBe("context_overflow");
    expect(errorEvent.error?.message.length).toBeGreaterThan(0);
    expect(errorEvent.error?.message).not.toBe("");
  });
});

// Review finding: response.failed/response.incomplete had zero coverage —
// every other terminal-event branch (response.completed, error) already had
// a dedicated test; these two did not.
describe("AC1 — response.incomplete and response.failed terminate as provider_error, not silently dropped", () => {
  test("response.incomplete (e.g. truncated by max_output_tokens) classifies per its error code", async () => {
    const sse = [
      'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_incomplete","status":"in_progress"}}\n\n',
      'event: response.incomplete\ndata: {"type":"response.incomplete","sequence_number":1,"response":{"id":"resp_incomplete","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"error":null}}\n\n',
    ].join("");
    const { fetch: fetchMock } = makeFetchMock(
      () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const deps: OpenAiProviderDeps = { fetch: fetchMock, grant: validGrant() };
    const provider = new OpenAiProvider(deps);
    const events = await collectEvents(provider.stream(buildRequest("request-incomplete"), { attemptId: "attempt-incomplete" }));

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("provider_error");
    // No error.code on this shape -> falls through to "unknown", per the
    // adapter's own classification rule (code undefined/empty -> unknown).
    expect(events[0]!.error?.kind).toBe("unknown");
    expect(events[0]!.error?.message.length).toBeGreaterThan(0);
  });

  test("response.failed with a real error code classifies as invalid_request, not silently dropped", async () => {
    const sse = [
      'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_failed","status":"in_progress"}}\n\n',
      'event: response.failed\ndata: {"type":"response.failed","sequence_number":1,"response":{"id":"resp_failed","status":"failed","error":{"code":"server_error","message":"internal error"}}}\n\n',
    ].join("");
    const { fetch: fetchMock } = makeFetchMock(
      () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const deps: OpenAiProviderDeps = { fetch: fetchMock, grant: validGrant() };
    const provider = new OpenAiProvider(deps);
    const events = await collectEvents(provider.stream(buildRequest("request-failed"), { attemptId: "attempt-failed" }));

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("provider_error");
    expect(events[0]!.error?.kind).toBe("invalid_request");
    expect(events[0]!.error?.message).toContain("internal error");
  });
});

// --- AC4: SSRF/egress guard --------------------------------------------------

describe("AC4 — SSRF/egress guard denies private/loopback/link-local/metadata hosts", () => {
  const deniedHosts = ["127.0.0.1", "localhost", "169.254.169.254", "10.0.0.5", "192.168.1.1"];

  for (const host of deniedHosts) {
    test(`baseUrl host ${host} is denied before any fetch`, async () => {
      const { fetch: fetchMock, calls } = makeFetchMock(() => {
        throw new Error("fetch must never be called for a denied host");
      });
      const deps: OpenAiProviderDeps = { fetch: fetchMock, grant: validGrant(`http://${host}:1234`) };
      const provider = new OpenAiProvider(deps);
      const events = await collectEvents(provider.stream(buildRequest("request-ssrf"), { attemptId: "attempt-ssrf" }));

      expect(calls).toHaveLength(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe("provider_error");
      expect(events[0]!.error?.kind).toBe("invalid_request");
      expect(events[0]!.error?.message).toContain("egress to a private/loopback/link-local/metadata host is denied");
    });
  }

  test("no grant -> fail-closed authentication error, fetch never invoked", async () => {
    const { fetch: fetchMock, calls } = makeFetchMock(() => {
      throw new Error("fetch must never be called without a grant");
    });
    const provider = new OpenAiProvider({ fetch: fetchMock });
    const events = await collectEvents(provider.stream(buildRequest("request-nogrant"), { attemptId: "attempt-nogrant" }));

    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.error?.kind).toBe("authentication");
  });
});

// --- AC5: capability matrix --------------------------------------------------

describe("AC5 — describe() capability matrix matches plan.md, unconfirmed items declared false", () => {
  test("capabilities", () => {
    const provider = new OpenAiProvider({ fetch: (() => Promise.reject(new Error("unused"))) as unknown as typeof fetch });
    const { capabilities, descriptor } = provider.describe();

    expect(capabilities).toEqual({
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      structuredOutput: true,
      reasoningMetadata: true,
      promptCaching: true,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    });
    expect(descriptor.providerId).toBe("openai");
  });
});

// --- AC6: no vendor SDK import audit ----------------------------------------

describe("AC6 — no OpenAI SDK / provider-wire type crosses the ProviderPort boundary", () => {
  test("source text audit: no vendor SDK import anywhere in this adapter module", () => {
    const modulePath = path.join(import.meta.dir, "openai-provider.ts");
    const source = readFileSync(modulePath, "utf8");
    // Match an actual IMPORT of an OpenAI SDK package, not the provider id
    // string literal `"openai"` this module legitimately uses for
    // `describe().descriptor.providerId`.
    const sdkImportPattern = /from\s+["']openai["']|from\s+["']@openai\/[^"']+["']|from\s+["']openai-node["']/;
    expect(sdkImportPattern.test(source)).toBe(false);
  });
});

// --- credential redaction ----------------------------------------------------

describe("credential redaction", () => {
  test("apiKey never appears in a yielded error message", async () => {
    const { fetch: fetchMock } = makeFetchMock(
      () =>
        new Response(JSON.stringify({ error: { message: `bad key ${API_KEY}`, type: "invalid_request_error" } }), {
          status: 401,
        }),
    );
    const deps: OpenAiProviderDeps = { fetch: fetchMock, grant: validGrant() };
    const provider = new OpenAiProvider(deps);
    const events = await collectEvents(provider.stream(buildRequest("request-401"), { attemptId: "attempt-401" }));

    expect(events).toHaveLength(1);
    expect(events[0]!.error?.kind).toBe("authentication");
    expect(events[0]!.error?.message).not.toContain(API_KEY);
    expect(events[0]!.error?.message).toContain("[redacted]");
  });
});

test("C-04: a non-JSON HTTP error keeps OpenAI's generic status message", async () => {
  const { fetch: fetchMock } = makeFetchMock(() => new Response("opaque upstream body", { status: 503 }));
  const provider = new OpenAiProvider({ fetch: fetchMock, grant: validGrant() });
  const events = await collectEvents(provider.stream(buildRequest("catch-c04"), { attemptId: "catch-c04" }));

  expect(events).toHaveLength(1);
  expect(events[0]?.kind).toBe("provider_error");
  expect(events[0]?.error?.kind).toBe("unavailable");
  expect(events[0]?.error?.message).toBe("OpenAI API returned HTTP 503");
  expect(JSON.stringify(events)).not.toContain("opaque upstream body");
});
