// RED tests for RP-01 (flow 018, W14 / T5) — pure Anthropic SSE parser.
//
// Pins `src/harness/provider/anthropic/sse.ts` (`AnthropicSSEParser`,
// `AnthropicSSEEvent`): a deterministic, stateful line/event parser that turns
// raw `text/event-stream` bytes (fed incrementally, at ANY chunk boundary)
// into complete `{ event?, data }` records, matching the Anthropic Messages
// API SSE wire format (`event: <type>\ndata: <json>\n\n`, multi-line `data:`
// fields joined with `\n`, `:`-prefixed comment lines and `ping` events
// ignored by the higher-level normalizer but still surfaced here as plain
// events so `normalize.ts` can decide what to do with them).
//
// This module is OPTIONAL per the dispatch ("may be inlined" into
// `anthropic-provider.ts`); if T6 inlines the parser instead of exporting a
// standalone `sse.ts`, this whole file's RED failure (missing module) is
// EXPECTED and does not block RP-01 — say so explicitly in the T6
// subagent-result rather than creating `sse.ts` just to satisfy this file.
//
// Pure / deterministic: no Date.now(), no network, no randomness — a stateful
// but side-effect-free incremental parser over strings.
import { describe, expect, test } from "bun:test";
import { AnthropicSSEParser } from "./sse";

describe("AnthropicSSEParser — chunk-boundary independence", () => {
  test("a single push() with one complete event yields exactly that event", () => {
    const parser = new AnthropicSSEParser();
    const events = parser.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    expect(events).toEqual([{ event: "message_stop", data: '{"type":"message_stop"}' }]);
  });

  test("an event split across two push() calls mid-field is only emitted once both arrive", () => {
    const parser = new AnthropicSSEParser();
    const first = parser.push('event: content_block_delta\ndata: {"type":"content_block_delta","in');
    expect(first).toEqual([]);
    const second = parser.push('dex":0,"delta":{"type":"text_delta","text":"hi"}}\n\n');
    expect(second).toEqual([
      { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}' },
    ]);
  });

  test("an event split at the exact blank-line boundary is only emitted once the terminating blank line arrives", () => {
    const parser = new AnthropicSSEParser();
    const first = parser.push('event: ping\ndata: {"type":"ping"}\n');
    expect(first).toEqual([]);
    const second = parser.push("\n");
    expect(second).toEqual([{ event: "ping", data: '{"type":"ping"}' }]);
  });

  test("multiple complete events in one push() are all returned, in order", () => {
    const parser = new AnthropicSSEParser();
    const events = parser.push(
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    expect(events).toEqual([
      { event: "content_block_stop", data: '{"type":"content_block_stop","index":0}' },
      { event: "message_stop", data: '{"type":"message_stop"}' },
    ]);
  });

  test("a single byte-at-a-time feed still reconstructs the exact same events as one bulk push()", () => {
    const text = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n';
    const bulk = new AnthropicSSEParser().push(text);

    const incremental = new AnthropicSSEParser();
    const events: ReturnType<typeof incremental.push> = [];
    for (const ch of text) {
      events.push(...incremental.push(ch));
    }
    expect(events).toEqual(bulk);
  });
});

describe("AnthropicSSEParser — multi-line data fields", () => {
  test("multiple `data:` lines within one event are joined with '\\n', per the SSE spec", () => {
    const parser = new AnthropicSSEParser();
    const events = parser.push('event: content_block_delta\ndata: line one\ndata: line two\n\n');
    expect(events).toEqual([{ event: "content_block_delta", data: "line one\nline two" }]);
  });
});

describe("AnthropicSSEParser — comments and events without an explicit `event:` line", () => {
  test("a `:`-prefixed comment line is ignored and never surfaces as an event", () => {
    const parser = new AnthropicSSEParser();
    const events = parser.push(': keep-alive\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    expect(events).toEqual([{ event: "message_stop", data: '{"type":"message_stop"}' }]);
  });

  test("a data-only block with no `event:` line surfaces with `event` undefined", () => {
    const parser = new AnthropicSSEParser();
    const events = parser.push('data: {"type":"ping"}\n\n');
    expect(events).toEqual([{ data: '{"type":"ping"}' }]);
  });
});

describe("AnthropicSSEParser — flush()", () => {
  test("flush() on a parser with no pending partial event returns an empty array", () => {
    const parser = new AnthropicSSEParser();
    parser.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    expect(parser.flush()).toEqual([]);
  });

  test("flush() surfaces a pending event that never received its terminating blank line (torn stream)", () => {
    const parser = new AnthropicSSEParser();
    const mid = parser.push('event: content_block_delta\ndata: {"type":"content_block_delta"');
    expect(mid).toEqual([]);
    // The connection ends here (EOF) without a trailing blank line — the
    // normalizer layer (`normalize.ts` / `anthropic-provider.ts`) is
    // responsible for treating a non-empty flush() as a torn/truncated
    // stream and mapping it to a `malformed` provider_error; this parser
    // only surfaces the raw partial record, unopinionated about what it means.
    const flushed = parser.flush();
    expect(flushed).toEqual([{ event: "content_block_delta", data: '{"type":"content_block_delta"' }]);
  });
});

describe("AnthropicSSEParser — determinism", () => {
  test("parsing the same text twice (fresh parser instances) yields deep-equal event arrays", () => {
    const text =
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const first = new AnthropicSSEParser().push(text);
    const second = new AnthropicSSEParser().push(text);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
