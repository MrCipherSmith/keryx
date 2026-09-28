// Codec for the `antigravity-cli` external agent — Google's Antigravity CLI,
// `agy` (flow 357). Package: docs/requirements/keryx-antigravity-agent
// specification.md §6, §11.
//
// Three pure functions — argv, parse, classify — same shape as `codex-cli.ts`
// and `claude-cli.ts`, and for the same reason: the whole adapter is testable
// offline against `fixtures/external/live/antigravity-cli/2026-09-28/
// read-only-ok.stream.jsonl`, a REAL recorded transcript, with no `agy`
// installed. That fixture is trusted over the design specification where the
// two disagree (`agy --help` on 1.2.12 confirms the flag names below):
//
//   - `init` carries `conversation_id` at the TOP LEVEL of the event, not
//     nested under `init.conversation_id`.
//   - assistant text arrives as `step_update.text_delta` on a step whose
//     `step_type` is `"agent_response"`, not as a separate delta event.
//   - the terminal `result` event REPEATS the final response and usage
//     already seen on the last `step_update` — both are folded onto the
//     canonical stream below (`usage` first, then the terminal event, same
//     ordering `codex-cli`/`claude-cli` use so a pump that stops at the
//     terminal event never drops the only usage figure the CLI reports).
//
// `--dangerously-skip-permissions` is never emitted, on any path.
import type { ExternalAgentCodec, ExternalEvent, ExternalRunInput, ProcessOutcome } from "../types";
import { isTerminalEvent } from "../types";

/** Seconds `--print-timeout` gets when the caller supplies none (matches `externalAgents.defaultTimeoutMs`'s own 600_000 ms default). */
const DEFAULT_PRINT_TIMEOUT_SECONDS = 600;

/**
 * Build the launch argv for one `agy` print-mode run. Pure.
 *
 * ```text
 * agy -p <prompt> --output-format stream-json --print-timeout <n>s
 *     [--model <slug>] [--sandbox]
 * ```
 *
 * Flag order is FIXED (specification §6.1, AC2 pins it element by element):
 * `--print-timeout` before `--model` before `--sandbox`. `--conversation` is
 * NOT part of this shape — a fresh run has no conversation to resume, and agy
 * assigns its own `conversation_id` (read, not set — see
 * {@link parseAntigravityEvents}, mirroring codex's `thread_id`); resuming one
 * is {@link buildAntigravityResumeArgv}'s job.
 *
 * `sandbox: "worktree-write"` omits `--sandbox` (agy's own default is
 * unsandboxed). That shape exists for completeness only: `worktree-write` is
 * refused upstream (`dispatch.ts`'s `IMPLEMENTED_SANDBOX_MODES`), so this
 * codec never actually builds it in this release.
 */
export function buildAntigravityArgv(input: ExternalRunInput): readonly string[] {
  const argv: string[] = [
    "agy",
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--print-timeout",
    `${input.printTimeoutSeconds ?? DEFAULT_PRINT_TIMEOUT_SECONDS}s`,
  ];
  if (input.model !== undefined) argv.push("--model", input.model);
  if (input.sandbox === "read-only") argv.push("--sandbox");
  return argv;
}

/**
 * Build the argv that delivers `message` to an existing conversation. Pure.
 *
 * ```text
 * agy -p <message> --output-format stream-json --print-timeout <n>s
 *     --conversation <sessionRef> [--model <slug>] [--sandbox]
 * ```
 *
 * `sessionRef` is the `conversation_id` agy itself announced on `init` — keryx
 * READS this handle, exactly like codex's `thread_id`, and never assigns one
 * (unlike claude's keryx-issued `--session-id`).
 */
