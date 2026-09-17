// Tests for OpenAI Responses reasoning support (flow 268, T14 / AC9).
//
// Covers: (a) the request only carries `reasoning`/`include`/`store` when the
// caller opted into an effort level — sending `reasoning` to a non-reasoning
// model (gpt-4.1/gpt-4o) is a documented HTTP 400, so this must stay
// conditional; (b) capture of a `reasoning` output item (summary deltas +
// `response.output_item.done`) into `reasoning_delta`/`reasoning_replay`
// events, interleaved with a tool call in the same turn; (c) the
// hidden-reasoning fallback when a provider withholds summary text entirely;
// (d) `toResponsesInput` replaying a captured reasoning item verbatim, ahead
// of the function_call items of the SAME assistant turn, while a
// foreign-provider replay item (not this adapter's to interpret) is ignored.
//
// Same offline/deterministic conventions as `openai-provider.test.ts`:
// `fetch` always injected, `.SYNTHETIC.`-caveated fixtures, never a real call.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { OpenAiCapabilityGrant, OpenAiProviderDeps } from "./openai-provider";
import { OpenAiProvider } from "./openai-provider";
import type { NormalizedEvent, NormalizedEventKind, NormalizedRequest, StreamOptions } from "../types";

const REASONING_TOOL_FIXTURE_PATH = path.join(
  import.meta.dir,
  "fixtures",
  "reasoning-tool-call-stream.SYNTHETIC.sse",
);

const API_KEY = "sk-openai-test-reasoning-DO-NOT-LEAK-0000000000";

function loadFixtureText(fixturePath: string): string {
  return readFileSync(fixturePath, "utf8");
}

function buildRequest(requestId: string, overrides?: Partial<NormalizedRequest>): NormalizedRequest {
  return {
    providerId: "openai",
    modelId: "o4-mini",
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
    ...overrides,
  };
}

