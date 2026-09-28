// Tests for the `antigravity-cli` codec (flow 357, AC2/AC3/AC4).
//
// AC3's event-shape assertions are made against the REAL recorded transcript,
// `fixtures/external/live/antigravity-cli/2026-09-28/read-only-ok.stream.jsonl`
// — a genuine `agy` 1.2.12 run — and the soft-denial row against a second
// real one, `tool-denied.stream.jsonl`. AC4's rows with no live counterpart (WAITING,
// ERROR, CANCELED, INTERRUPTED, INVALID, timeout) are exercised
// against hand-authored synthetic lines, each named as such.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExternalEvent, ExternalRunInput, ProcessOutcome } from "../types";
import { isTerminalEvent } from "../types";
import {
  antigravityCliCodec,
  buildAntigravityArgv,
  buildAntigravityResumeArgv,
  classifyAntigravityFailure,
  isRecognisedAntigravityLine,
  parseAntigravityEvents,
  parseAntigravityLine,
} from "./antigravity-cli";

const LIVE_FIXTURE = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "external",
  "live",
  "antigravity-cli",
  "2026-09-28",
  "read-only-ok.stream.jsonl",
);

const DENIED_FIXTURE = path.join(path.dirname(LIVE_FIXTURE), "tool-denied.stream.jsonl");
const DENIED_STDERR = path.join(path.dirname(LIVE_FIXTURE), "tool-denied.stderr.txt");

function fixtureLines(file: string = LIVE_FIXTURE): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function foldTranscript(lines: readonly string[]): ExternalEvent[] {
  return lines.flatMap((line) => [...parseAntigravityEvents(line)]);
}

const PROMPT = "Reply with the single word OK and nothing else. Do not use any tools.";

const BASE_INPUT: ExternalRunInput = {
  prompt: PROMPT,
  cwd: "/tmp/keryx-worktree-357",
  sandbox: "read-only",
};

function outcomeOf(overrides: {
  events: readonly ExternalEvent[];
  exitCode: number;
  stderr?: string;
  timedOut?: boolean;
  stdout?: string;
}): ProcessOutcome {
  return {
    exitCode: overrides.exitCode,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    timedOut: overrides.timedOut ?? false,
    prompt: PROMPT,
    events: overrides.events,
  };
}

describe("buildAntigravityArgv", () => {
  test("produces the AC2 argv element by element", () => {
    expect(buildAntigravityArgv({ ...BASE_INPUT, printTimeoutSeconds: 120 })).toEqual([
      "agy",
      "-p",
      PROMPT,
      "--output-format",
      "stream-json",
      "--print-timeout",
      "120s",
      "--sandbox",
    ]);
  });

  test("falls back to the shared default print-timeout when the caller supplies none", () => {
    expect(buildAntigravityArgv(BASE_INPUT)).toContain("600s");
  });

  test("--model appears only when the field is present, before --sandbox", () => {
    const argv = buildAntigravityArgv({ ...BASE_INPUT, model: "gemini-3-pro", printTimeoutSeconds: 60 });
    expect(argv).toEqual([
      "agy",
      "-p",
      PROMPT,
      "--output-format",
      "stream-json",
      "--print-timeout",
      "60s",
      "--model",
      "gemini-3-pro",
      "--sandbox",
    ]);
  });

  test("worktree-write omits --sandbox", () => {
    expect(buildAntigravityArgv({ ...BASE_INPUT, sandbox: "worktree-write" })).not.toContain("--sandbox");
  });

  test("never emits --dangerously-skip-permissions", () => {
    for (const input of [BASE_INPUT, { ...BASE_INPUT, sandbox: "worktree-write" as const }]) {
      expect(buildAntigravityArgv(input)).not.toContain("--dangerously-skip-permissions");
    }
  });

  test("--conversation is absent from a fresh run — agy assigns its own conversation id", () => {
    expect(buildAntigravityArgv(BASE_INPUT)).not.toContain("--conversation");
  });
});

describe("buildAntigravityResumeArgv", () => {
  test("adds --conversation <id> and keeps --sandbox for a read-only resume", () => {
    expect(buildAntigravityResumeArgv("235ab503-43b5-4e17-8bde-52f903ccd7a7", "also say hi", { ...BASE_INPUT, printTimeoutSeconds: 30 })).toEqual([
      "agy",
      "-p",
      "also say hi",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "30s",
      "--conversation",
      "235ab503-43b5-4e17-8bde-52f903ccd7a7",
      "--sandbox",
    ]);
  });

  test("never emits --dangerously-skip-permissions on resume either", () => {
    expect(buildAntigravityResumeArgv("conv-1", "keep going", BASE_INPUT)).not.toContain("--dangerously-skip-permissions");
  });
});

