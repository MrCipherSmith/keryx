// Codec for the `codex-cli` external agent (flow 176, T8).
// Package: docs/requirements/keryx-external-agent-runtime §5.1, §6.2, §7.7.
//
// Three pure functions — argv, parse, classify — because that is what lets this
// whole adapter be tested offline against the recorded transcripts in
// `fixtures/external/codex-cli/` on a machine with no `codex` installed. Nothing
// here spawns, reads the filesystem, or looks at a clock.
//
// Two facts about codex 0.147.0 shape almost everything below, and both were
// measured rather than read off the docs:
//
//   - `codex exec` NARRATES ITSELF on stderr and prints the contents of files it
//     reads. Any classifier that greps the streams for "error" therefore reports
//     successful runs as failures, because the agent's own answer can contain the
//     word. `fixtures/external/codex-cli/error-word.stdout.jsonl` is exactly that
//     run — exit 0, terminal `turn.completed`, an `agent_message` reading
//     "error: nothing is actually wrong" — and it must classify as SUCCESS.
//   - Top-level `{"type":"error"}` events are RETRY NOISE, not failure. The
//     captured no-credentials transcript carries ten of them before its single
//     terminal `turn.failed`. Treating the first as terminal would report every
//     transient network hiccup as a dead run.
//
// The vendor stream is folded onto the canonical `ExternalEvent` set so
// `reduceAgents`/`reduceState` consume external children unchanged.
import type { ExternalAgentCodec, ExternalEvent, ExternalRunInput, ExternalSandbox, ProcessOutcome } from "../types";

/**
 * keryx's sandbox vocabulary translated into the values `codex exec -s` actually
 * accepts (`read-only`, `workspace-write`, `danger-full-access`, verified against
 * `codex exec --help` on 0.147.0).
 *
 * The translation is not cosmetic: keryx says `worktree-write` and codex has never
 * heard that word, so passing the keryx term straight through would be rejected
 * with `error: invalid value 'worktree-write'` — the class of failure that killed
 * every run of a reference implementation on the command line before the agent was
 * asked anything. `danger-full-access` is deliberately unreachable from here.
 */
export const CODEX_SANDBOX_MODES: Readonly<Record<ExternalSandbox, string>> = {
  "read-only": "read-only",
  "worktree-write": "workspace-write",
};

/**
 * Build the complete argv for one `codex exec` run, prompt included. Pure.
 *
 * Shape (specification §5.1, `fixtures/external/manifest.json` `baseArgv`):
 *
 * ```text
 * codex exec --json --color never -s <sandbox> -C <cwd>
 *            --ignore-user-config --skip-git-repo-check
 *            [--output-schema <path>] [-m <model>] <prompt>
 * ```
 *
 * `--ephemeral` IS DELIBERATELY ABSENT AND MUST STAY ABSENT. It is mutually
 * exclusive with resume: a thread started ephemerally fails `codex exec resume`
 * with `no rollout found for thread id … (code -32600)`, captured in
 * `fixtures/external/codex-cli/resume-refused-ephemeral.stderr.txt`. Resume is
 * what makes operator messages and `force` work for this agent, so persistence
 * wins and the run leaves a rollout in the operator's `CODEX_HOME` exactly as a
 * hand-run `codex` does. Redirecting `CODEX_HOME` is not an escape either —
 * `--ignore-user-config`'s own help states auth still resolves from it, so moving
 * it loses the subscription.
 *
 * Optional flags appear only when the field is present, because the repo runs
 * `exactOptionalPropertyTypes` and an absent model must mean "let the CLI resolve
 * its own default under the active subscription", not "pass an empty string".
 *
 * `sessionId` and `maxCostUnits` are ignored on purpose: codex generates its own
 * thread id (see {@link parseCodexEvents}) and exposes no budget ceiling flag,
 * which is why its registry entry declares `budgetFlag: false`.
 */