export function buildAntigravityResumeArgv(
  sessionRef: string,
  message: string,
  input: ExternalRunInput,
): readonly string[] {
  const argv: string[] = [
    "agy",
    "-p",
    message,
    "--output-format",
    "stream-json",
    "--print-timeout",
    `${input.printTimeoutSeconds ?? DEFAULT_PRINT_TIMEOUT_SECONDS}s`,
    "--conversation",
    sessionRef,
  ];
  if (input.model !== undefined) argv.push("--model", input.model);
  if (input.sandbox === "read-only") argv.push("--sandbox");
  return argv;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

/** Parse one JSONL line into a plain object, or undefined for anything else. Never throws. */
function readJsonObject(line: string): JsonObject | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `step_type` values this codec maps or deliberately skips (recognised either way). */
const KNOWN_STEP_TYPES: ReadonlySet<string> = new Set(["user_input", "agent_response", "tool"]);

/** `result.status` values this codec has a row for (specification §6.3). */
const KNOWN_RESULT_STATUSES: ReadonlySet<string> = new Set([
  "SUCCESS",
  "WAITING",
  "ERROR",
  "CANCELED",
  "INTERRUPTED",
  "INVALID",
]);

/**
 * Token totals from an `agy` `usage` object.
 *
 * Only `input_tokens`/`output_tokens` are carried. The recorded fixture's own
 * arithmetic rules the other two out as ADDITIONS: `input_tokens (13166) +
 * output_tokens (31) === total_tokens (13197)` exactly, so `cache_read_tokens`
 * (a subset of input processing) and `thinking_tokens` (≤ `output_tokens`, a
 * subset of it) are already counted — adding either would double-count
 * against the CLI's own total. No `costUnits`: the registry declares
 * `reportsCost: false`, and `agy`'s usage carries tokens only, never a price.
 */
function parseUsage(raw: unknown): ExternalEvent | undefined {
  const usage = asObject(raw);
  if (usage === undefined) return undefined;
  const inputTokens = asNumber(usage.input_tokens);
  const outputTokens = asNumber(usage.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    kind: "usage",
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/** `{"event":"init", "conversation_id":..., "init":{cwd,tools,permission_mode}}` — fires once. */
function parseInitEvent(record: JsonObject): ExternalEvent[] {
  // Top-level, per the recorded fixture — NOT `init.conversation_id`. The
  // nested `init` object (`cwd`, `tools`, `permission_mode`) carries nothing
  // the canonical event set has a home for.
  const conversationId = asString(record.conversation_id);
  return [conversationId === undefined ? { kind: "child_started" } : { kind: "child_started", sessionRef: conversationId }];
}

/**
 * `{"event":"step_update","step_update":{step_type,text_delta?,usage?,...}}`.
 *
 * Only `step_type: "agent_response"` carries anything this codec maps —
 * `"user_input"` echoes the operator's own prompt back and is deliberately
 * unmapped, the same treatment codex gives `turn.started`. A step can legally
 * report BOTH a text delta and usage on the same line (the fixture's final
 * `agent_response` step does exactly that), so this returns up to two events.
 */
function parseStepUpdate(raw: unknown): ExternalEvent[] {
  const step = asObject(raw);
  if (step === undefined) return [];
  if (asString(step.step_type) === "tool") return parseToolStep(step);
  if (asString(step.step_type) !== "agent_response") return [];
  const events: ExternalEvent[] = [];
  const delta = asString(step.text_delta);
  if (delta !== undefined) events.push({ kind: "assistant_text", text: delta });
  const usage = parseUsage(step.usage);
  if (usage !== undefined) events.push(usage);
  return events;
}

/**
 * A `step_type: "tool"` update — recorded live (`tool-denied.stream.jsonl`):
 * `ACTIVE` announces the call with `tool_name` and `tool_info.parameters`, and
 * a later update on the same `step_index` ends it `DONE` or `ERROR`, the error
 * under `tool_info.error.message`. Only the call's name and a short argument
 * preview travel — the parameters are the agent's own, but a command line can
 * be long, so it is truncated like every other operator-facing fragment here.
 */
function parseToolStep(step: JsonObject): ExternalEvent[] {
  const name = asString(step.tool_name) ?? "tool";
  const info = asObject(step.tool_info);
  const state = asString(step.state);
  if (state === "ACTIVE") {
    const parameters = asObject(info?.parameters);
    const detail = parameters === undefined ? undefined : truncate(JSON.stringify(parameters), 160);
    return [detail === undefined ? { kind: "tool_call", name } : { kind: "tool_call", name, detail }];
  }
  if (state === "ERROR") {
    const message = asString(asObject(info?.error)?.message);
    return [{ kind: "tool_result", detail: `${name} failed${message === undefined ? "" : `: ${truncate(message, 160)}`}` }];
  }
  if (state === "DONE") return [{ kind: "tool_result", detail: `${name} done` }];
  return [];
}

/**
 * `result.denied_actions` — recorded live: `[{action: "command", display_name:
 * "RunCommand"}]` on a run whose tool call headless mode auto-denied. The run
 * still reports `status: "SUCCESS"`, often with an EMPTY `response`.
 */
function readDeniedActions(result: JsonObject): string[] {
  const raw = result.denied_actions;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    const entry = asObject(item);
    const action = asString(entry?.action);
    const display = asString(entry?.display_name);
    if (action !== undefined || display !== undefined) {
      names.push(action !== undefined && display !== undefined ? `${action} (${display})` : (action ?? display ?? ""));
    }
  }
  return names;
}

/**
 * Operator-readable summary of a non-`SUCCESS` `result`, keyed by `status`
 * (specification §6.3). `result.error`, when present, is appended verbatim
 * (truncated) — it is the one field a synthetic transcript can use to carry a
 * vendor-specific detail this codec has no row for.
 */
function describeResultFailure(status: string | undefined, result: JsonObject): string {
  const detail = asString(result.error);
  const brief = detail === undefined ? undefined : truncate(detail, 400);
  switch (status) {
    case "WAITING":
      // Worded to satisfy `runtime.ts`'s `DENIED_CAUSE_MARKERS` ("blocked …
      // approval") — a headless run cannot supply the permission decision agy
      // is waiting on, which is a REFUSAL, not a crash (specification §6.3).
      return `agy is waiting on a permission decision it cannot receive in this headless run (blocked on approval)${brief === undefined ? "" : `: ${brief}`}`;
    case "CANCELED":
      return `agy reported the run was canceled${brief === undefined ? "" : `: ${brief}`}`;
    case "INTERRUPTED":
      return `agy reported the run was interrupted${brief === undefined ? "" : `: ${brief}`}`;
    case "INVALID":
      return `agy rejected this request as invalid${brief === undefined ? "" : `: ${brief}`}`;
    case "ERROR":
      // The raw detail travels verbatim (no "agy reported status" wrapper) so
      // `classifyAntigravityFailure`'s AUTH_PATTERNS/LIMIT_PATTERNS below can
      // match it directly, the same shape codex/claude's own error text has.
      return brief ?? "agy reported an error with no further detail";
    default:
      // An unrecognised `status` — future CLI versions may add one. Reported,
      // never assumed successful (D-07): `isRecognisedAntigravityLine` also
      // counts this as a parse-skip.
      return `agy reported an unrecognised status "${status ?? "unknown"}"${brief === undefined ? "" : `: ${brief}`}`;
  }
}

/**
 * `{"event":"result","result":{status,response,error?,usage,...}}` — terminal.
 *
 * `usage` is emitted FIRST when present, mirroring `codex-cli`/`claude-cli`:
 * a stream pump that stops consuming at the terminal event must not lose the
 * only usage figure the CLI reports on this line.
 */
function parseResultEvent(raw: unknown): ExternalEvent[] {
  const result = asObject(raw);
  if (result === undefined) return [];
  const events: ExternalEvent[] = [];
  const usage = parseUsage(result.usage);
  if (usage !== undefined) events.push(usage);

  const status = asString(result.status);
  const response = asString(result.response);
  const denied = readDeniedActions(result);
  if (status === "SUCCESS" && denied.length > 0) {
    // Completed-with-denials (specification §6.3) is never reported as plain
    // success: a tool the task needed was refused, so the answer — often
    // empty — is not the answer the task asked for. Whatever text there is
    // travels as partial output; the cause names the denials and the
    // operator's own remedy. Worded to match `runtime.ts`'s
    // `DENIED_CAUSE_MARKERS` ("blocked on approval"), so the run is `Denied`.
    if (response !== undefined) events.push({ kind: "assistant_text", text: response });
    events.push({
      kind: "child_failed",
      message:
        `agy denied ${denied.length} tool action(s) its headless mode cannot ask you to approve ` +
        `(blocked on approval): ${denied.join(", ")}. Allow the ones you trust with a ` +
        "`permissions.allow` rule in agy's own settings.json, or give it a task that needs none.",
    });
    return events;
  }
  if (status === "SUCCESS") {
    events.push(response === undefined ? { kind: "child_finished" } : { kind: "child_finished", text: response });
    return events;
  }
  events.push({ kind: "child_failed", message: describeResultFailure(status, result) });
  return events;
}

/**
 * Fold one `agy` stream-json line onto zero or more canonical events. Pure and
 * total: anything unparseable or unmodelled yields an empty array, never a
 * throw — a vendor patch release adding a stream shape must degrade to a
 * counted parse-skip, not a dead run.
 */
export function parseAntigravityEvents(line: string): readonly ExternalEvent[] {
  const record = readJsonObject(line);
  if (record === undefined) return [];
  switch (asString(record.event)) {
    case "init":
      return parseInitEvent(record);
    case "step_update":
      return parseStepUpdate(record.step_update);
    case "result":
      return parseResultEvent(record.result);
    default:
      return [];
  }
}

/**
 * The codec-port form: one line to at most one canonical event.
 *
 * Where a line yields several — only `result` does — the TERMINAL one wins,
 * matching `claude-cli`'s own `parseLine`/`parseEvents` split and for the
 * identical reason: the runtime keys completion off terminality, so losing it
 * would misclassify every successful run.
 */
export function parseAntigravityLine(line: string): ExternalEvent | undefined {
  const events = parseAntigravityEvents(line);
  return events.find(isTerminalEvent) ?? events[0];
}

/**
 * Whether this codec RECOGNISES a line, whether or not it maps to a canonical
 * event. `"user_input"` step updates are recognised-but-unmapped; an unlisted
 * `step_type` or `result.status` is NOT — that is the version-drift signal
 * `isRecognisedLine` exists to keep meaningful (see `codex-cli.ts`'s own note
 * on why a healthy run must not score a phantom skip).
 */
export function isRecognisedAntigravityLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  const record = readJsonObject(trimmed);
  if (record === undefined) return false;
  const event = asString(record.event);
  if (event === "init") return true;
  if (event === "step_update") {
    const stepType = asString(asObject(record.step_update)?.step_type);
    return stepType !== undefined && KNOWN_STEP_TYPES.has(stepType);
  }
  if (event === "result") {
    const status = asString(asObject(record.result)?.status);
    return status !== undefined && KNOWN_RESULT_STATUSES.has(status);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** Go's `flag` package error for an argv this build does not accept — measured on 1.2.12 (`agy --nonexistent`). */
const ARGV_REJECTION = /^\s*flags? provided but not defined:\s*(.+)$/im;

/** No usable credentials. Synthetic (no live fixture for this row — AC4). */
const AUTH_PATTERNS = /\b(401|unauthorized|not logged in|authenticat(e|ion|ed)|please (run|log ?in))\b/i;

/** Quota exhausted. Synthetic (no live fixture for this row — AC4). */
const LIMIT_PATTERNS = /\b(usage limit|rate limit|quota|too many requests|429)\b/i;

/** The last terminal event in a transcript, or undefined when there is none. */
function lastTerminalEvent(events: readonly ExternalEvent[]): ExternalEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && isTerminalEvent(event)) return event;
  }
  return undefined;
}