describe("parsing the recorded live transcript (AC3)", () => {
  const lines = fixtureLines();

  test("init yields child_started carrying the TOP-LEVEL conversation_id", () => {
    expect(parseAntigravityLine(lines[0] as string)).toEqual({
      kind: "child_started",
      sessionRef: "235ab503-43b5-4e17-8bde-52f903ccd7a7",
    });
  });

  test("a user_input step_update has no canonical equivalent but is recognised", () => {
    expect(parseAntigravityLine(lines[1] as string)).toBeUndefined();
    expect(isRecognisedAntigravityLine(lines[1] as string)).toBe(true);
  });

  test("an agent_response step_update with a text_delta yields assistant_text", () => {
    expect(parseAntigravityEvents(lines[2] as string)).toEqual([{ kind: "assistant_text", text: "OK" }]);
  });

  test("the DONE agent_response step folds text_delta then usage, in that order", () => {
    expect(parseAntigravityEvents(lines[3] as string)).toEqual([
      { kind: "assistant_text", text: "\n" },
      { kind: "usage", inputTokens: 13166, outputTokens: 31 },
    ]);
  });

  test("result folds usage then child_finished carrying the response text, in that order", () => {
    expect(parseAntigravityEvents(lines[4] as string)).toEqual([
      { kind: "usage", inputTokens: 13166, outputTokens: 31 },
      { kind: "child_finished", text: "OK\n" },
    ]);
  });

  test("replaying the whole fixture end to end: outcome completed, response OK, usage totals, conversation id", () => {
    const events = foldTranscript(lines);
    const outcome = outcomeOf({ events, exitCode: 0 });

    expect(classifyAntigravityFailure(outcome)).toBeNull();

    const terminal = [...events].reverse().find((event) => event.kind === "child_finished");
    expect(terminal).toEqual({ kind: "child_finished", text: "OK\n" });

    const started = events.find((event) => event.kind === "child_started");
    expect(started).toEqual({ kind: "child_started", sessionRef: "235ab503-43b5-4e17-8bde-52f903ccd7a7" });

    const usageEvents = events.filter((event) => event.kind === "usage");
    expect(usageEvents.at(-1)).toEqual({ kind: "usage", inputTokens: 13166, outputTokens: 31 });
  });

  test("an unknown event or step_type is not recognised, and does not appear as an event", () => {
    expect(parseAntigravityEvents('{"event":"heartbeat"}')).toEqual([]);
    expect(isRecognisedAntigravityLine('{"event":"heartbeat"}')).toBe(false);
    expect(parseAntigravityEvents('{"event":"step_update","step_update":{"step_type":"tool_call"}}')).toEqual([]);
    expect(isRecognisedAntigravityLine('{"event":"step_update","step_update":{"step_type":"tool_call"}}')).toBe(false);
  });

  test("antigravityCliCodec.parseLine matches the standalone function", () => {
    for (const line of lines) {
      expect(antigravityCliCodec.parseLine(line)).toEqual(parseAntigravityLine(line));
    }
  });
});

