// Tests for the `claude -p` codec (flow 176, T9).
//
// These run offline and assert against the REAL transcripts in
// `fixtures/external/claude-cli/`, captured from Claude Code 2.1.220 (see
// `fixtures/external/manifest.json`). Nothing here spawns a CLI, and no test
// asks the vendor a paid question.
//
// One fixture is not evidence: `usage-limit.SYNTHETIC.jsonl` is hand-authored,
// because a quota exhaustion cannot be provoked on demand. The limit test below
// is therefore provisional and pins OUR mapping, not the vendor's wording.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import type { ExternalEvent, ExternalRunInput, ProcessOutcome } from "../types";
import { isTerminalEvent } from "../types";
import {
  CLAUDE_ALLOWED_TOOLS,
  CLAUDE_EMPTY_MCP_CONFIG,
  CLAUDE_VARIADIC_FLAGS,
  buildClaudeArgv,
  buildClaudeResumeArgv,
  buildClaudeStreamingArgv,
  encodeClaudeStdinMessage,
  claudeCliCodec,
  classifyClaudeFailure,
  isRecognisedClaudeLine,
  parseClaudeEvents,
  parseClaudeLine,
} from "./claude-cli";

const FIXTURE_DIR = fileURLToPath(new URL("../../../../fixtures/external/claude-cli/", import.meta.url));

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

