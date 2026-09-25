// Flow 329: pure-function tests for the turn guard's fact extraction,
// deterministic-contradiction detection, skip-trivial rule, question/state
// building and verdict computation — all on synthetic transcripts, no
// network and no Jev call (AC7).

import { describe, expect, test } from "bun:test";
import {
  buildTurnGuardQuestions,
  buildTurnGuardState,
  computeTurnGuardVerdict,
  DEFAULT_TURN_GUARD_THRESHOLD,
  detectTurnGuardContradiction,
  extractTurnGuardFacts,
  renderTurnGuardAdvisory,
  renderTurnGuardNoticeLine,
  shouldSkipTurnGuard,
  TURN_GUARD_TRIVIAL_REPLY_CHARS,
  TURN_GUARD_TRIVIAL_REQUEST_CHARS,
  type TurnGuardToolCall,
  type TurnGuardTranscript,
} from "./turn-guard";

function transcript(input: Partial<TurnGuardTranscript>): TurnGuardTranscript {
  return { userRequest: "", finalMessage: "", toolCalls: [], ...input };
}

function toolCall(input: Partial<TurnGuardToolCall> & { name: string }): TurnGuardToolCall {
  return { output: "", isError: false, ...input };
}

describe("AC1: extractTurnGuardFacts — deterministic facts from a synthetic transcript", () => {
  test("no tools called: zero counts, no files, no commands, no tests", () => {
    const facts = extractTurnGuardFacts(transcript({ userRequest: "what is 2+2?", finalMessage: "4." }));
    expect(facts.toolCallCount).toBe(0);
    expect(facts.anyToolFailed).toBe(false);
    expect(facts.filesWritten).toEqual([]);
    expect(facts.commandsRun).toEqual([]);
    expect(facts.testsRun).toEqual([]);
    expect(facts.lastTestRunFailed).toBe(false);
    expect(facts.markers).toEqual([]);
    expect(facts.asksQuestion).toBe(false);
  });

  test("a write tool call records the file path from its JSON input", () => {
    const facts = extractTurnGuardFacts(
      transcript({
        toolCalls: [toolCall({ name: "apply_patch", input: JSON.stringify({ path: "src/foo.ts", diff: "..." }), output: "applied" })],
      }),
    );
    expect(facts.filesWritten).toEqual(["src/foo.ts"]);
    expect(facts.toolsCalled).toEqual(["apply_patch"]);
  });

  test("a failed shell_exec is recorded with a parsed exit code and counted as a tool failure", () => {
    const facts = extractTurnGuardFacts(
      transcript({
        toolCalls: [
          toolCall({
            name: "shell_exec",
            input: JSON.stringify({ command: "bun run build" }),
            output: "(no output; exit 1)",
            isError: true,
          }),
        ],
      }),
    );
    expect(facts.anyToolFailed).toBe(true);
    expect(facts.failedTools).toEqual(["shell_exec"]);
    expect(facts.commandsRun).toEqual([{ command: "bun run build", ok: false, exitCode: 1 }]);
  });

  test("a bun test run's pass/fail counts are parsed out of the tool's own output", () => {
    const facts = extractTurnGuardFacts(
      transcript({
        toolCalls: [
          toolCall({
            name: "shell_exec",
            input: JSON.stringify({ command: "bun test" }),
            output: " 12 pass\n 0 fail\n",
            isError: false,
          }),
        ],
      }),
    );
    expect(facts.testsRun).toEqual([{ command: "bun test", ok: true, passed: 12, failed: 0 }]);
    expect(facts.lastTestRunFailed).toBe(false);
  });

  test("a failing test run (jest-style, fail-count first) is detected as failed", () => {
    const facts = extractTurnGuardFacts(
      transcript({
        toolCalls: [
          toolCall({
            name: "shell_exec",
            input: JSON.stringify({ command: "npm test" }),
            output: "Tests: 2 failed, 8 passed, 10 total",
            isError: true,
          }),
        ],
      }),
    );
    expect(facts.testsRun[0]?.ok).toBe(false);
    expect(facts.testsRun[0]?.failed).toBe(2);
    expect(facts.testsRun[0]?.passed).toBe(8);
    expect(facts.lastTestRunFailed).toBe(true);
  });

  test("a non-test shell command is recorded in commandsRun but never in testsRun", () => {
    const facts = extractTurnGuardFacts(
      transcript({ toolCalls: [toolCall({ name: "shell_exec", input: JSON.stringify({ command: "ls -la" }), output: "a.ts\nb.ts" })] }),
    );
    expect(facts.commandsRun).toHaveLength(1);
    expect(facts.testsRun).toEqual([]);
  });

  test("explicit incompleteness markers in the final message are found", () => {
    const facts = extractTurnGuardFacts(transcript({ finalMessage: "I could not finish the last part — there is still a TODO left." }));
    expect(facts.markers).toContain("I could not");
    expect(facts.markers).toContain("TODO");
  });

  test("a final message that asks the user a question is detected", () => {
    const facts = extractTurnGuardFacts(transcript({ finalMessage: "Which provider should I use for this — OpenRouter or Anthropic?" }));
    expect(facts.asksQuestion).toBe(true);
  });

  test("a final message with no question mark is not flagged as asking one", () => {
    const facts = extractTurnGuardFacts(transcript({ finalMessage: "Done. The file was updated." }));
    expect(facts.asksQuestion).toBe(false);
  });

  test("factLines renders one line per fact category, in a stable order", () => {
    const facts = extractTurnGuardFacts(transcript({ finalMessage: "done" }));
    expect(facts.factLines).toHaveLength(5);
    expect(facts.factLines[0]).toContain("tools:");
    expect(facts.factLines[1]).toContain("files written/edited:");
    expect(facts.factLines[2]).toContain("commands run:");
    expect(facts.factLines[3]).toContain("tests run:");
    expect(facts.factLines[4]).toContain("final-message markers:");
  });
});