/** Trim a cause fragment so an operator-facing reason stays one readable line. */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function brief(text: string, max = 200): string {
  return truncate(text, max);
}

/**
 * Classify a finished `agy` process. Null means it succeeded. Pure.
 *
 * Row-by-row against specification §6.3 (AC4):
 *
 *   - `SUCCESS`, no denial notice → `null` (completed).
 *   - `SUCCESS` with `denied_actions` → the parser already turned it into a
 *     `child_failed` naming the denials, so it lands on the failure branch
 *     below and classifies `Denied` (recorded live: `tool-denied.stream.jsonl`).
 *   - `WAITING` → `blocked-on-approval` wording (matches
 *     `runtime.ts`'s `DENIED_CAUSE_MARKERS`, so the run classifies `Denied`).
 *   - `ERROR` with auth/credential wording → `not-logged-in` wording (matches
 *     `DENIED_CAUSE_MARKERS`, classifies `Denied`).
 *   - `ERROR` otherwise, `CANCELED`, `INTERRUPTED`, `INVALID` → a named
 *     failure string (classifies `Error` — none of these has a dedicated slot
 *     in `ExternalCompletionStatus` today, the same limit codex/claude live
 *     with for their own non-auth, non-limit failures).
 *   - no terminal event before the wall-clock ceiling → `timed-out` wording
 *     (classifies `Timeout`, since `outcome.timedOut` is checked by
 *     `runtime.ts` ahead of the marker match).
 */
