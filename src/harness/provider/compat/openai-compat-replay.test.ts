// Compat reasoning replay tests for `OpenAiCompatEngine` (flow 268, T12 /
// AC7): `grant.reasoning.replay` ("deepseek" | "minimax") controls (1) what
// this engine EMITS as a `reasoning_replay` event at the end of a successful
// round, and (2) what it SENDS back on a later request for a prior assistant
// message carrying `reasoning.replay` items.
//
// `openai-compat-reasoning.test.ts` covers `format`/`requestParams`/
// `reasoning_details`-as-`reasoning_delta` wiring (AC4-AC5) — this file is
// scoped to the replay payload itself and never touches those paths.
//
// Every stream body here is a hand-controlled `ReadableStream<Uint8Array>`
// (mirrors `openai-compat-streaming.test.ts`) so the abort test can assert
// "no reasoning_replay before the abort lands" precisely.
import { describe, expect, test } from "bun:test";
import { OpenAiCompatEngine, type OpenAiCompatCapabilityGrant, type OpenAiCompatIdentity, type OpenAiCompatProviderDeps } from "./openai-compat-provider";
import type { NormalizedEvent, NormalizedMessage, NormalizedRequest, ProviderReplayItem, StreamOptions } from "../types";

const identity: OpenAiCompatIdentity = {
  providerId: "compat-replay-fixture",
  providerRevision: "test",
  defaultBaseUrl: "http://localhost:43126",
  defaultModel: { modelId: "fixture-model", revision: "test" },
  providerLabel: "Compat replay fixture",
};

const COMPAT_REPLAY_PROVIDER_ID = "openai-compat";

function buildRequest(
  requestId: string,
  overrides: Partial<Pick<NormalizedRequest, "messages" | "tools">> = {},
): NormalizedRequest {
  return {
    providerId: identity.providerId,
    modelId: identity.defaultModel.modelId,
    systemInstruction: "fixture",
    messages: overrides.messages ?? [{ role: "user", content: "hello" }],
    ...(overrides.tools !== undefined ? { tools: overrides.tools } : {}),
    budget: { maxOutputTokens: 32, runReservation: 32 },
    stream: true,
    requestId,
    parentRunId: requestId,
  };
}

const oneTool = [{ name: "lookup", inputSchema: { type: "object" as const } }];

interface CapturedCall {
  input: RequestInfo | URL;
  init?: RequestInit;
}

function fetchMockFor(sseText: string): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(init === undefined ? { input } : { input, init });
    return new Response(sseText, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

async function collectEvents(provider: OpenAiCompatEngine, requestId: string, opts: Partial<StreamOptions> = {}): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of provider.stream(buildRequest(requestId), { attemptId: `att-${requestId}`, ...opts })) {
    events.push(event);
  }
  return events;
}

function replayEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  return events.filter((e) => e.kind === "reasoning_replay");
}

/** A `ReadableStream<Uint8Array>` the test can feed bytes into on its own schedule (mirrors `openai-compat-streaming.test.ts`). */
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

function fetchMockForResponse(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

// --- emission: deepseek ------------------------------------------------------

describe("AC7 — emission: replay: \"deepseek\"", () => {
  test("emits one reasoning_replay(reasoning_content) with the concatenated raw reasoning text, before model_end", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_content":"Let me "}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_content":"think."}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { replay: "deepseek" },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const events = await collectEvents(provider, "deepseek-emit");

    const replays = replayEvents(events);
    expect(replays).toHaveLength(1);
    expect(replays[0]?.replay).toEqual({
      providerId: COMPAT_REPLAY_PROVIDER_ID,
      kind: "reasoning_content",
      data: "Let me think.",
    });
    const replayIdx = events.indexOf(replays[0]!);
    const modelEndIdx = events.findIndex((e) => e.kind === "model_end");
    expect(modelEndIdx).toBeGreaterThan(-1);
    expect(replayIdx).toBeLessThan(modelEndIdx);
  });

  test("no reasoning text this round -> no reasoning_replay event", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Answer only"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { replay: "deepseek" },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const events = await collectEvents(provider, "deepseek-empty");
    expect(replayEvents(events)).toHaveLength(0);
  });
});

