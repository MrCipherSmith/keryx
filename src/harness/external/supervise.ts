// Process supervision for external agent runs — THE ONE IMPURE SEAM of this
// subsystem (flow 176, T14). Package: docs/requirements/keryx-external-agent-runtime
// §5, §6.2, §7.1, §7.4, §7.7.
//
// Everything else under `src/harness/external/` is pure: the registry parses
// injected version text, `env.ts` takes the parent environment as a parameter,
// and every codec is three total functions over strings. That is what lets the
// whole adapter layer be tested offline against `fixtures/external/` on a
// machine with neither CLI installed. This file is where a process is actually
// created, so the process API itself is INJECTED behind {@link ExternalSpawnPort}
// and the supervisor stays testable with no real subprocess — which matters
// more here than anywhere else in the repo, because the alternative is a test
// suite that spends the operator's paid vendor subscription every run.
//
// Five rules below each exist because of a measured failure, and every one of
// them reads as removable to someone who has not seen it:
//
//   1. STDIN IS NEVER INHERITED (§7.4). {@link ExternalStdinMode} has no
//      "inherit" member, so the failure is unrepresentable rather than merely
//      discouraged.
//   2. TIMEOUT AND KILL ARE RACED, NEVER CHAINED. `kill()` may reach only a
//      wrapper process while the real CLI outlives it holding the pipes, so
//      awaiting the stream reads after a kill can block past the very ceiling
//      the kill was enforcing.
//   3. PARTIAL OUTPUT IS KEPT. A killed or failed run still returns whatever
//      stdout, stderr and events were collected.
//   4. A LINE THAT DOES NOT PARSE IS COUNTED, NOT FATAL. §6.2 treats a high skip
//      rate as a version-drift signal, which only works if a skip is survivable.
//   5. A NON-ZERO EXIT IS NEVER THROWN. A failed process is a `ProcessOutcome`
//      and `classifyFailure` names the cause (§7.7). Throwing is reserved for a
//      genuinely broken port.
import type { ExternalAgentCodec, ExternalEvent, ProcessOutcome } from "./types";
import { isTerminalEvent } from "./types";

// ---------------------------------------------------------------------------
// The injected seam
// ---------------------------------------------------------------------------

/**
 * How the child's stdin is wired.
 *
 * THERE IS NO `"inherit"` AND THERE MUST NEVER BE ONE (§7.4). A CLI that
 * inherits an open stdin announces that it is reading from stdin and then waits
 * forever — observed in a real `codex` run, where the process produced its
 * banner, no transcript, and never exited. The run looks alive to every
 * process-level signal, so it burns the entire wall-clock ceiling before
 * anything notices. Making the mode a two-member union means a future caller
 * cannot reintroduce it by passing a string.
 */
export type ExternalStdinMode = "ignore" | "pipe";

/** Everything the spawn seam needs to launch one child. */
export interface ExternalSpawnOptions {
  /** Absolute path the child runs in — the disposable worktree (§7.2). */
  readonly cwd: string;
  /** The child environment, already built by `buildExternalChildEnv` (§7.4). */
  readonly env: Record<string, string>;
  /** `"pipe"` for a steerable run, `"ignore"` otherwise. Never inherited. */
  readonly stdin: ExternalStdinMode;
}

/**
 * A running child, as the supervisor needs to see it.
 *
 * `stdout`/`stderr` yield COMPLETE LINES, not byte chunks. Line framing belongs
 * to the adapter that owns the real streams (see {@link toLineStream}) so the
 * supervisor never has to hold a partial-line buffer, and so a fake port in a
 * test can simply yield the recorded transcript's lines.
 */