function transcriptLines(name: string): string[] {
  return fixture(name)
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function eventsOf(name: string): ExternalEvent[] {
  return transcriptLines(name).flatMap((line) => [...parseClaudeEvents(line)]);
}

/** Assemble a `ProcessOutcome` whose events come from a real transcript. */
function outcomeFrom(
  name: string | undefined,
  overrides: Partial<Omit<ProcessOutcome, "events">> = {},
): ProcessOutcome {
  return {
    exitCode: 0,
    stdout: name === undefined ? "" : fixture(name),
    stderr: "",
    timedOut: false,
    prompt: "say ok",
    events: name === undefined ? [] : eventsOf(name),
    ...overrides,
  };
}

const BASE_INPUT: ExternalRunInput = {
  prompt: "Report on the failing test.",
  cwd: "/tmp/keryx-worktree",
  sandbox: "read-only",
  sessionId: "9a3e7c11-0b52-4d68-a7f3-6c1e94b25d07",
};

describe("buildArgv — the ordering is load-bearing", () => {
  test("produces the exact recorded argv, element by element", () => {
    expect(buildClaudeArgv(BASE_INPUT)).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--safe-mode",
      "--tools",
      "Read",
      "Grep",
      "Glob",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--add-dir",
      "/tmp/keryx-worktree",
      "--session-id",
      "9a3e7c11-0b52-4d68-a7f3-6c1e94b25d07",
      "Report on the failing test.",
    ]);
  });

  test("optional flags appear only when their input field is present, in a fixed order", () => {
    const argv = buildClaudeArgv({
      ...BASE_INPUT,
      model: "claude-opus-5",
      resultSchemaPath: "/tmp/result.schema.json",
      maxCostUnits: 2.5,
    });
    expect(argv.slice(argv.indexOf("--mcp-config") + 2)).toEqual([
      "--max-budget-usd",
      "2.5",
      "--json-schema",
      "/tmp/result.schema.json",
      "--add-dir",
      "/tmp/keryx-worktree",
      "--model",
      "claude-opus-5",
      "--session-id",
      "9a3e7c11-0b52-4d68-a7f3-6c1e94b25d07",
      "Report on the failing test.",
    ]);
  });

  test("omitted optional fields emit no flag at all", () => {
    const argv = buildClaudeArgv(BASE_INPUT);
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--json-schema");
    expect(argv).not.toContain("--max-budget-usd");
  });

  test("THE PROMPT NEVER DIRECTLY FOLLOWS A VARIADIC FLAG", () => {
    // A probe that placed the prompt after `--mcp-config` failed with
    // `MCP config file not found: …/Rep` — the CLI took the prompt's first word
    // as a path. Asserted across every combination of optional fields, because
    // the hazard is created by which flag happens to land last.
    const flags: Array<Partial<ExternalRunInput>> = [
      {},
      { model: "claude-opus-5" },
      { resultSchemaPath: "/tmp/s.json" },
      { maxCostUnits: 1 },
      { model: "m", resultSchemaPath: "/tmp/s.json", maxCostUnits: 1 },
    ];
    for (const extra of flags) {
      for (const sessionId of ["9a3e7c11-0b52-4d68-a7f3-6c1e94b25d07", undefined]) {
        for (const cwd of ["/tmp/keryx-worktree", ""]) {
          const input: ExternalRunInput = {
            ...BASE_INPUT,
            ...extra,
            cwd,
            ...(sessionId === undefined ? {} : { sessionId }),
          };
          const argv = sessionId === undefined ? buildClaudeArgv({ ...input, sessionId: "" }) : buildClaudeArgv(input);
          const beforePrompt = argv[argv.length - 2];
          expect(argv[argv.length - 1]).toBe(input.prompt);
          expect(CLAUDE_VARIADIC_FLAGS).not.toContain(beforePrompt as string);
        }
      }
    }
  });

  test("--session-id is the single-valued separator directly before the prompt", () => {
    const argv = buildClaudeArgv(BASE_INPUT);
    expect(argv[argv.length - 3]).toBe("--session-id");
  });

  test("a missing session id keeps the argv safe with a zero-valued flag instead", () => {
    // No uuid is invented: two concurrent runs sharing one would corrupt each
    // other's history.
    const argv = buildClaudeArgv({ ...BASE_INPUT, sessionId: "  " });
    expect(argv).not.toContain("--session-id");
    expect(argv[argv.length - 2]).toBe("--strict-mcp-config");
    expect(argv[argv.length - 1]).toBe(BASE_INPUT.prompt);
  });

  test("the prompt is exactly one argv element even when it contains spaces and newlines", () => {
    const prompt = "line one\nline two --mcp-config /etc/passwd";
    const argv = buildClaudeArgv({ ...BASE_INPUT, prompt });
    expect(argv.filter((element) => element === prompt)).toHaveLength(1);
    expect(argv[argv.length - 1]).toBe(prompt);
  });

  test("--tools is the allow-list; --allowed-tools and --permission-mode are never sent", () => {
    const argv = buildClaudeArgv(BASE_INPUT);
    const start = argv.indexOf("--tools");
    expect(argv.slice(start + 1, start + 1 + CLAUDE_ALLOWED_TOOLS.length)).toEqual(["Read", "Grep", "Glob"]);
    // `--allowed-tools` is a permission rule and does NOT restrict the roster;
    // `--permission-mode plan` makes a plan-approval answer look like success.
    expect(argv).not.toContain("--allowed-tools");
    expect(argv).not.toContain("--permission-mode");
  });

  test("--safe-mode is sent and --bare is not", () => {
    const argv = buildClaudeArgv(BASE_INPUT);
    // Without `--safe-mode` the child runs the operator's hooks and skills;
    // `--bare` would suppress the same things but force API-key auth.
    expect(argv).toContain("--safe-mode");
    expect(argv).not.toContain("--bare");
  });

  test("MCP is disabled by an empty inline config plus the strict flag", () => {
    const argv = buildClaudeArgv(BASE_INPUT);
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe(CLAUDE_EMPTY_MCP_CONFIG);
  });

  test("sandbox level does not change the argv in this release", () => {
    expect(buildClaudeArgv({ ...BASE_INPUT, sandbox: "worktree-write" })).toEqual(buildClaudeArgv(BASE_INPUT));
  });

  test("--input-format is NEVER sent alongside a positional prompt", () => {
    // Measured on 2.1.220: that combination makes the CLI ignore the prompt,
    // wait on stdin, and exit 0 with zero bytes on both streams — a silent
    // no-op wearing a success exit code. Specification 0.1.0–0.3.0 all carried
    // it. This assertion is the guard against it coming back.
    expect(buildClaudeArgv(BASE_INPUT)).not.toContain("--input-format");
    expect(buildClaudeArgv({ ...BASE_INPUT, sessionId: "" })).not.toContain("--input-format");
    expect(buildClaudeResumeArgv("sid", "msg", BASE_INPUT)).not.toContain("--input-format");
  });
});