export function buildCodexArgv(input: ExternalRunInput): readonly string[] {
  const argv: string[] = [
    "codex",
    "exec",
    "--json",
    "--color",
    "never",
    "-s",
    CODEX_SANDBOX_MODES[input.sandbox],
    "-C",
    input.cwd,
    "--ignore-user-config",
    "--skip-git-repo-check",
  ];
  if (input.resultSchemaPath !== undefined) argv.push("--output-schema", input.resultSchemaPath);
  if (input.model !== undefined) argv.push("-m", input.model);
  // Always last, always one element. Everything before it is either a boolean
  // flag or a single-valued flag with its value, so the prompt can never be
  // swallowed as an extra value the way it can behind claude's variadic `--tools`.
  argv.push(input.prompt);
  return argv;
}

/**
 * Build the argv delivering `message` to an existing codex thread. Pure.
 *
 * ```text
 * codex exec resume <thread_id> --json --ignore-user-config --skip-git-repo-check <message>
 * ```
 *
 * `codex exec resume` accepts a STRICTLY NARROWER flag set than `codex exec` —
 * no `-s/--sandbox`, no `-C/--cd`, no `--color` (verified against
 * `codex exec resume --help` on 0.147.0). Two consequences the caller owns:
 *
 *   1. The sandbox level cannot be re-asserted; it is inherited from the resumed
 *      session, and the disposable worktree is doing the containment work.
 *   2. THE CALLER MUST SPAWN THIS PROCESS WITH ITS CWD ALREADY SET TO THE
 *      WORKTREE. There is no flag to carry it, so a resume launched from the
 *      parent's cwd silently runs the agent against the wrong tree.
 *
 * The `ExternalRunInput` the codec port passes is deliberately unused here: not
 * one of its fields is expressible on this subcommand, and pretending otherwise
 * would hide requirement 2 behind an argument that looks like it handles it.
 */
export function buildCodexResumeArgv(sessionRef: string, message: string): readonly string[] {
  return ["codex", "exec", "resume", sessionRef, "--json", "--ignore-user-config", "--skip-git-repo-check", message];
}

/**
 * Fold one codex JSONL line onto zero, one or two canonical events. Pure and
 * total: anything unparseable or unmodelled yields an empty array rather than
 * throwing, because a vendor that adds a stream type in a patch release must
 * degrade to a counted parse-skip and not to a dead run.
 *
 * Mapping (specification §6.2):
 *
 * | codex | canonical |
 * |---|---|
 * | `thread.started` | `child_started` carrying `thread_id` |
 * | `turn.started` | — |
 * | `item.completed` (`command_execution`) | `tool_call` |
 * | `item.completed` (`agent_message`) | `assistant_text` |
 * | `turn.completed` | `usage` **then** `child_finished` |
 * | `turn.failed` | `child_failed` |
 * | `error` (top level) | `retry` — NON-terminal |
 *
 * `thread_id` is READ, never assigned: codex generates the resume handle itself,
 * unlike claude's keryx-supplied `--session-id`. A run whose `thread.started` is
 * missed cannot be resumed at all, which is why it is the first thing parsed.
 *
 * `turn.completed` is the one line that legitimately carries two facts — what the
 * turn cost and that it ended — so this plural form exists and the stream pump
 * should prefer it over {@link parseCodexLine}.
 */
