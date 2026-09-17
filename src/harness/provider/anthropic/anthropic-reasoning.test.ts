// Anthropic `thinking` request/parse/replay tests (flow 268 T13 / AC8).
//
// Covers: the model-family helper (`anthropicModelFamily`), the request body
// built per family + reasoning effort, `thinking_delta`/`signature_delta`/
// `redacted_thinking` SSE parsing into `reasoning_delta`/`reasoning_replay`
// events, and `toAnthropicMessages()` replaying owned `thinking`/
// `redacted_thinking` blocks (in order, before `text`/`tool_use`, ignoring a
// foreign `providerId`).
//
// OFFLINE / DETERMINISTIC: `fetch` is always injected; no live network.
import { describe, expect, test } from "bun:test";
import {
  AnthropicProvider,
  anthropicModelFamily,
  toAnthropicMessages,
  type AnthropicCapabilityGrant,
  type AnthropicProviderDeps,
} from "./anthropic-provider";
import type { NormalizedEvent, NormalizedMessage, NormalizedRequest, StreamOptions } from "../types";

const API_KEY = "sk-ant-test-DO-NOT-LEAK-0000000000000000";

interface CapturedCall {
  input: RequestInfo | URL;
  init?: RequestInit;
}

function makeFetchMock(sseText: string): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(init === undefined ? { input } : { input, init });
    return new Response(sseText, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

function validGrant(): AnthropicCapabilityGrant {
  return { network: true, apiKey: API_KEY };
}

function buildRequest(
  modelId: string,
  messages: NormalizedMessage[],
  reasoning: string | undefined,
): NormalizedRequest {
  return {
    providerId: "anthropic",
    modelId,
    systemInstruction: "fixture system instruction",
    messages,
    budget: { maxOutputTokens: 1024, runReservation: 1024 },
    stream: true,
    ...(reasoning !== undefined ? { options: { reasoning } } : {}),
    requestId: "req-reasoning-fixture",
    parentRunId: "run-reasoning-fixture",
  };
}

async function requestBodyFor(
  modelId: string,
  reasoning: string | undefined,
  messages: NormalizedMessage[] = [{ role: "user", content: "hello" }],
): Promise<Record<string, unknown>> {
  const { fetch: fetchMock, calls } = makeFetchMock(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  );
  const deps: AnthropicProviderDeps = { fetch: fetchMock, grant: validGrant() };
  const provider = new AnthropicProvider(deps);
  const opts: StreamOptions = { attemptId: "attempt-reasoning-fixture" };
  const events: NormalizedEvent[] = [];
  for await (const event of provider.stream(buildRequest(modelId, messages, reasoning), opts)) {
    events.push(event);
  }
  return JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
}

async function collectEvents(sseText: string, modelId = "claude-opus-5-20260101"): Promise<NormalizedEvent[]> {
  const { fetch: fetchMock } = makeFetchMock(sseText);
  const deps: AnthropicProviderDeps = { fetch: fetchMock, grant: validGrant() };
  const provider = new AnthropicProvider(deps);
  const request = buildRequest(modelId, [{ role: "user", content: "hello" }], "high");
  const opts: StreamOptions = { attemptId: "attempt-reasoning-sse" };
  const events: NormalizedEvent[] = [];
  for await (const event of provider.stream(request, opts)) {
    events.push(event);
  }
  return events;
}

// --- Model family helper -----------------------------------------------

describe("anthropicModelFamily", () => {
  test("adaptive family: Opus 5 / Sonnet 5 / Fable / Mythos / Opus 4.6-4.8 / Sonnet 4.6", () => {
    expect(anthropicModelFamily("claude-opus-5-20260101")).toBe("adaptive");
    expect(anthropicModelFamily("claude-sonnet-5-20260101")).toBe("adaptive");
    expect(anthropicModelFamily("claude-fable-5-20260101")).toBe("adaptive");
    expect(anthropicModelFamily("claude-fable-5-1-20260101")).toBe("adaptive");
    expect(anthropicModelFamily("claude-mythos-20260101")).toBe("adaptive");
    expect(anthropicModelFamily("claude-opus-4-6-20260101")).toBe("adaptive");
    expect(anthropicModelFamily("claude-opus-4-7-20260101")).toBe("adaptive");
    expect(anthropicModelFamily("claude-opus-4-8-20260101")).toBe("adaptive");
    expect(anthropicModelFamily("claude-sonnet-4-6-20260101")).toBe("adaptive");
  });

  test("adaptive family default: an unrecognized future claude id", () => {
    expect(anthropicModelFamily("claude-nebula-9-20270101")).toBe("adaptive");
  });

  test("budget family: Haiku 4.5, Sonnet 4.5, Opus 4.5, claude-3*, claude-2*", () => {
    expect(anthropicModelFamily("claude-haiku-4-5-20250929")).toBe("budget");
    expect(anthropicModelFamily("claude-sonnet-4-5-20250929")).toBe("budget");
    expect(anthropicModelFamily("claude-opus-4-5-20250929")).toBe("budget");
    expect(anthropicModelFamily("claude-3-5-sonnet-20241022")).toBe("budget");
    expect(anthropicModelFamily("claude-3-opus-20240229")).toBe("budget");
    expect(anthropicModelFamily("claude-2.1")).toBe("budget");
  });
});

// --- Request body: thinking params per family ---------------------------

describe("AC8 — request body: thinking params per model family and effort", () => {
  test("adaptive model + effort: thinking adaptive + summarized display + output_config.effort, no budget_tokens, max_tokens unchanged", async () => {
    const body = await requestBodyFor("claude-opus-5-20260101", "high");
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.max_tokens).toBe(1024);
    expect((body.thinking as Record<string, unknown>).budget_tokens).toBeUndefined();
  });

  test("Opus 4.6 / Sonnet 4.6 have no xhigh: effort xhigh maps to high", async () => {
    const body = await requestBodyFor("claude-opus-4-6-20260101", "xhigh");
    expect(body.output_config).toEqual({ effort: "high" });
  });

  test("Opus 5 keeps xhigh unmapped", async () => {
    const body = await requestBodyFor("claude-opus-5-20260101", "xhigh");
    expect(body.output_config).toEqual({ effort: "xhigh" });
  });

  test("haiku-4-5 (budget family) + effort: thinking enabled + budget_tokens, max_tokens raised, no output_config", async () => {
    const body = await requestBodyFor("claude-haiku-4-5-20250929", "high");
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(body.output_config).toBeUndefined();
    // max_tokens raised to budget_tokens (8192) + the request's maxOutputTokens (1024).
    expect(body.max_tokens).toBe(8192 + 1024);
  });

  test("budget family effort levels map to the documented budget_tokens", async () => {
    expect(((await requestBodyFor("claude-haiku-4-5-20250929", "low")).thinking as Record<string, unknown>).budget_tokens).toBe(
      2048,
    );
    expect(
      ((await requestBodyFor("claude-haiku-4-5-20250929", "medium")).thinking as Record<string, unknown>).budget_tokens,
    ).toBe(4096);
    expect(
      ((await requestBodyFor("claude-haiku-4-5-20250929", "xhigh")).thinking as Record<string, unknown>).budget_tokens,
    ).toBe(16000);
    expect(
      ((await requestBodyFor("claude-haiku-4-5-20250929", "max")).thinking as Record<string, unknown>).budget_tokens,
    ).toBe(16000);
  });

  test("no thinking param when effort is absent (an adaptive model may still think by default — that's fine, untouched here)", async () => {
    const body = await requestBodyFor("claude-opus-5-20260101", undefined);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.max_tokens).toBe(1024);
  });

  test('no thinking param when effort is "off"', async () => {
    const body = await requestBodyFor("claude-haiku-4-5-20250929", "off");
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(1024);
  });
});