describe("streaming mode is a different argv, not a flag on the same one", () => {
  test("sends --input-format stream-json and NO positional prompt", () => {
    const argv = buildClaudeStreamingArgv(BASE_INPUT);
    const i = argv.indexOf("--input-format");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("stream-json");
    // The prompt arrives on stdin; nothing positional may trail the flags.
    expect(argv).not.toContain(BASE_INPUT.prompt);
  });

  test("keeps the session id so the run stays resumable", () => {
    const argv = buildClaudeStreamingArgv(BASE_INPUT);
    expect(argv[argv.length - 2]).toBe("--session-id");
    expect(argv[argv.length - 1]).toBe(BASE_INPUT.sessionId);
  });

  test("omits --session-id entirely when none was assigned", () => {
    const argv = buildClaudeStreamingArgv({ ...BASE_INPUT, sessionId: "" });
    expect(argv).not.toContain("--session-id");
  });

  test("carries the same containment flags as the one-shot shape", () => {
    const argv = buildClaudeStreamingArgv(BASE_INPUT);
    expect(argv).toContain("--safe-mode");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv.slice(argv.indexOf("--tools") + 1, argv.indexOf("--tools") + 4)).toEqual(["Read", "Grep", "Glob"]);
  });

  test("encodeClaudeStdinMessage produces one newline-terminated JSON user message", () => {
    const line = encodeClaudeStdinMessage("Reply with exactly the word: ok");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(JSON.parse(line)).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Reply with exactly the word: ok" }] },
    });
  });

  test("a message containing newlines and quotes stays one JSON line", () => {
    const line = encodeClaudeStdinMessage('stop\nand "reconsider"');
    expect(line.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(JSON.parse(line).message.content[0].text).toBe('stop\nand "reconsider"');
  });
});

describe("buildResumeArgv", () => {
  test("swaps --session-id for --resume and puts the message last", () => {
    const argv = buildClaudeResumeArgv("9a3e7c11-0b52-4d68-a7f3-6c1e94b25d07", "keep going", BASE_INPUT);
    expect(argv).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--safe-mode",
      "--tools",
      "Read",
      "Grep",
      "Glob",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--add-dir",
      "/tmp/keryx-worktree",
      "--resume",
      "9a3e7c11-0b52-4d68-a7f3-6c1e94b25d07",
      "keep going",
    ]);
    expect(argv).not.toContain("--session-id");
  });

  test("--resume is a single-valued separator, so the message is safe there too", () => {
    const argv = buildClaudeResumeArgv("sess", "msg", { ...BASE_INPUT, cwd: "", maxCostUnits: 1 });
    expect(CLAUDE_VARIADIC_FLAGS).not.toContain(argv[argv.length - 2] as string);
    expect(argv[argv.length - 1]).toBe("msg");
  });
});

