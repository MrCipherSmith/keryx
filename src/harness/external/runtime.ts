// The external child runtime (flow 176, T14).
// Package: docs/requirements/keryx-external-agent-runtime §7.1.
//
// This is the one module that puts the whole subsystem together: gate, validate,
// resolve, isolate, assemble, supervise, classify, clean up. Everything it
// composes is pure except the two injected ports (process spawn, git worktree),
// so a complete run is exercisable offline with no CLI and no real subprocess.
//
// What it deliberately does NOT do:
//
//   - It does not authorise. Admission, the budget ledger and the depth/child
//     caps belong to `spawnChild`, which runs BEFORE this and is unchanged.
//     There is no second spawn path, second ledger or second event stream —
//     that is the substance of the package's AC17.
//   - It does not decide policy. Whether an external child may be spawned at all
//     is the policy engine's ruling, taken by the caller.
//   - It does not fall back. Every failure returns a named status and stops
//     (decisions.md D-07). A runtime that silently substitutes another agent or
//     the parent's own model corrupts the parent's account of what happened, and
//     in keryx the parent owns completion.
//
// The worktree is removed on EVERY terminal path, including thrown errors. A
// leaked worktree is a leaked escape hatch: containment (D-08) rests on that
// directory being disposable, not on the tool roster being complete.
import type { WorktreePort } from "../child/worktree";
import { validateRuntimeBlock, type RuntimeBlock } from "./dispatch";
import { buildExternalChildEnv, canNestExternalChild } from "./env";
import { buildExternalPrompt } from "./prompt";
import { resolveAvailability, type DetectionOutcome } from "./registry";
import { superviseExternalRun, type ExternalRunHandle, type ExternalSpawnPort } from "./supervise";
import { getExternalCodec } from "./codec";
import type { ExternalEvent } from "./types";

/**
 * The completion vocabulary, restated locally.
 *
 * Deliberately NOT imported from `spawn-subagent-tool.ts`: that module pulls in
 * the whole interactive agent loop, and this runtime must stay importable by
 * anything that only wants to run an external child. The values are identical,
 * so the tool adapts one to the other with no mapping table.
 */
export type ExternalCompletionStatus =
  | "Completed"
  | "BudgetExhausted"
  | "Timeout"
  | "Denied"
  | "Error"
  | "NoProgress";

/** What one external child run produced. Structurally a `StructuredSubagentResult`. */
export interface ExternalChildOutcome {
  readonly status: ExternalCompletionStatus;
  readonly output: string;
  readonly isError: boolean;
  /** Best-effort partial output, present only when `status !== "Completed"`. */
  readonly partial?: string;
  /** The agent's own resume handle, once it announced one. Absent means no resume is possible. */
  readonly sessionRef?: string;
  /** The exact argv, so the modal can show it and the operator can reproduce the run by hand (§8.2). */
  readonly argv?: readonly string[];
  /**
   * The disposable worktree the run happened in.
   *
   * Reported because the operator surface shows it (§8.2 Meta) and because a
   * detach — continuing the session by hand — needs the directory the agent
   * actually saw, not the parent's cwd. It is already deleted by the time this
   * is read: the value is for the record, not for opening.
   */
  readonly worktreePath?: string;
  /** Lines the codec did not recognise — the version-drift signal (§6.2). */
  readonly skippedLines?: number;
  /** Reported cost, where the CLI reports one. Absent means missing, never zero. */
  readonly costUnits?: number;
}