function validGrant(): OpenAiCapabilityGrant {
  return { network: true, apiKey: API_KEY };
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

// --- request body: reasoning gated on options.reasoning ----------------------

describe("AC9 — request body only carries reasoning/include/store when effort is set", () => {
  test("no options.reasoning -> no reasoning/include/store fields at all", async () => {
    const { fetch: fetchMock, calls } = makeFixtureFetchMock(REASONING_TOOL_FIXTURE_PATH);
    const provider = new OpenAiProvider({ fetch: fetchMock, grant: validGrant() });
    await collectEvents(provider.stream(buildRequest("req-no-effort"), { attemptId: "att-no-effort" }));

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.reasoning).toBeUndefined();
    expect(body.include).toBeUndefined();
    expect(body.store).toBeUndefined();
  });

  test('options.reasoning: "off" -> no reasoning/include/store fields (explicit opt-out)', async () => {
    const { fetch: fetchMock, calls } = makeFixtureFetchMock(REASONING_TOOL_FIXTURE_PATH);
    const provider = new OpenAiProvider({ fetch: fetchMock, grant: validGrant() });
    await collectEvents(
      provider.stream(buildRequest("req-off", { options: { reasoning: "off" } }), { attemptId: "att-off" }),
    );

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.reasoning).toBeUndefined();
    expect(body.include).toBeUndefined();
    expect(body.store).toBeUndefined();
  });

  test('options.reasoning: "medium" -> reasoning:{effort,summary:"auto"}, include, and store:false', async () => {
    const { fetch: fetchMock, calls } = makeFixtureFetchMock(REASONING_TOOL_FIXTURE_PATH);
    const provider = new OpenAiProvider({ fetch: fetchMock, grant: validGrant() });
    await collectEvents(
      provider.stream(buildRequest("req-medium", { options: { reasoning: "medium" } }), { attemptId: "att-medium" }),
    );

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.store).toBe(false);
    // Unrelated fields are unaffected.
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBe(1024);
  });

  // flow 268 merge (reasoning + temperature coexistence): the Responses API
  // 400s a reasoning-effort request that also carries a sampling
  // `temperature` — an operator-configured `options.temperature` must never
  // reach the wire on a reasoning-requested turn, even though it DOES reach
  // it on a non-reasoning turn (see `openai-provider.test.ts`'s
  // "flow 268 — max_output_tokens/temperature reach the Responses API
  // payload" describe block).
  test("options.reasoning set + options.temperature configured -> temperature is omitted, reasoning still sent", async () => {
    const { fetch: fetchMock, calls } = makeFixtureFetchMock(REASONING_TOOL_FIXTURE_PATH);
    const provider = new OpenAiProvider({ fetch: fetchMock, grant: validGrant() });
    await collectEvents(
      provider.stream(buildRequest("req-medium-temp", { options: { reasoning: "medium", temperature: 0.2 } }), {
        attemptId: "att-medium-temp",
      }),
    );

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect("temperature" in body).toBe(false);
  });

  test('flow 268 T16: options.reasoning "xhigh"/"max" -> reasoning.effort clamps to "high" (OpenAI has no xhigh/max)', async () => {
    const { fetch: fetchXhigh, calls: callsXhigh } = makeFixtureFetchMock(REASONING_TOOL_FIXTURE_PATH);
    const providerXhigh = new OpenAiProvider({ fetch: fetchXhigh, grant: validGrant() });
    await collectEvents(
      providerXhigh.stream(buildRequest("req-xhigh", { options: { reasoning: "xhigh" } }), { attemptId: "att-xhigh" }),
    );
    const bodyXhigh = JSON.parse(String(callsXhigh[0]?.init?.body)) as Record<string, unknown>;
    expect(bodyXhigh.reasoning).toEqual({ effort: "high", summary: "auto" });

    const { fetch: fetchMax, calls: callsMax } = makeFixtureFetchMock(REASONING_TOOL_FIXTURE_PATH);
    const providerMax = new OpenAiProvider({ fetch: fetchMax, grant: validGrant() });
    await collectEvents(
      providerMax.stream(buildRequest("req-max", { options: { reasoning: "max" } }), { attemptId: "att-max" }),
    );
    const bodyMax = JSON.parse(String(callsMax[0]?.init?.body)) as Record<string, unknown>;
    expect(bodyMax.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  test('flow 268 T16: options.reasoning "minimal" passes through unclamped (OpenAI\'s own lowest documented level)', async () => {
    const { fetch: fetchMock, calls } = makeFixtureFetchMock(REASONING_TOOL_FIXTURE_PATH);
    const provider = new OpenAiProvider({ fetch: fetchMock, grant: validGrant() });
    await collectEvents(
      provider.stream(buildRequest("req-minimal", { options: { reasoning: "minimal" } }), { attemptId: "att-minimal" }),
    );
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: "minimal", summary: "auto" });
  });
});

// --- capture: reasoning summary deltas + output_item.done + tool call --------

describe("AC9 — reasoning summary deltas, a captured reasoning_replay item, and a tool call in one turn", () => {
  test("stream() yields model_start, 2x reasoning_delta, reasoning_replay (verbatim item), tool_call_*, usage_update, model_end", async () => {
    const { fetch: fetchMock } = makeFixtureFetchMock(REASONING_TOOL_FIXTURE_PATH);
    const deps: OpenAiProviderDeps = { fetch: fetchMock, grant: validGrant() };
    const provider = new OpenAiProvider(deps);
    const request = buildRequest("request-reasoning-tool", { options: { reasoning: "medium" } });
    const opts: StreamOptions = { attemptId: "attempt-reasoning-tool" };

    const events = await collectEvents(provider.stream(request, opts));

    expect(kinds(events)).toEqual([
      "model_start",
      "reasoning_delta",
      "reasoning_delta",
      "reasoning_replay",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_end",
      "usage_update",
      "model_end",
    ]);

    expect(events[1]).toMatchObject({ kind: "reasoning_delta", text: "Checking the " });
    expect(events[2]).toMatchObject({ kind: "reasoning_delta", text: "forecast source." });

    const replayEvent = events[3]!;
    expect(replayEvent.kind).toBe("reasoning_replay");
    expect(replayEvent.replay).toEqual({
      providerId: "openai",
      kind: "reasoning_item",
      data: {
        id: "rs_fixture0000000000000001",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Checking the forecast source." }],
        encrypted_content: "gAAAAABfixtureEncryptedReasoningContent0001",
      },
    });

    // Not double-counted: reasoning_replay appears exactly once even though
    // this fixture's response.completed does not repeat the output array
    // (this adapter never parses response.completed.response.output for
    // reasoning items — output_item.done is the single capture point).
    expect(events.filter((e) => e.kind === "reasoning_replay")).toHaveLength(1);

    const toolStart = events[4]!;
    expect(toolStart).toMatchObject({ kind: "tool_call_start", toolCallId: "call_fixtureWeather0002", toolName: "get_weather" });
    const toolEnd = events[7]!;
    expect(toolEnd.kind).toBe("tool_call_end");
    expect(JSON.parse(toolEnd.input as string)).toEqual({ location: "New York, NY" });

    const usageEvent = events[8]!;
    // Reasoning token usage stays in unknownExtensions, unchanged by this task.
    expect(usageEvent.unknownExtensions).toEqual({ "openai.reasoning_tokens": 18 });
  });
});