export function parseCodexEvents(line: string): readonly ExternalEvent[] {
  const record = readJsonObject(line);
  if (record === undefined) return [];

  switch (asString(record.type)) {
    case "thread.started": {
      const threadId = asString(record.thread_id);
      return [threadId === undefined ? { kind: "child_started" } : { kind: "child_started", sessionRef: threadId }];
    }
    case "turn.started":
      // No canonical equivalent. A turn boundary is not an observation the parent
      // can act on, and inventing an event for it would inflate the no-progress
      // signal with something that carries no progress.
      return [];
    case "item.completed":
      return parseCompletedItem(record.item);
    case "turn.completed": {
      const events: ExternalEvent[] = [];
      const usage = parseUsage(record.usage);
      if (usage !== undefined) events.push(usage);
      events.push({ kind: "child_finished" });
      return events;
    }
    case "turn.failed":
      return [{ kind: "child_failed", message: parseFailureMessage(record.error) }];
    case "error":
      // NON-TERMINAL, and this is the whole point of the `retry` kind. The captured
      // no-credentials transcript carries ten of these before one `turn.failed`.
      return [{ kind: "retry", message: asString(record.message) ?? "codex reported a non-terminal error" }];
    default:
      return [];
  }
}

/**
 * The codec-port form: one line to at most one canonical event.
 *
 * Where a line folds to two events — only `turn.completed` does — this returns the
 * TERMINAL one, `child_finished`, and the `usage` event is the one dropped. That
 * choice is forced rather than aesthetic: {@link classifyCodexFailure} and the
 * runtime's completion status both key on terminality, so a `parseLine` that
 * returned `usage` would make every successful codex run classify as
 * `transcript ended without a terminal event`. Losing a token count is a reporting
 * gap; losing the terminal event is a wrong verdict on every run.
 *
 * Callers that want the token count as well should use {@link parseCodexEvents},
 * which returns both in stream order.
 */
export function parseCodexLine(line: string): ExternalEvent | undefined {
  const events = parseCodexEvents(line);
  return events[events.length - 1];
}

/** Stream types this codec knows about, whether or not they map to an event. */
const RECOGNISED_TYPES: ReadonlySet<string> = new Set([
  "thread.started",
  "turn.started",
  "item.completed",
  "turn.completed",
  "turn.failed",
  "error",
]);

/**
 * Whether this codec RECOGNISES a line, even when the line maps to no canonical
 * event.
 *
 * `parseLine` returning undefined conflates two different facts: "the codec has
 * never seen this" and "the codec deliberately does not map it". Only the first
 * is version drift. Without this hook a healthy codex run scores a skip for its
 * unmapped `turn.started`, and the drift signal is permanently noisy — so the
 * supervisor's skip counter is only meaningful when this is passed to it.
 */
export function isRecognisedCodexLine(line: string): boolean {
  const record = readJsonObject(line);
  if (record === undefined) return false;
  const type = asString(record.type);
  return type !== undefined && RECOGNISED_TYPES.has(type);
}

/** Stream lines worth reading at all: codex prefixes its real complaints this way. */
const NARRATED_FAILURE_LINE = /^\s*(error\b|usage:)/i;

/** argv rejected by this CLI version — the failure that happens before the agent is asked anything. */
const CLI_USAGE_PATTERNS: readonly RegExp[] = [
  /unexpected argument/i,
  /unrecognized subcommand/i,
  /unknown option/i,
  /^\s*usage:\s*codex/i,
];

/** No usable credentials. Fixture: `not-logged-in.stdout.jsonl` (401 on every attempt). */
const AUTH_PATTERNS: readonly RegExp[] = [/\b401\b/, /unauthorized/i, /not logged/i];

/** Quota exhausted. Fixture: `usage-limit.SYNTHETIC.jsonl` — hand-authored, so this rule is provisional. */
const LIMIT_PATTERNS: readonly RegExp[] = [/rate limit/i, /usage limit/i, /quota/i];

