// Shared provider stream contract (flow 354, AC1 / L-1, L-2, L-3).
//
// The four full adapters (anthropic, openai, gemini, openai-compat) disagreed
// on what a truncated stream, an in-stream error and a missing tool-call id
// mean. This file runs the SAME three rows against all four, one `describe`
// per row, one `test` per adapter — so the four stay agreeing (or, where an
// adapter's wire format makes a row structurally different, the test
// documents exactly what that adapter does instead of silently skipping it).
//
// Fixed by flow 354: the compat adapter's `flushPendingToolEnds` (row A) and
// the Gemini streaming loop's in-stream-error branch (row B) and `callId`
// fallback (row C). Fixed by flow 356 (L-16): the compat adapter's OWN
// in-stream-error branch (row B), previously a documented gap. Anthropic and
// openai (native) keep their PRE-EXISTING behaviour on every row — this file
// pins that behaviour, it does not change it.
//
// OFFLINE / DETERMINISTIC: `fetch` is always injected; no test touches the
// network or `globalThis.fetch`.
import { describe, expect, test } from "bun:test";
import { AnthropicProvider } from "./anthropic/anthropic-provider";
import { OpenAiProvider } from "./openai/openai-provider";
import { GeminiProvider } from "./gemini/gemini-provider";
import { OpenAiCompatEngine, type OpenAiCompatIdentity } from "./compat/openai-compat-provider";
import type { NormalizedEvent, NormalizedRequest } from "./types";

/** A minimal, valid in-memory `NormalizedRequest` — the specific provider/model never matters to these tests. */
function buildRequest(requestId: string): NormalizedRequest {
  return {
    providerId: "fixture",
    modelId: "fixture-model",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "fixture prompt" }],
    budget: { maxOutputTokens: 32, runReservation: 32 },
    stream: true,
    requestId,
    parentRunId: requestId,
  };
}

/** Offline `fetch` mock that always resolves with `body`/`status` — never touches the network. */
function fetchMockFor(body: string, status = 200): typeof fetch {
  const fn = async (): Promise<Response> =>
    new Response(body, { status, headers: { "content-type": "text/event-stream" } });
  return Object.assign(fn, { preconnect: (_input: string | URL) => {} }) as typeof fetch;
}