describe("AC3: detectTurnGuardContradiction — decides without Jev", () => {
  test("a failed tool the final message never mentions is a contradiction", () => {
    const facts = extractTurnGuardFacts(
      transcript({
        toolCalls: [toolCall({ name: "shell_exec", input: JSON.stringify({ command: "bun run build" }), output: "boom", isError: true })],
        finalMessage: "I updated the file as requested.",
      }),
    );
    const contradiction = detectTurnGuardContradiction(facts, "I updated the file as requested.");
    expect(contradiction?.kind).toBe("unmentioned-failure");
  });

  test("a failed tool the final message DOES mention (generic failure language) is not a contradiction", () => {
    const facts = extractTurnGuardFacts(
      transcript({
        toolCalls: [toolCall({ name: "shell_exec", input: JSON.stringify({ command: "bun run build" }), output: "boom", isError: true })],
        finalMessage: "The build failed and I could not fix it in time.",
      }),
    );
    const contradiction = detectTurnGuardContradiction(facts, "The build failed and I could not fix it in time.");
    expect(contradiction).toBeUndefined();
  });

  test("claiming tests pass while the last test run failed is a contradiction (the canonical AC3 example)", () => {
    const finalMessage = "All done — the tests pass now.";
    const facts = extractTurnGuardFacts(
      transcript({
        toolCalls: [
          toolCall({ name: "shell_exec", input: JSON.stringify({ command: "bun test" }), output: " 3 pass\n 1 fail\n", isError: true }),
        ],
        finalMessage,
      }),
    );
    const contradiction = detectTurnGuardContradiction(facts, finalMessage);
    expect(contradiction?.kind).toBe("false-test-pass-claim");
    expect(contradiction?.reason).toContain("bun test");
  });

  test("claiming tests pass when the last test run actually passed is NOT a contradiction", () => {
    const finalMessage = "All done — the tests pass now.";
    const facts = extractTurnGuardFacts(
      transcript({
        toolCalls: [toolCall({ name: "shell_exec", input: JSON.stringify({ command: "bun test" }), output: " 4 pass\n 0 fail\n" })],
        finalMessage,
      }),
    );
    expect(detectTurnGuardContradiction(facts, finalMessage)).toBeUndefined();
  });

  test("no tool calls, no test claims: no contradiction", () => {
    const facts = extractTurnGuardFacts(transcript({ finalMessage: "Here is the answer." }));
    expect(detectTurnGuardContradiction(facts, "Here is the answer.")).toBeUndefined();
  });
});

describe("AC6: shouldSkipTurnGuard — trivial turns are skipped without asking Jev", () => {
  test("no tools, short request, short reply: skipped", () => {
    const t = transcript({ userRequest: "what is 2+2?", finalMessage: "4." });
    expect(shouldSkipTurnGuard(t, extractTurnGuardFacts(t))).toBe(true);
  });

  test("any tool call at all: never skipped, even for a trivial-looking exchange", () => {
    const t = transcript({
      userRequest: "ok",
      finalMessage: "done",
      toolCalls: [toolCall({ name: "read_file", output: "x" })],
    });
    expect(shouldSkipTurnGuard(t, extractTurnGuardFacts(t))).toBe(false);
  });

  test("a long request is never skipped, even with no tool calls", () => {
    const t = transcript({ userRequest: "x".repeat(TURN_GUARD_TRIVIAL_REQUEST_CHARS + 1), finalMessage: "ok" });
    expect(shouldSkipTurnGuard(t, extractTurnGuardFacts(t))).toBe(false);
  });

  test("a long reply is never skipped, even with no tool calls", () => {
    const t = transcript({ userRequest: "ok", finalMessage: "x".repeat(TURN_GUARD_TRIVIAL_REPLY_CHARS + 1) });
    expect(shouldSkipTurnGuard(t, extractTurnGuardFacts(t))).toBe(false);
  });
});