/**
 * Name why a finished `codex` process failed, or return null when it did not. Pure.
 *
 * The interesting work is deciding what text is even admissible as evidence:
 *
 *   - The STREAMS are narration. `codex exec` describes what it is doing and
 *     prints the contents of files it reads, so the prompt is subtracted first and
 *     only lines matching {@link NARRATED_FAILURE_LINE} survive. Without that
 *     filter a run whose answer merely contains the word "error" is misclassified.
 *   - The EVENTS are structured, so `retry` and `child_failed` messages are
 *     admitted whole. This matters because codex's 401s live inside JSONL objects
 *     that begin with `{`, so the line filter would otherwise see nothing at all
 *     and a no-credentials run would classify as a generic non-zero exit.
 *   - `assistant_text` is never admitted. That is the trap the `error-word`
 *     fixture pins: the model's own prose is not evidence about the process.
 *
 * A run that exited 0 with a terminal `child_finished` short-circuits to success
 * BEFORE any pattern runs, so retry noise on a run that recovered cannot
 * retroactively fail it.
 */
export function classifyCodexFailure(outcome: ProcessOutcome): string | null {
  const terminal = lastTerminalEvent(outcome.events);

  // Checked first, deliberately. Exit 0 plus a terminal success event is the
  // strongest evidence available, and no amount of narration outranks it.
  if (!outcome.timedOut && outcome.exitCode === 0 && terminal?.kind === "child_finished") return null;

  if (outcome.timedOut) return "codex-cli run hit its wall-clock ceiling and was killed";

  const lines = admissibleFailureLines(outcome);
  const text = lines.join("\n");

  const usageLine = lines.find((line) => CLI_USAGE_PATTERNS.some((pattern) => pattern.test(line)));
  if (usageLine !== undefined) {
    return `codex-cli rejected this command line — the installed CLI version does not match what this keryx build targets: ${brief(usageLine)}`;
  }

  if (AUTH_PATTERNS.some((pattern) => pattern.test(text))) {
    return "codex-cli has no usable credentials (authentication rejected); run `codex login` and retry";
  }

  if (LIMIT_PATTERNS.some((pattern) => pattern.test(text))) {
    const when = /try again at\s+([^\n]+)/i.exec(text)?.[1]?.trim();
    return when === undefined
      ? "codex-cli reported a usage or rate limit"
      : `codex-cli reported a usage or rate limit; try again at ${brief(when, 80)}`;
  }

  // Spec §6.2 fixes this wording; the runtime maps it to `SubagentCompletionStatus: "Error"`.
  if (terminal === undefined) return "transcript ended without a terminal event";

  if (terminal.kind === "child_failed") return `codex-cli reported a failed turn: ${brief(terminal.message)}`;

  return `codex-cli exited with code ${outcome.exitCode} without reporting a cause`;
}

/**
 * The shipped `codex-cli` adapter.
 *
 * `buildResumeArgv` drops the `ExternalRunInput` the port hands it, for the reason
 * spelled out on {@link buildCodexResumeArgv}: `codex exec resume` cannot express
 * any of it, and the cwd in particular is the SPAWNER's responsibility.
 */
export const codexCliCodec: ExternalAgentCodec = {
  id: "codex-cli",
  buildArgv: buildCodexArgv,
  parseLine: parseCodexLine,
  parseEvents: parseCodexEvents,
  classifyFailure: classifyCodexFailure,
  buildResumeArgv: (sessionRef, message) => buildCodexResumeArgv(sessionRef, message),
  isRecognisedLine: isRecognisedCodexLine,
};

// ---------------------------------------------------------------------------
// Internals. Not exported: every one of them is a detail of the three functions
// above, and widening the surface widens what a future change has to keep true.
// ---------------------------------------------------------------------------

