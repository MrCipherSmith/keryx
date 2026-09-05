import { describe, expect, test } from "bun:test";
import { contextTokensOf, parseStream } from "./retrieval-agent-claude";

// Parsed against transcripts shaped like the real one — captured from a live
// `claude -p --output-format stream-json` run, not invented. The event kinds,
// the nesting of `tool_use` inside `message.content`, and the field names in
// `result` are all as they actually arrive.

function assistantToolUse(name: string, input: unknown): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
}

function resultEvent(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    result: "The file is src/billing/charge.ts",
    total_cost_usd: 0.042,
    num_turns: 3,
    is_error: false,
    usage: {
      input_tokens: 6,
      cache_creation_input_tokens: 23737,
      cache_read_input_tokens: 108721,
      output_tokens: 285,
    },
    ...over,
  });
}

describe("contextTokensOf", () => {
  test("sums everything the model read, cache included", () => {
    expect(
      contextTokensOf({
        input_tokens: 6,
        cache_creation_input_tokens: 23737,
        cache_read_input_tokens: 108721,
        output_tokens: 285,
      }),
    ).toBe(132464);
  });

  test("output tokens are not context — they are what it wrote", () => {
    expect(contextTokensOf({ input_tokens: 10, output_tokens: 9999 })).toBe(10);
  });

  test("missing usage is zero, not a crash", () => {
    expect(contextTokensOf(undefined)).toBe(0);
  });
});

describe("parseStream", () => {
  test("counts tool calls and reads the final answer", () => {
    const parsed = parseStream(
      [
        JSON.stringify({ type: "system", subtype: "init" }),
        assistantToolUse("Bash", { command: "ls src" }),
        JSON.stringify({ type: "user", message: { content: [] } }),
        assistantToolUse("Read", { file_path: "src/billing/charge.ts" }),
        resultEvent(),
      ],
      ["src/billing/charge.ts"],
    );
    expect(parsed.toolCalls).toBe(2);
    expect(parsed.text).toContain("src/billing/charge.ts");
    expect(parsed.contextTokens).toBe(132464);
    expect(parsed.costUsd).toBeCloseTo(0.042, 5);
  });

  test("stepsToFirstGold is the tool call that first named a gold file", () => {
    const parsed = parseStream(
      [
        assistantToolUse("Bash", { command: "ls" }),
        assistantToolUse("Bash", { command: "grep -r refund src" }),
        assistantToolUse("Read", { file_path: "src/billing/charge.ts" }),
        resultEvent(),
      ],
      ["src/billing/charge.ts"],
    );
    expect(parsed.stepsToFirstGold).toBe(3);
  });

  test("stepsToFirstGold is null when the agent never reached the file", () => {
    // Distinct from 0. Reporting 0 would make a total miss look like an instant
    // hit, which is the wrong direction for the metric that claims to measure
    // how fast the agent oriented.
    const parsed = parseStream(
      [assistantToolUse("Bash", { command: "ls" }), resultEvent()],
      ["src/billing/charge.ts"],
    );
    expect(parsed.stepsToFirstGold).toBeNull();
  });

  test("a malformed line is skipped, not fatal", () => {
    // These transcripts gain new event kinds between releases; losing a whole
    // sweep to one unparseable line would be a bad trade.
    const parsed = parseStream(
      ["{not json", assistantToolUse("Bash", { command: "ls" }), resultEvent()],
      ["src/a.ts"],
    );
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.text).toContain("charge.ts");
  });

  test("an error result is reported as one rather than scored as a miss", () => {
    // A failed arm and an arm that searched and found nothing both produce zero
    // recall, and they mean opposite things about the context under test.
    const parsed = parseStream([resultEvent({ is_error: true })], ["src/a.ts"]);
    expect(parsed.isError).toBe(true);
  });

  test("a tool_use block sitting beside text is still counted", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
        ],
      },
    });
    const parsed = parseStream([line, resultEvent()], ["src/a.ts"]);
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.stepsToFirstGold).toBe(1);
  });
});
