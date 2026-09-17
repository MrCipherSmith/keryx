// Reasoning-config engine tests for `OpenAiCompatEngine` (flow 268, T10 /
// AC4-AC5): the `grant.reasoning` capability threaded from a custom
// provider's `reasoning` config (`src/lib/provider-config.ts` ->
// `src/commands/providers.ts` -> `src/harness/provider/make-provider.ts`).
//
// `think-tag-parser.test.ts` is the parser's own unit suite (pure, no SSE);
// this file proves the WIRING: `delta.content` routed through the parser
// only under `format: "inline-tags"`, `reasoning.requestParams` merged into
// the outbound payload without overriding the request's own fields, and
// `reasoning_details` read as `reasoning_delta` for every format.
import { describe, expect, test } from "bun:test";
import { OpenAiCompatEngine, type OpenAiCompatCapabilityGrant, type OpenAiCompatIdentity } from "./openai-compat-provider";
import type { NormalizedEvent, NormalizedRequest } from "../types";

const identity: OpenAiCompatIdentity = {
  providerId: "compat-reasoning-fixture",
  providerRevision: "test",
  defaultBaseUrl: "http://localhost:43125",
  defaultModel: { modelId: "fixture-model", revision: "test" },
  providerLabel: "Compat reasoning fixture",
};

const baseGrant: OpenAiCompatCapabilityGrant = {
  network: true,
  baseUrl: identity.defaultBaseUrl,
  allowLoopback: true,
};

function buildRequest(requestId: string): NormalizedRequest {
  return {
    providerId: identity.providerId,
    modelId: identity.defaultModel.modelId,
    systemInstruction: "fixture",
    messages: [{ role: "user", content: "hello" }],
    budget: { maxOutputTokens: 32, runReservation: 32 },
    stream: true,
    requestId,
    parentRunId: requestId,
  };
}

interface CapturedCall {
  input: RequestInfo | URL;
  init?: RequestInit;
}

/** Offline `fetch` mock: records every call, always answers with `sseText`. */
function fetchMockFor(sseText: string): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(init === undefined ? { input } : { input, init });
    return new Response(sseText, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

async function collectEvents(provider: OpenAiCompatEngine, requestId: string): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of provider.stream(buildRequest(requestId), { attemptId: `att-${requestId}` })) {
    events.push(event);
  }
  return events;
}

function textOf(events: NormalizedEvent[], kind: "text_delta" | "reasoning_delta"): string {
  return events
    .filter((e) => e.kind === kind)
    .map((e) => e.text ?? "")
    .join("");
}

// --- AC4: inline-tags routing -------------------------------------------

describe("AC4 — format: inline-tags routes delta.content through the parser", () => {
  test("<think>A</think>B split across two SSE records: reasoning_delta A, text_delta B", () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"nk>A</think>B"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = { ...baseGrant, reasoning: { format: "inline-tags" } };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    return collectEvents(provider, "inline-split").then((events) => {
      expect(textOf(events, "reasoning_delta")).toBe("A");
      expect(textOf(events, "text_delta")).toBe("B");
      expect(events[events.length - 1]?.kind).toBe("model_end");
    });
  });

  test("without inline-tags configured, the same content passes through unchanged", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"<think>A</think>B"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const provider = new OpenAiCompatEngine({ fetch, grant: baseGrant }, identity);
    const events = await collectEvents(provider, "no-config");
    expect(textOf(events, "text_delta")).toBe("<think>A</think>B");
    expect(textOf(events, "reasoning_delta")).toBe("");
  });

  test("an unclosed <think> at finish yields reasoning only, no text_delta", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"<think>A"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = { ...baseGrant, reasoning: { format: "inline-tags" } };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const events = await collectEvents(provider, "unclosed");
    expect(textOf(events, "reasoning_delta")).toBe("A");
    expect(events.some((e) => e.kind === "text_delta")).toBe(false);
    expect(events[events.length - 1]?.kind).toBe("model_end");
  });

  test("a stray </think> with no open is dropped: both sides surface as text_delta", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hello</think>World"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = { ...baseGrant, reasoning: { format: "inline-tags" } };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const events = await collectEvents(provider, "stray-close");
    expect(textOf(events, "text_delta")).toBe("HelloWorld");
    expect(textOf(events, "reasoning_delta")).toBe("");
  });
});

