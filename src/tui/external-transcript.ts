// External child transcript, Meta and Command views — PURE (flow 176, T16).
// Package: docs/requirements/keryx-external-agent-runtime §7.5, §8.2; D-11.
//
// D-11 chose "render the structured event stream" over a PTY or a tmux pane,
// because both alternatives buy visual fidelity by forcing the vendor CLI into
// interactive mode — and interactive mode is mutually exclusive with the
// structured output format, the result schema and the native budget ceiling this
// whole package depends on. The compensation D-11 promises is exactly what this
// module renders: a transcript that READS like a coding agent's own terminal
// (`● $ command` / `● Read: file.ts` / `  └ result`), plus the exact launch argv
// and a detach instruction so the operator can continue the session by hand.
//
// Everything here is pure: events in, lines out. No OpenTUI, no renderer, no
// clock, no store. `external-inspector.ts` is the only file that mounts these
// strings into a modal, which is what lets the whole surface be pinned by
// headless tests with no live TTY.
//
// Two rules exist because a plausible-looking shortcut is wrong:
//
//   1. A COST THE CLI DID NOT REPORT RENDERS AS `MISSING`, NEVER AS `0`. codex
//      reports no monetary cost at all (registry `reportsCost: false`), so a
//      zero would tell the operator a run was free when the truth is that
//      nobody counted. `usage.costUnits` is optional in the canonical event set
//      for the same reason.
//   2. THE TURN COUNT IS DERIVED AND SAYS SO. `num_turns` has no canonical home
//      (specification §6.2 flags this explicitly), so the modal meets R26 from
//      the transcript it already renders. Labelling it "derived" keeps a
//      reconstructed number from being read as a vendor-reported one.
import type { ExternalEvent, ExternalSandbox } from "../harness/external/types";

/** Rendered where a cost figure is genuinely absent. Never `0`, never `—`. */
export const EXTERNAL_COST_MISSING = "MISSING";

/** Shown in Work before the child has produced anything. */
export const EXTERNAL_TRANSCRIPT_EMPTY = "(no events yet)";

/** Longest tool-result body kept per event, in lines. Beyond it, a `+N lines` note. */
export const MAX_RESULT_LINES = 6;

/** Glyphs. Chosen to match the subagent sidebar's existing vocabulary (`●`, `✗`). */
const GLYPH = {
  call: "●",
  result: "└",
  thinking: "✻",
  retry: "⟳",
  operator: "›",
  failed: "✗",
} as const;

/**
 * Keys a tool input JSON blob is searched for, in order, to name the tool's
 * TARGET. `claude` carries the whole input object as the `tool_call` detail (the
 * `scope_drift` trigger reads the path out of it), so the transcript would
 * otherwise show `Read: {"file_path":"/very/long/…"}` where the operator wants
 * `Read: src/tui/main-queue.ts`.
 */
const TARGET_KEYS: readonly string[] = [
  "command",
  "file_path",
  "notebook_path",
  "path",
  "pattern",
  "query",
  "url",
  "prompt",
  "description",
];

/** Tool names whose call renders as a shell line (`● $ …`) rather than `Name: target`. */
const SHELL_TOOL_NAMES: readonly string[] = ["command_execution", "bash", "shell", "run_command"];

/** What a folded transcript knows that no single event does. */
export interface ExternalTranscriptSummary {
  /** Number of `tool_call` events. */
  readonly toolCalls: number;
  /** Number of non-terminal `retry` observations. Retry noise is not failure (§6.2). */
  readonly retries: number;
  /**
   * Assistant messages, used as the turn count. DERIVED: `num_turns` has no
   * canonical home (§6.2), so this is reconstructed from the transcript and is
   * always labelled as such where it is displayed.
   */
  readonly turns: number;
  /** Last reported cost. Absent means the CLI reported none — render {@link EXTERNAL_COST_MISSING}. */
  readonly costUnits?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** The agent's resume handle, once it announced one. */
  readonly sessionRef?: string;
  /** Operator messages delivered into this run (§7.5 / D-09). */
  readonly operatorMessages: number;
  /** The terminal event, when one arrived. Absent means the run is still live. */
  readonly outcome?:
    | { readonly kind: "finished"; readonly text?: string }
    | { readonly kind: "failed"; readonly message: string };
}

