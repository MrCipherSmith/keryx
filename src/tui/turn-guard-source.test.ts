// Flow 329: the turn-guard collector (FIFO tool-call/result matching) and the
// `runTurnGuard` adapter — driven entirely through an injected fake `fetch`
// (AC7: hermetic, no real network), including a hanging fake Jev pinning the
// non-blocking timeout bound (AC2).

import { describe, expect, test } from "bun:test";
import { createTurnGuardCollector, insertTurnGuardResult, runTurnGuard } from "./turn-guard-source";
import type { TurnGuardResult } from "./turn-guard-source";

const ENV_WITH_KEY = { OPENROUTER_API_KEY: "sk-or-test" } as const;

function fakeFetch(body: unknown, status = 200): typeof fetch {
  const fn = async (): Promise<Response> => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return fn as unknown as typeof fetch;
}

function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    })) as unknown as typeof fetch;
}

describe("createTurnGuardCollector", () => {
  test("collects a full turn: request, tool calls matched FIFO to their results, and the final assistant text", () => {
    const c = createTurnGuardCollector();
    c.reset("add a feature");
    c.onToolCall("read_file", JSON.stringify({ path: "a.ts" }));
    c.onToolResult("read_file", { output: "content", isError: false });
    c.onToolCall("apply_patch", JSON.stringify({ path: "a.ts" }));
    c.onToolResult("apply_patch", { output: "applied", isError: false });
    c.onAssistantText("Added the feature.");
    const t = c.transcript();
    expect(t.userRequest).toBe("add a feature");
    expect(t.finalMessage).toBe("Added the feature.");
    expect(t.toolCalls).toEqual([
      { name: "read_file", input: JSON.stringify({ path: "a.ts" }), output: "content", isError: false },
      { name: "apply_patch", input: JSON.stringify({ path: "a.ts" }), output: "applied", isError: false },
    ]);
  });

  test("two calls to the SAME tool are matched in call order (FIFO by name)", () => {
    const c = createTurnGuardCollector();
    c.reset("run two commands");
    c.onToolCall("shell_exec", JSON.stringify({ command: "first" }));
    c.onToolCall("shell_exec", JSON.stringify({ command: "second" }));
    c.onToolResult("shell_exec", { output: "1 done", isError: false });
    c.onToolResult("shell_exec", { output: "2 done", isError: false });
    const t = c.transcript();
    expect(t.toolCalls[0]?.input).toBe(JSON.stringify({ command: "first" }));
    expect(t.toolCalls[1]?.input).toBe(JSON.stringify({ command: "second" }));
  });

  test("only the LAST onAssistantText call becomes the final message (a multi-round turn)", () => {
    const c = createTurnGuardCollector();
    c.reset("x");
    c.onAssistantText("thinking out loud");
    c.onToolCall("read_file", "{}");
    c.onToolResult("read_file", { output: "x", isError: false });
    c.onAssistantText("here is the real answer");
    expect(c.transcript().finalMessage).toBe("here is the real answer");
  });

  test("reset() clears everything for the next turn", () => {
    const c = createTurnGuardCollector();
    c.reset("first");
    c.onToolCall("shell_exec", "{}");
    c.onToolResult("shell_exec", { output: "x", isError: true });
    c.reset("second");
    const t = c.transcript();
    expect(t.userRequest).toBe("second");
    expect(t.toolCalls).toEqual([]);
    expect(t.finalMessage).toBe("");
  });
});

describe("runTurnGuard — AC5: disabled by default, does nothing", () => {
  test("enabled: false never calls fetch, returns skipped with reason 'off'", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const result = await runTurnGuard(
      { userRequest: "build the feature", finalMessage: "done, but I could not add tests", toolCalls: [] },
      { enabled: false, fetchFn, env: ENV_WITH_KEY },
    );
    expect(called).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("off");
    expect(result.verdict.flagged).toBe(false);
  });
});

describe("runTurnGuard — AC3: a deterministic contradiction flags without ever calling Jev", () => {
  test("an unmentioned tool failure flags immediately, no fetch call", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const result = await runTurnGuard(
      {
        userRequest: "fix the build",
        finalMessage: "Fixed it, all good now.",
        toolCalls: [{ name: "shell_exec", input: JSON.stringify({ command: "bun run build" }), output: "boom", isError: true }],
      },
      { enabled: true, fetchFn, env: ENV_WITH_KEY },
    );
    expect(called).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.verdict.flagged).toBe(true);
    expect(result.verdict.deterministic?.kind).toBe("unmentioned-failure");
  });

  test("holds even with NO credential at all (Jev unavailable) — AC3's explicit requirement", async () => {
    const result = await runTurnGuard(
      {
        userRequest: "fix the build",
        finalMessage: "All done.",
        toolCalls: [{ name: "shell_exec", input: JSON.stringify({ command: "bun run build" }), output: "boom", isError: true }],
      },
      { enabled: true, env: {} },
    );
    expect(result.verdict.flagged).toBe(true);
  });
});

describe("runTurnGuard — AC6: a trivial turn is skipped without asking Jev", () => {
  test("no tools, short request, short reply: skipped, no fetch call", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const result = await runTurnGuard({ userRequest: "what is 2+2?", finalMessage: "4.", toolCalls: [] }, { enabled: true, fetchFn, env: ENV_WITH_KEY });
    expect(called).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("trivial");
  });
});