/** One external child run. */
export interface RunExternalChildInput {
  /** The dispatch's `runtime` block. Validated here, fail-closed. */
  readonly runtime: RuntimeBlock;
  /** The dispatch's `allowed_actions`, checked for consistency with the sandbox. */
  readonly allowedActions: readonly string[];
  readonly taskTitle: string;
  readonly taskDescription: string;
  readonly acceptanceCriteria: readonly string[];
  /** The operator's uncommitted diff; a detached worktree checks out HEAD without it. */
  readonly workingDiff?: string;
  /** Stable id for this run's disposable worktree. */
  readonly worktreeId: string;
  /** Assigned by keryx where the CLI accepts one. codex ignores it and reports its own. */
  readonly sessionId?: string;
  readonly maxPromptBytes: number;
  readonly timeoutMs: number;
  /** The parent process environment, stripped before it reaches the child (§7.4). */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** This child's nesting depth, written to the marker keryx honours on entry. */
  readonly depth: number;
  /**
   * Launch a STEERABLE run, so operator messages can reach the child mid-flight.
   *
   * Honoured only when the resolved codec has a streaming shape — codex has no
   * mid-run input channel and its messages travel by resume regardless. Asking
   * for it there is not an error; it simply yields the one-shot shape.
   *
   * This is a SPAWN-TIME decision and cannot be revisited: the flag that accepts
   * a later message also forbids the positional prompt that starts a one-shot
   * run, so there is no conversion afterwards (§5.2).
   */
  readonly steerable?: boolean;
}

/** The impure seams and gates. */
export interface RunExternalChildDeps {
  readonly spawn: ExternalSpawnPort;
  readonly worktree: WorktreePort;
  /**
   * The opt-in capability gate plus the transport/CI hard disable, resolved by
   * the caller. Refusal is always a NAMED reason: a silent no-op would leave the
   * operator believing an external agent ran (security-policy §5).
   */
  readonly capability: () => { readonly enabled: boolean; readonly reason?: string };
  /** Version probe. Omitted means "not probed", which is a first-class state, never an assumption. */
  readonly detect?: (binary: string, argv: readonly string[]) => Promise<DetectionOutcome>;
  /** Ceiling on external nesting, checked against the inherited depth marker. */
  readonly maxExternalDepth: number;
  readonly onEvent?: (event: ExternalEvent) => void;
  readonly onSpawned?: (handle: ExternalRunHandle) => void;
  /** Recorded, not thrown: an out-of-range CLI version is a warning (registry `judgeVersion`). */
  readonly onWarning?: (warning: string) => void;
}

/**
 * Causes that mean "the run was refused before or by the vendor", not "the run
 * went wrong".
 *
 * A known weakness, stated rather than hidden: the codec port returns a free
 * STRING cause, so mapping it onto §7.7's status vocabulary means matching text.
 * The right fix is for `classifyFailure` to return `{code, message}`, which is a
 * port change and therefore a later task. Until then the markers below are
 * matched only when the run already failed, so a false positive costs a
 * mislabelled status and never a wrong verdict on a healthy run.
 */
const DENIED_CAUSE_MARKERS: readonly RegExp[] = [
  /credential/i,
  /authenticat/i,
  /\bauth\b/i,
  /not logged/i,
  /usage or rate limit/i,
  /usage limit/i,
  /rate limit/i,
  /quota/i,
];

/** A refusal that happened before any process existed. */
function refuse(status: ExternalCompletionStatus, output: string): ExternalChildOutcome {
  return { status, output, isError: true };
}

/**
 * Run one external child end to end.
 *
 * Order is fixed and each step is fail-closed, cheapest first so an impossible
 * run costs nothing: capability, nesting depth, contract validation, codec
 * resolution, detection, prompt assembly, worktree, spawn, classify, cleanup.
 *
 * The worktree is created LAST among the setup steps and removed in a `finally`,
 * so no path can leave one behind — including a `spawn` port that throws.
 */