// --- T24: MiniMax default-mode duplication fix ---------------------------
//
// Live smoke evidence (2026-09-17, api.minimax.io, MiniMax-M3, no
// `reasoning_split`): every reasoning phrase arrives TWICE — inline in
// `delta.content` as `<think>…</think>`, AND again, plain, in `delta.reasoning`
// — and the LAST `reasoning` chunk bled answer text across the boundary
// (`content:" manner.Hi"`, `reasoning:" manner.Hi"`, where "Hi" starts the
// answer). Configuring `format: "inline-tags"` must make `delta.content`
// (via `ThinkTagParser`) the ONLY reasoning source: `reasoning`/
// `reasoning_content`/`reasoning_details` deltas are ignored entirely for
// `reasoning_delta` emission once inline-tags is active.
describe("T24 — format: inline-tags ignores reasoning/reasoning_content/reasoning_details deltas", () => {
  test("MiniMax default-mode duplicate deltas: each reasoning phrase surfaces exactly once, answer excludes tags and reasoning text", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"<think>\\nThe","reasoning":"The"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" user just","reasoning":" user just"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" manner.Hi","reasoning":" manner.Hi"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"\\n</think>\\n\\nthere! \\ud83d\\udc4b"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = { ...baseGrant, reasoning: { format: "inline-tags" } };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const events = await collectEvents(provider, "minimax-default-mode-duplicate");

    const reasoning = textOf(events, "reasoning_delta");
    const text = textOf(events, "text_delta");
    expect(reasoning).toBe("\nThe user just manner.Hi\n");
    expect(text).toBe("there! \u{1F44B}");
    // The bug: the "reasoning" field's raw text used to surface a SECOND time
    // alongside the inline-tags segments. Every occurrence of each phrase is
    // accounted for above by the SINGLE reasoning string, not doubled.
    expect(reasoning.split("The user just").length - 1).toBe(1);
    expect(events.filter((e) => e.kind === "text_delta").length).toBe(1);
    expect(text).not.toContain("<think>");
    expect(text).not.toContain("</think>");
  });
});

// --- T24: field-sourced reasoning tag stripping (format: field / split) --
//
// Live smoke evidence: split-mode (`reasoning_split: true`) reasoning text
// ended with a literal `</think>` line even though the gateway never puts
// tags in `delta.content` under split mode. Any `format` OTHER than
// `"inline-tags"` (including the default, absent `format`) must strip a
// literal `<think>`/`</think>` tag — and its one adjacent newline on each
// side — out of the emitted `reasoning_delta`, without ever touching the
// replay accumulation (covered separately in `openai-compat-replay.test.ts`).
describe("T24 — field-sourced reasoning strips a leaked <think>/</think> tag", () => {
  test("format: split, tag split across two deltas: reasoning_delta has no tag", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_content":"All good so far.\\n</thi"}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_content":"nk>"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      ...baseGrant,
      reasoning: { format: "split", requestParams: { reasoning_split: true } },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const events = await collectEvents(provider, "field-strip-split-boundary");

    expect(textOf(events, "reasoning_delta")).toBe("All good so far.");
    expect(textOf(events, "text_delta")).toBe("Answer");
  });

  test("no reasoning config at all (default format: field): a leaked tag in reasoning_content is still stripped", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_content":"<think>thinking about it</think>"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const provider = new OpenAiCompatEngine({ fetch, grant: baseGrant }, identity);
    const events = await collectEvents(provider, "field-strip-default-format");

    expect(textOf(events, "reasoning_delta")).toBe("thinking about it");
    expect(textOf(events, "text_delta")).toBe("Answer");
  });

  test("a delta that becomes empty after stripping the tag is skipped entirely (no empty reasoning_delta)", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_content":"</think>"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const provider = new OpenAiCompatEngine({ fetch, grant: baseGrant }, identity);
    const events = await collectEvents(provider, "field-strip-empty-after-strip");

    expect(events.some((e) => e.kind === "reasoning_delta")).toBe(false);
  });
});

// --- AC5: requestParams + reasoning_details ------------------------------

describe("AC5 — requestParams merge and reasoning_details parsing", () => {
  test("requestParams merges into the payload; reasoning_details deltas surface as reasoning_delta", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"Hel"},{"type":"reasoning.text","text":"lo"}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"World"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch, calls } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      ...baseGrant,
      reasoning: { format: "split", requestParams: { reasoning_split: true } },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    const events = await collectEvents(provider, "split-details");

    expect(textOf(events, "reasoning_delta")).toBe("Hello");
    expect(textOf(events, "text_delta")).toBe("World");

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.reasoning_split).toBe(true);
  });

  test("reasoning_content wins over reasoning_details when both are present on the same delta (no double emit)", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_content":"field-text","reasoning_details":[{"text":"details-text"}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fetchMockFor(sse);
    const provider = new OpenAiCompatEngine({ fetch, grant: baseGrant }, identity);
    const events = await collectEvents(provider, "prefer-field");
    const reasoningDeltas = events.filter((e) => e.kind === "reasoning_delta");
    expect(reasoningDeltas).toHaveLength(1);
    expect(reasoningDeltas[0]?.text).toBe("field-text");
  });

  test("requestParams cannot override model, messages, stream, or tools", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch, calls } = fetchMockFor(sse);
    const grant: OpenAiCompatCapabilityGrant = {
      ...baseGrant,
      reasoning: {
        requestParams: {
          model: "sneaky-override",
          messages: ["sneaky"],
          stream: false,
          tools: ["sneaky"],
          reasoning_split: true,
        },
      },
    };
    const provider = new OpenAiCompatEngine({ fetch, grant }, identity);
    await collectEvents(provider, "no-override");

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe(identity.defaultModel.modelId);
    expect(body.stream).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).not.toEqual(["sneaky"]);
    expect(body.tools).toBeUndefined();
    // The un-guarded key still merges.
    expect(body.reasoning_split).toBe(true);
  });
});