export interface SpawnedProcess {
  /** The child's stdout, one line per iteration, newline stripped. */
  readonly stdout: AsyncIterable<string>;
  /** The child's stderr, one line per iteration, newline stripped. */
  readonly stderr: AsyncIterable<string>;
  /**
   * Write one already-encoded line to the child's stdin. Only meaningful when
   * the run was spawned with `stdin: "pipe"`; a port may make it a no-op
   * otherwise, since {@link ExternalRunHandle} refuses the call before it
   * reaches here.
   */
  writeStdin(text: string): void;
  /** Request termination. May reach only a wrapper — see the race below. */
  kill(): void;
  /** Resolves with the exit code. May never resolve; nothing awaits it unraced. */
  readonly exited: Promise<number>;
}

/**
 * The injected process API. The only thing in this subsystem that a test cannot
 * substitute with a pure value, and therefore the only thing worth injecting.
 *
 * `spawn` is allowed to THROW: a port that cannot create a process at all is
 * genuinely broken, and that is the one case rule 5 above reserves throwing
 * for. It must not throw for a child that starts and then fails.
 */
export interface ExternalSpawnPort {
  spawn(argv: readonly string[], opts: ExternalSpawnOptions): SpawnedProcess;
}

/**
 * A live handle on a supervised run, handed to `deps.onSpawned`.
 *
 * This is how §7.5 operator messages reach a steerable child and how §7.6
 * supervision triggers kill one: both happen WHILE `superviseExternalRun` is
 * still awaiting, so neither can be expressed through its return value.
 */
export interface ExternalRunHandle {
  /**
   * Whether this run was launched with a stdin pipe, i.e. whether it can take an
   * operator message mid-flight at all.
   *
   * Stated rather than probed, because the only way to probe is to attempt a
   * write, and an attempted write is not free. A consumer that guesses instead
   * gets the whole feature wrong in one direction or the other: assume `true`
   * and messages vanish into a closed pipe; assume `false` and every message
   * takes the resume path even where stdin was available — which is exactly the
   * bug this field was added to kill.
   */
  readonly streaming: boolean;
  /**
   * Deliver one encoded stdin line. Returns `false` — rather than throwing —
   * when the run was launched one-shot, because "this run has no stdin route"
   * is a normal, registry-predicted state (§7.5: a `streamingInput: true` agent
   * launched one-shot falls back to resume) and not a programming error.
   */
  writeStdin(text: string): boolean;
  /** Terminate the child. Idempotent from the supervisor's side. */
  kill(): void;
}

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

/** One supervised run. Everything impure it needs arrives through {@link SuperviseDeps}. */
export interface SuperviseInput {
  /** The complete argv from `codec.buildArgv`, prompt included. */
  readonly argv: readonly string[];
  /** Absolute path the child runs in. */
  readonly cwd: string;
  /** The stripped child environment (§7.4). */
  readonly env: Record<string, string>;
  /**
   * The assembled prompt, carried onto the outcome unchanged. Classifiers
   * subtract it from the streams before pattern-matching, because `codex exec`
   * echoes it back and a prompt containing the word "error" would otherwise
   * fail every run of that task.
   */
  readonly prompt: string;
  /** Wall-clock ceiling in milliseconds. Raced, never chained — see below. */
  readonly timeoutMs: number;
  /** Defaults to `"ignore"`. Never inherited (§7.4). */
  readonly stdin?: ExternalStdinMode;
  /**
   * Lines written to stdin immediately after spawn. For a steerable `claude`
   * run this carries the prompt itself as an `encodeClaudeStdinMessage` line,
   * since that shape has no positional prompt (§5.2). Ignored when `stdin` is
   * not `"pipe"`.
   */
  readonly initialStdin?: readonly string[];
  /** Grace given to the exit signal AFTER a kill. Defaults to {@link DEFAULT_KILL_GRACE_MS}. */
  readonly killGraceMs?: number;
  /** Grace given to the streams after a terminal event. Defaults to {@link DEFAULT_TERMINAL_SETTLE_MS}. */
  readonly terminalSettleMs?: number;
}