// --- hidden reasoning: no summary text ever arrives ---------------------------

describe("AC9 — hidden reasoning (no summary text, only encrypted_content) emits one redacted reasoning_delta", () => {
  test("no reasoning_summary_text.delta and no visible item.summary text -> redacted reasoning_delta once, plus reasoning_replay", async () => {
    const sse = [
      'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_hidden","status":"in_progress"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"rs_hidden0001","type":"reasoning","summary":[]}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":2,"output_index":0,"item":{"id":"rs_hidden0001","type":"reasoning","summary":[],"encrypted_content":"gAAAAABhiddenReasoning0001"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":3,"item_id":"msg_hidden0001","delta":"Answer text."}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","sequence_number":4,"response":{"id":"resp_hidden","status":"completed","usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}}}\n\n',
    ].join("");
    const { fetch: fetchMock } = makeFetchMock(
      () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const deps: OpenAiProviderDeps = { fetch: fetchMock, grant: validGrant() };
    const provider = new OpenAiProvider(deps);
    const events = await collectEvents(
      provider.stream(buildRequest("request-hidden", { options: { reasoning: "high" } }), { attemptId: "attempt-hidden" }),
    );

    expect(kinds(events)).toEqual([
      "model_start",
      "reasoning_delta",
      "reasoning_replay",
      "text_delta",
      "usage_update",
      "model_end",
    ]);

    const hiddenDelta = events[1]!;
    expect(hiddenDelta.kind).toBe("reasoning_delta");
    expect(hiddenDelta.redacted).toBe(true);
    expect(hiddenDelta.text).toBeUndefined();

    // Emitted exactly once even though the item carries no visible summary.
    expect(events.filter((e) => e.kind === "reasoning_delta")).toHaveLength(1);

    const replayEvent = events[2]!;
    expect(replayEvent.kind).toBe("reasoning_replay");
    expect(replayEvent.replay).toMatchObject({ providerId: "openai", kind: "reasoning_item" });
    expect((replayEvent.replay?.data as Record<string, unknown>).encrypted_content).toBe(
      "gAAAAABhiddenReasoning0001",
    );
  });

  test("a reasoning item WITH visible summary text never triggers the redacted fallback", async () => {
    // Regression guard: the fixture in the primary capture test above already
    // has visible summary text and streamed deltas — assert directly that no
    // `redacted: true` reasoning_delta appears there.
    const { fetch: fetchMock } = makeFixtureFetchMock(REASONING_TOOL_FIXTURE_PATH);
    const provider = new OpenAiProvider({ fetch: fetchMock, grant: validGrant() });
    const events = await collectEvents(
      provider.stream(buildRequest("request-visible", { options: { reasoning: "medium" } }), {
        attemptId: "attempt-visible",
      }),
    );

    const redacted = events.filter((e) => e.kind === "reasoning_delta" && e.redacted === true);
    expect(redacted).toHaveLength(0);
  });
});

// --- toResponsesInput replay ordering (exercised via the wire request body) --

describe("AC9 — toResponsesInput replays an owned reasoning_item verbatim ahead of function_call items; a foreign providerId is ignored", () => {
  test("request.input carries the reasoning item, then the function_call, then function_call_output; the anthropic item never appears", async () => {
    const { fetch: fetchMock, calls } = makeFixtureFetchMock(REASONING_TOOL_FIXTURE_PATH);
    const provider = new OpenAiProvider({ fetch: fetchMock, grant: validGrant() });

    const reasoningItemData = {
      id: "rs_replay0001",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Previously reasoned about this." }],
      encrypted_content: "gAAAAABreplayEncryptedContent0001",
    };
    const request = buildRequest("request-replay", {
      messages: [
        { role: "user", content: "What is the weather in New York?" },
        {
          role: "assistant",
          content: "",
          provenance: "model",
          toolCalls: [{ id: "call_replay0001", name: "get_weather", arguments: '{"location":"New York, NY"}' }],
          reasoning: {
            replay: [
              { providerId: "openai", kind: "reasoning_item", data: reasoningItemData },
              // Foreign-provider item: not this adapter's to interpret, must
              // never appear in the wire request.
              { providerId: "anthropic", kind: "thinking_signature", data: { signature: "anthropic-opaque-bytes" } },
            ],
          },
        },
        { role: "tool", content: "Sunny, 72F.", toolCallId: "call_replay0001" },
      ],
    });

    await collectEvents(provider.stream(request, { attemptId: "attempt-replay" }));

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    const inputArray = body.input as Record<string, unknown>[];

    expect(JSON.stringify(inputArray)).not.toContain("anthropic-opaque-bytes");

    // user message, then [reasoning item, function_call], then function_call_output.
    expect(inputArray[0]).toMatchObject({ type: "message", role: "user" });
    expect(inputArray[1]).toEqual(reasoningItemData);
    expect(inputArray[2]).toMatchObject({
      type: "function_call",
      call_id: "call_replay0001",
      name: "get_weather",
      arguments: '{"location":"New York, NY"}',
    });
    expect(inputArray[3]).toMatchObject({ type: "function_call_output", call_id: "call_replay0001" });
    expect(inputArray).toHaveLength(4);
  });

  test("a text-only assistant turn (no tool calls) still replays its owned reasoning item first", async () => {
    const { fetch: fetchMock, calls } = makeFixtureFetchMock(REASONING_TOOL_FIXTURE_PATH);
    const provider = new OpenAiProvider({ fetch: fetchMock, grant: validGrant() });

    const reasoningItemData = { id: "rs_textonly0001", type: "reasoning", summary: [], encrypted_content: "enc" };
    const request = buildRequest("request-replay-text", {
      messages: [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: "Hello!",
          provenance: "model",
          reasoning: { replay: [{ providerId: "openai", kind: "reasoning_item", data: reasoningItemData }] },
        },
      ],
    });

    await collectEvents(provider.stream(request, { attemptId: "attempt-replay-text" }));

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    const inputArray = body.input as Record<string, unknown>[];

    expect(inputArray[0]).toMatchObject({ type: "message", role: "user" });
    expect(inputArray[1]).toEqual(reasoningItemData);
    expect(inputArray[2]).toMatchObject({ type: "message", role: "assistant" });
  });

  test("a message without any reasoning replay items builds exactly as before (no injected items)", async () => {
    const { fetch: fetchMock, calls } = makeFixtureFetchMock(REASONING_TOOL_FIXTURE_PATH);
    const provider = new OpenAiProvider({ fetch: fetchMock, grant: validGrant() });

    const request = buildRequest("request-no-reasoning", {
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!", provenance: "model" },
      ],
    });

    await collectEvents(provider.stream(request, { attemptId: "attempt-no-reasoning" }));

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    const inputArray = body.input as Record<string, unknown>[];

    expect(inputArray).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello!" }] },
    ]);
  });
});