export function classifyAntigravityFailure(outcome: ProcessOutcome): string | null {
  // Checked first: the run never reached the agent at all.
  const rejected = ARGV_REJECTION.exec(outcome.stderr);
  if (rejected !== null) {
    return (
      `agy rejected the command line: ${brief(rejected[0])} — the argv keryx sends was recorded ` +
      `against 1.2.12, so this is a CLI version mismatch; check "agy --version"`
    );
  }

  const terminal = lastTerminalEvent(outcome.events);

  if (terminal?.kind === "child_finished") {
    return null;
  }

  if (terminal?.kind === "child_failed") {
    const haystack = `${terminal.message}\n${outcome.stderr}`;
    if (AUTH_PATTERNS.test(haystack)) {
      return `agy has no usable credentials: ${terminal.message} — run \`agy\` once interactively to log in`;
    }
    if (LIMIT_PATTERNS.test(haystack)) {
      return `agy reported a usage or rate limit: ${terminal.message}`;
    }
    return terminal.message.toLowerCase().startsWith("agy ") ? terminal.message : `agy ended in failure: ${terminal.message}`;
  }

  if (outcome.timedOut) {
    return "agy produced no terminal event before the wall-clock ceiling and was killed";
  }

  if (AUTH_PATTERNS.test(outcome.stderr)) {
    return `agy could not authenticate and produced no terminal event (exit ${outcome.exitCode}) — run \`agy\` once interactively to log in`;
  }

  return `transcript ended without a terminal event (exit ${outcome.exitCode})`;
}

/**
 * The shipped `antigravity-cli` adapter. No `buildStreamingArgv`/
 * `encodeStdinMessage`: `agy --help` documents `--input-format stream-json`
 * for print mode, so the registry declares `streamingInput: true` as a CLI
 * capability (`./registry.ts`'s own doc on that field), but this codec does
 * not implement the steerable shape in this release — the NDJSON message
 * schema that mode expects is unverified against a real run, and inventing it
 * risks a silently-broken steerable turn rather than the honest "codex has no
 * streaming shape either" absence this mirrors.
 */
export const antigravityCliCodec: ExternalAgentCodec = {
  id: "antigravity-cli",
  buildArgv: buildAntigravityArgv,
  parseLine: parseAntigravityLine,
  parseEvents: parseAntigravityEvents,
  classifyFailure: classifyAntigravityFailure,
  buildResumeArgv: buildAntigravityResumeArgv,
  isRecognisedLine: isRecognisedAntigravityLine,
};