describe("parseLine against the captured success transcript", () => {
  const lines = transcriptLines("success.stdout.jsonl");

  test("system/init becomes child_started carrying the session id keryx assigned", () => {
    // Unlike codex, where the handle is READ off `thread.started`, this id is
    // the one keryx passed in via `--session-id`.
    expect(parseClaudeLine(lines[0] as string)).toEqual({
      kind: "child_started",
      sessionRef: "9a3e7c11-0b52-4d68-a7f3-6c1e94b25d07",
    });
  });

  test("the multi-KB system/init line parses — no short-line assumption", () => {
    expect((lines[0] as string).length).toBeGreaterThan(1000);
  });

  test("rate_limit_event maps to no event, because it appears on HEALTHY runs", () => {
    // Folding it onto `retry` would report retries on a clean single-turn run.
    expect(parseClaudeLine(lines[1] as string)).toBeUndefined();
    expect(isRecognisedClaudeLine(lines[1] as string)).toBe(true);
  });

  test("an assistant text block becomes assistant_text", () => {
    expect(parseClaudeLine(lines[2] as string)).toEqual({ kind: "assistant_text", text: "ok" });
  });

  test("result(success) is terminal and carries the result payload", () => {
    const event = parseClaudeLine(lines[3] as string);
    expect(event).toEqual({ kind: "child_finished", text: "ok" });
    expect(isTerminalEvent(event as ExternalEvent)).toBe(true);
  });

  test("the same result line also yields usage, emitted BEFORE the terminal event", () => {
    const events = parseClaudeEvents(lines[3] as string);
    expect(events).toHaveLength(2);
    // Cache reads are folded into inputTokens: the raw `input_tokens: 2` beside
    // `cache_read_input_tokens: 5118` would under-report the run 2500-fold.
    expect(events[0]).toEqual({ kind: "usage", inputTokens: 5120, outputTokens: 4, costUnits: 0.003257 });
    expect(isTerminalEvent(events[1] as ExternalEvent)).toBe(true);
  });

  test("exactly one terminal event in the whole transcript", () => {
    expect(eventsOf("success.stdout.jsonl").filter(isTerminalEvent)).toHaveLength(1);
  });

  test("classifyFailure returns null", () => {
    expect(classifyClaudeFailure(outcomeFrom("success.stdout.jsonl"))).toBeNull();
  });
});

describe("parseLine against the captured resume transcript", () => {
  test("resume reports the SAME session id, proving the handle is keryx-assigned", () => {
    const started = eventsOf("resume.stdout.jsonl").find((event) => event.kind === "child_started");
    expect(started).toEqual({ kind: "child_started", sessionRef: "9a3e7c11-0b52-4d68-a7f3-6c1e94b25d07" });
  });

  test("resume terminates successfully and reports its own cost", () => {
    const events = eventsOf("resume.stdout.jsonl");
    expect(events.filter(isTerminalEvent)).toEqual([{ kind: "child_finished", text: "ok" }]);
    expect(events.find((event) => event.kind === "usage")).toEqual({
      kind: "usage",
      inputTokens: 5135,
      outputTokens: 4,
      costUnits: 0.02484,
    });
    expect(classifyClaudeFailure(outcomeFrom("resume.stdout.jsonl"))).toBeNull();
  });
});

describe("the bad-credential transcript — exit 0 is NOT success", () => {
  const events = eventsOf("not-logged-in.stdout.jsonl");

  test("all eight api_retry events are non-terminal", () => {
    const retries = events.filter((event) => event.kind === "retry");
    expect(retries).toHaveLength(8);
    for (const retry of retries) {
      expect(isTerminalEvent(retry)).toBe(false);
    }
    expect(retries[0]).toEqual({ kind: "retry", message: "api retry 1/10, status 401, authentication_failed" });
  });

  test("the run still reaches exactly one terminal event, after the retries", () => {
    const terminals = events.filter(isTerminalEvent);
    expect(terminals).toHaveLength(1);
    expect(events.indexOf(terminals[0] as ExternalEvent)).toBe(events.length - 1);
  });

  test("result.subtype error_during_execution becomes child_failed and quotes the subtype", () => {
    const terminal = events.find(isTerminalEvent) as ExternalEvent & { kind: "child_failed" };
    expect(terminal.kind).toBe("child_failed");
    expect(terminal.message).toContain('result.subtype "error_during_execution"');
  });

  test("classifyFailure is driven by result.subtype, not by exit code or output length", () => {
    const outcome = outcomeFrom("not-logged-in.stdout.jsonl", { exitCode: 0 });
    // Exit 0 and a full, normal-looking transcript. "exit 0 and non-empty
    // output means success" would call this a clean run.
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.length).toBeGreaterThan(1000);
    const cause = classifyClaudeFailure(outcome);
    expect(cause).not.toBeNull();
    expect(cause).toContain("authenticate");
    // The operator's practical symptom is slowness, so the retries are named.
    expect(cause).toContain("8 api retries");
  });

  test("the transcript's echoed user text does NOT become a user_message", () => {
    // `user_message` is reserved for messages keryx delivers. The echo here is
    // `[Request interrupted by user]`, which no operator typed.
    expect(events.some((event) => event.kind === "user_message")).toBe(false);
  });
});