/**
 * Fold an event sequence into the counters the Meta view and the transcript
 * footer need. Pure; safe to call on every repaint.
 */
export function foldExternalTranscript(events: readonly ExternalEvent[]): ExternalTranscriptSummary {
  let toolCalls = 0;
  let retries = 0;
  let turns = 0;
  let operatorMessages = 0;
  let costUnits: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let sessionRef: string | undefined;
  let outcome: ExternalTranscriptSummary["outcome"];

  for (const event of events) {
    switch (event.kind) {
      case "child_started":
        if (event.sessionRef !== undefined) sessionRef = event.sessionRef;
        break;
      case "tool_call":
        toolCalls += 1;
        break;
      case "assistant_text":
        turns += 1;
        break;
      case "user_message":
        operatorMessages += 1;
        break;
      case "retry":
        retries += 1;
        break;
      case "usage":
        // Last one wins, and an ABSENT figure never overwrites a present one:
        // a `usage` event carrying only tokens must not erase a cost reported
        // earlier in the same run.
        if (event.costUnits !== undefined) costUnits = event.costUnits;
        if (event.inputTokens !== undefined) inputTokens = event.inputTokens;
        if (event.outputTokens !== undefined) outputTokens = event.outputTokens;
        break;
      case "child_finished":
        outcome = event.text === undefined ? { kind: "finished" } : { kind: "finished", text: event.text };
        break;
      case "child_failed":
        outcome = { kind: "failed", message: event.message };
        break;
      default:
        break;
    }
  }

  return {
    toolCalls,
    retries,
    turns,
    operatorMessages,
    ...(costUnits === undefined ? {} : { costUnits }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(sessionRef === undefined ? {} : { sessionRef }),
    ...(outcome === undefined ? {} : { outcome }),
  };
}

/** Knobs for {@link renderExternalTranscript}. All optional; defaults suit the modal. */
export interface ExternalTranscriptOptions {
  /** Clip every line to this many columns. Omitted means no clipping. */
  readonly width?: number;
  /** Append the `N tool calls · N turns · …` footer. Default true. */
  readonly summary?: boolean;
  /** Lines kept per tool result before the `+N lines` note. Default {@link MAX_RESULT_LINES}. */
  readonly maxResultLines?: number;
}

/**
 * Fold canonical events into a live transcript, one string per line.
 *
 * The shape is deliberate (D-11): a coding agent's transcript IS a sequence of
 * tool calls and results, so rendering the same events in that shape is what
 * makes a structured view read like watching a terminal. What it loses — the
 * vendor's spinners, colours and layout — is not information.
 */
export function renderExternalTranscript(
  events: readonly ExternalEvent[],
  options: ExternalTranscriptOptions = {},
): string[] {
  const maxResultLines = options.maxResultLines ?? MAX_RESULT_LINES;
  const lines: string[] = [];

  for (const event of events) {
    switch (event.kind) {
      case "child_started":
        lines.push(
          event.sessionRef === undefined
            ? `${GLYPH.call} started`
            : `${GLYPH.call} started · session ${event.sessionRef}`,
        );
        break;
      case "tool_call":
        lines.push(`${GLYPH.call} ${describeToolCall(event.name, event.detail)}`);
        break;
      case "tool_result":
        lines.push(...renderResult(event.detail, maxResultLines));
        break;
      case "assistant_text":
        lines.push(...textLines(event.text));
        break;
      case "thinking":
        lines.push(...prefixed(event.text, `${GLYPH.thinking} `, "  "));
        break;
      case "user_message":
        // The operator's own message, rendered inline so the transcript shows
        // WHEN it landed relative to the child's work (D-09).
        lines.push(...prefixed(event.text, `${GLYPH.operator} `, "  "));
        break;
      case "retry":
        // Non-terminal by construction (§6.2): both CLIs emit these in bulk
        // while retrying, and a reader must not mistake them for a dead run.
        lines.push(`${GLYPH.retry} ${event.message}`);
        break;
      case "usage":
        // Folded into the footer and Meta, not narrated: a token line between
        // every tool call would bury the work the operator came to watch.
        break;
      case "child_finished":
        lines.push(`${GLYPH.call} finished`);
        if (event.text !== undefined) lines.push(...textLines(event.text).map((line) => `  ${line}`));
        break;
      case "child_failed":
        lines.push(`${GLYPH.failed} ${event.message}`);
        break;
      default:
        break;
    }
  }

  if (lines.length === 0) lines.push(EXTERNAL_TRANSCRIPT_EMPTY);
  if (options.summary !== false && events.length > 0) {
    lines.push("", formatTranscriptFooter(foldExternalTranscript(events)));
  }
  return options.width === undefined ? lines : lines.map((line) => clip(line, options.width ?? 0));
}

/** The Work tab body: {@link renderExternalTranscript} as one string. */
export function formatExternalWork(
  events: readonly ExternalEvent[],
  options: ExternalTranscriptOptions = {},
): string {
  return renderExternalTranscript(events, options).join("\n");
}

/**
 * The transcript footer. Retries, cost and the derived turn count in one line,
 * so the operator sees the run's shape without opening Meta.
 */
export function formatTranscriptFooter(summary: ExternalTranscriptSummary): string {
  const parts = [
    plural(summary.toolCalls, "tool call"),
    `${plural(summary.turns, "turn")} (derived)`,
    plural(summary.retries, "retry", "retries"),
    `cost ${formatCostUnits(summary.costUnits)}`,
  ];
  if (summary.operatorMessages > 0) parts.push(plural(summary.operatorMessages, "operator message"));
  const status =
    summary.outcome === undefined
      ? "running"
      : summary.outcome.kind === "finished"
        ? "finished"
        : "failed";
  return `── ${status} · ${parts.join(" · ")}`;
}

/**
 * A cost figure, or {@link EXTERNAL_COST_MISSING}.
 *
 * `0` is a REPORTED zero and prints as `0`; `undefined` is "nobody counted" and
 * prints as MISSING. Collapsing the two is the failure this function exists to
 * prevent — codex reports no cost at all, so every codex run would otherwise
 * read as free.
 */
export function formatCostUnits(costUnits: number | undefined): string {
  if (costUnits === undefined || !Number.isFinite(costUnits)) return EXTERNAL_COST_MISSING;
  return costUnits.toFixed(4);
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

/**
 * Everything the operator surface knows about one external run.
 *
 * Assembled by the caller from the dispatch (`agentId`, `model`, `sandbox`), the
 * worktree port (`worktreePath`), the live event stream (`events`) and, once the
 * run ends, `ExternalChildOutcome` (`argv`, `sessionRef`, `costUnits`,
 * `skippedLines`). Nothing here is fetched: this module stays pure.
 */
export interface ExternalRunView {
  /** Stable id for this run — the sidebar/inspector key. */
  readonly id: string;
  readonly agentId: string;
  /** Registry label (`Codex`, `Claude`). Falls back to `agentId` when absent. */
  readonly agentLabel?: string;
  /** Omitted means the CLI resolved its own default under the active subscription. */
  readonly model?: string;
  readonly sandbox?: ExternalSandbox;
  /** Absolute path of the disposable worktree the child ran in (§7.2). */
  readonly worktreePath?: string;
  /** The exact launch argv (`ExternalChildOutcome.argv`). */
  readonly argv?: readonly string[];
  /** Argv that continues this session by hand, when a resume handle exists. */
  readonly resumeArgv?: readonly string[];
  /**
   * Resume handle: keryx ASSIGNS it for claude (`--session-id`) and READS it for
   * codex (`thread_id`, only after `thread.started`). Absent means no resume.
   */
  readonly sessionRef?: string;
  /** `false` for an agent that reports no monetary cost — turns MISSING into an explained MISSING. */
  readonly reportsCost?: boolean;
  /** Cost from `ExternalChildOutcome`, when the run has ended. */
  readonly costUnits?: number;
  /** Lines the codec did not recognise — the version-drift signal (§6.2). */
  readonly skippedLines?: number;
  /** Recorded warnings (out-of-range CLI version, truncated diff). Never thrown. */
  readonly warnings?: readonly string[];
  /** Completion status once known; omitted while the run is live. */
  readonly status?: string;
  readonly events: readonly ExternalEvent[];
}

/**
 * The Meta tab body (§8.2): agent, model, sandbox, session handle, cost, turns,
 * worktree path, parse-skip count and any recorded warning.
 */
export function formatExternalMeta(view: ExternalRunView): string {
  const summary = foldExternalTranscript(view.events);
  const sessionRef = view.sessionRef ?? summary.sessionRef;
  const cost = view.costUnits ?? summary.costUnits;
  const rows: Array<[string, string]> = [
    ["Agent", view.agentLabel === undefined ? view.agentId : `${view.agentLabel} (${view.agentId})`],
    ["Model", view.model ?? "(CLI default)"],
    ["Sandbox", view.sandbox ?? "—"],
    ["Status", view.status ?? (summary.outcome === undefined ? "running" : summary.outcome.kind)],
    // "no resume handle" is a real, load-bearing state: a codex run killed
    // before `thread.started` cannot be resumed AT ALL, and `force` on it
    // degrades to a plain kill (§7.5).
    ["Session", sessionRef ?? "(none announced — this run cannot be resumed)"],
    ["Cost", describeCost(cost, view.reportsCost)],
    ["Turns", `${summary.turns} (derived from transcript; the CLI reports none)`],
    ["Tokens", describeTokens(summary)],
    ["Worktree", view.worktreePath ?? "—"],
    ["Parse skips", describeSkips(view.skippedLines)],
  ];
  const warnings = view.warnings ?? [];
  rows.push(["Warnings", warnings.length === 0 ? "(none)" : warnings[0] ?? "(none)"]);

  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  const lines = rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
  // Extra warnings hang under the first, aligned, rather than being dropped —
  // a truncated-diff warning and a version warning can both apply to one run.
  for (const extra of warnings.slice(1)) lines.push(`${" ".repeat(width)}  ${extra}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * The Command tab body (§8.2, D-11's compensation): the exact launch argv, a
 * copy-pasteable shell form, and the detach instruction.
 *
 * The detach block is the whole point of the tab. The modal is not a terminal,
 * so the escape hatch has to be explicit: with the argv and the session handle
 * an operator can reproduce the run, or continue THIS session by hand in a real
 * terminal. Where no handle was ever announced the block says so instead of
 * printing a command that cannot work.
 */
export function formatExternalCommand(view: ExternalRunView): string {
  const lines: string[] = ["Launch argv"];
  const argv = view.argv ?? [];
  if (argv.length === 0) {
    lines.push("  (not recorded — the run was refused before a process was built)");
  } else {
    argv.forEach((arg, index) => {
      lines.push(`  ${String(index + 1).padStart(2)}  ${arg}`);
    });
    lines.push("", "Shell form", `  ${shellQuote(argv)}`);
  }

  lines.push("", "Detach");
  const sessionRef = view.sessionRef ?? foldExternalTranscript(view.events).sessionRef;
  if (view.worktreePath !== undefined) {
    lines.push(`  cd ${shellQuoteArg(view.worktreePath)}`);
    lines.push("  # the worktree is removed when the run ends; copy anything you need first");
  }
  if (view.resumeArgv !== undefined && view.resumeArgv.length > 0) {
    lines.push(`  ${shellQuote(view.resumeArgv)}`);
  } else if (sessionRef !== undefined) {
    lines.push(`  # session handle: ${sessionRef}`);
    lines.push("  # resume this session with the agent's own resume command");
  } else {
    lines.push("  # no session handle was announced, so this run cannot be continued by hand");
  }
  return lines.join("\n");
}

/** Join argv into one copy-pasteable shell command, quoting where a shell would need it. */
export function shellQuote(argv: readonly string[]): string {
  return argv.map(shellQuoteArg).join(" ");
}

/**
 * Quote one argv element for a POSIX shell.
 *
 * Single quotes with the `'\''` escape, because the prompt argument routinely
 * contains newlines, double quotes and `$` — a double-quoted form would let the
 * shell expand them and the operator would not reproduce the run they watched.
 */
export function shellQuoteArg(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Name one tool call the way a terminal would show it.
 *
 * Shell-shaped tools render as `$ command`; everything else renders as
 * `Name: target`, with the target lifted out of the JSON input blob so the
 * operator sees `Read: src/x.ts` rather than the raw object.
 */
export function describeToolCall(name: string, detail: string | undefined): string {
  const target = extractTarget(detail);
  if (SHELL_TOOL_NAMES.includes(name.toLowerCase())) {
    return target === undefined ? "$ (command not reported)" : `$ ${target}`;
  }
  return target === undefined ? name : `${name}: ${target}`;
}

/**
 * Pull a human target out of a tool detail.
 *
 * The detail is either a raw string (codex `command_execution`) or a JSON object
 * (claude `tool_use.input`). Unparseable JSON falls back to the raw string —
 * losing the target is acceptable, dropping the line is not.
 */
function extractTarget(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const trimmed = detail.trim();
  if (trimmed.length === 0) return undefined;
  if (!trimmed.startsWith("{")) return firstLineOf(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return firstLineOf(trimmed);
  }
  if (typeof parsed !== "object" || parsed === null) return firstLineOf(trimmed);
  const record = parsed as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return firstLineOf(value.trim());
  }
  return firstLineOf(trimmed);
}

function firstLineOf(value: string): string {
  const [first = ""] = value.split("\n");
  const rest = value.includes("\n") ? " …" : "";
  return `${first}${rest}`;
}

/** `  └ result` plus indented continuation lines, capped with a `+N lines` note. */
function renderResult(detail: string | undefined, maxResultLines: number): string[] {
  if (detail === undefined || detail.trim().length === 0) return [`  ${GLYPH.result} (no output)`];
  const all = detail.split("\n");
  const kept = all.slice(0, Math.max(1, maxResultLines));
  const lines = kept.map((line, index) => (index === 0 ? `  ${GLYPH.result} ${line}` : `    ${line}`));
  const dropped = all.length - kept.length;
  if (dropped > 0) lines.push(`    … +${dropped} more ${dropped === 1 ? "line" : "lines"}`);
  return lines;
}

/** Split text into lines, dropping a wholly empty payload. */
function textLines(text: string): string[] {
  if (text.trim().length === 0) return [];
  return text.split("\n");
}

/** First line gets `head`, continuations get `cont`. */
function prefixed(text: string, head: string, cont: string): string[] {
  const lines = textLines(text);
  return lines.map((line, index) => (index === 0 ? `${head}${line}` : `${cont}${line}`));
}

function describeCost(costUnits: number | undefined, reportsCost: boolean | undefined): string {
  if (costUnits !== undefined && Number.isFinite(costUnits)) return formatCostUnits(costUnits);
  return reportsCost === false
    ? `${EXTERNAL_COST_MISSING} (this CLI reports no cost)`
    : EXTERNAL_COST_MISSING;
}

function describeTokens(summary: ExternalTranscriptSummary): string {
  const parts: string[] = [];
  if (summary.inputTokens !== undefined) parts.push(`in ${summary.inputTokens}`);
  if (summary.outputTokens !== undefined) parts.push(`out ${summary.outputTokens}`);
  return parts.length === 0 ? EXTERNAL_COST_MISSING : parts.join(" · ");
}

/** Parse skips are a drift SIGNAL, so "not counted" and "zero" must stay distinct. */
function describeSkips(skippedLines: number | undefined): string {
  if (skippedLines === undefined) return "(not counted)";
  return skippedLines === 0 ? "0" : `${skippedLines} (possible CLI version drift)`;
}

function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

function clip(value: string, width: number): string {
  if (width <= 0 || value.length <= width) return value;
  return `${value.slice(0, Math.max(1, width - 1))}…`;
}