/** Parse one JSONL line into a plain object, or undefined for anything else. Never throws. */
function readJsonObject(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** A field's value when it is a non-empty string, else undefined. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A field's value when it is a finite number, else undefined. */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Fold an `item.completed` payload.
 *
 * Only `command_execution` and `agent_message` are modelled. The captured
 * no-credentials transcript also contains an `item.completed` whose item type is
 * `error` ("Falling back from WebSockets to HTTPS transport"), and it is
 * deliberately dropped rather than counted as a `retry`: the ten `retry`
 * observations that transcript is specified to produce are its ten TOP-LEVEL
 * `error` events, and folding the item in as an eleventh would inflate the
 * retry-derived version-drift and no-progress signals with a transport notice.
 *
 * The `command_execution` shape is MODELLED, not recorded — no captured fixture
 * exercises a tool call (manifest `gaps`) — so it reads defensively and simply
 * omits `detail` when the command is absent.
 */
function parseCompletedItem(raw: unknown): readonly ExternalEvent[] {
  if (typeof raw !== "object" || raw === null) return [];
  const item = raw as Record<string, unknown>;

  switch (asString(item.type)) {
    case "command_execution": {
      const command = asString(item.command);
      return [
        command === undefined
          ? { kind: "tool_call", name: "command_execution" }
          : { kind: "tool_call", name: "command_execution", detail: command },
      ];
    }
    case "agent_message": {
      const text = asString(item.text);
      return text === undefined ? [] : [{ kind: "assistant_text", text }];
    }
    default:
      return [];
  }
}

/**
 * Fold `turn.completed.usage`.
 *
 * codex 0.147.0 reports five fields — `input_tokens`, `cached_input_tokens`,
 * `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`. Only the
 * two totals are carried. `cached_input_tokens` is a SUBSET of `input_tokens` and
 * adding it would double count; `reasoning_output_tokens` is not documented as
 * either a subset of or an addition to `output_tokens`, and over-reporting a
 * billing figure on a guess is worse than under-reporting it on a known fact.
 *
 * `costUnits` is never set: codex reports no monetary cost at all (registry
 * `reportsCost: false`), and a missing figure must be shown as missing, never as
 * zero.
 */
function parseUsage(raw: unknown): ExternalEvent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const inputTokens = asNumber(usage.input_tokens);
  const outputTokens = asNumber(usage.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    kind: "usage",
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/** `turn.failed.error.message`, with a stated fallback so `child_failed` always carries text. */
function parseFailureMessage(raw: unknown): string {
  if (typeof raw === "object" && raw !== null) {
    const message = asString((raw as Record<string, unknown>).message);
    if (message !== undefined) return message;
  }
  return asString(raw) ?? "codex reported a failed turn without a message";
}

/** The last terminal event in a transcript, or undefined when there is none. */
function lastTerminalEvent(events: readonly ExternalEvent[]): ExternalEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && (event.kind === "child_finished" || event.kind === "child_failed")) return event;
  }
  return undefined;
}

/**
 * Every line admissible as evidence of failure: narrated stream lines that survive
 * prompt subtraction and the `error`/`usage:` filter, plus the messages of the
 * structured `retry` and `child_failed` events.
 *
 * Prompt subtraction happens twice over, because codex echoes the prompt in two
 * different ways: as a contiguous block (removed as a substring) and interleaved
 * line by line with its own narration (removed by matching trimmed prompt lines).
 * A prompt that itself says "error:" — a task about fixing an error, say — would
 * otherwise classify every run of that task as a CLI usage failure.
 */
function admissibleFailureLines(outcome: ProcessOutcome): string[] {
  const streams = subtractPrompt(`${outcome.stderr}\n${outcome.stdout}`, outcome.prompt);
  const promptLines = new Set(
    outcome.prompt
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );

  const narrated = streams
    .split("\n")
    .filter((line) => !promptLines.has(line.trim()))
    .filter((line) => NARRATED_FAILURE_LINE.test(line))
    .map((line) => line.trim());

  const structured = outcome.events.flatMap((event) =>
    event.kind === "retry" || event.kind === "child_failed" ? [event.message] : [],
  );

  return [...narrated, ...structured];
}

/** Remove verbatim occurrences of the prompt from a stream. Empty prompts are a no-op. */
function subtractPrompt(streams: string, prompt: string): string {
  if (prompt.length === 0) return streams;
  return streams.split(prompt).join(" ");
}

/** Trim a cause fragment so an operator-facing reason stays one readable line. */
function brief(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