describe("argv rejected by this CLI version", () => {
  test("stderr `unknown option` classifies as a cli-usage cause naming the version", () => {
    const stderr = fixture("bad-argv.stderr.txt");
    // Terse, and with NO usage block — unlike codex, there is nothing else to
    // anchor on.
    expect(stderr.trim()).toBe("error: unknown option '--no-such-flag'");
    const cause = classifyClaudeFailure(outcomeFrom(undefined, { exitCode: 1, stderr }));
    expect(cause).toContain("rejected the command line");
    expect(cause).toContain("--no-such-flag");
    expect(cause).toContain("2.1.220");
  });

  test("argv rejection outranks the empty transcript it causes", () => {
    const cause = classifyClaudeFailure(
      outcomeFrom(undefined, { exitCode: 1, stderr: "error: unknown option '--nope'" }),
    );
    expect(cause).not.toContain("without a terminal event");
  });
});

describe("usage limit (SYNTHETIC fixture — provisional)", () => {
  test("a limit-worded terminal result classifies as a limit, not a generic error", () => {
    const cause = classifyClaudeFailure(outcomeFrom("usage-limit.SYNTHETIC.jsonl", { exitCode: 1 }));
    expect(cause).toContain("usage or rate limit");
    expect(cause).toContain("usage limit reached");
  });

  test("the synthetic transcript's bare rate_limit_event still maps to nothing", () => {
    expect(parseClaudeLine('{"type":"rate_limit_event"}')).toBeUndefined();
  });
});

describe("classifyFailure — remaining causes", () => {
  test("a timeout is named as one", () => {
    const cause = classifyClaudeFailure(outcomeFrom(undefined, { timedOut: true }));
    expect(cause).toContain("wall-clock ceiling");
  });

  test("a transcript with no terminal event says exactly that", () => {
    const cause = classifyClaudeFailure(outcomeFrom(undefined, { exitCode: 3 }));
    expect(cause).toContain("transcript ended without a terminal event");
    expect(cause).toContain("exit 3");
  });

  test("a completed run that raced the kill is a success, not a timeout", () => {
    expect(classifyClaudeFailure(outcomeFrom("success.stdout.jsonl", { timedOut: true }))).toBeNull();
  });

  test("the retired `Not logged in` string is tolerated only where nothing else speaks", () => {
    // 0.1.0 asserted this shape; it does NOT reproduce on 2.1.220. It stays as a
    // fallback that can never contradict a real `result.subtype`.
    const cause = classifyClaudeFailure(
      outcomeFrom(undefined, { stdout: "Not logged in · Please run /login\n", prompt: "" }),
    );
    expect(cause).toContain("authentication problem");
  });

  test("the prompt is subtracted before stdout is pattern-matched", () => {
    const cause = classifyClaudeFailure(
      outcomeFrom(undefined, { stdout: "please run /login to continue", prompt: "please run /login to continue" }),
    );
    expect(cause).toContain("transcript ended without a terminal event");
  });

  test("retry noise alone never terminates a run", () => {
    const retries: ExternalEvent[] = [{ kind: "retry", message: "api retry 1/10" }];
    expect(retries.some(isTerminalEvent)).toBe(false);
    expect(classifyClaudeFailure({ ...outcomeFrom(undefined), events: retries })).toContain("1 api retry");
  });
});

