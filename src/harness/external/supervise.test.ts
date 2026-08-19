// Tests for the external agent process supervisor (flow 176, T14).
//
// OFFLINE, AND STRUCTURALLY SO. Every run below goes through a FAKE
// `ExternalSpawnPort`; nothing here spawns `claude` or `codex`, because a test
// suite that did would spend the operator's paid subscription on every `bun
// test`. That is exactly why the process API is injected rather than imported.
//
// The fake is fed the REAL recorded transcripts from `fixtures/external/`, read
// off disk, so the stream pump is exercised against genuine vendor bytes — a
// hand-written stub would only prove the pump agrees with whatever the author
// imagined the CLI emits, which is the assumption `fixtures/external/manifest.json`
// exists to stop the repo making.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { claudeCliCodec, classifyClaudeFailure, isRecognisedClaudeLine } from "./codec/claude-cli";
import { codexCliCodec, classifyCodexFailure } from "./codec/codex-cli";
import { EXTERNAL_CODECS, externalCodecIds, getExternalCodec } from "./codec/index";
import { EXTERNAL_TIMEOUT_EXIT_CODE, superviseExternalRun, toLineStream } from "./supervise";
import type {
  ExternalRunHandle,
  ExternalSpawnOptions,
  ExternalSpawnPort,
  SuperviseDeps,
  SuperviseInput,
} from "./supervise";
import type { ExternalEvent } from "./types";

const FIXTURE_DIR = fileURLToPath(new URL("../../../fixtures/external/", import.meta.url));