export async function runExternalChild(
  input: RunExternalChildInput,
  deps: RunExternalChildDeps,
): Promise<ExternalChildOutcome> {
  const gate = deps.capability();
  if (!gate.enabled) {
    return refuse("Denied", gate.reason ?? "the external agent runtime capability is disabled");
  }

  const nesting = canNestExternalChild(input.parentEnv, deps.maxExternalDepth);
  if (!nesting.ok) return refuse("Denied", nesting.reason);

  const validated = validateRuntimeBlock(input.runtime, input.allowedActions);
  if (!validated.ok) return refuse("Denied", validated.reason);
  if (validated.runtime !== "external") {
    // The caller asked the external runtime to run a native dispatch. Refusing is
    // the only honest answer: silently running it in-process would report an
    // external agent's status for work keryx did itself.
    return refuse("Error", "runtime.kind is not \"external\"; this dispatch does not belong to the external runtime");
  }

  const { entry, sandbox } = validated;
  const codec = getExternalCodec(entry.id);
  if (codec === undefined) {
    return refuse("Error", `no codec is registered for external agent "${entry.id}"`);
  }

  if (deps.detect !== undefined) {
    const availability = resolveAvailability(entry, await deps.detect(entry.binary, entry.detect));
    if (availability.state === "binary-missing") {
      return refuse("Denied", `${entry.label} is not installed (\`${entry.binary}\` not on PATH)`);
    }
    if (availability.state === "available" && availability.verdict.state !== "in-range") {
      // Advisory by design: neither CLI publishes a stable event schema, so
      // hard-failing outside the recorded range would break the feature on the
      // vendor's next release. The parse-skip counter is the real drift signal.
      deps.onWarning?.(
        `${entry.label} version ${availability.version ?? "unknown"} is outside the range this build's fixtures were recorded against`,
      );
    }
  }

  const assembled = buildExternalPrompt({
    taskTitle: input.taskTitle,
    taskDescription: input.taskDescription,
    acceptanceCriteria: input.acceptanceCriteria,
    ...(input.workingDiff === undefined ? {} : { workingDiff: input.workingDiff }),
    maxPromptBytes: input.maxPromptBytes,
  });
  if (!assembled.ok) {
    // The prompt module refuses rather than cutting the directive or the task.
    // Spawning a child handed half a task is worse than not spawning one.
    return refuse("Error", assembled.reason);
  }
  if (assembled.truncated) {
    deps.onWarning?.(
      `working diff truncated: ${assembled.droppedBytes} bytes dropped to fit the ${input.maxPromptBytes}-byte prompt ceiling`,
    );
  }

  const created = await deps.worktree.create(input.worktreeId);
  try {
    const runInput = {
      prompt: assembled.prompt,
      cwd: created.path,
      sandbox,
      ...(input.runtime.model === undefined || input.runtime.model === null ? {} : { model: input.runtime.model }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.runtime.maxCostUnits === undefined || input.runtime.maxCostUnits === null
        ? {}
        : { maxCostUnits: input.runtime.maxCostUnits }),
    };

    // Steerable when the caller asked AND this agent has a streaming shape.
    // The two argv forms are mutually exclusive: a steerable run takes NO
    // positional prompt, because `claude -p` given both `--input-format
    // stream-json` and a positional prompt ignores the prompt and exits 0 with
    // zero output — a silent no-op wearing a success code. So the decision is
    // made HERE, once, before the process exists, and cannot be revisited: a
    // one-shot run can never be sent a later message (§5.2, §7.5).
    const streaming =
      input.steerable === true && codec.buildStreamingArgv !== undefined && codec.encodeStdinMessage !== undefined;
    const argv = streaming
      ? (codec.buildStreamingArgv as NonNullable<typeof codec.buildStreamingArgv>)(runInput)
      : codec.buildArgv(runInput);

    const outcome = await superviseExternalRun(
      {
        argv,
        cwd: created.path,
        env: buildExternalChildEnv({ parent: input.parentEnv, depth: input.depth }),
        prompt: assembled.prompt,
        timeoutMs: input.timeoutMs,
        // `"ignore"` otherwise, never inherited: a CLI that inherits an open
        // stdin announces it is reading from it and waits forever.
        stdin: streaming ? "pipe" : "ignore",
        ...(streaming
          ? {
              initialStdin: [
                (codec.encodeStdinMessage as NonNullable<typeof codec.encodeStdinMessage>)(assembled.prompt),
              ],
            }
          : {}),
      },
      {
        spawn: deps.spawn,
        codec,
        // Without this the skip counter conflates "never seen this line" with
        // "deliberately unmapped", and only the first is version drift. The
        // T19 smoke scored one phantom skip on every healthy run for want of
        // it — a drift signal that is noise at rest is not a signal.
        ...(codec.isRecognisedLine === undefined
          ? {}
          : { isRecognisedLine: codec.isRecognisedLine.bind(codec) }),
        ...(deps.onEvent === undefined ? {} : { onEvent: deps.onEvent }),
        ...(deps.onSpawned === undefined ? {} : { onSpawned: deps.onSpawned }),
      },
    );

    const cause = codec.classifyFailure(outcome);
    return buildOutcome({ cause, outcome, argv, worktreePath: created.path });
  } finally {
    // Unconditional. Containment rests on this directory being disposable, so a
    // leaked worktree is a leaked escape hatch — and the `remove` itself must not
    // mask the run's real result, hence the swallowed rejection.
    await deps.worktree.remove(input.worktreeId).catch(() => undefined);
  }
}