describe("event shapes with no recorded fixture (manifest gap: no multi-turn tool-call capture)", () => {
  test("an assistant tool_use block becomes tool_call carrying its input", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/etc/hosts" } }] },
    });
    // The detail carries the input verbatim because the `scope_drift`
    // supervision trigger reads the target path out of it.
    expect(parseClaudeLine(line)).toEqual({
      kind: "tool_call",
      name: "Read",
      detail: '{"file_path":"/etc/hosts"}',
    });
  });

  test("a user tool_result block becomes tool_result", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: [{ type: "text", text: "127.0.0.1" }] }] },
    });
    expect(parseClaudeLine(line)).toEqual({ kind: "tool_result", detail: "127.0.0.1" });
  });

  test("an assistant thinking block becomes thinking", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "weighing options" }] },
    });
    expect(parseClaudeLine(line)).toEqual({ kind: "thinking", text: "weighing options" });
  });

  test("a multi-block message yields every event, and parseLine returns the first", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "reading" },
          { type: "tool_use", name: "Grep", input: { pattern: "x" } },
        ],
      },
    });
    expect(parseClaudeEvents(line).map((event) => event.kind)).toEqual(["thinking", "assistant_text", "tool_call"]);
    expect(parseClaudeLine(line)).toEqual({ kind: "thinking", text: "hm" });
  });
});

describe("unknown and unparseable lines", () => {
  test("garbage yields no event and is NOT recognised", () => {
    for (const line of ["not json at all", "{", '{"type":', "[1,2,3]", '"a string"']) {
      expect(parseClaudeLine(line)).toBeUndefined();
      expect(isRecognisedClaudeLine(line)).toBe(false);
    }
  });

  test("a blank line yields no event and does not count as drift", () => {
    expect(parseClaudeLine("   ")).toBeUndefined();
    expect(isRecognisedClaudeLine("")).toBe(true);
  });

  test("an unknown line type yields no event and counts as drift", () => {
    const line = '{"type":"quantum_event","payload":1}';
    expect(parseClaudeLine(line)).toBeUndefined();
    expect(isRecognisedClaudeLine(line)).toBe(false);
  });

  test("hook events are recognised but unmapped — our argv always sends --safe-mode", () => {
    // They only appear when `--safe-mode` is absent, so seeing one means the
    // argv was tampered with, not that the parser is behind the CLI.
    for (const subtype of ["hook_started", "hook_response"]) {
      const line = JSON.stringify({ type: "system", subtype, session_id: "s" });
      expect(parseClaudeLine(line)).toBeUndefined();
      expect(isRecognisedClaudeLine(line)).toBe(true);
    }
  });

  test("every recognised line of every captured transcript parses", () => {
    for (const name of ["success.stdout.jsonl", "resume.stdout.jsonl", "not-logged-in.stdout.jsonl"]) {
      for (const line of transcriptLines(name)) {
        expect(isRecognisedClaudeLine(line)).toBe(true);
      }
    }
  });

  test("a result line with no subtype falls back to is_error", () => {
    // `subtype` is the discriminator; `is_error` is backward compatibility only.
    expect(parseClaudeLine('{"type":"result","is_error":false,"result":"done"}')).toEqual({
      kind: "child_finished",
      text: "done",
    });
    expect(parseClaudeLine('{"type":"result","is_error":true}')).toMatchObject({ kind: "child_failed" });
  });
});

describe("the codec object", () => {
  test("wires the four pure functions under the registry id", () => {
    expect(claudeCliCodec.id).toBe("claude-cli");
    expect(claudeCliCodec.buildArgv(BASE_INPUT)).toEqual(buildClaudeArgv(BASE_INPUT));
    expect(claudeCliCodec.parseLine('{"type":"rate_limit_event"}')).toBeUndefined();
    expect(claudeCliCodec.classifyFailure(outcomeFrom("success.stdout.jsonl"))).toBeNull();
    expect(claudeCliCodec.buildResumeArgv("s", "m", BASE_INPUT)).toEqual(buildClaudeResumeArgv("s", "m", BASE_INPUT));
  });
});