/** Callbacks and ports {@link superviseExternalRun} needs. */
export interface SuperviseDeps {
  /** The process seam. The only mandatory impure dependency. */
  readonly spawn: ExternalSpawnPort;
  /** The agent's adapter; only `parseLine` is used here. */
  readonly codec: ExternalAgentCodec;
  /**
   * Called for each canonical event AS IT ARRIVES, before the run ends.
   *
   * A consumer that only saw events at the end could not drive the TUI session
   * store, the §7.6 supervision triggers, or the no-progress interval — all
   * three are defined over a live stream, and all three are useless on a
   * transcript delivered after the run they were meant to interrupt.
   *
   * Throwing from here is the caller's own bug and is deliberately NOT caught:
   * swallowing it would hide a broken consumer behind a healthy-looking run.
   */
  readonly onEvent?: (event: ExternalEvent) => void;
  /** Called for each counted parse-skip, with the offending line. */
  readonly onSkippedLine?: (line: string) => void;
  /**
   * Optional "this codec RECOGNISES the line even though it maps to no event"
   * test, used to keep the skip counter a real version-drift signal.
   *
   * Without it the counter is an UPPER BOUND: `parseLine` returns `undefined`
   * both for a line the codec has never seen and for one it deliberately does
   * not map, and those are different facts. A healthy `codex` run scores one
   * skip for its unmapped `turn.started`; a healthy `claude` run would score one
   * for `rate_limit_event`, which appears on SUCCESSFUL runs — pass
   * `isRecognisedClaudeLine` and it scores zero. The hook lives here rather than
   * on the codec port because only one of the two shipped codecs can answer the
   * question today.
   */
  readonly isRecognisedLine?: (line: string) => boolean;
  /** Receives the live handle once the child exists. See {@link ExternalRunHandle}. */
  readonly onSpawned?: (handle: ExternalRunHandle) => void;
}

/**
 * What a supervised run produces. A `ProcessOutcome` — so it goes straight into
 * `codec.classifyFailure` — plus the two facts supervision knows and a pure
 * classifier cannot.
 */
export interface SupervisedOutcome extends ProcessOutcome {
  /**
   * Lines that yielded no canonical event and were not recognised. §6.2 makes a
   * high skip rate the version-drift signal, which is only usable if it is
   * reported rather than thrown.
   */
  readonly skippedLines: number;
  /** The supervisor terminated the child, for either the timeout or the settle reason. */
  readonly killed: boolean;
}

/**
 * Exit code reported when a timed-out child never delivers one.
 *
 * `timeout(1)`'s convention, chosen so the number is recognisable rather than
 * invented. `timedOut` is the field classifiers key on; this is for the operator
 * reading a transcript.
 */
export const EXTERNAL_TIMEOUT_EXIT_CODE = 124;

/** How long the exit signal is given after a kill before its code is presumed lost. */
export const DEFAULT_KILL_GRACE_MS = 2_000;

/** How long the streams are given to close after a terminal event before the child is killed. */
export const DEFAULT_TERMINAL_SETTLE_MS = 2_000;

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------

/**
 * Spawn one external agent CLI, pump its stdout through the codec, and return
 * what happened. Never throws for a failed run (rule 5).
 *
 * The lifecycle is §7.1 steps 6–8. Three outcomes end the wait, and they are
 * RACED against each other rather than checked in sequence:
 *
 *   - `drained` — both streams closed AND the process exited. The clean path.
 *   - `timeout` — the wall-clock ceiling elapsed first. THIS IS THE RULE THAT
 *     LOOKS REDUNDANT AND IS NOT. The obvious implementation is "wait for the
 *     timer, kill, then await the streams", and it is wrong: `kill()` may reach
 *     only a wrapper process while the real CLI outlives it holding the pipes
 *     open, so the await after the kill blocks past the very ceiling the kill
 *     was enforcing — a "timeout" that never times out. So the reads are raced
 *     against an independent deadline and LOSING THAT RACE IS TREATED AS AN
 *     ANSWER: the outcome is built from what was collected, `timedOut: true`,
 *     and nothing further is awaited unraced.
 *   - `terminal` — a `child_finished`/`child_failed` event arrived and the
 *     streams did not close within `terminalSettleMs`. Same wrapper problem,
 *     benign cause: the run genuinely ended, so this is NOT a timeout.
 *
 * Whatever ends the wait, the transcript collected so far is kept (rule 3). A
 * timeout that discards the transcript destroys the only evidence of what went
 * wrong, which is precisely the run an operator most needs to read.
 */
