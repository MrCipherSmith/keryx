// Unit tests for `FieldThinkTagStripper` (flow 268 T24): a stray literal
// `<think>`/`</think>` tag leaking into an already-classified reasoning-field
// text stream. Pure, offline, deterministic — no fetch, no SSE framing here;
// the engine-level wiring is covered by `openai-compat-reasoning.test.ts`.
import { describe, expect, test } from "bun:test";
import { FieldThinkTagStripper } from "./think-tag-stripper";

function drive(chunks: string[]): string {
  const stripper = new FieldThinkTagStripper();
  let out = "";
  for (const chunk of chunks) out += stripper.push(chunk);
  out += stripper.flush();
  return out;
}

describe("FieldThinkTagStripper — no tags", () => {
  test("plain text with no tag passes through unchanged", () => {
    expect(drive(["The user is asking about the weather."])).toBe("The user is asking about the weather.");
  });

  test("empty input yields empty output", () => {
    expect(drive([""])).toBe("");
  });
});

describe("FieldThinkTagStripper — a single tag", () => {
  test("a trailing </think> on its own line is removed with its adjacent newlines", () => {
    expect(drive(["...manner.\n</think>\n"])).toBe("...manner.");
  });

  test("a trailing </think> with no surrounding newline is still removed", () => {
    expect(drive(["...manner.</think>"])).toBe("...manner.");
  });

  test("a leading <think> with no surrounding newline is removed", () => {
    expect(drive(["<think>The user asked..."])).toBe("The user asked...");
  });

  test("a tag in the middle is removed, text before and after is kept", () => {
    expect(drive(["before</think>after"])).toBe("beforeafter");
  });

  test("only one adjacent newline on each side is stripped, not more", () => {
    expect(drive(["a\n\n</think>\n\nb"])).toBe("a\n\nb");
  });
});

describe("FieldThinkTagStripper — tags split across chunks", () => {
  test("</think> split as '\\n</thi' + 'nk>' strips cleanly across the push() boundary", () => {
    expect(drive(["...manner.\n</thi", "nk>"])).toBe("...manner.");
  });

  test("</think> split byte-by-byte still strips cleanly", () => {
    const text = "reasoning text\n</think>";
    const chunks = text.split("");
    expect(drive(chunks)).toBe("reasoning text");
  });

  test("a chunk ending in a partial match that turns out NOT to be a tag is emitted verbatim", () => {
    // "<thi" looks like the start of "<think>" but the next chunk breaks it.
    expect(drive(["<thi", "nking about it"])).toBe("<thinking about it");
  });
});

describe("FieldThinkTagStripper — multiple tags in one stream", () => {
  test("an open tag followed later by a close tag both strip, text between and around is kept", () => {
    expect(drive(["a<think>b</think>c"])).toBe("abc");
  });
});
