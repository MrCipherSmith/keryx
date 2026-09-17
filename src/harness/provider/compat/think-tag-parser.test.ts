// Unit tests for the inline `<think>…</think>` segment parser (flow 268 T10 /
// AC4). Pure, offline, deterministic — no fetch, no SSE framing here; the
// engine-level wiring (`grant.reasoning.format === "inline-tags"`) is covered
// by `openai-compat-streaming.test.ts`.
import { describe, expect, test } from "bun:test";
import { ThinkTagParser, type ThinkTagSegment } from "./think-tag-parser";

function drive(chunks: string[]): ThinkTagSegment[] {
  const parser = new ThinkTagParser();
  const segments: ThinkTagSegment[] = [];
  for (const chunk of chunks) segments.push(...parser.push(chunk));
  segments.push(...parser.flush());
  return segments;
}

describe("ThinkTagParser — simple block", () => {
  test("<think>A</think>B in one push yields reasoning then text", () => {
    expect(drive(["<think>A</think>B"])).toEqual([
      { kind: "reasoning", text: "A" },
      { kind: "text", text: "B" },
    ]);
  });

  test("text before the think block is emitted as text first", () => {
    expect(drive(["Hello <think>World</think>"])).toEqual([
      { kind: "text", text: "Hello " },
      { kind: "reasoning", text: "World" },
    ]);
  });

  test("no tags at all: everything is text, unchanged", () => {
    expect(drive(["Hello World"])).toEqual([{ kind: "text", text: "Hello World" }]);
  });
});

describe("ThinkTagParser — multiple blocks", () => {
  test("<think>A</think>B<think>C</think>D yields four alternating segments", () => {
    expect(drive(["<think>A</think>B<think>C</think>D"])).toEqual([
      { kind: "reasoning", text: "A" },
      { kind: "text", text: "B" },
      { kind: "reasoning", text: "C" },
      { kind: "text", text: "D" },
    ]);
  });
});

describe("ThinkTagParser — unclosed <think> at flush", () => {
  test("an unclosed <think> means everything after it is reasoning, emitted on flush", () => {
    expect(drive(["<think>Some reasoning, never closed"])).toEqual([
      { kind: "reasoning", text: "Some reasoning, never closed" },
    ]);
  });

  test("a partial close held at end of stream is flushed as reasoning, not dropped", () => {
    // "</thi" is a genuine partial match for "</think>" and is held back by
    // push(); since the stream ends there, flush() must not lose it.
    expect(drive(["<think>Some reasoning</thi"])).toEqual([
      { kind: "reasoning", text: "Some reasoning" },
      { kind: "reasoning", text: "</thi" },
    ]);
  });
});

describe("ThinkTagParser — stray close", () => {
  test("a </think> with no matching open is dropped, not emitted as either kind", () => {
    expect(drive(["Hello</think>World"])).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "text", text: "World" },
    ]);
  });
});

describe("ThinkTagParser — trim after close", () => {
  test("leading newlines right after </think> are trimmed from the first text segment only", () => {
    expect(drive(["<think>A</think>\n\nHello"])).toEqual([
      { kind: "reasoning", text: "A" },
      { kind: "text", text: "Hello" },
    ]);
  });

  test("newlines arriving in a later push are still trimmed if nothing but newlines came first", () => {
    expect(drive(["<think>A</think>", "\n", "\n", "Hello"])).toEqual([
      { kind: "reasoning", text: "A" },
      { kind: "text", text: "Hello" },
    ]);
  });

  test("the trim applies again after a second close, but only once per close", () => {
    // Each `</think>` arms exactly one trim, for the text segment
    // immediately following IT — not a one-time global effect. A later
    // newline inside that same trimmed segment (there is none here) would
    // stay untouched; this only strips the run right after the tag.
    expect(drive(["<think>A</think>\nB<think>C</think>\nD"])).toEqual([
      { kind: "reasoning", text: "A" },
      { kind: "text", text: "B" },
      { kind: "reasoning", text: "C" },
      { kind: "text", text: "D" },
    ]);
  });
});

describe("ThinkTagParser — tag split across chunks", () => {
  test("<think> split at every position yields the same result as one push", () => {
    const whole = "<think>A</think>B";
    for (let i = 1; i < OPEN_TAG_LEN; i++) {
      const chunks = [whole.slice(0, i), whole.slice(i)];
      expect(drive(chunks)).toEqual([
        { kind: "reasoning", text: "A" },
        { kind: "text", text: "B" },
      ]);
    }
  });

  test("</think> split at every position yields the same result as one push", () => {
    const prefix = "<think>A";
    const closeAndTail = "</think>B";
    for (let i = 1; i < closeAndTail.length; i++) {
      const chunks = [prefix + closeAndTail.slice(0, i), closeAndTail.slice(i)];
      expect(drive(chunks)).toEqual([
        { kind: "reasoning", text: "A" },
        { kind: "text", text: "B" },
      ]);
    }
  });

  test("three-way split across <think>, body, and </think> still assembles correctly", () => {
    // Each push() resolves what it can independently — the reasoning body
    // arrives as two segments here ("Rea" then "soning") because the body
    // itself is split across a push() boundary, not because anything is
    // lost; a consumer concatenates same-kind deltas as it does for
    // `text_delta` already. Concatenating this test's segments by kind
    // reconstructs "Reasoning" / "Answer" exactly.
    expect(drive(["<thi", "nk>Rea", "soning</th", "ink>Answer"])).toEqual([
      { kind: "reasoning", text: "Rea" },
      { kind: "reasoning", text: "soning" },
      { kind: "text", text: "Answer" },
    ]);
  });
});

const OPEN_TAG_LEN = "<think>".length;