// --- SSE parsing: thinking_delta / signature_delta -----------------------

describe("AC8 — thinking_delta + signature_delta parse to reasoning_delta and a full reasoning_replay", () => {
  test("thinking block (with signature) then tool_use: reasoning_delta text, reasoning_replay full text+signature, tool events unchanged", async () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me "}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think."}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01Fixture","name":"get_weather","input":{}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';

    const events = await collectEvents(sse);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "model_start",
      "reasoning_delta",
      "reasoning_delta",
      "reasoning_replay",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "usage_update",
      "model_end",
    ]);

    expect(events[1]).toMatchObject({ kind: "reasoning_delta", text: "Let me " });
    expect(events[1]!.redacted).toBeUndefined();
    expect(events[2]).toMatchObject({ kind: "reasoning_delta", text: "think." });

    const replayEvent = events[3]!;
    expect(replayEvent.kind).toBe("reasoning_replay");
    expect(replayEvent.replay).toEqual({
      providerId: "anthropic",
      kind: "thinking",
      data: { type: "thinking", thinking: "Let me think.", signature: "sig-abc" },
    });

    // Tool events are unaffected by the interleaved thinking block.
    expect(events[4]).toMatchObject({ kind: "tool_call_start", toolCallId: "toolu_01Fixture", toolName: "get_weather" });
    expect(events[5]).toMatchObject({ kind: "tool_call_delta", toolCallId: "toolu_01Fixture", inputDelta: "{}" });
    expect(events[6]).toMatchObject({ kind: "tool_call_end", toolCallId: "toolu_01Fixture" });
  });

  test("an empty thinking_delta is skipped (no reasoning_delta emitted for it)", async () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ok"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":1}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';

    const events = await collectEvents(sse);
    const reasoningDeltas = events.filter((e) => e.kind === "reasoning_delta");
    expect(reasoningDeltas).toHaveLength(1);
    expect(reasoningDeltas[0]!.text).toBe("ok");
  });
});