// --- emission: minimax split (reasoning_details) -----------------------------

describe("AC7 — emission: replay: \"minimax\", format: \"split\"", () => {
  test("merges fragmented reasoning_details by index into one reasoning_replay(reasoning_details)", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_details":[{"index":0,"type":"reasoning.text","text":"Hel"}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_details":[{"index":0,"type":"reasoning.text","text":"lo"},{"index":1,"type":"reasoning.text","text":"World"}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { format: "split", replay: "minimax", requestParams: { reasoning_split: true } },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const events = await collectEvents(provider, "minimax-split-emit");

    const replays = replayEvents(events);
    expect(replays).toHaveLength(1);
    expect(replays[0]?.replay).toEqual({
      providerId: COMPAT_REPLAY_PROVIDER_ID,
      kind: "reasoning_details",
      data: [
        { index: 0, type: "reasoning.text", text: "Hello" },
        { index: 1, type: "reasoning.text", text: "World" },
      ],
    });
  });

  test("items without index or id merge into one item, keeping the first item's other fields", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"A"}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"B"}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { format: "split", replay: "minimax" },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const events = await collectEvents(provider, "minimax-split-nokeys");

    const replays = replayEvents(events);
    expect(replays).toHaveLength(1);
    expect(replays[0]?.replay).toEqual({
      providerId: COMPAT_REPLAY_PROVIDER_ID,
      kind: "reasoning_details",
      data: [{ type: "reasoning.text", text: "AB" }],
    });
  });

  // flow 268 T24: live smoke evidence against MiniMax-M3 — split-mode
  // reasoning_details ends with a literal `</think>` line, itself split
  // across two deltas (`"...\n</thi"` + `"nk>"`). The EMITTED reasoning_delta
  // must have the tag and its adjacent newline stripped; the REPLAY payload
  // (reasoning_details) must stay byte-exact, tag included, since a replayed
  // transcript must round-trip exactly what the provider sent.
  test("a </think> tag split across two deltas is stripped from reasoning_delta but left verbatim in the reasoning_replay payload", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_details":[{"index":0,"type":"reasoning.text","id":"reasoning-text-1","format":"MiniMax-response-v1","text":"The user wants a greeting in a friendly "}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_details":[{"index":0,"type":"reasoning.text","id":"reasoning-text-1","format":"MiniMax-response-v1","text":"manner.\\n</thi"}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_details":[{"index":0,"type":"reasoning.text","id":"reasoning-text-1","format":"MiniMax-response-v1","text":"nk>"}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Hi there!"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { format: "split", replay: "minimax", requestParams: { reasoning_split: true } },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const events = await collectEvents(provider, "minimax-split-tag-boundary");

    const reasoning = events.filter((e) => e.kind === "reasoning_delta").map((e) => e.text ?? "").join("");
    expect(reasoning).toBe("The user wants a greeting in a friendly manner.");
    expect(reasoning).not.toContain("<think>");
    expect(reasoning).not.toContain("</think>");

    const replays = replayEvents(events);
    expect(replays).toHaveLength(1);
    expect(replays[0]?.replay).toEqual({
      providerId: COMPAT_REPLAY_PROVIDER_ID,
      kind: "reasoning_details",
      data: [
        {
          index: 0,
          type: "reasoning.text",
          id: "reasoning-text-1",
          format: "MiniMax-response-v1",
          text: "The user wants a greeting in a friendly manner.\n</think>",
        },
      ],
    });
  });
});

// --- emission: minimax inline (raw_content) ----------------------------------

describe("AC7 — emission: replay: \"minimax\", format: \"inline-tags\"", () => {
  test("emits one reasoning_replay(raw_content) with the exact raw content string, tags included", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"<think>reason"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"ing</think>answer"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { format: "inline-tags", replay: "minimax" },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const events = await collectEvents(provider, "minimax-inline-emit");

    const replays = replayEvents(events);
    expect(replays).toHaveLength(1);
    expect(replays[0]?.replay).toEqual({
      providerId: COMPAT_REPLAY_PROVIDER_ID,
      kind: "raw_content",
      data: "<think>reasoning</think>answer",
    });
    // The parsed reasoning_delta/text_delta output is unaffected by replay capture.
    const reasoning = events.filter((e) => e.kind === "reasoning_delta").map((e) => e.text ?? "").join("");
    const text = events.filter((e) => e.kind === "text_delta").map((e) => e.text ?? "").join("");
    expect(reasoning).toBe("reasoning");
    expect(text).toBe("answer");
  });
});