export async function superviseExternalRun(
  input: SuperviseInput,
  deps: SuperviseDeps,
): Promise<SupervisedOutcome> {
  // Never inherited, and defaulted here rather than at the port so a caller that
  // simply forgets the field still gets the safe wiring (§7.4).
  const stdinMode: ExternalStdinMode = input.stdin ?? "ignore";

  // Allowed to throw: a port that cannot create a process is broken, and that is
  // the one case rule 5 reserves throwing for.
  const child = deps.spawn.spawn(input.argv, { cwd: input.cwd, env: input.env, stdin: stdinMode });

  // Declared BEFORE anything is awaited, so every exit path — including the one
  // that abandons the pumps mid-stream — can still build an outcome from them.
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const events: ExternalEvent[] = [];
  let skippedLines = 0;
  let killed = false;

  const handle: ExternalRunHandle = {
    streaming: stdinMode === "pipe",
    writeStdin(text: string): boolean {
      if (stdinMode !== "pipe") return false;
      child.writeStdin(text);
      return true;
    },
    kill(): void {
      killed = true;
      child.kill();
    },
  };
  deps.onSpawned?.(handle);
  for (const line of input.initialStdin ?? []) handle.writeStdin(line);

  const terminalSeen = deferred<Verdict>();
  let cancelSettle: (() => void) | undefined;

  const consumeStdout = async (): Promise<void> => {
    for await (const line of child.stdout) {
      stdoutLines.push(line);
      if (line.trim().length === 0) continue;

      const event = deps.codec.parseLine(line);
      if (event === undefined) {
        // Counted, not fatal (rule 4). A vendor that adds a stream type in a
        // patch release must degrade to a drift signal, not to a dead run.
        if (deps.isRecognisedLine?.(line) === true) continue;
        skippedLines += 1;
        deps.onSkippedLine?.(line);
        continue;
      }

      events.push(event);
      // Incremental, deliberately: the TUI and the supervision triggers are
      // defined over a live stream (§7.6).
      deps.onEvent?.(event);

      if (cancelSettle === undefined && isTerminalEvent(event)) {
        const settle = afterMs<Verdict>(input.terminalSettleMs ?? DEFAULT_TERMINAL_SETTLE_MS, "terminal");
        cancelSettle = settle.cancel;
        void settle.promise.then(terminalSeen.resolve);
      }
    }
  };

  const consumeStderr = async (): Promise<void> => {
    for await (const line of child.stderr) stderrLines.push(line);
  };

  // Stream-read failures are RECORDED, not thrown. A port whose iterator blows
  // up mid-run is broken, but by then a partial transcript exists and rule 3
  // outranks the diagnostic: the note lands on stderr where the classifier and
  // the operator both already look.
  const guard = async (pump: () => Promise<void>, stream: string): Promise<void> => {
    try {
      await pump();
    } catch (error) {
      stderrLines.push(`[keryx] ${stream} stream read failed: ${describeError(error)}`);
    }
  };

  let reportedExitCode: number | undefined;
  const exited: Promise<number | undefined> = child.exited.then(
    (code) => {
      reportedExitCode = code;
      return code;
    },
    (error) => {
      stderrLines.push(`[keryx] exit signal failed: ${describeError(error)}`);
      return undefined;
    },
  );

  const pumps = Promise.all([guard(consumeStdout, "stdout"), guard(consumeStderr, "stderr")]);
  const drained = Promise.all([pumps, exited]).then<Verdict>(() => "drained");
  const wall = afterMs<Verdict>(input.timeoutMs, "timeout");

  let verdict: Verdict;
  try {
    verdict = await Promise.race([drained, wall.promise, terminalSeen.promise]);
  } finally {
    // Both timers are cleared on every path, including the clean one, so a fast
    // run does not hold the event loop open for its full ceiling.
    wall.cancel();
    cancelSettle?.();
  }

  const build = (exitCode: number, timedOut: boolean): SupervisedOutcome => ({
    exitCode,
    stdout: stdoutLines.join("\n"),
    stderr: stderrLines.join("\n"),
    timedOut,
    prompt: input.prompt,
    // Snapshotted: an abandoned pump may still be appending to `events` after
    // this returns, and an outcome that mutates under its classifier is worse
    // than one that is a few lines short.
    events: [...events],
    skippedLines,
    killed,
  });

  if (verdict === "drained") {
    return build(reportedExitCode ?? exitCodeFromEvents(events), false);
  }

  // Timed out, or terminated with the streams still open. Kill, then RACE the
  // exit signal against its own grace window — awaiting it unraced is the same
  // trap this whole function exists to avoid.
  handle.kill();
  const grace = afterMs<undefined>(input.killGraceMs ?? DEFAULT_KILL_GRACE_MS, undefined);
  const code = await Promise.race([exited, grace.promise]);
  grace.cancel();

  if (verdict === "timeout") {
    return build(code ?? EXTERNAL_TIMEOUT_EXIT_CODE, true);
  }

  // `terminal`: the transcript ended on its own terms and only the pipes hung,
  // so this is not a timeout and `timedOut` stays false — `classifyClaudeFailure`
  // and `classifyCodexFailure` both branch on that field first.
  return build(code ?? exitCodeFromEvents(events), false);
}