/** Fold a finished run into the status vocabulary of §7.7. */
function buildOutcome(args: {
  cause: string | null;
  outcome: Awaited<ReturnType<typeof superviseExternalRun>>;
  argv: readonly string[];
  worktreePath: string;
}): ExternalChildOutcome {
  const { cause, outcome, argv, worktreePath } = args;
  const sessionRef = findSessionRef(outcome.events);
  const costUnits = findCostUnits(outcome.events);
  const text = collectAssistantText(outcome.events);

  const base = {
    argv,
    worktreePath,
    skippedLines: outcome.skippedLines,
    ...(sessionRef === undefined ? {} : { sessionRef }),
    ...(costUnits === undefined ? {} : { costUnits }),
  };

  if (cause === null) {
    return { status: "Completed", output: text, isError: false, ...base };
  }

  // Structural first, text only where the port leaves no alternative. `timedOut`
  // is a fact supervision knows; the rest is inference over a free-text cause,
  // which is why the weakness is documented on DENIED_CAUSE_MARKERS.
  const status: ExternalCompletionStatus = outcome.timedOut
    ? "Timeout"
    : DENIED_CAUSE_MARKERS.some((marker) => marker.test(cause))
      ? "Denied"
      : "Error";

  return {
    status,
    output: cause,
    isError: true,
    ...base,
    ...(text.length > 0 ? { partial: text } : {}),
  };
}

/** The agent's resume handle, if it announced one. */
function findSessionRef(events: readonly ExternalEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind === "child_started" && event.sessionRef !== undefined) return event.sessionRef;
  }
  return undefined;
}

/** The last reported cost. Absent stays absent — a missing figure is never zero. */
function findCostUnits(events: readonly ExternalEvent[]): number | undefined {
  let cost: number | undefined;
  for (const event of events) {
    if (event.kind === "usage" && event.costUnits !== undefined) cost = event.costUnits;
  }
  return cost;
}

/**
 * Everything the agent said, in order.
 *
 * NOTE for the caller: this text is `derived` trust level and must pass
 * `quarantineChildSummary` and `keryx security check-output` before it reaches
 * the parent's context (agent-protocol.md §3). This function deliberately does
 * not quarantine it itself — doing so here would let a caller believe the value
 * is already safe wherever it is read.
 */
function collectAssistantText(events: readonly ExternalEvent[]): string {
  // A terminal event's text WINS OUTRIGHT rather than being appended.
  //
  // Measured in the live smoke (flow 176 T19): claude's `result.result` is the
  // same final answer its `assistant` blocks already carried, so appending both
  // returned "ok\nok" for a one-word reply — and would have duplicated an entire
  // report for a real one. codex has the opposite shape: its `turn.completed`
  // carries no text, so the assistant messages are all there is. Preferring the
  // terminal text when present, and falling back to the stream when it is not,
  // is correct for both without branching on the agent.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.kind === "child_finished" && event.text !== undefined && event.text.trim().length > 0) {
      return event.text.trim();
    }
  }
  const parts: string[] = [];
  for (const event of events) {
    if (event.kind === "assistant_text") parts.push(event.text);
  }
  return parts.join("\n").trim();
}