// --- no replay setting -------------------------------------------------------

describe("AC7 — replay: \"none\"/absent sends no reasoning replay", () => {
  test("replay absent: reasoning-bearing round emits no reasoning_replay event", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = { network: true, baseUrl: identity.defaultBaseUrl, allowLoopback: true };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const events = await collectEvents(provider, "no-replay-config");
    expect(replayEvents(events)).toHaveLength(0);
  });

  test('replay: "none" explicit: same, no reasoning_replay event', async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { replay: "none" },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const events = await collectEvents(provider, "explicit-none");
    expect(replayEvents(events)).toHaveLength(0);
  });
});

// --- no emission on abort -----------------------------------------------------

describe("AC7 — no reasoning_replay on an aborted attempt", () => {
  test("aborting mid-stream (deepseek reasoning already seen) yields no reasoning_replay, no model_end", async () => {
    const stream = controlledStream();
    stream.enqueue('data: {"choices":[{"delta":{"reasoning_content":"partial thought"}}]}\n\n');

    const controller = new AbortController();
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { replay: "deepseek" },
    };
    const deps: OpenAiCompatProviderDeps = { fetch: fetchMockForResponse(stream.response), grant };
    const provider = new OpenAiCompatEngine(deps, identity);
    const opts: StreamOptions = { attemptId: "att-abort", signal: controller.signal };
    const iterator = provider.stream(buildRequest("req-abort"), opts)[Symbol.asyncIterator]();

    // Drain the one event the enqueued chunk produces (model_start), then abort.
    const events: NormalizedEvent[] = [];
    const first = await iterator.next();
    expect(first.done).toBe(false);
    events.push(first.value as NormalizedEvent);

    controller.abort();

    let result = await iterator.next();
    while (!result.done) {
      events.push(result.value as NormalizedEvent);
      result = await iterator.next();
    }

    expect(replayEvents(events)).toHaveLength(0);
    expect(events.some((e) => e.kind === "model_end")).toBe(false);
    expect(events.some((e) => e.kind === "provider_error" && e.error?.kind === "cancelled")).toBe(true);
  });
});

// --- request building: deepseek ----------------------------------------------

function assistantMessageWithReplay(content: string, replay: ProviderReplayItem[]): NormalizedMessage {
  return { role: "assistant", content, reasoning: { replay } };
}

describe("AC7 — request building: replay: \"deepseek\"", () => {
  test("with tools: a prior assistant message's owned reasoning_content item is sent as reasoning_content", async () => {
    const sse = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' + "data: [DONE]\n\n";
    const { fetch, calls } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { replay: "deepseek" },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const priorAssistant = assistantMessageWithReplay("earlier answer", [
      { providerId: COMPAT_REPLAY_PROVIDER_ID, kind: "reasoning_content", data: "earlier reasoning" },
    ]);
    const request = buildRequest("deepseek-tools", {
      messages: [{ role: "user", content: "hi" }, priorAssistant, { role: "user", content: "again" }],
      tools: oneTool,
    });
    for await (const _ of provider.stream(request, { attemptId: "att-deepseek-tools" })) {
      // drain
    }

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init?.body)) as { messages: Array<Record<string, unknown>> };
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.reasoning_content).toBe("earlier reasoning");
    expect(assistantMsg?.content).toBe("earlier answer");
  });

  test("without tools: the same owned reasoning_content item is NOT sent", async () => {
    const sse = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' + "data: [DONE]\n\n";
    const { fetch, calls } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { replay: "deepseek" },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const priorAssistant = assistantMessageWithReplay("earlier answer", [
      { providerId: COMPAT_REPLAY_PROVIDER_ID, kind: "reasoning_content", data: "earlier reasoning" },
    ]);
    const request = buildRequest("deepseek-no-tools", {
      messages: [{ role: "user", content: "hi" }, priorAssistant, { role: "user", content: "again" }],
    });
    for await (const _ of provider.stream(request, { attemptId: "att-deepseek-no-tools" })) {
      // drain
    }

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init?.body)) as { messages: Array<Record<string, unknown>> };
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.reasoning_content).toBeUndefined();
    expect(assistantMsg?.content).toBe("earlier answer");
  });
});