// ---------------------------------------------------------------------------
// Line framing helper for real adapters
// ---------------------------------------------------------------------------

/**
 * Turn a byte or string chunk stream into the line stream {@link SpawnedProcess}
 * promises. Decodes incrementally, strips a trailing `\r`, and emits a final
 * partial line if the stream ends without a newline.
 *
 * It lives here, next to the contract it satisfies, because otherwise every real
 * adapter reimplements it — and a chunk boundary that lands mid-line is the
 * classic way a JSONL parser starts reporting parse-skips on a healthy run.
 * `claude`'s `system/init` line is multiple KB and therefore SPANS chunks by
 * construction, so this is exercised on the very first line of every claude run.
 */
export async function* toLineStream(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield stripCarriageReturn(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield stripCarriageReturn(buffer);
}

// ---------------------------------------------------------------------------
// Internals. Not exported: each is a detail of the function above, and widening
// the surface widens what a future change has to keep true.
// ---------------------------------------------------------------------------

/** What ended the wait. */
type Verdict = "drained" | "timeout" | "terminal";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A cancellable timer. Cancelling matters: an uncancelled one keeps the loop alive. */
function afterMs<T>(ms: number, value: T): { readonly promise: Promise<T>; readonly cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((resolve) => {
    handle = setTimeout(() => resolve(value), Math.max(0, ms));
  });
  return {
    promise,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

/**
 * The exit code to report when the process never delivered one.
 *
 * Derived from the transcript rather than defaulted to a sentinel, because the
 * codecs read the exit code as corroboration: `classifyCodexFailure`
 * short-circuits to success only on `exitCode === 0` plus a terminal
 * `child_finished`, so reporting a sentinel for a run that demonstrably finished
 * would turn a successful run into "exited with code N without reporting a
 * cause". A transcript that terminated is stronger evidence about the run than a
 * pipe we could not drain. `1` for a failed terminal and for no terminal at all,
 * which is what a caller would infer anyway.
 */
function exitCodeFromEvents(events: readonly ExternalEvent[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.kind === "child_finished") return 0;
    if (event.kind === "child_failed") return 1;
  }
  return 1;
}

/** One readable line for an unknown thrown value. Never throws itself. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return "unknown error";
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