async function collect(iterable: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

const COMPAT_IDENTITY: OpenAiCompatIdentity = {
  providerId: "compat-fixture",
  providerRevision: "test",
  defaultBaseUrl: "http://localhost:43123",
  defaultModel: { modelId: "fixture-model", revision: "test" },
  providerLabel: "Compat fixture",
};

function toolCallEnds(events: NormalizedEvent[]): NormalizedEvent[] {
  return events.filter((e) => e.kind === "tool_call_end");
}

function toolCallStarts(events: NormalizedEvent[]): NormalizedEvent[] {
  return events.filter((e) => e.kind === "tool_call_start");
}

function providerErrors(events: NormalizedEvent[]): NormalizedEvent[] {
  return events.filter((e) => e.kind === "provider_error");
}

// ---------------------------------------------------------------------------
// Row A: stream EOF while a tool call is still accumulating.
// ---------------------------------------------------------------------------

describe("row A — EOF while a tool call is still accumulating", () => {
  test("compat: CHANGED (L-1) — one malformed provider_error naming the pending call, no tool_call_end", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_pending_1","function":{"name":"get_weather","arguments":"{\\"loc"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\\":\\"NYC\\"}"}}]}}]}\n\n',
    ].join("");
    const provider = new OpenAiCompatEngine(
      { grant: { network: true, baseUrl: COMPAT_IDENTITY.defaultBaseUrl, allowLoopback: true }, fetch: fetchMockFor(sse) },
      COMPAT_IDENTITY,
    );
    const events = await collect(provider.stream(buildRequest("row-a-compat"), { attemptId: "row-a-compat" }));

    expect(toolCallStarts(events)).toHaveLength(1);
    expect(toolCallEnds(events)).toHaveLength(0);
    const errors = providerErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.kind).toBe("malformed");
    expect(errors[0]?.error?.detail?.pendingToolCallId).toBe("call_pending_1");
  });

  test("gemini: CURRENT (structurally N/A) — tool calls arrive whole (start+end atomic), a later EOF without finishReason is the generic truncated-stream malformed with no pending call named", async () => {
    // Gemini never streams partial function-call arguments (confirmed via
    // research, see gemini-provider.ts's own header) — `tool_call_start` and
    // `tool_call_end` are always pushed together in the SAME chunk, so there
    // is no accumulating state an EOF could ever catch mid-flight. This row
    // documents that atomicity plus the adapter's existing (unchanged)
    // generic truncation error for the still-missing `finishReason`.
    const sse = 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","id":"call_1","args":{}}}]},"index":0}]}\n\n';
    const provider = new GeminiProvider({ grant: { network: true, apiKey: "AIzaFixture" }, fetch: fetchMockFor(sse) });
    const events = await collect(provider.stream(buildRequest("row-a-gemini"), { attemptId: "row-a-gemini" }));

    expect(toolCallStarts(events)).toHaveLength(1);
    expect(toolCallEnds(events)).toHaveLength(1); // atomic — already ended, never "pending"
    const errors = providerErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.kind).toBe("malformed");
    expect(errors[0]?.error?.detail?.pendingToolCallId).toBeUndefined();
  });

  test("anthropic: CURRENT (unchanged) — content_block_start with no matching content_block_stop yields malformed, no tool_call_end, no detail", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_pending_1","name":"get_weather","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"loc"}}\n\n',
    ].join("");
    const provider = new AnthropicProvider({ grant: { network: true, apiKey: "sk-ant-fixture" }, fetch: fetchMockFor(sse) });
    const events = await collect(provider.stream(buildRequest("row-a-anthropic"), { attemptId: "row-a-anthropic" }));

    expect(toolCallStarts(events)).toHaveLength(1);
    expect(toolCallEnds(events)).toHaveLength(0);
    const errors = providerErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.kind).toBe("malformed");
    expect(errors[0]?.error?.detail?.pendingToolCallId).toBeUndefined();
  });

  test("openai (native): CURRENT (unchanged) — output_item.added + arguments.delta with no .done/output_item.done yields malformed, no tool_call_end", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item_id":"item_1","item":{"type":"function_call","id":"item_1","call_id":"call_pending_1","name":"get_weather"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\\"loc"}\n\n',
    ].join("");
    const provider = new OpenAiProvider({ grant: { network: true, apiKey: "sk-openai-fixture" }, fetch: fetchMockFor(sse) });
    const events = await collect(provider.stream(buildRequest("row-a-openai"), { attemptId: "row-a-openai" }));

    expect(toolCallStarts(events)).toHaveLength(1);
    expect(toolCallEnds(events)).toHaveLength(0);
    const errors = providerErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.kind).toBe("malformed");
    expect(errors[0]?.error?.detail?.pendingToolCallId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Row B: an in-stream error envelope/event.
// ---------------------------------------------------------------------------

describe("row B — an in-stream error envelope/event", () => {
  test("gemini: CHANGED (L-2) — a 503 UNAVAILABLE envelope mid-stream classifies as retryable unavailable, not a generic malformed", async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]},"index":0}]}\n\n',
      'data: {"error":{"code":503,"status":"UNAVAILABLE","message":"backend overloaded"}}\n\n',
    ].join("");
    const provider = new GeminiProvider({ grant: { network: true, apiKey: "AIzaFixture" }, fetch: fetchMockFor(sse) });
    const events = await collect(provider.stream(buildRequest("row-b-gemini"), { attemptId: "row-b-gemini" }));

    const errors = providerErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.kind).toBe("unavailable");
    expect(errors[0]?.error?.retryable).toBe(true);
  });

  test("compat: CHANGED (L-16) — an in-band {error} envelope with no pending tool call becomes a provider_error classified like a pre-2xx error", async () => {
    // A DIFFERENT gap from L-1 (which is specifically about a pending TOOL
    // CALL at EOF): this record touches no tool call. It used to hit the
    // compat adapter's `sawStart && !sawFinish` fallthrough, which — unlike
    // every other adapter's post-loop EOF handling — emitted neither
    // `model_end` nor a `malformed` `provider_error`: the stream ended with
    // NO terminal event at all. Fixed by reading the `error` envelope the
    // moment it arrives and classifying it the same way a pre-2xx HTTP error
    // is (`classifyHttpError`).
    const sse = 'data: {"error":{"code":503,"status":"UNAVAILABLE","message":"backend overloaded"}}\n\n';
    const provider = new OpenAiCompatEngine(
      { grant: { network: true, baseUrl: COMPAT_IDENTITY.defaultBaseUrl, allowLoopback: true }, fetch: fetchMockFor(sse) },
      COMPAT_IDENTITY,
    );
    const events = await collect(provider.stream(buildRequest("row-b-compat"), { attemptId: "row-b-compat" }));

    const errors = providerErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.kind).toBe("unavailable");
    expect(errors[0]?.error?.retryable).toBe(true);
    expect(errors[0]?.error?.message).toContain("backend overloaded");
    expect(events.some((e) => e.kind === "model_end")).toBe(false);
  });

  test("anthropic: CURRENT (unchanged) — its own event:error SSE event classifies via classifySseErrorType (overloaded_error -> overloaded, retryable)", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"backend overloaded"}}\n\n',
    ].join("");
    const provider = new AnthropicProvider({ grant: { network: true, apiKey: "sk-ant-fixture" }, fetch: fetchMockFor(sse) });
    const events = await collect(provider.stream(buildRequest("row-b-anthropic"), { attemptId: "row-b-anthropic" }));

    const errors = providerErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.kind).toBe("overloaded");
    expect(errors[0]?.error?.retryable).toBe(true);
  });

  test("openai (native): CURRENT (unchanged) — its own event:error SSE event classifies via extractErrorFields", async () => {
    const sse = 'event: error\ndata: {"type":"error","error":{"code":"rate_limit_exceeded","message":"slow down"}}\n\n';
    const provider = new OpenAiProvider({ grant: { network: true, apiKey: "sk-openai-fixture" }, fetch: fetchMockFor(sse) });
    const events = await collect(provider.stream(buildRequest("row-b-openai"), { attemptId: "row-b-openai" }));

    const errors = providerErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.kind).toBe("invalid_request");
    expect(errors[0]?.error?.message).toContain("slow down");
  });
});

