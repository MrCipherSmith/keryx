// Tests for the `codex-cli` codec (flow 176, T8).
//
// Every assertion about vendor behaviour is made against the REAL transcripts in
// `fixtures/external/codex-cli/`, recorded from codex-cli 0.147.0 (flow 176 T5).
// That is the point of the codec being three pure functions: this file spawns
// nothing, needs no network, and passes on a machine with no `codex` installed.
//
// The one exception is `usage-limit.SYNTHETIC.jsonl`, which is HAND-AUTHORED —
// a quota cannot be exhausted on demand — so the limit test below is provisional
// and is marked as such where it appears.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { isTerminalEvent } from "../types";
import type { ExternalEvent, ExternalRunInput, ProcessOutcome } from "../types";
import {
  CODEX_SANDBOX_MODES,
  buildCodexArgv,
  buildCodexResumeArgv,
  classifyCodexFailure,
  codexCliCodec,
  parseCodexEvents,
  parseCodexLine,
} from "./codex-cli";

const FIXTURES = path.join(import.meta.dir, "..", "..", "..", "..", "fixtures", "external", "codex-cli");

/** Read a recorded transcript verbatim. Synchronous and committed — no test setup. */
function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

/** Fold a whole recorded stdout the way the stream pump would. */
function foldTranscript(stdout: string): ExternalEvent[] {
  return stdout.split("\n").flatMap((line) => [...parseCodexEvents(line)]);
}

const PROMPT = "Reply with the single word ok.";

/** Build the `ProcessOutcome` a real run of this fixture would have produced. */
function outcomeOf(
  stdoutFixture: string | undefined,
  overrides: { exitCode: number; stderr?: string; timedOut?: boolean; prompt?: string },
): ProcessOutcome {
  const stdout = stdoutFixture === undefined ? "" : fixture(stdoutFixture);
  return {
    exitCode: overrides.exitCode,
    stdout,
    stderr: overrides.stderr ?? "",
    timedOut: overrides.timedOut ?? false,
    prompt: overrides.prompt ?? PROMPT,
    events: foldTranscript(stdout),
  };
}

const BASE_INPUT: ExternalRunInput = {
  prompt: PROMPT,
  cwd: "/tmp/keryx-worktree-176",
  sandbox: "read-only",
};

describe("buildCodexArgv", () => {
  test("produces the recorded argv element by element", () => {
    // Asserted positionally, not by `toContain`: the reference implementation's
    // months-long outage was a flag in the wrong shape, not a missing one.
    expect(buildCodexArgv(BASE_INPUT)).toEqual([
      "codex",
      "exec",
      "--json",
      "--color",
      "never",
      "-s",
      "read-only",
      "-C",
      "/tmp/keryx-worktree-176",
      "--ignore-user-config",
      "--skip-git-repo-check",
      PROMPT,
    ]);
  });

  test("optional flags appear in spec order only when their field is present", () => {
    expect(
      buildCodexArgv({
        ...BASE_INPUT,
        model: "gpt-5-codex",
        resultSchemaPath: "/tmp/result.schema.json",
      }),
    ).toEqual([
      "codex",
      "exec",
      "--json",
      "--color",
      "never",
      "-s",
      "read-only",
      "-C",
      "/tmp/keryx-worktree-176",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--output-schema",
      "/tmp/result.schema.json",
      "-m",
      "gpt-5-codex",
      PROMPT,
    ]);
  });

  test("omits --output-schema and -m entirely when the fields are absent", () => {
    const argv = buildCodexArgv(BASE_INPUT);
    expect(argv).not.toContain("--output-schema");
    expect(argv).not.toContain("-m");
  });

  test("never emits --ephemeral, because it makes the thread unresumable", () => {
    // fixtures/external/codex-cli/resume-refused-ephemeral.stderr.txt:
    // `no rollout found for thread id … (code -32600)`. Resume is what makes
    // operator messages and `force` work for this agent, so persistence wins.
    const refusal = fixture("resume-refused-ephemeral.stderr.txt");
    expect(refusal).toContain("no rollout found for thread id");

    for (const input of [BASE_INPUT, { ...BASE_INPUT, model: "gpt-5-codex", resultSchemaPath: "/tmp/s.json" }]) {
      expect(buildCodexArgv(input)).not.toContain("--ephemeral");
    }
  });

  test("the prompt is the final single element and never trails a variadic flag", () => {
    // `-i/--image <FILE>...` is the only multi-value flag `codex exec` declares
    // (0.147.0 `--help`). A prompt placed behind one is eaten as another value —
    // the failure mode captured on the claude side as `MCP config file not
    // found: …/Rep`, where the CLI took the prompt's first word as a path.
    const variadic = ["-i", "--image"];
    for (const input of [BASE_INPUT, { ...BASE_INPUT, model: "gpt-5-codex", resultSchemaPath: "/tmp/s.json" }]) {
      const argv = buildCodexArgv(input);
      expect(argv[argv.length - 1]).toBe(PROMPT);
      expect(argv.filter((element) => element === PROMPT)).toHaveLength(1);
      expect(variadic).not.toContain(argv[argv.length - 2]);
    }
  });

  test("translates keryx's sandbox vocabulary into values codex actually accepts", () => {
    // codex `-s` takes read-only | workspace-write | danger-full-access. keryx
    // says `worktree-write`, which codex would reject outright.
    expect(buildCodexArgv({ ...BASE_INPUT, sandbox: "worktree-write" })).toContain("workspace-write");
    expect(buildCodexArgv({ ...BASE_INPUT, sandbox: "worktree-write" })).not.toContain("worktree-write");
    expect(Object.values(CODEX_SANDBOX_MODES)).not.toContain("danger-full-access");
  });
});

