// `claude -p` codec — argv, stream-json parsing, failure classification
// (flow 176, T9). Package: docs/requirements/keryx-external-agent-runtime
// §5.2, §5.3, §6.2, §7.7.
//
// Everything here is pure. No spawn, no filesystem, no clock — which is what
// lets the whole adapter be tested offline against the recorded transcripts in
// `fixtures/external/claude-cli/`, captured from a real Claude Code 2.1.220.
//
// Three things in this file exist because a measured run failed without them,
// and all three read as removable to someone who has not seen the failure:
//
//   1. THE ARGV ORDER IS LOAD-BEARING. `--tools`, `--mcp-config`, `--add-dir`
//      and `--disallowed-tools` are variadic, so a prompt placed directly
//      behind one is swallowed as another value. A probe that put the prompt
//      after `--mcp-config` died with `MCP config file not found: …/Rep` — the
//      CLI had taken the prompt's first word as a path. `--session-id` is the
//      single-valued flag chosen to separate them, rather than `--model`,
//      because the model is deliberately left unpinned while a session id is
//      always assigned.
//   2. `--safe-mode`, not `--bare`. Without it the child runs the OPERATOR's
//      hooks (`system/hook_started`, `system/hook_response` appeared in the
//      probe) and loads their whole skill set, ~130 slash commands. `--bare`
//      would suppress the same things but forces API-key auth, defeating the
//      point of running on the subscription.
//   3. `--tools Read Grep Glob` is an ALLOW-LIST over the built-in roster and
//      is verified: `system/init` reported exactly `["Glob","Grep","Read"]`.
//      It is NOT `--allowed-tools`, which is a permission-rule flag that leaves
//      the roster at 27 tools including `NotebookEdit` and `WebFetch`.
//
// And one flag that is deliberately ABSENT: `--permission-mode plan`. It
// injects the vendor's plan workflow into the system prompt, so the agent
// answers with a plan-approval request — exit 0, non-empty output, and
// therefore indistinguishable from a successful run.
import type {
  ExternalAgentCodec,
  ExternalEvent,
  ExternalRunInput,
  ProcessOutcome,
} from "../types";
import { isTerminalEvent } from "../types";

/**
 * The tool roster offered to the child. An allow-list, so anything the CLI
 * gains in a future release is excluded by default — the opposite of a
 * deny-list's failure mode (specification §5.3).
 */
export const CLAUDE_ALLOWED_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

/**
 * MCP config passed inline with `--strict-mcp-config`, which together mean "no
 * MCP servers at all". Confirmed by `mcp_servers: []` in the probe's
 * `system/init`. Serialised without spaces so it survives as one argv element.
 */
export const CLAUDE_EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

/**
 * Flags this CLI treats as variadic. The prompt must never be the element
 * directly after one of these, or it is consumed as another value.
 *
 * `--add-dir` is on this list even though the specification's prose names only
 * three: `claude --help` on 2.1.220 declares it `--add-dir <directories...>`.
 * It is safe in the argv below only because `--session-id`/`--resume` always
 * follows it.
 */
export const CLAUDE_VARIADIC_FLAGS: readonly string[] = [
  "--tools",
  "--mcp-config",
  "--add-dir",
  "--disallowed-tools",
];

/** Flag names the argv uses, in one place so the tests can name them too. */
const FLAG = {
  print: "-p",
  outputFormat: "--output-format",
  inputFormat: "--input-format",
  verbose: "--verbose",
  safeMode: "--safe-mode",
  tools: "--tools",
  strictMcp: "--strict-mcp-config",
  mcpConfig: "--mcp-config",
  maxBudget: "--max-budget-usd",
  jsonSchema: "--json-schema",
  addDir: "--add-dir",
  model: "--model",
  sessionId: "--session-id",
  resume: "--resume",
} as const;

/**
 * The invariant part of every argv, up to but not including the optional
 * flags. `--strict-mcp-config` is a boolean flag and is emitted here so it can
 * also serve as an emergency separator; see {@link buildClaudeArgv}.
 */
function argvPrelude(streaming: boolean): string[] {
  return [
    "claude",
    FLAG.print,
    FLAG.outputFormat,
    "stream-json",
    ...(streaming ? [FLAG.inputFormat, "stream-json"] : []),
    FLAG.verbose,
    FLAG.safeMode,
    FLAG.tools,
    ...CLAUDE_ALLOWED_TOOLS,
    FLAG.strictMcp,
    FLAG.mcpConfig,
    CLAUDE_EMPTY_MCP_CONFIG,
  ];
}