// --- request building: minimax ------------------------------------------------

describe("AC7 — request building: replay: \"minimax\"", () => {
  test("a raw_content item REPLACES the message's content verbatim", async () => {
    const sse = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' + "data: [DONE]\n\n";
    const { fetch, calls } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { format: "inline-tags", replay: "minimax" },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const priorAssistant = assistantMessageWithReplay("answer", [
      { providerId: COMPAT_REPLAY_PROVIDER_ID, kind: "raw_content", data: "<think>reasoning</think>answer" },
    ]);
    const request = buildRequest("minimax-raw", {
      messages: [{ role: "user", content: "hi" }, priorAssistant, { role: "user", content: "again" }],
    });
    for await (const _ of provider.stream(request, { attemptId: "att-minimax-raw" })) {
      // drain
    }

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init?.body)) as { messages: Array<Record<string, unknown>> };
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toBe("<think>reasoning</think>answer");
  });

  test("a reasoning_details item is attached as reasoning_details, content unchanged", async () => {
    const sse = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' + "data: [DONE]\n\n";
    const { fetch, calls } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { format: "split", replay: "minimax" },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const details = [{ type: "reasoning.text", text: "hi" }];
    const priorAssistant = assistantMessageWithReplay("answer text", [
      { providerId: COMPAT_REPLAY_PROVIDER_ID, kind: "reasoning_details", data: details },
    ]);
    const request = buildRequest("minimax-details", {
      messages: [{ role: "user", content: "hi" }, priorAssistant, { role: "user", content: "again" }],
    });
    for await (const _ of provider.stream(request, { attemptId: "att-minimax-details" })) {
      // drain
    }

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init?.body)) as { messages: Array<Record<string, unknown>> };
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.reasoning_details).toEqual(details);
    expect(assistantMsg?.content).toBe("answer text");
  });
});

// --- request building: foreign providerId ignored ------------------------------

describe("AC7 — a replay item with a foreign providerId is ignored", () => {
  test("deepseek: a reasoning_content item stamped by another adapter is not sent", async () => {
    const sse = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' + "data: [DONE]\n\n";
    const { fetch, calls } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { replay: "deepseek" },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const priorAssistant = assistantMessageWithReplay("earlier answer", [
      { providerId: "anthropic", kind: "reasoning_content", data: "not ours" },
    ]);
    const request = buildRequest("foreign-provider-id", {
      messages: [{ role: "user", content: "hi" }, priorAssistant, { role: "user", content: "again" }],
      tools: oneTool,
    });
    for await (const _ of provider.stream(request, { attemptId: "att-foreign" })) {
      // drain
    }

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init?.body)) as { messages: Array<Record<string, unknown>> };
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.reasoning_content).toBeUndefined();
    expect(assistantMsg?.content).toBe("earlier answer");
  });

  test("minimax: raw_content/reasoning_details items stamped by another adapter are not sent", async () => {
    const sse = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' + "data: [DONE]\n\n";
    const { fetch, calls } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      network: true,
      baseUrl: identity.defaultBaseUrl,
      allowLoopback: true,
      reasoning: { format: "inline-tags", replay: "minimax" },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const priorAssistant = assistantMessageWithReplay("earlier answer", [
      { providerId: "gemini", kind: "raw_content", data: "<think>not ours</think>foo" },
      { providerId: "gemini", kind: "reasoning_details", data: [{ text: "not ours" }] },
    ]);
    const request = buildRequest("foreign-provider-id-minimax", {
      messages: [{ role: "user", content: "hi" }, priorAssistant, { role: "user", content: "again" }],
    });
    for await (const _ of provider.stream(request, { attemptId: "att-foreign-minimax" })) {
      // drain
    }

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init?.body)) as { messages: Array<Record<string, unknown>> };
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toBe("earlier answer");
    expect(assistantMsg?.reasoning_details).toBeUndefined();
  });
});