describe("buildCodexResumeArgv", () => {
  test("produces the recorded resume argv element by element", () => {
    expect(buildCodexResumeArgv("01a01b40-ddbd-75e3-9204-ed00ca6e3a86", "also mention the date")).toEqual([
      "codex",
      "exec",
      "resume",
      "01a01b40-ddbd-75e3-9204-ed00ca6e3a86",
      "--json",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "also mention the date",
    ]);
  });

  test("omits every flag `codex exec resume` does not accept", () => {
    // Verified against `codex exec resume --help` on 0.147.0: no -s/--sandbox,
    // no -C/--cd, no --color. The caller must therefore spawn the resume process
    // with its cwd ALREADY set to the worktree — there is no flag to carry it.
    const argv = buildCodexResumeArgv("thread-1", "keep going");
    for (const rejected of ["-s", "--sandbox", "-C", "--cd", "--color"]) {
      expect(argv).not.toContain(rejected);
    }
  });

  test("the message is last, and the session ref is positional right after `resume`", () => {
    const argv = buildCodexResumeArgv("thread-1", "keep going");
    expect(argv[3]).toBe("thread-1");
    expect(argv[argv.length - 1]).toBe("keep going");
  });

  test("the codec port's ExternalRunInput cannot change the resume argv", () => {
    // Nothing on the input is expressible on this subcommand; a caller that
    // believes otherwise would ship a resume pointed at the wrong tree.
    expect(codexCliCodec.buildResumeArgv("thread-1", "keep going", { ...BASE_INPUT, model: "gpt-5-codex" })).toEqual(
      buildCodexResumeArgv("thread-1", "keep going"),
    );
  });
});

describe("parseCodexLine against the recorded success transcript", () => {
  const lines = fixture("success.stdout.jsonl").split("\n").filter((line) => line.trim().length > 0);

  test("thread.started yields child_started carrying codex's own thread id", () => {
    // codex GENERATES this id; keryx cannot assign one, unlike claude's --session-id.
    expect(parseCodexLine(lines[0] as string)).toEqual({
      kind: "child_started",
      sessionRef: "01a01b40-ddbd-75e3-9204-ed00ca6e3a86",
    });
  });

  test("turn.started has no canonical equivalent", () => {
    expect(parseCodexLine(lines[1] as string)).toBeUndefined();
  });

  test("item.completed(agent_message) yields assistant_text carrying item.text", () => {
    expect(parseCodexLine(lines[2] as string)).toEqual({ kind: "assistant_text", text: "ok" });
  });

  test("turn.completed folds to usage then child_finished, in that order", () => {
    expect(parseCodexEvents(lines[3] as string)).toEqual([
      { kind: "usage", inputTokens: 34063, outputTokens: 5 },
      { kind: "child_finished" },
    ]);
  });

  test("parseLine keeps the TERMINAL half of turn.completed, not the usage half", () => {
    // Forced, not aesthetic: classifyFailure keys on terminality, so returning
    // `usage` here would make every successful run classify as
    // "transcript ended without a terminal event".
    expect(parseCodexLine(lines[3] as string)).toEqual({ kind: "child_finished" });
  });

  test("the whole transcript folds to one clean run", () => {
    expect(foldTranscript(fixture("success.stdout.jsonl")).map((event) => event.kind)).toEqual([
      "child_started",
      "assistant_text",
      "usage",
      "child_finished",
    ]);
  });
});