// --- SSE parsing: redacted_thinking --------------------------------------

describe("AC8 — a redacted_thinking block yields reasoning_delta {redacted:true} then a reasoning_replay carrying the opaque data", () => {
  test("redacted_thinking fixture", async () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque-bytes-abc"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":1}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';

    const events = await collectEvents(sse);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["model_start", "reasoning_delta", "reasoning_replay", "usage_update", "model_end"]);

    expect(events[1]).toMatchObject({ kind: "reasoning_delta", redacted: true });
    expect(events[1]!.text).toBeUndefined();

    expect(events[2]!.replay).toEqual({
      providerId: "anthropic",
      kind: "redacted_thinking",
      data: { type: "redacted_thinking", data: "opaque-bytes-abc" },
    });
  });
});

// --- toAnthropicMessages(): replay ordering ------------------------------

describe("AC8 — toAnthropicMessages() replays owned thinking/redacted_thinking blocks before text/tool_use", () => {
  test("thinking, then redacted_thinking, then text, then tool_use, in stored order", () => {
    const messages: NormalizedMessage[] = [
      {
        role: "assistant",
        content: "Here you go.",
        toolCalls: [{ id: "call-1", name: "get_weather", arguments: '{"location":"NYC"}' }],
        reasoning: {
          replay: [
            { providerId: "anthropic", kind: "thinking", data: { type: "thinking", thinking: "step one", signature: "sig-1" } },
            { providerId: "anthropic", kind: "redacted_thinking", data: { type: "redacted_thinking", data: "opaque-1" } },
          ],
        },
      },
      { role: "tool", content: "sunny", toolCallId: "call-1" },
    ];

    const wire = toAnthropicMessages(messages);
    expect(wire).toHaveLength(2);
    const entry = wire[0]!;
    expect(entry.role).toBe("assistant");
    expect(entry.content).toEqual([
      { type: "thinking", thinking: "step one", signature: "sig-1" },
      { type: "redacted_thinking", data: "opaque-1" },
      { type: "text", text: "Here you go." },
      { type: "tool_use", id: "call-1", name: "get_weather", input: { location: "NYC" } },
    ]);
  });

  test("a foreign providerId's replay items are ignored", () => {
    const messages: NormalizedMessage[] = [
      {
        role: "assistant",
        content: "plain answer",
        reasoning: {
          replay: [{ providerId: "openai", kind: "encrypted_content", data: { type: "reasoning", encrypted_content: "xyz" } }],
        },
      },
    ];

    const wire = toAnthropicMessages(messages);
    // No owned replay items and no tool calls: falls back to the plain
    // string-content shape, exactly as a message with no reasoning at all.
    expect(wire).toEqual([{ role: "assistant", content: "plain answer" }]);
  });

  test("a thinking-only round (no tool calls, empty text) still reaches the wire as array-content", () => {
    const messages: NormalizedMessage[] = [
      {
        role: "assistant",
        content: "",
        reasoning: {
          replay: [{ providerId: "anthropic", kind: "thinking", data: { type: "thinking", thinking: "just thinking", signature: "sig-2" } }],
        },
      },
    ];

    const wire = toAnthropicMessages(messages);
    expect(wire).toEqual([
      { role: "assistant", content: [{ type: "thinking", thinking: "just thinking", signature: "sig-2" }] },
    ]);
  });

  test("a message without reasoning builds exactly as before (plain string content, no calls)", () => {
    const messages: NormalizedMessage[] = [{ role: "assistant", content: "hi" }];
    expect(toAnthropicMessages(messages)).toEqual([{ role: "assistant", content: "hi" }]);
  });

  test("a message without reasoning but with linked tool calls builds exactly as before (no thinking blocks prepended)", () => {
    const messages: NormalizedMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-2", name: "noop", arguments: "{}" }],
      },
      { role: "tool", content: "ok", toolCallId: "call-2" },
    ];
    const wire = toAnthropicMessages(messages);
    expect(wire[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "call-2", name: "noop", input: {} }],
    });
  });
});