// ---------------------------------------------------------------------------
// Row C: a tool call the provider sends without an id.
// ---------------------------------------------------------------------------

describe("row C — a tool call the provider sends without an id", () => {
  test("gemini: CHANGED (L-3) — two same-named calls with no id get two distinct synthetic ids, results linked to the right call", async () => {
    const sse =
      'data: {"candidates":[{"content":{"parts":[' +
      '{"functionCall":{"name":"read_file","args":{"path":"a.txt"}}},' +
      '{"functionCall":{"name":"read_file","args":{"path":"b.txt"}}}' +
      '],"role":"model"},"finishReason":"STOP","index":0}]}\n\n';
    const provider = new GeminiProvider({ grant: { network: true, apiKey: "AIzaFixture" }, fetch: fetchMockFor(sse) });
    const events = await collect(provider.stream(buildRequest("row-c-gemini"), { attemptId: "row-c-gemini" }));

    const starts = toolCallStarts(events);
    expect(starts).toHaveLength(2);
    const ids = starts.map((e) => e.toolCallId);
    expect(new Set(ids).size).toBe(2);
    const ends = toolCallEnds(events);
    expect(ends.map((e) => e.toolCallId)).toEqual(ids);
    expect(ends[0]?.input).toContain("a.txt");
    expect(ends[1]?.input).toContain("b.txt");
  });

  test("compat: CURRENT (unchanged) — two id-less tool_calls keyed by their distinct `index` already get distinct synthetic ids", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"read_file","arguments":"{\\"path\\":\\"b.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    ].join("");
    const provider = new OpenAiCompatEngine(
      { grant: { network: true, baseUrl: COMPAT_IDENTITY.defaultBaseUrl, allowLoopback: true }, fetch: fetchMockFor(sse) },
      COMPAT_IDENTITY,
    );
    const events = await collect(provider.stream(buildRequest("row-c-compat"), { attemptId: "row-c-compat" }));

    const starts = toolCallStarts(events);
    expect(starts).toHaveLength(2);
    const ids = starts.map((e) => e.toolCallId);
    expect(new Set(ids).size).toBe(2);
  });

  test("anthropic: CURRENT (unchanged) — the wire always carries a provider-assigned tool_use id; never synthesized", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"read_file","input":{}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const provider = new AnthropicProvider({ grant: { network: true, apiKey: "sk-ant-fixture" }, fetch: fetchMockFor(sse) });
    const events = await collect(provider.stream(buildRequest("row-c-anthropic"), { attemptId: "row-c-anthropic" }));

    const starts = toolCallStarts(events);
    expect(starts.map((e) => e.toolCallId)).toEqual(["toolu_1", "toolu_2"]);
  });

  test("openai (native): CURRENT (unchanged) — the wire always carries a call_id; never synthesized", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item_id":"item_1","item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"read_file"}}\n\n',
      'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"item_1","arguments":"{\\"path\\":\\"a.txt\\"}"}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item_id":"item_2","item":{"type":"function_call","id":"item_2","call_id":"call_2","name":"read_file"}}\n\n',
      'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"item_2","arguments":"{\\"path\\":\\"b.txt\\"}"}\n\n',
    ].join("");
    const provider = new OpenAiProvider({ grant: { network: true, apiKey: "sk-openai-fixture" }, fetch: fetchMockFor(sse) });
    const events = await collect(provider.stream(buildRequest("row-c-openai"), { attemptId: "row-c-openai" }));

    const starts = toolCallStarts(events);
    expect(starts.map((e) => e.toolCallId)).toEqual(["call_1", "call_2"]);
  });
});
