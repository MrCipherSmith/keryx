// External agent runtime — port and canonical types (flow 176, T6).
// Package: docs/requirements/keryx-external-agent-runtime.
//
// An "external agent" is a vendor coding CLI (`codex exec`, `claude -p`) hosted
// as a child of this harness. It is NOT a `ProviderPort`: these are whole agents
// with their own tool loops, so they plug in as a child RUNTIME, not as a model
// endpoint (package decisions.md D-02).
//
// Everything in this file is types plus one pure helper. The codec port below is
// deliberately three pure functions — argv, parse, classify — so an entire
// adapter is testable offline against recorded transcripts on a machine with
// neither CLI installed (fixtures/external/, package AC4-AC6). The only impure
// seam in the whole subsystem is the process spawn, and it lives elsewhere.
//
// The vendor event vocabularies are folded onto ONE canonical `ExternalEvent`
// set so `reduceAgents`/`reduceState` consume external children unchanged.

/** Permission level a dispatch may request for an external child. */
export type ExternalSandbox = "read-only" | "worktree-write";

/**
 * One external agent CLI, described as data. Metadata only: argv construction,
 * parsing and failure classification differ STRUCTURALLY between agents (see the
 * codec port below), so they are code, not table rows (decisions.md D-06).
 */
export interface ExternalAgentEntry {
  readonly id: string;
  readonly label: string;
  /** Executable resolved on PATH. Its presence says nothing about being logged in. */
  readonly binary: string;
  /** Argv proving the binary exists and reporting a version. Must not spend quota. */
  readonly detect: readonly string[];
  /** Regex source with ONE capture group extracting a version from `detect` output. */
  readonly versionPattern: string;
  /** Versions this agent's fixtures were recorded against. Outside it: warn, never block. */
  readonly knownGoodRange: { readonly min: string; readonly max?: string };
  /**
   * Sandbox levels the CLI ITSELF supports — agent capability, not the keryx
   * release gate. "this agent cannot" and "keryx does not yet" must stay
   * distinguishable refusals (specification §4, §6.1).
   */
  readonly sandboxModes: readonly ExternalSandbox[];
  /** Whether the CLI accepts operator messages mid-run; false routes them through resume. */
  readonly streamingInput: boolean;
  /** Whether a killed session can be resumed by id — what makes `force` cost a restart. */
  readonly resumable: boolean;
  /** Whether the CLI reports a monetary cost. A missing figure is shown as missing, never zero. */
  readonly reportsCost: boolean;
  /** Whether the CLI accepts a native budget ceiling keryx can forward. */
  readonly budgetFlag: boolean;
  readonly notes?: string;
}

/** What a codec needs to build one run's argv. */
export interface ExternalRunInput {
  /** Directive + task + working diff, assembled upstream. One argv element. */
  readonly prompt: string;
  /** Absolute path the agent runs in — the disposable worktree. */
  readonly cwd: string;
  readonly sandbox: ExternalSandbox;
  /** Omitted lets the CLI resolve its own default under the active subscription. */
  readonly model?: string;
  /** Assigned by keryx where the CLI accepts one (claude); ignored where it does not (codex). */
  readonly sessionId?: string;
  /** Path to a JSON Schema file describing the required final response shape. */
  readonly resultSchemaPath?: string;
  /** Forwarded to a native budget ceiling when the entry declares `budgetFlag`. */
  readonly maxCostUnits?: number;
}

/**
 * The canonical event set. Vendor streams fold onto this so the existing
 * monitoring folds need no change.
 *
 * `retry` exists because BOTH CLIs emit non-terminal error events in bulk while
 * retrying — a captured codex no-credentials transcript carries ten
 * "Reconnecting n/5" errors before its single terminal `turn.failed`, and the
 * claude equivalent carries eight `system/api_retry` before its `result`. A
 * parser that treated the first as terminal would report every transient network
 * hiccup as a dead run (flow 176 T5).
 */
export type ExternalEvent =
  | { readonly kind: "child_started"; readonly sessionRef?: string }
  | { readonly kind: "tool_call"; readonly name: string; readonly detail?: string }
  | { readonly kind: "tool_result"; readonly detail?: string }
  | { readonly kind: "assistant_text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "user_message"; readonly text: string }
  | { readonly kind: "retry"; readonly message: string }
  | {
      readonly kind: "usage";
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly costUnits?: number;
    }
  | { readonly kind: "child_finished"; readonly text?: string }
  | { readonly kind: "child_failed"; readonly message: string };

/** Terminal event kinds. Everything else — including `retry` — continues the run. */
export const TERMINAL_EVENT_KINDS: readonly ExternalEvent["kind"][] = ["child_finished", "child_failed"];

/** True when this event ends the run. Pure. */
export function isTerminalEvent(event: ExternalEvent): boolean {
  return event.kind === "child_finished" || event.kind === "child_failed";
}

/** What a finished process looked like, handed to {@link ExternalAgentCodec.classifyFailure}. */
export interface ProcessOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The wall-clock ceiling elapsed and the process was killed. */
  readonly timedOut: boolean;
  /** The prompt, so a classifier can subtract it before reading the streams. */
  readonly prompt: string;
  /** Canonical events already parsed from stdout, so a classifier can see terminality. */
  readonly events: readonly ExternalEvent[];
}

/**
 * One CLI's adapter. Every method is pure, total and side-effect free — no
 * spawning, no filesystem, no clock. That is what lets the whole layer be tested
 * against recorded transcripts.
 *
 * `buildArgv` is a named export with its own test because a reference
 * implementation shipped a wrong flag for months and every run failed on the
 * command line before the agent was ever asked anything.
 */
export interface ExternalAgentCodec {
  readonly id: string;
  /** The complete argv, prompt included. Pure. */
  buildArgv(input: ExternalRunInput): readonly string[];
  /** One transcript line to zero or one canonical events. Unparseable lines yield undefined. */
  parseLine(line: string): ExternalEvent | undefined;
  /** Null means the run succeeded; a string names the cause in operator-readable terms. */
  classifyFailure(outcome: ProcessOutcome): string | null;
  /**
   * Argv delivering a message to a resumable session. `sessionRef` is whatever
   * the agent's resume handle is — keryx ASSIGNS it for claude (`--session-id`)
   * but READS it for codex (`thread_id`, emitted on `thread.started`).
   */
  buildResumeArgv(sessionRef: string, message: string, input: ExternalRunInput): readonly string[];
}