/**
 * One line of `--input-format stream-json` input: a user message on stdin.
 *
 * This is the ONLY way to reach a streaming run. Verified live against 2.1.220
 * (flow 176): the same argv fed this on stdin answers normally, while a
 * positional prompt is ignored outright — see {@link buildClaudeStreamingArgv}.
 */
export function encodeClaudeStdinMessage(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

/**
 * Argv for a STEERABLE run: `--input-format stream-json`, and NO positional
 * prompt.
 *
 * The distinction is not stylistic, it is a silent-failure trap measured on
 * 2.1.220. Passing `--input-format stream-json` together with a positional
 * prompt makes the CLI ignore the prompt, wait for JSON on stdin, and — when
 * stdin is closed — **exit 0 having produced zero bytes on both streams**. No
 * error, no transcript, nothing to classify: the worst shape a failure can take,
 * because every process-level signal says success. Specification 0.1.0 through
 * 0.3.0 all carried that argv.
 *
 * So a run is one of two things and the caller chooses at spawn time:
 *
 *   - {@link buildClaudeArgv} — one-shot, positional prompt, stdin ignored. Not
 *     steerable: no later message can reach it.
 *   - this — the prompt and every subsequent operator message are written to
 *     stdin as {@link encodeClaudeStdinMessage} lines.
 *
 * There is no way to convert one into the other after the fact, which is why
 * steerability has to be decided before the process starts.
 */
export function buildClaudeStreamingArgv(input: ExternalRunInput): readonly string[] {
  const argv = [...argvPrelude(true), ...argvOptions(input)];
  const sessionId = input.sessionId;
  if (sessionId !== undefined && sessionId.length > 0) argv.push(FLAG.sessionId, sessionId);
  // No prompt element: it arrives on stdin. Nothing here can be swallowed by a
  // variadic flag because nothing positional follows.
  return argv;
}

/**
 * Optional flags, emitted only when the corresponding input field is present.
 *
 * `exactOptionalPropertyTypes` is on, so an absent field is genuinely absent
 * rather than `undefined`, and the check is a plain presence test. Every one of
 * these is single-valued except `--add-dir`, which is why the caller must keep
 * a single-valued flag between this block and the prompt.
 *
 * `input.sandbox` deliberately changes nothing here. Read-only containment is
 * the tool roster plus the disposable worktree (§7.2); `worktree-write` is
 * refused upstream in this release, so there is no second argv shape to get
 * wrong.
 */
function argvOptions(input: ExternalRunInput): string[] {
  const out: string[] = [];
  if (input.maxCostUnits !== undefined) out.push(FLAG.maxBudget, String(input.maxCostUnits));
  if (input.resultSchemaPath !== undefined) out.push(FLAG.jsonSchema, input.resultSchemaPath);
  if (input.cwd.length > 0) out.push(FLAG.addDir, input.cwd);
  if (input.model !== undefined) out.push(FLAG.model, input.model);
  return out;
}

/**
 * Build the launch argv for one ONE-SHOT run — a positional prompt, stdin
 * ignored, not steerable.
 *
 * ```text
 * claude -p --output-format stream-json --verbose
 *        --safe-mode --tools Read Grep Glob
 *        --strict-mcp-config --mcp-config '{"mcpServers":{}}'
 *        [--max-budget-usd n] [--json-schema path] [--add-dir cwd] [--model m]
 *        --session-id <uuid> <prompt>
 * ```
 *
 * `--input-format stream-json` IS DELIBERATELY ABSENT and must stay absent from
 * this shape. Combined with a positional prompt it makes the CLI ignore the
 * prompt entirely and exit 0 with zero bytes on both streams — a silent no-op
 * wearing a success exit code. Use {@link buildClaudeStreamingArgv} when the run
 * must be steerable; there is no shape that is both.
 *
 * The prompt is the last element and is always exactly one element.
 *
 * When `sessionId` is absent the argv keeps its safety rather than throwing:
 * `--session-id` is dropped and the boolean `--strict-mcp-config` is moved to
 * the end so the prompt still follows a flag that takes no value. A session id
 * is not invented, because two concurrent runs sharing one would corrupt each
 * other's history — a worse outcome than losing resumability for that run.
 */
export function buildClaudeArgv(input: ExternalRunInput): readonly string[] {
  const sessionId = input.sessionId?.trim();
  if (sessionId === undefined || sessionId.length === 0) {
    // Fallback shape: no session id to separate the variadics from the prompt,
    // so the zero-valued `--strict-mcp-config` does the job instead.
    const prelude = argvPrelude(false).filter((element) => element !== FLAG.strictMcp);
    return [...prelude, ...argvOptions(input), FLAG.strictMcp, input.prompt];
  }
  return [...argvPrelude(false), ...argvOptions(input), FLAG.sessionId, sessionId, input.prompt];
}

/**
 * Build the argv that delivers `message` to an existing session.
 *
 * Identical to {@link buildClaudeArgv} except that `--resume <sessionRef>`
 * replaces `--session-id <uuid>`. `--resume` takes an optional single value, so
 * it separates the variadic flags from the message exactly as `--session-id`
 * does. keryx ASSIGNS this handle (unlike codex, where it is read off
 * `thread.started`), so a resume never has to wait for the child to announce
 * an id.
 */
export function buildClaudeResumeArgv(
  sessionRef: string,
  message: string,
  input: ExternalRunInput,
): readonly string[] {
  return [...argvPrelude(false), ...argvOptions(input), FLAG.resume, sessionRef, message];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Longest tool input we put in a `tool_call` detail. Enough for a path, not a file. */
const TOOL_DETAIL_LIMIT = 400;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * `system` line subtypes recognised and deliberately NOT mapped to a canonical
 * event, so a parse-skip counter does not inflate on healthy runs.
 *
 * `hook_started`/`hook_response` only appear when `--safe-mode` is absent, and
 * this codec's argv never omits it. They are listed anyway: they were observed
 * live, and a future reader who sees them in a transcript should find them
 * accounted for rather than assume the parser is behind the CLI. Nothing in the
 * canonical vocabulary describes "the operator's hook ran inside the child",
 * and inventing a `tool_call` for one would put the operator's own machinery
 * into the child's tool trace.
 */
export const CLAUDE_UNMAPPED_SYSTEM_SUBTYPES: readonly string[] = ["hook_started", "hook_response"];

/**
 * Top-level line types recognised and deliberately NOT mapped.
 *
 * `rate_limit_event` is here because it appears in SUCCESSFUL runs — the
 * captured success and resume transcripts both carry one with
 * `status: "allowed"`. Folding it onto `retry` would report two retries on a
 * clean single-turn run and poison the no-progress and version-drift signals
 * that read the retry count. It is not `usage` either: it carries a reset
 * timestamp and a bucket name, no tokens and no cost. Exhaustion still reaches
 * the operator, through the terminal `result` and {@link classifyClaudeFailure}.
 */
export const CLAUDE_UNMAPPED_LINE_TYPES: readonly string[] = ["rate_limit_event"];

function systemEvents(obj: JsonObject): ExternalEvent[] {
  const subtype = asString(obj.subtype);

  if (subtype === "init") {
    // This line is multiple KB — it enumerates the tool roster and every slash
    // command — so nothing here may assume a short line or a fixed field order.
    const sessionRef = asString(obj.session_id);
    return [sessionRef === undefined ? { kind: "child_started" } : { kind: "child_started", sessionRef }];
  }

  if (subtype === "api_retry") {
    // NON-TERMINAL. The captured bad-credential transcript carries eight of
    // these before its single terminal `result`; a parser that ended the run on
    // the first would report every transient hiccup as a dead child.
    const attempt = asFiniteNumber(obj.attempt);
    const max = asFiniteNumber(obj.max_retries);
    const status = asFiniteNumber(obj.error_status);
    const error = asString(obj.error);
    const parts = [
      attempt === undefined ? "api retry" : `api retry ${attempt}${max === undefined ? "" : `/${max}`}`,
      status === undefined ? undefined : `status ${status}`,
      error,
    ].filter((part): part is string => part !== undefined && part.length > 0);
    return [{ kind: "retry", message: parts.join(", ") }];
  }

  return [];
}

/** Flatten a `tool_result` block's content, which is a string or an array of blocks. */
function toolResultDetail(content: unknown): string | undefined {
  const direct = asString(content);
  if (direct !== undefined) return truncate(direct, TOOL_DETAIL_LIMIT);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((entry) => asString(asObject(entry)?.text))
    .filter((entry): entry is string => entry !== undefined)
    .join("\n");
  return text.length === 0 ? undefined : truncate(text, TOOL_DETAIL_LIMIT);
}

function assistantBlockEvent(block: JsonObject): ExternalEvent | undefined {
  switch (asString(block.type)) {
    case "tool_use": {
      const name = asString(block.name) ?? "unknown";
      // The input is carried verbatim (truncated) because the `scope_drift`
      // supervision trigger reads the target path out of it (§7.6).
      const detail = block.input === undefined ? undefined : truncate(JSON.stringify(block.input), TOOL_DETAIL_LIMIT);
      return detail === undefined ? { kind: "tool_call", name } : { kind: "tool_call", name, detail };
    }
    case "text":
      return { kind: "assistant_text", text: asString(block.text) ?? "" };
    case "thinking":
      // The API names this field `thinking`; `text` is tolerated because
      // redacted/summarised variants have used it.
      return { kind: "thinking", text: asString(block.thinking) ?? asString(block.text) ?? "" };
    default:
      return undefined;
  }
}

function userBlockEvent(block: JsonObject): ExternalEvent | undefined {
  if (asString(block.type) !== "tool_result") return undefined;
  const detail = toolResultDetail(block.content);
  return detail === undefined ? { kind: "tool_result" } : { kind: "tool_result", detail };
}

/**
 * Map the content blocks of an `assistant` or `user` line.
 *
 * A `user` line's `text` blocks are deliberately dropped. `user_message` is
 * reserved for messages keryx itself delivers to the child (§6.2); minting one
 * from a transcript echo would show the operator a message nobody sent — the
 * captured bad-credential transcript ends with exactly such an echo,
 * `[Request interrupted by user]`, which no operator typed.
 */
function contentEvents(obj: JsonObject, role: "assistant" | "user"): ExternalEvent[] {
  const content = asObject(obj.message)?.content;
  if (!Array.isArray(content)) return [];
  const out: ExternalEvent[] = [];
  for (const raw of content) {
    const block = asObject(raw);
    if (block === undefined) continue;
    const event = role === "assistant" ? assistantBlockEvent(block) : userBlockEvent(block);
    if (event !== undefined) out.push(event);
  }
  return out;
}

/**
 * Token totals for the `usage` event.
 *
 * Cache reads and cache writes are ADDED to `inputTokens`. The captured success
 * transcript reports `input_tokens: 2` alongside `cache_read_input_tokens:
 * 5118`; a ledger fed the bare `input_tokens` would under-report that run by
 * three orders of magnitude. Money is not double counted, because cost travels
 * separately as `costUnits` from the CLI's own `total_cost_usd`.
 */
function usageEvent(obj: JsonObject): ExternalEvent | undefined {
  const usage = asObject(obj.usage);
  const input = asFiniteNumber(usage?.input_tokens);
  const cacheRead = asFiniteNumber(usage?.cache_read_input_tokens);
  const cacheWrite = asFiniteNumber(usage?.cache_creation_input_tokens);
  const output = asFiniteNumber(usage?.output_tokens);
  const cost = asFiniteNumber(obj.total_cost_usd);

  const inputTotal =
    input === undefined && cacheRead === undefined && cacheWrite === undefined
      ? undefined
      : (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);

  if (inputTotal === undefined && output === undefined && cost === undefined) return undefined;
  return {
    kind: "usage",
    ...(inputTotal === undefined ? {} : { inputTokens: inputTotal }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cost === undefined ? {} : { costUnits: cost }),
  };
}

/**
 * Operator-readable summary of a failing `result` line.
 *
 * `subtype` leads, because it is the discriminator {@link classifyClaudeFailure}
 * keys on and the one the operator must be able to quote. `num_turns` is folded
 * in here because the canonical `usage` event has no field for it — see the
 * note on {@link parseClaudeEvents}.
 */
function describeFailure(obj: JsonObject): string {
  const subtype = asString(obj.subtype) ?? "unknown";
  const parts = [`result.subtype "${subtype}"`];
  const text = asString(obj.result);
  if (text !== undefined && text.length > 0) parts.push(truncate(text, TOOL_DETAIL_LIMIT));
  const errors = obj.errors;
  if (Array.isArray(errors)) {
    const flat = errors.map((entry) => asString(entry)).filter((entry): entry is string => entry !== undefined);
    if (flat.length > 0) parts.push(truncate(flat.join("; "), TOOL_DETAIL_LIMIT));
  }
  const turns = asFiniteNumber(obj.num_turns);
  if (turns !== undefined) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
  return parts.join(" — ");
}

function resultEvents(obj: JsonObject): ExternalEvent[] {
  const subtype = asString(obj.subtype);
  // `subtype` is the discriminator (§6.2). `is_error` is consulted ONLY when
  // the subtype is missing, and is retained purely for backward compatibility.
  const succeeded = subtype === undefined ? obj.is_error === false : subtype === "success";
  const terminal: ExternalEvent = succeeded
    ? (() => {
        const text = asString(obj.result);
        return text === undefined ? { kind: "child_finished" } : { kind: "child_finished", text };
      })()
    : { kind: "child_failed", message: describeFailure(obj) };

  const usage = usageEvent(obj);
  // Usage FIRST. A pump that stops consuming at the terminal event would
  // otherwise drop the only cost figure the CLI ever reports.
  return usage === undefined ? [terminal] : [usage, terminal];
}

/**
 * Every canonical event a single transcript line yields, in emission order.
 *
 * The port contract is one event per line, which the `result` line cannot
 * honour: it is simultaneously the terminal event and the only carrier of
 * `total_cost_usd`. This function is the total mapping; {@link parseClaudeLine}
 * is the contract-shaped projection of it. A stream pump should prefer this one
 * so the cost figure survives.
 *
 * One field has no canonical home at all: `num_turns`. `ExternalEvent`'s
 * `usage` variant carries tokens and cost only, so turns are folded into the
 * `child_failed` message and are simply lost on a successful run.
 */
export function parseClaudeEvents(line: string): readonly ExternalEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const obj = asObject(parsed);
  if (obj === undefined) return [];

  switch (asString(obj.type)) {
    case "system":
      return systemEvents(obj);
    case "assistant":
      return contentEvents(obj, "assistant");
    case "user":
      return contentEvents(obj, "user");
    case "result":
      return resultEvents(obj);
    default:
      return [];
  }
}

/**
 * One transcript line to at most one canonical event.
 *
 * Where a line yields several, the TERMINAL one wins and the rest are dropped.
 * Losing a cost figure costs the operator a number; losing terminality hangs
 * the run waiting for an event that already went past.
 */
export function parseClaudeLine(line: string): ExternalEvent | undefined {
  const events = parseClaudeEvents(line);
  return events.find(isTerminalEvent) ?? events[0];
}

/**
 * Whether a line is one this codec RECOGNISES, whether or not it maps to a
 * canonical event.
 *
 * The runtime counts unparseable lines as a version-drift signal (§6.2). Without
 * this distinction every healthy run would report skips, because
 * `rate_limit_event` is emitted on successful runs and maps to nothing.
 */
export function isRecognisedClaudeLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  const obj = asObject(parsed);
  if (obj === undefined) return false;
  const type = asString(obj.type);
  if (type === undefined) return false;
  if (CLAUDE_UNMAPPED_LINE_TYPES.includes(type)) return true;
  if (type === "system") {
    const subtype = asString(obj.subtype) ?? "";
    return subtype === "init" || subtype === "api_retry" || CLAUDE_UNMAPPED_SYSTEM_SUBTYPES.includes(subtype);
  }
  return type === "assistant" || type === "user" || type === "result";
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * stderr shapes that mean "this build does not accept a flag keryx sent".
 *
 * claude is terse here and, unlike codex, prints NO usage block: the captured
 * fixture is exactly `error: unknown option '--no-such-flag'`. So there is no
 * `Usage:` line to anchor on and the match has to be the error line itself.
 */
const ARGV_REJECTION = /^\s*error:\s*unknown\s+(option|argument|command)\b.*$/im;

/** Wording that means quota, not a transient error. */
const LIMIT_WORDING = /\b(usage limit|rate limit|rate_limit|quota|limit reached|too many requests|429)\b/i;

/** Wording that means the credential, not the network. */
const CREDENTIAL_WORDING = /\b(401|403|authentication_failed|unauthorized|invalid api key|not logged in|\/login)\b/i;

/** Strip the prompt out of a stream before pattern-matching it. */
function withoutPrompt(text: string, prompt: string): string {
  return prompt.length === 0 ? text : text.split(prompt).join(" ");
}

function retryCount(events: readonly ExternalEvent[]): number {
  return events.filter((event) => event.kind === "retry").length;
}

/**
 * Retries preceding a failure are worth naming: the operator's practical
 * symptom is a run that took a minute and a half to fail, not one that errored.
 */
function retrySuffix(count: number): string {
  if (count === 0) return "";
  return ` (after ${count} api retr${count === 1 ? "y" : "ies"} — the run was slow before it failed)`;
}

/**
 * Classify a finished `claude -p` process. Null means it succeeded.
 *
 * The rule this function exists to NOT implement is "exit 0 with non-empty
 * output means success". The captured bad-credential run exits 0, prints a full
 * and entirely normal-looking `system/init`, and only then burns eight
 * `system/api_retry` events before `result.subtype = "error_during_execution"`.
 * The discriminator is that subtype, surfaced here as the terminal event's kind.
 *
 * 0.1.0 of the specification claimed `claude -p` prints `Not logged in · Please
 * run /login` to stdout with exit 0. It does NOT reproduce on 2.1.220. The
 * string is still matched below, but only as a last-resort fallback on a
 * transcript that produced no terminal event at all, where it cannot override
 * the real signal.
 *
 * Reads `outcome.events`, not `outcome.stdout`, for terminality — deliberately.
 * Re-parsing stdout here would make an empty `events` array indistinguishable
 * from a transcript that genuinely never terminated, which is the one case §6.2
 * requires be reported as itself.
 */
export function classifyClaudeFailure(outcome: ProcessOutcome): string | null {
  const retries = retryCount(outcome.events);

  // First: the run never reached the agent at all. Checked ahead of everything
  // else because it also explains the empty transcript that follows it.
  const rejected = ARGV_REJECTION.exec(outcome.stderr);
  if (rejected !== null) {
    return (
      `claude rejected the command line: ${rejected[0].trim()} — the argv keryx sends was recorded ` +
      `against 2.1.220, so this is a CLI version mismatch; check "claude --version"`
    );
  }

  const terminal = outcome.events.find(isTerminalEvent);

  if (terminal?.kind === "child_finished") {
    // Returned even when `timedOut` is set: the kill races the terminal event,
    // and a run whose result already arrived did not time out.
    return null;
  }

  if (terminal?.kind === "child_failed") {
    const haystack = [terminal.message, outcome.stderr, ...outcome.events.flatMap((e) => (e.kind === "retry" ? [e.message] : []))].join("\n");
    if (LIMIT_WORDING.test(haystack)) {
      return `claude reported a usage or rate limit: ${terminal.message}${retrySuffix(retries)}`;
    }
    if (CREDENTIAL_WORDING.test(haystack)) {
      return `claude could not authenticate: ${terminal.message}${retrySuffix(retries)}`;
    }
    return `claude ended in failure: ${terminal.message}${retrySuffix(retries)}`;
  }

  if (outcome.timedOut) {
    return `claude produced no terminal event before the wall-clock ceiling and was killed${retrySuffix(retries)}`;
  }

  const stdout = withoutPrompt(outcome.stdout, outcome.prompt);
  if (CREDENTIAL_WORDING.test(stdout)) {
    // Defensive only — see the note above. Reached only when no terminal event
    // exists, so it can never contradict `result.subtype`.
    return `claude reported an authentication problem and produced no terminal event (exit ${outcome.exitCode})${retrySuffix(retries)}`;
  }

  return `transcript ended without a terminal event (exit ${outcome.exitCode})${retrySuffix(retries)}`;
}

/**
 * The `claude-cli` codec. Three pure functions plus an id; the only impure seam
 * in the subsystem is the spawn, and it lives elsewhere.
 */
export const claudeCliCodec: ExternalAgentCodec = {
  id: "claude-cli",
  buildArgv: buildClaudeArgv,
  parseLine: parseClaudeLine,
  parseEvents: parseClaudeEvents,
  classifyFailure: classifyClaudeFailure,
  // Present because this agent declares `streamingInput: true`. codex omits
  // both and its operator messages travel by resume instead.
  buildStreamingArgv: buildClaudeStreamingArgv,
  encodeStdinMessage: encodeClaudeStdinMessage,
  isRecognisedLine: isRecognisedClaudeLine,
  buildResumeArgv: buildClaudeResumeArgv,
};