describe("AC2: buildTurnGuardQuestions / buildTurnGuardState", () => {
  test("exactly the two documented noul questions", () => {
    const questions = buildTurnGuardQuestions();
    expect(Object.keys(questions).sort()).toEqual(["contradiction", "done"]);
    expect(questions.done.type).toBe("noul");
    expect(questions.contradiction.type).toBe("noul");
  });

  test("state carries the redacted request, final message and fact lines, in order", () => {
    const t = transcript({ userRequest: "add a feature", finalMessage: "added it" });
    const facts = extractTurnGuardFacts(t);
    const state = buildTurnGuardState(t, facts);
    expect(state).toContain("add a feature");
    expect(state).toContain("added it");
    expect(state).toContain("tools: 0 called");
  });

  test("a secret in the user request is redacted before it reaches state", () => {
    const t = transcript({ userRequest: "use sk-or-abcdefghijklmnopqrstuvwx1234567890 as the key", finalMessage: "ok" });
    const state = buildTurnGuardState(t, extractTurnGuardFacts(t));
    expect(state).not.toContain("sk-or-abcdefghijklmnopqrstuvwx1234567890");
  });
});

describe("computeTurnGuardVerdict — deterministic contradiction always wins; otherwise Jev's noul answers against the threshold", () => {
  test("a deterministic contradiction flags regardless of Jev answers (or their absence)", () => {
    const verdict = computeTurnGuardVerdict({ contradiction: { kind: "unmentioned-failure", reason: "x failed and was not mentioned." } });
    expect(verdict.flagged).toBe(true);
    expect(verdict.deterministic?.kind).toBe("unmentioned-failure");
  });

  test("no contradiction and no Jev answers: not flagged, not checked", () => {
    const verdict = computeTurnGuardVerdict({});
    expect(verdict.flagged).toBe(false);
  });

  test("Jev's done probability below the threshold flags as likely-incomplete", () => {
    const verdict = computeTurnGuardVerdict({ jevAnswers: { done: 0.2 } });
    expect(verdict.flagged).toBe(true);
    expect(verdict.doneProbability).toBe(0.2);
  });

  test("Jev's done probability at/above the threshold does not flag", () => {
    const verdict = computeTurnGuardVerdict({ jevAnswers: { done: DEFAULT_TURN_GUARD_THRESHOLD } });
    expect(verdict.flagged).toBe(false);
  });

  test("Jev's contradiction probability at/above the threshold flags", () => {
    const verdict = computeTurnGuardVerdict({ jevAnswers: { done: 0.9, contradiction: 0.7 } });
    expect(verdict.flagged).toBe(true);
    expect(verdict.reason).toContain("contradicts");
  });
});

describe("AC4: renderTurnGuardNoticeLine / renderTurnGuardAdvisory", () => {
  test("the notice line is one compact line naming the reason and pointing at /guard", () => {
    const verdict = computeTurnGuardVerdict({ contradiction: { kind: "unmentioned-failure", reason: "shell_exec failed and was not mentioned." } });
    const line = renderTurnGuardNoticeLine(verdict);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("/guard");
    expect(line).toContain("shell_exec failed");
  });

  test("the advisory includes facts, probabilities and usage when given", () => {
    const t = transcript({ finalMessage: "done" });
    const facts = extractTurnGuardFacts(t);
    const verdict = computeTurnGuardVerdict({ jevAnswers: { done: 0.3 } });
    const advisory = renderTurnGuardAdvisory({ verdict, facts, usage: { inputTokens: 100, outputTokens: 20, cost: 0.001 } });
    expect(advisory).toContain("FLAGGED");
    expect(advisory).toContain("done: ≈30%");
    expect(advisory).toContain("usage:");
    expect(advisory).toContain("ADVISORY ONLY");
  });

  test("a not-flagged advisory says so, without a FLAGGED line", () => {
    const facts = extractTurnGuardFacts(transcript({ finalMessage: "done" }));
    const verdict = computeTurnGuardVerdict({ jevAnswers: { done: 0.9 } });
    const advisory = renderTurnGuardAdvisory({ verdict, facts });
    expect(advisory).toContain("looks done");
    expect(advisory).not.toContain("FLAGGED");
  });
});