describe("runTurnGuard — AC2: asks Jev's two noul questions and combines them into a verdict", () => {
  test("a low 'done' probability flags the turn as likely incomplete", async () => {
    const fetchFn = fakeFetch({
      answers: { done: { type: "noul", noul: 0.2 }, contradiction: { type: "noul", noul: 0.1 } },
      usage: { input_tokens: 500, output_tokens: 5, cost: 0.0002 },
    });
    const result = await runTurnGuard(
      {
        userRequest: "implement the export feature end to end",
        finalMessage: "I implemented part of it.",
        toolCalls: [{ name: "apply_patch", input: JSON.stringify({ path: "a.ts" }), output: "applied", isError: false }],
      },
      { enabled: true, fetchFn, env: ENV_WITH_KEY },
    );
    expect(result.skipped).toBe(false);
    expect(result.verdict.flagged).toBe(true);
    expect(result.verdict.doneProbability).toBe(0.2);
    expect(result.usage).toEqual({ input_tokens: 500, output_tokens: 5, cost: 0.0002 });
  });

  test("a high 'done' probability and low contradiction: not flagged", async () => {
    const fetchFn = fakeFetch({ answers: { done: { type: "noul", noul: 0.95 }, contradiction: { type: "noul", noul: 0.02 } }, usage: {} });
    const result = await runTurnGuard(
      {
        userRequest: "implement the export feature end to end",
        finalMessage: "Implemented and verified.",
        toolCalls: [{ name: "apply_patch", input: JSON.stringify({ path: "a.ts" }), output: "applied", isError: false }],
      },
      { enabled: true, fetchFn, env: ENV_WITH_KEY },
    );
    expect(result.verdict.flagged).toBe(false);
  });
});

describe("runTurnGuard — AC2: bounded by a short timeout, never hangs (non-blocking guarantee)", () => {
  test("a Jev call that never resolves still resolves runTurnGuard, unflagged, within the injected timeout", async () => {
    const startedAt = Date.now();
    const result = await runTurnGuard(
      {
        userRequest: "implement the export feature end to end",
        finalMessage: "Implemented.",
        toolCalls: [{ name: "apply_patch", input: JSON.stringify({ path: "a.ts" }), output: "applied", isError: false }],
      },
      { enabled: true, fetchFn: hangingFetch(), env: ENV_WITH_KEY, timeoutMs: 20 },
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.skipped).toBe(true);
    expect(result.verdict.flagged).toBe(false);
    expect(result.skipReason).toContain("did not complete");
  });
});

function guardResult(at: number, userRequest: string): TurnGuardResult {
  return {
    at,
    userRequest,
    finalMessage: "",
    facts: {
      toolCallCount: 0,
      toolsCalled: [],
      failedTools: [],
      anyToolFailed: false,
      deterministicFailedTools: [],
      filesWritten: [],
      commandsRun: [],
      testsRun: [],
      lastTestRunFailed: false,
      markers: [],
      asksQuestion: false,
      factLines: [],
    },
    verdict: { flagged: false, reason: "the turn looks done." },
    skipped: true,
    skipReason: "trivial",
  };
}

describe("insertTurnGuardResult — PR #720 review item 3: turn order, not completion order", () => {
  test("inserting in COMPLETION order out of TURN order still ends up sorted newest-`at`-first", () => {
    // Turn A started first (at: 1000, a slow real Jev round trip) but its
    // guard result arrives LAST; turn B started second (at: 2000, a fast
    // trivial/deterministic turn) but its guard result arrives FIRST — the
    // exact race `tui-shell.ts`'s `void (async () => { ... })()` per-turn
    // guard call can produce.
    const b = guardResult(2000, "turn B (fast)");
    const a = guardResult(1000, "turn A (slow)");
    let history: TurnGuardResult[] = [];
    history = insertTurnGuardResult(history, b, 20); // B's guard resolves first
    history = insertTurnGuardResult(history, a, 20); // A's guard resolves second, but started EARLIER
    expect(history.map((r) => r.userRequest)).toEqual(["turn B (fast)", "turn A (slow)"]);
  });

  test("a turn with an earlier `at` than everything already recorded sorts to the back, not the front", () => {
    const history = insertTurnGuardResult([guardResult(3000, "newest")], guardResult(1000, "oldest"), 20);
    expect(history.map((r) => r.at)).toEqual([3000, 1000]);
  });

  test("caps at `cap`, dropping the OLDEST (smallest `at`) entries first", () => {
    const history = [guardResult(30, "c"), guardResult(20, "b"), guardResult(10, "a")];
    const next = insertTurnGuardResult(history, guardResult(25, "b.5"), 3);
    expect(next.map((r) => r.userRequest)).toEqual(["c", "b.5", "b"]);
  });

  test("the input array is left untouched (pure)", () => {
    const history = [guardResult(10, "only")];
    const next = insertTurnGuardResult(history, guardResult(20, "new"), 20);
    expect(history).toHaveLength(1);
    expect(next).toHaveLength(2);
  });
});