describe("parseCodexLine on input it was not given", () => {
  test("unparseable lines yield nothing rather than throwing", () => {
    for (const line of ["", "   ", "not json at all", "{", '["array"]', "null", "42"]) {
      expect(parseCodexLine(line)).toBeUndefined();
      expect(parseCodexEvents(line)).toEqual([]);
    }
  });

  test("an unmodelled stream type is skipped, not guessed at", () => {
    // A vendor that adds an event type in a patch release must degrade to a
    // counted parse-skip, never to a dead run.
    expect(parseCodexLine('{"type":"turn.thinking","text":"…"}')).toBeUndefined();
    expect(parseCodexLine('{"no_type_field":true}')).toBeUndefined();
  });

  test("item.completed with an unmodelled item type is skipped", () => {
    // The real no-credentials transcript contains an item.completed whose item
    // type is `error` (a transport-fallback notice). It is deliberately NOT
    // counted as a retry — see the ten-retry assertion below.
    expect(parseCodexLine('{"type":"item.completed","item":{"id":"i","type":"error","message":"x"}}')).toBeUndefined();
  });

  test("command_execution folds to tool_call, with the command as detail when present", () => {
    // Modelled, not recorded: no captured fixture exercises a tool call
    // (fixtures/external/manifest.json `gaps`), so this reads defensively.
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"command_execution","command":"ls -la"}}')).toEqual({
      kind: "tool_call",
      name: "command_execution",
      detail: "ls -la",
    });
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"command_execution"}}')).toEqual({
      kind: "tool_call",
      name: "command_execution",
    });
  });

  test("turn.failed always carries a message, even when the payload has none", () => {
    expect(parseCodexLine('{"type":"turn.failed"}')).toEqual({
      kind: "child_failed",
      message: "codex reported a failed turn without a message",
    });
  });

  test("a thread.started without an id still starts the child, just unresumably", () => {
    expect(parseCodexLine('{"type":"thread.started"}')).toEqual({ kind: "child_started" });
  });
});

describe("classifyCodexFailure — the error-word trap", () => {
  test("a SUCCESSFUL run whose answer contains the word `error` classifies as success", () => {
    // fixtures/external/codex-cli/error-word.stdout.jsonl: exit 0, terminal
    // turn.completed, agent_message "error: nothing is actually wrong".
    const outcome = outcomeOf("error-word.stdout.jsonl", { exitCode: 0 });
    expect(outcome.events).toContainEqual({ kind: "assistant_text", text: "error: nothing is actually wrong" });
    expect(classifyCodexFailure(outcome)).toBeNull();
  });

  test("the model's own prose is never evidence, even on stderr-heavy runs", () => {
    // codex narrates itself on stderr and prints the contents of files it reads.
    const outcome: ProcessOutcome = {
      ...outcomeOf("error-word.stdout.jsonl", { exitCode: 0 }),
      stderr: "error: unauthorized 401 appears in a file the agent read\nUsage: codex exec [OPTIONS]\n",
    };
    expect(classifyCodexFailure(outcome)).toBeNull();
  });

  test("the clean success and resume transcripts both classify as success", () => {
    expect(classifyCodexFailure(outcomeOf("success.stdout.jsonl", { exitCode: 0 }))).toBeNull();
    expect(classifyCodexFailure(outcomeOf("resume.stdout.jsonl", { exitCode: 0 }))).toBeNull();
  });
});

describe("classifyCodexFailure — the recorded no-credentials run", () => {
  const outcome = outcomeOf("not-logged-in.stdout.jsonl", { exitCode: 1 });

  test("the ten top-level error events fold to retry, and none of them is terminal", () => {
    const retries = outcome.events.filter((event) => event.kind === "retry");
    expect(retries).toHaveLength(10);
    for (const retry of retries) expect(isTerminalEvent(retry)).toBe(false);
  });

  test("exactly one terminal event closes the run, and it is the turn.failed", () => {
    const terminal = outcome.events.filter(isTerminalEvent);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.kind).toBe("child_failed");
  });

  test("the retries arrive before the terminal event, so a first-error parser would misreport it", () => {
    const kinds = outcome.events.map((event) => event.kind);
    expect(kinds.indexOf("retry")).toBeLessThan(kinds.indexOf("child_failed"));
    expect(kinds[0]).toBe("child_started");
  });

  test("classifies as an auth failure even though the 401s live inside JSON", () => {
    // The `^(error|usage:)` line filter sees nothing here — every stdout line
    // begins with `{`. The cause comes from the structured event messages.
    expect(classifyCodexFailure(outcome)).toBe(
      "codex-cli has no usable credentials (authentication rejected); run `codex login` and retry",
    );
  });
});