/** The recorded transcript, split into the lines a real line-framed port would yield. */
function transcript(relative: string): string[] {
  return readFileSync(path.join(FIXTURE_DIR, relative), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

// ---------------------------------------------------------------------------
// The fake port
// ---------------------------------------------------------------------------

interface FakeOptions {
  readonly stdout?: readonly string[];
  readonly stderr?: readonly string[];
  readonly exitCode?: number;
  /** Stall stdout before emitting the line at this index, until `release()`. */
  readonly pauseBefore?: number;
  /**
   * Keep stdout open after the last line until `release()`, and DO NOT let
   * `kill()` close it. This is the wrapper-holds-the-pipes shape the raced
   * timeout exists for: the supervisor must finish anyway.
   */
  readonly holdStdout?: boolean;
  /** Never resolve `exited` until `release()`. */
  readonly holdExit?: boolean;
  /** Make the stdout iterator throw after its lines — a broken port mid-run. */
  readonly stdoutError?: string;
}

interface FakeHarness {
  readonly port: ExternalSpawnPort;
  readonly calls: Array<{ argv: readonly string[]; opts: ExternalSpawnOptions }>;
  readonly stdinWrites: string[];
  kills(): number;
  release(): void;
}

function fakePort(options: FakeOptions = {}): FakeHarness {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  const calls: Array<{ argv: readonly string[]; opts: ExternalSpawnOptions }> = [];
  const stdinWrites: string[] = [];
  let kills = 0;

  const stdoutLines = options.stdout ?? [];
  const stderrLines = options.stderr ?? [];

  async function* stdout(): AsyncGenerator<string, void, undefined> {
    for (let i = 0; i < stdoutLines.length; i += 1) {
      if (options.pauseBefore === i) await gate;
      const line = stdoutLines[i];
      if (line === undefined) continue;
      yield line;
    }
    if (options.stdoutError !== undefined) throw new Error(options.stdoutError);
    // Deliberately NOT closed by `kill()`. A well-behaved port would close here;
    // this one models the child that outlives the signal still holding the pipe.
    if (options.holdStdout === true) await gate;
  }

  async function* stderr(): AsyncGenerator<string, void, undefined> {
    for (const line of stderrLines) yield line;
  }

  const exited =
    options.holdExit === true
      ? gate.then(() => options.exitCode ?? 0)
      : Promise.resolve(options.exitCode ?? 0);

  const port: ExternalSpawnPort = {
    spawn(argv, opts) {
      calls.push({ argv, opts });
      return {
        stdout: stdout(),
        stderr: stderr(),
        writeStdin(text: string): void {
          stdinWrites.push(text);
        },
        kill(): void {
          kills += 1;
        },
        exited,
      };
    },
  };

  return { port, calls, stdinWrites, kills: () => kills, release: () => open() };
}

function input(overrides: Partial<SuperviseInput> = {}): SuperviseInput {
  return {
    argv: ["codex", "exec", "--json", "say ok"],
    cwd: "/tmp/worktree",
    env: { PATH: "/usr/bin" },
    prompt: "say ok",
    timeoutMs: 5_000,
    ...overrides,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function kinds(events: readonly ExternalEvent[]): string[] {
  return events.map((event) => event.kind);
}

// ---------------------------------------------------------------------------

describe("codec lookup fails closed", () => {
  test("both shipped agents resolve", () => {
    expect(getExternalCodec("codex-cli")).toBe(codexCliCodec);
    expect(getExternalCodec("claude-cli")).toBe(claudeCliCodec);
  });

  test("an unknown id yields undefined, never a default codec", () => {
    // Substituting some other agent's adapter would spawn the wrong binary with
    // the wrong flags and then misclassify its output.
    expect(getExternalCodec("opencode")).toBeUndefined();
    expect(getExternalCodec("")).toBeUndefined();
  });

  test("the list is enumerable and agrees with the codecs' own ids", () => {
    expect(externalCodecIds()).toEqual(["codex-cli", "claude-cli"]);
    expect(EXTERNAL_CODECS.map((codec) => codec.id)).toEqual(externalCodecIds());
  });
});

describe("a clean run", () => {
  test("codex: the recorded transcript yields the canonical events in order", async () => {
    const fake = fakePort({ stdout: transcript("codex-cli/success.stdout.jsonl"), exitCode: 0 });
    const outcome = await superviseExternalRun(input(), { spawn: fake.port, codec: codexCliCodec });

    expect(kinds(outcome.events)).toEqual(["child_started", "assistant_text", "child_finished"]);
    const started = outcome.events[0];
    // The resume handle codex GENERATES and keryx reads; a run that loses it
    // cannot be resumed at all, so it is pinned rather than assumed.
    expect(started?.kind === "child_started" && started.sessionRef).toBe(
      "01a01b40-ddbd-75e3-9204-ed00ca6e3a86",
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.killed).toBe(false);
    expect(fake.kills()).toBe(0);
    expect(classifyCodexFailure(outcome)).toBeNull();
  });

  test("codex: the whole transcript is kept verbatim on stdout", async () => {
    const lines = transcript("codex-cli/success.stdout.jsonl");
    const fake = fakePort({ stdout: lines });
    const outcome = await superviseExternalRun(input(), { spawn: fake.port, codec: codexCliCodec });
    expect(outcome.stdout).toBe(lines.join("\n"));
    expect(outcome.prompt).toBe("say ok");
  });

  test("claude: the recorded transcript yields the canonical events in order", async () => {
    const fake = fakePort({ stdout: transcript("claude-cli/success.stdout.jsonl"), exitCode: 0 });
    const outcome = await superviseExternalRun(input({ argv: ["claude", "-p"] }), {
      spawn: fake.port,
      codec: claudeCliCodec,
      isRecognisedLine: isRecognisedClaudeLine,
    });

    expect(kinds(outcome.events)).toEqual(["child_started", "assistant_text", "child_finished"]);
    expect(classifyClaudeFailure(outcome)).toBeNull();
  });

  test("the spawn seam receives the argv, cwd and env unchanged", async () => {
    const fake = fakePort({ stdout: transcript("codex-cli/success.stdout.jsonl") });
    const run = input({ argv: ["codex", "exec", "x"], cwd: "/w", env: { NO_COLOR: "1" } });
    await superviseExternalRun(run, { spawn: fake.port, codec: codexCliCodec });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.argv).toEqual(["codex", "exec", "x"]);
    expect(fake.calls[0]?.opts.cwd).toBe("/w");
    expect(fake.calls[0]?.opts.env).toEqual({ NO_COLOR: "1" });
  });
});

describe("stdin is never inherited (§7.4)", () => {
  test('the default mode is "ignore"', async () => {
    // A CLI that inherits an open stdin announces it is reading from stdin and
    // waits forever — observed in a real codex run. The default must be safe for
    // a caller who never thought about the field.
    const fake = fakePort({ stdout: transcript("codex-cli/success.stdout.jsonl") });
    await superviseExternalRun(input(), { spawn: fake.port, codec: codexCliCodec });
    expect(fake.calls[0]?.opts.stdin).toBe("ignore");
  });

  test("a one-shot run refuses stdin writes instead of throwing", async () => {
    const fake = fakePort({ stdout: transcript("codex-cli/success.stdout.jsonl") });
    let handle: ExternalRunHandle | undefined;
    await superviseExternalRun(input(), {
      spawn: fake.port,
      codec: codexCliCodec,
      onSpawned: (h) => {
        handle = h;
      },
    });
    // "This run has no stdin route" is a registry-predicted state (§7.5), not a
    // programming error: the message falls back to the resume path.
    expect(handle?.writeStdin("hello")).toBe(false);
    expect(fake.stdinWrites).toEqual([]);
  });

  test('"pipe" carries the initial stdin lines and later operator messages', async () => {
    const fake = fakePort({ stdout: transcript("claude-cli/streaming-input.stdout.jsonl") });
    let handle: ExternalRunHandle | undefined;
    const outcome = await superviseExternalRun(
      input({ argv: ["claude", "-p"], stdin: "pipe", initialStdin: ['{"type":"user"}\n'] }),
      {
        spawn: fake.port,
        codec: claudeCliCodec,
        isRecognisedLine: isRecognisedClaudeLine,
        onSpawned: (h) => {
          handle = h;
        },
      },
    );

    expect(fake.calls[0]?.opts.stdin).toBe("pipe");
    expect(handle?.writeStdin("second")).toBe(true);
    expect(fake.stdinWrites).toEqual(['{"type":"user"}\n', "second"]);
    expect(kinds(outcome.events)).toContain("child_finished");
  });
});

describe("timeout and kill are RACED, not chained", () => {
  test("a child holding the pipes past the ceiling still returns, and does not hang", async () => {
    // The failure this pins: `kill()` reaches only a wrapper while the real CLI
    // outlives it holding the pipes, so awaiting the stream reads after the kill
    // blocks past the very ceiling the kill was enforcing. Here `kill()` does
    // nothing at all and `exited` never resolves.
    const lines = transcript("codex-cli/success.stdout.jsonl").slice(0, 2);
    const fake = fakePort({ stdout: lines, holdStdout: true, holdExit: true });

    const started = Date.now();
    const outcome = await superviseExternalRun(input({ timeoutMs: 25, killGraceMs: 10 }), {
      spawn: fake.port,
      codec: codexCliCodec,
    });
    const elapsed = Date.now() - started;

    expect(outcome.timedOut).toBe(true);
    expect(outcome.killed).toBe(true);
    expect(fake.kills()).toBe(1);
    expect(outcome.exitCode).toBe(EXTERNAL_TIMEOUT_EXIT_CODE);
    // The whole point: bounded by the ceiling plus the grace, not by the child.
    expect(elapsed).toBeLessThan(2_000);

    fake.release();
  });

  test("partial output and partial events survive the timeout", async () => {
    // A timeout that discards the transcript destroys the only evidence of what
    // went wrong — which is the run an operator most needs to read.
    const lines = transcript("codex-cli/not-logged-in.stdout.jsonl").slice(0, 4);
    const fake = fakePort({ stdout: lines, holdStdout: true, holdExit: true });

    const outcome = await superviseExternalRun(input({ timeoutMs: 25, killGraceMs: 10 }), {
      spawn: fake.port,
      codec: codexCliCodec,
    });

    expect(outcome.stdout).toBe(lines.join("\n"));
    expect(kinds(outcome.events)).toEqual(["child_started", "retry", "retry"]);
    expect(classifyCodexFailure(outcome)).toContain("wall-clock ceiling");

    fake.release();
  });

  test("a terminal event with hung pipes ends the run WITHOUT calling it a timeout", async () => {
    // Same wrapper problem, benign cause: the transcript ended on its own terms,
    // so `timedOut` must stay false or every successful run of a CLI with a
    // lingering wrapper would be reported as a timeout.
    const fake = fakePort({
      stdout: transcript("codex-cli/success.stdout.jsonl"),
      holdStdout: true,
      holdExit: true,
    });

    const outcome = await superviseExternalRun(
      input({ timeoutMs: 5_000, terminalSettleMs: 15, killGraceMs: 10 }),
      { spawn: fake.port, codec: codexCliCodec },
    );

    expect(outcome.timedOut).toBe(false);
    expect(outcome.killed).toBe(true);
    // Derived from the terminal event, not from a sentinel: codex's classifier
    // short-circuits to success only on exit 0 plus `child_finished`.
    expect(outcome.exitCode).toBe(0);
    expect(classifyCodexFailure(outcome)).toBeNull();

    fake.release();
  });
});

describe("a failed process is an outcome, never a throw (§7.7)", () => {
  test("codex: a non-zero exit with no credentials returns and classifies", async () => {
    const fake = fakePort({ stdout: transcript("codex-cli/not-logged-in.stdout.jsonl"), exitCode: 1 });
    const outcome = await superviseExternalRun(input(), { spawn: fake.port, codec: codexCliCodec });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.timedOut).toBe(false);
    expect(kinds(outcome.events).filter((kind) => kind === "retry")).toHaveLength(10);
    expect(outcome.events.at(-1)?.kind).toBe("child_failed");
    expect(classifyCodexFailure(outcome)).toContain("credentials");
  });

  test("claude: exit 0 with a failing result still returns an outcome", async () => {
    // The nastiest shape: exit code 0, a full and normal-looking `system/init`,
    // then eight retries and `result.subtype = error_during_execution`. Nothing
    // at the process level says failure, so the supervisor must not either — it
    // reports, and the codec judges.
    const fake = fakePort({ stdout: transcript("claude-cli/not-logged-in.stdout.jsonl"), exitCode: 0 });
    const outcome = await superviseExternalRun(input({ argv: ["claude", "-p"] }), {
      spawn: fake.port,
      codec: claudeCliCodec,
      isRecognisedLine: isRecognisedClaudeLine,
    });

    expect(outcome.exitCode).toBe(0);
    expect(kinds(outcome.events).filter((kind) => kind === "retry")).toHaveLength(8);
    expect(classifyClaudeFailure(outcome)).toContain("claude");
  });

  test("an empty transcript is reported as itself, not as a crash", async () => {
    // `empty-output.stdout.jsonl` is zero bytes with exit 0 — the silent no-op.
    // The only signal is the absence of any terminal event.
    const fake = fakePort({ stdout: transcript("claude-cli/empty-output.stdout.jsonl"), exitCode: 0 });
    const outcome = await superviseExternalRun(input({ argv: ["claude", "-p"] }), {
      spawn: fake.port,
      codec: claudeCliCodec,
    });

    expect(outcome.events).toEqual([]);
    expect(outcome.stdout).toBe("");
    expect(classifyClaudeFailure(outcome)).toContain("transcript ended without a terminal event");
  });

  test("a broken stream is recorded on stderr, not thrown, so the transcript survives", async () => {
    const lines = transcript("codex-cli/success.stdout.jsonl").slice(0, 2);
    const fake = fakePort({ stdout: lines, stdoutError: "pipe exploded", exitCode: 3 });
    const outcome = await superviseExternalRun(input(), { spawn: fake.port, codec: codexCliCodec });

    expect(outcome.stdout).toBe(lines.join("\n"));
    expect(outcome.stderr).toContain("pipe exploded");
    expect(outcome.exitCode).toBe(3);
  });

  test("a port that cannot create a process at all DOES throw", async () => {
    // The one reserved case: this is not a failed run, it is a broken port, and
    // silently returning "exit 1" would hide a wiring bug behind a vendor error.
    const port: ExternalSpawnPort = {
      spawn() {
        throw new Error("spawn unavailable");
      },
    };
    await expect(superviseExternalRun(input(), { spawn: port, codec: codexCliCodec })).rejects.toThrow(
      "spawn unavailable",
    );
  });
});

describe("unparseable lines are counted, not fatal (§6.2)", () => {
  test("junk between real events is skipped and the run continues", async () => {
    const lines = transcript("codex-cli/success.stdout.jsonl");
    const polluted = [lines[0] ?? "", "not json at all", '{"type":', ...lines.slice(1)];
    const skipped: string[] = [];

    const fake = fakePort({ stdout: polluted, exitCode: 0 });
    const outcome = await superviseExternalRun(input(), {
      spawn: fake.port,
      codec: codexCliCodec,
      onSkippedLine: (line) => skipped.push(line),
    });

    // Two injected junk lines plus codex's own unmapped `turn.started`.
    expect(outcome.skippedLines).toBe(3);
    expect(skipped).toContain("not json at all");
    expect(kinds(outcome.events)).toEqual(["child_started", "assistant_text", "child_finished"]);
    expect(classifyCodexFailure(outcome)).toBeNull();
  });

  test("without a recogniser the count is an upper bound — codex scores its unmapped lines", async () => {
    // `turn.started` and the mid-transcript `item.completed(error)` both map to
    // nothing on purpose. The counter cannot tell that apart from drift, which is
    // exactly why `isRecognisedLine` exists.
    const fake = fakePort({ stdout: transcript("codex-cli/not-logged-in.stdout.jsonl"), exitCode: 1 });
    const outcome = await superviseExternalRun(input(), { spawn: fake.port, codec: codexCliCodec });
    expect(outcome.skippedLines).toBe(2);
  });

  test("with the codec's own recogniser a healthy claude run scores zero skips", async () => {
    // `rate_limit_event` appears on SUCCESSFUL runs; counting it would poison the
    // version-drift signal on runs that are fine.
    const fake = fakePort({ stdout: transcript("claude-cli/success.stdout.jsonl"), exitCode: 0 });
    const outcome = await superviseExternalRun(input({ argv: ["claude", "-p"] }), {
      spawn: fake.port,
      codec: claudeCliCodec,
      isRecognisedLine: isRecognisedClaudeLine,
    });
    expect(outcome.skippedLines).toBe(0);
  });

  test("blank lines are not skips", async () => {
    const lines = transcript("codex-cli/success.stdout.jsonl");
    const fake = fakePort({ stdout: [lines[0] ?? "", "", "   ", ...lines.slice(1)] });
    const outcome = await superviseExternalRun(input(), {
      spawn: fake.port,
      codec: codexCliCodec,
      isRecognisedLine: (line) => line.includes("turn.started"),
    });
    expect(outcome.skippedLines).toBe(0);
  });
});

describe("onEvent fires incrementally", () => {
  test("a consumer sees an event before the run has finished", async () => {
    // A consumer that only saw events at the end could not drive the TUI, the
    // §7.6 supervision triggers, or the no-progress interval.
    const lines = transcript("codex-cli/success.stdout.jsonl");
    const fake = fakePort({ stdout: lines, pauseBefore: 1, exitCode: 0 });

    const seen: ExternalEvent[] = [];
    const deps: SuperviseDeps = {
      spawn: fake.port,
      codec: codexCliCodec,
      onEvent: (event) => seen.push(event),
    };

    let settled = false;
    const run = superviseExternalRun(input(), deps).then((outcome) => {
      settled = true;
      return outcome;
    });

    await tick();
    await tick();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("child_started");
    expect(settled).toBe(false);

    fake.release();
    const outcome = await run;

    expect(seen).toHaveLength(3);
    expect(kinds(seen)).toEqual(kinds(outcome.events));
  });
});

describe("toLineStream", () => {
  test("reassembles a line split across chunk boundaries", async () => {
    // `claude`'s multi-KB `system/init` spans chunks by construction, so this is
    // exercised on the very first line of every claude run.
    async function* chunks(): AsyncGenerator<string, void, undefined> {
      yield '{"type":"sys';
      yield 'tem","subtype":"init"}\n{"type":"res';
      yield 'ult"}\n';
    }
    const out: string[] = [];
    for await (const line of toLineStream(chunks())) out.push(line);
    expect(out).toEqual(['{"type":"system","subtype":"init"}', '{"type":"result"}']);
  });

  test("emits a final unterminated line and strips CRLF", async () => {
    async function* chunks(): AsyncGenerator<Uint8Array, void, undefined> {
      yield new TextEncoder().encode("alpha\r\nbeta");
    }
    const out: string[] = [];
    for await (const line of toLineStream(chunks())) out.push(line);
    expect(out).toEqual(["alpha", "beta"]);
  });
});
