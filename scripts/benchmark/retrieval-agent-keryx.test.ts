import { describe, expect, test } from "bun:test";
import { buildKeryxArgs, interpretKeryxTurn, parseKeryxEvents, type KeryxTurn } from "./retrieval-agent-keryx";

const ctx = { timedOut: false, timeoutMs: 600_000, model: "grok-4.6", cwd: "/tmp/t" };

const ok: KeryxTurn = {
  text: "src/a.ts",
  toolCalls: 3,
  inputTokens: 12_975,
  stepsToFirstGold: 2,
  sawTurnEnd: true,
  clippedBeforeGold: false,
};

function ndjson(events: readonly Record<string, unknown>[]): string[] {
  return events.map((event) => JSON.stringify(event));
}

describe("buildKeryxArgs", () => {
  test("one turn, no terminal, unattended", () => {
    const args = buildKeryxArgs("find it", "grok-4.6", "grok", "/tmp/e.jsonl", 1000);
    expect(args).toEqual(
      expect.arrayContaining(["--no-tui", "--print", "find it", "--auto", "--events-file", "/tmp/e.jsonl"]),
    );
  });

  test("the provider and model are both pinned", () => {
    // The reason this leg can exist: the same model runs under keryx and under
    // the grok CLI, so a difference between them is the shell and nothing else.
    const args = buildKeryxArgs("p", "grok-4.6", "grok", "/tmp/e", 10);
    expect(args).toEqual(expect.arrayContaining(["--provider", "grok", "--model", "grok-4.6"]));
  });
});

describe("parseKeryxEvents", () => {
  test("counts tool calls and finds the first gold path in a tool RESULT", () => {
    // Not only in inputs. An agent that asks the graph about a symptom and is
    // handed the paths never names one in an input, and counting inputs alone
    // scores exactly the behaviour under test as "never arrived".
    const turn = parseKeryxEvents(
      ndjson([
        { type: "turn_start", prompt: "q", provider: "grok", model: "grok-4.6" },
        { type: "tool_call", name: "search_code", input: '{"pattern":"refund"}' },
        { type: "tool_result", name: "search_code", isError: false, output: "src/charge.ts:12: refund" },
        { type: "turn_end", text: "src/charge.ts", toolCalls: 1, usage: { inputTokens: 900 } },
      ]),
      ["src/charge.ts"],
    );
    expect(turn.toolCalls).toBe(1);
    expect(turn.stepsToFirstGold).toBe(1);
    expect(turn.inputTokens).toBe(900);
    expect(turn.text).toBe("src/charge.ts");
  });

  test("a clipped output before the first gold hit is remembered", () => {
    // Otherwise a gold path cut out of a long tool result is scored as an arm
    // that never held one — a different claim, not a smaller number.
    const turn = parseKeryxEvents(
      ndjson([
        { type: "tool_call", name: "read_file", input: "{}" },
        { type: "tool_result", name: "read_file", isError: false, output: "xxxx…[+8000 chars]" },
        { type: "turn_end", text: "src/charge.ts", toolCalls: 1, usage: { inputTokens: 900 } },
      ]),
      ["src/charge.ts"],
    );
    expect(turn.stepsToFirstGold).toBeNull();
    expect(turn.clippedBeforeGold).toBe(true);
  });

  test("absent usage is null, not zero", () => {
    const turn = parseKeryxEvents(ndjson([{ type: "turn_end", text: "x", toolCalls: 0 }]), []);
    expect(turn.inputTokens).toBeNull();
  });

  test("a torn line is skipped rather than fatal", () => {
    const turn = parseKeryxEvents(
      ["{not json", JSON.stringify({ type: "turn_end", text: "src/a.ts", toolCalls: 0, usage: { inputTokens: 5 } })],
      [],
    );
    expect(turn.sawTurnEnd).toBe(true);
  });
});

describe("interpretKeryxTurn", () => {
  test("a good turn comes through, so the refusals below are not vacuous", () => {
    expect(interpretKeryxTurn(ok, ctx)).toEqual({
      text: "src/a.ts",
      toolCalls: 3,
      contextTokens: 12_975,
      costUsd: null,
      stepsToFirstGold: 2,
    });
  });

  test("no usage is refused, because on this harness it means no model ran", () => {
    // keryx returns an offline fake provider when a credential is missing, and
    // the session header still names the provider that was asked for. A sweep
    // could complete against that fake and record its empty answers as a real
    // negative result. The fake reports no usage; a real provider always does.
    expect(() => interpretKeryxTurn({ ...ok, inputTokens: null }, ctx)).toThrow(/no token usage/);
  });

  test("a recorded provider error is refused rather than scored as an empty answer", () => {
    expect(() => interpretKeryxTurn({ ...ok, errorMessage: "[error] no credential" }, ctx)).toThrow(
      /reported an error/,
    );
  });

  test("a transcript with no turn_end is refused", () => {
    // A killed process leaves the events it produced. Scoring what is there
    // would report a partial session as a finished one.
    expect(() => interpretKeryxTurn({ ...ok, sawTurnEnd: false }, ctx)).toThrow(/no turn_end/);
  });

  test("a timeout is a timeout, not zero recall", () => {
    expect(() => interpretKeryxTurn({ ...ok, text: "" }, { ...ctx, timedOut: true })).toThrow(/exceeded 600s/);
  });

  test("an empty answer from a real turn is refused", () => {
    expect(() => interpretKeryxTurn({ ...ok, text: "  " }, ctx)).toThrow(/no final answer/);
  });

  test("cost is null and never zero", () => {
    // keryx does not price its turns. A zero would understate this leg in the
    // write-up while looking like a measurement.
    expect(interpretKeryxTurn(ok, ctx).costUsd).toBeNull();
  });
});