describe("classifyAntigravityFailure — one row per outcome (AC4)", () => {
  test("SUCCESS, no denial → completed (null)", () => {
    const outcome = outcomeOf({
      events: [{ kind: "child_finished", text: "OK\n" }],
      exitCode: 0,
    });
    expect(classifyAntigravityFailure(outcome)).toBeNull();
  });

  test("SUCCESS with denied_actions → Denied-worded failure naming the denials, never plain success (recorded live)", () => {
    // Real transcript: headless mode auto-denied `run_command`, and agy still
    // reported `status: "SUCCESS"` with an empty response.
    const lines = fixtureLines(DENIED_FIXTURE);
    const events = foldTranscript(lines);
    expect(events.some((event) => event.kind === "child_finished")).toBe(false);
    const stderr = readFileSync(DENIED_STDERR, "utf8");
    const cause = classifyAntigravityFailure(outcomeOf({ events, exitCode: 0, stderr }));
    expect(cause).toContain("blocked on approval");
    expect(cause).toContain("command (RunCommand)");
    expect(cause).toContain("permissions.allow");
    // agy's own stderr suggests the skip-everything flag; keryx never relays it.
    expect(cause).not.toContain("dangerously");
  });

  test("SUCCESS with denied_actions keeps a non-empty response as assistant text (partial output)", () => {
    const events = parseAntigravityEvents(
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "I could not list the files.", denied_actions: [{ action: "command" }] },
      }),
    );
    expect(events[0]).toEqual({ kind: "assistant_text", text: "I could not list the files." });
    expect(events.at(-1)?.kind).toBe("child_failed");
  });

  test("tool steps from the recorded transcript map to tool_call and tool_result, and are recognised", () => {
    const lines = fixtureLines(DENIED_FIXTURE);
    const toolLines = lines.filter((line) => line.includes('"step_type":"tool"'));
    expect(toolLines).toHaveLength(2);
    expect(parseAntigravityEvents(toolLines[0] as string)).toEqual([
      { kind: "tool_call", name: "run_command", detail: '{"CommandLine":"ls -la"}' },
    ]);
    const done = parseAntigravityEvents(toolLines[1] as string);
    expect(done[0]?.kind).toBe("tool_result");
    for (const line of lines) expect(isRecognisedAntigravityLine(line)).toBe(true);
  });

  test("WAITING → blocked-on-approval wording (classifies Denied via runtime.ts's markers)", () => {
    // Synthetic result line — no live fixture reaches WAITING.
    const events = parseAntigravityEvents(
      JSON.stringify({
        event: "result",
        result: { conversation_id: "conv-wait", status: "WAITING", response: "", error: "tool run_command needs approval" },
      }),
    );
    const outcome = outcomeOf({ events, exitCode: 0 });
    const cause = classifyAntigravityFailure(outcome);
    expect(cause).not.toBeNull();
    expect(cause).toMatch(/blocked on approval/i);
    expect(cause).toMatch(/waiting/i);
  });

  test('ERROR with an authentication message → not-logged-in wording, "run agy once"', () => {
    const events = parseAntigravityEvents(
      JSON.stringify({
        event: "result",
        result: { conversation_id: "conv-err", status: "ERROR", response: "", error: "authentication required: please run agy to log in" },
      }),
    );
    const outcome = outcomeOf({ events, exitCode: 1 });
    const cause = classifyAntigravityFailure(outcome);
    expect(cause).toMatch(/no usable credentials/i);
    expect(cause).toMatch(/run `agy` once interactively/i);
  });

  test("a non-TTY auth exit with no terminal event → not-logged-in wording", () => {
    const outcome = outcomeOf({
      events: [],
      exitCode: 1,
      stderr: "Error: not logged in — run agy interactively to authenticate\n",
    });
    const cause = classifyAntigravityFailure(outcome);
    expect(cause).toMatch(/could not authenticate/i);
    expect(cause).toMatch(/run `agy` once interactively/i);
  });

  test("ERROR otherwise → failed with the error detail", () => {
    const events = parseAntigravityEvents(
      JSON.stringify({
        event: "result",
        result: { conversation_id: "conv-err2", status: "ERROR", response: "", error: "internal tool crashed" },
      }),
    );
    const outcome = outcomeOf({ events, exitCode: 1 });
    const cause = classifyAntigravityFailure(outcome);
    expect(cause).toContain("internal tool crashed");
    expect(cause).toMatch(/ended in failure/i);
  });

  test("CANCELED/INTERRUPTED → cancelled wording", () => {
    for (const status of ["CANCELED", "INTERRUPTED"] as const) {
      const events = parseAntigravityEvents(
        JSON.stringify({ event: "result", result: { conversation_id: "conv-cancel", status, response: "" } }),
      );
      const cause = classifyAntigravityFailure(outcomeOf({ events, exitCode: 1 }));
      expect(cause?.toLowerCase()).toContain(status === "CANCELED" ? "canceled" : "interrupted");
    }
  });

  test("INVALID → invalid-request wording", () => {
    const events = parseAntigravityEvents(
      JSON.stringify({
        event: "result",
        result: { conversation_id: "conv-invalid", status: "INVALID", response: "", error: "unknown model \"nope\"" },
      }),
    );
    const cause = classifyAntigravityFailure(outcomeOf({ events, exitCode: 1 }));
    expect(cause).toMatch(/invalid/i);
    expect(cause).toContain('unknown model "nope"');
  });

  test("no result before the timeout → timed-out wording", () => {
    const outcome = outcomeOf({ events: [{ kind: "child_started", sessionRef: "conv-timeout" }], exitCode: -1, timedOut: true });
    const cause = classifyAntigravityFailure(outcome);
    expect(cause).toMatch(/wall-clock ceiling/i);
  });

  test("a rejected CLI flag is classified before anything else is consulted", () => {
    const outcome = outcomeOf({
      events: [],
      exitCode: 2,
      stderr: "flags provided but not defined: -nonexistent\nUsage of agy:\n",
    });
    const cause = classifyAntigravityFailure(outcome);
    expect(cause).toMatch(/rejected the command line/i);
    expect(cause).toMatch(/agy --version/i);
  });

  test("no terminal event and no recognisable cause → transcript ended without a terminal event", () => {
    const outcome = outcomeOf({ events: [{ kind: "child_started", sessionRef: "conv-x" }], exitCode: 1 });
    expect(classifyAntigravityFailure(outcome)).toMatch(/transcript ended without a terminal event/i);
  });
});

describe("antigravityCliCodec port shape", () => {
  test("id and every required method are present, and no streaming shape is claimed", () => {
    expect(antigravityCliCodec.id).toBe("antigravity-cli");
    expect(antigravityCliCodec.buildStreamingArgv).toBeUndefined();
    expect(antigravityCliCodec.encodeStdinMessage).toBeUndefined();
    expect(typeof antigravityCliCodec.classifyFailure).toBe("function");
    expect(typeof antigravityCliCodec.isRecognisedLine).toBe("function");
  });

  test("isTerminalEvent agrees with what parseAntigravityLine surfaces as terminal", () => {
    const lines = fixtureLines();
    const terminalLine = lines[4] as string; // the result line
    const event = parseAntigravityLine(terminalLine);
    expect(event).toBeDefined();
    expect(isTerminalEvent(event as ExternalEvent)).toBe(true);
  });
});