describe("classifyCodexFailure — argv rejected by this CLI version", () => {
  const outcome = outcomeOf(undefined, { exitCode: 2, stderr: fixture("bad-argv.stderr.txt") });

  test("names the version mismatch and quotes the CLI's own complaint", () => {
    const cause = classifyCodexFailure(outcome);
    expect(cause).toContain("does not match");
    expect(cause).toContain("unexpected argument '--no-interactive'");
  });

  test("the fixture really is a zero-event transcript, so events cannot be the source", () => {
    // The run died on the command line before the agent was asked anything.
    expect(outcome.events).toEqual([]);
  });
});

describe("classifyCodexFailure — quota (PROVISIONAL: synthetic fixture)", () => {
  // usage-limit.SYNTHETIC.jsonl is HAND-AUTHORED. A usage limit cannot be
  // provoked on demand, and the wording is second-hand from a reference
  // implementation. Replace the fixture, and this expectation, on first real hit.
  const outcome = outcomeOf("usage-limit.SYNTHETIC.jsonl", { exitCode: 1 });

  test("classifies as a limit and carries the retry-at time forward to the operator", () => {
    expect(classifyCodexFailure(outcome)).toBe(
      "codex-cli reported a usage or rate limit; try again at Aug 26th, 2026 5:49 PM.",
    );
  });

  test("a limit without a stated time still classifies, just without the time", () => {
    expect(
      classifyCodexFailure({
        exitCode: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
        prompt: PROMPT,
        events: [{ kind: "child_failed", message: "quota exceeded for this organisation" }],
      }),
    ).toBe("codex-cli reported a usage or rate limit");
  });
});

describe("classifyCodexFailure — process-level and structural causes", () => {
  test("a timeout is reported as a timeout even though the transcript also lacks an end", () => {
    const outcome = outcomeOf("success.stdout.jsonl", { exitCode: 0, timedOut: true });
    expect(classifyCodexFailure(outcome)).toBe("codex-cli run hit its wall-clock ceiling and was killed");
  });

  test("a transcript with no terminal event names exactly that", () => {
    const truncated: ProcessOutcome = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      prompt: PROMPT,
      events: [{ kind: "child_started", sessionRef: "t" }, { kind: "assistant_text", text: "half an answer" }],
    };
    expect(classifyCodexFailure(truncated)).toBe("transcript ended without a terminal event");
  });

  test("an empty transcript is terminal-event-free, not silently successful", () => {
    // No captured `empty output` fixture exists for either CLI (manifest `gaps`),
    // so the case is asserted against a synthesised zero-event stream.
    expect(classifyCodexFailure(outcomeOf(undefined, { exitCode: 0 }))).toBe(
      "transcript ended without a terminal event",
    );
  });

  test("a failed turn with no recognised pattern still reports its message", () => {
    expect(
      classifyCodexFailure({
        exitCode: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
        prompt: PROMPT,
        events: [{ kind: "child_failed", message: "stream closed unexpectedly" }],
      }),
    ).toBe("codex-cli reported a failed turn: stream closed unexpectedly");
  });

  test("a non-zero exit with a successful terminal event still fails, naming the code", () => {
    expect(
      classifyCodexFailure({
        ...outcomeOf("success.stdout.jsonl", { exitCode: 0 }),
        exitCode: 3,
      }),
    ).toBe("codex-cli exited with code 3 without reporting a cause");
  });

  test("the prompt is subtracted before the streams are read", () => {
    // A task ABOUT an error would otherwise classify every one of its runs as a
    // CLI usage failure, because codex echoes the prompt into its narration.
    const prompt = "Fix this build:\nerror: unexpected argument '--no-interactive' found\nUsage: codex exec";
    const cause = classifyCodexFailure({
      exitCode: 1,
      stdout: `${prompt}\n`,
      stderr: `${prompt}\n`,
      timedOut: false,
      prompt,
      events: [],
    });
    expect(cause).toBe("transcript ended without a terminal event");
  });
});

describe("codecCliCodec wiring", () => {
  test("declares the registry's agent id and delegates to the named exports", () => {
    expect(codexCliCodec.id).toBe("codex-cli");
    expect(codexCliCodec.buildArgv(BASE_INPUT)).toEqual(buildCodexArgv(BASE_INPUT));
    expect(codexCliCodec.parseLine('{"type":"turn.started"}')).toBeUndefined();
    expect(codexCliCodec.classifyFailure(outcomeOf("success.stdout.jsonl", { exitCode: 0 }))).toBeNull();
  });
});
