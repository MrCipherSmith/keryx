// Supervision trigger detection — the pure fold behind §7.6 (flow 176, T21).
// Package: docs/requirements/keryx-external-agent-runtime §7.6, AC12.
//
// specification.md §7.6 names five triggers the parent agent reacts to
// (`phase_changed`, `budget_threshold`, `no_progress`, `agent_asked`,
// `scope_drift`) and was explicit that none of them existed yet ("NOT
// IMPLEMENTED as of 0.4.0"). This file is the detector; `supervise.ts` wires it
// into the live event stream.
//
// Pure, mirroring `foldExternalTranscript` (`src/tui/external-transcript.ts`):
// a single-pass `events in, triggers out` function with no clock of its own —
// `now` and the run's start time arrive as parameters, so a fixture-based test
// can pin an exact millisecond with no real timer.
//
// AC12 reads: "a fixture transcript of N events produces at most one parent
// update per trigger condition." This function honours that literally —
// {@link detectSupervisionTriggers} returns AT MOST ONE {@link SupervisionTrigger}
// per {@link SupervisionTriggerKind}, every time it is called, regardless of how
// many times the underlying condition was independently satisfied in the
// transcript (e.g. three tool calls only ever produce one `phase_changed`). It
// has no memory of prior calls: a live caller that wants "only NEWLY fired
// triggers" must diff against what it already reported — see `supervise.ts`'s
// `firedSupervisionTriggers` set, which does exactly that and is deliberately
// NOT duplicated here.
//
// `ExternalEvent` (`./types.ts`) carries no timestamp on any variant, so a pure
// fold over `events[]` alone cannot know "how long since the last event" — only
// "how long since the run started" (`now() - runStartedAt`). Genuine no_progress
// detection needs "time since the last event", which only a LIVE caller can
// track (a local variable updated every time a new event arrives), so that value
// arrives here as the explicit `sinceLastEventMs` parameter rather than being
// derived from `runStartedAt` — keeping the live-vs-fixture distinction visible
// in the signature instead of hidden inside an approximation.
import { isPathInside } from "../../lib/fs";
import { isTerminalEvent, type ExternalEvent } from "./types";

/** The five triggers named in specification.md §7.6. */
export type SupervisionTriggerKind =
  | "phase_changed"
  | "budget_threshold"
  | "no_progress"
  | "agent_asked"
  | "scope_drift";

/** One fired trigger. */
export interface SupervisionTrigger {
  readonly kind: SupervisionTriggerKind;
  /** Human-readable detail for the operator/parent (e.g. which phase, which path, elapsed ms). */
  readonly message: string;
}

/** Tunables {@link detectSupervisionTriggers} needs, supplied once per run. */
export interface SupervisionConfig {
  /** Fraction of maxCostUnits/timeoutMs that counts as "threshold crossed". */
  readonly budgetThresholdFraction: number;
  /** Milliseconds of silence (no new canonical event) that counts as no_progress. */
  readonly noProgressIntervalMs: number;
  /** The dispatch's declared scope — a single path prefix (the worktree cwd) events must stay under. */
  readonly declaredScopePath: string;
  /** Native budget ceiling, when the dispatch has one. Absent means cost-based budget_threshold never fires. */
  readonly maxCostUnits?: number;
  /** Wall-clock ceiling for this run, for the elapsed-time half of budget_threshold. */
  readonly timeoutMs: number;
}

/**
 * Detects which of §7.6's five triggers the transcript-so-far satisfies, given
 * the run's start time, "now", and how long it has been since the last
 * canonical event arrived (tracked by the caller — see the module header).
 *
 * Pure given `now` and `sinceLastEventMs`: the same fixed transcript and the
 * same two numbers always yield the same firings. Returns AT MOST ONE firing
 * per {@link SupervisionTriggerKind} (AC12), computed fresh from the whole
 * transcript every call — this function has no memory of prior calls; a
 * caller that wants only newly-fired triggers must dedup itself.
 */
export function detectSupervisionTriggers(
  events: readonly ExternalEvent[],
  config: SupervisionConfig,
  runStartedAt: Date,
  now: () => Date,
  sinceLastEventMs: number,
): SupervisionTrigger[] {
  const triggers: SupervisionTrigger[] = [];

  const phaseChanged = detectPhaseChanged(events);
  if (phaseChanged !== undefined) triggers.push(phaseChanged);

  const budgetThreshold = detectBudgetThreshold(events, config, runStartedAt, now);
  if (budgetThreshold !== undefined) triggers.push(budgetThreshold);

  const noProgress = detectNoProgress(config, sinceLastEventMs);
  if (noProgress !== undefined) triggers.push(noProgress);

  const agentAsked = detectAgentAsked(events);
  if (agentAsked !== undefined) triggers.push(agentAsked);

  const scopeDrift = detectScopeDrift(events, config);
  if (scopeDrift !== undefined) triggers.push(scopeDrift);

  return triggers;
}

// ---------------------------------------------------------------------------
// phase_changed — first tool call, first assistant text, terminal event
// ---------------------------------------------------------------------------

/**
 * The most ADVANCED phase reached in the transcript so far, in the order
 * §7.6's table lists them (tool call, assistant text, terminal) — terminal
 * implies the other two already happened, so it wins when present.
 */
function detectPhaseChanged(events: readonly ExternalEvent[]): SupervisionTrigger | undefined {
  let firstToolCallName: string | undefined;
  let sawAssistantText = false;
  let terminal: ExternalEvent | undefined;

  for (const event of events) {
    if (event.kind === "tool_call" && firstToolCallName === undefined) firstToolCallName = event.name;
    if (event.kind === "assistant_text") sawAssistantText = true;
    if (terminal === undefined && isTerminalEvent(event)) terminal = event;
  }

  if (terminal !== undefined) {
    const detail = terminal.kind === "child_failed" ? `failed: ${terminal.message}` : "finished";
    return { kind: "phase_changed", message: `run reached its terminal phase (${detail})` };
  }
  if (firstToolCallName !== undefined) {
    return { kind: "phase_changed", message: `first tool call: ${firstToolCallName}` };
  }
  if (sawAssistantText) {
    return { kind: "phase_changed", message: "first assistant message" };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// budget_threshold — reported cost OR elapsed time crosses a configured fraction
// ---------------------------------------------------------------------------

function detectBudgetThreshold(
  events: readonly ExternalEvent[],
  config: SupervisionConfig,
  runStartedAt: Date,
  now: () => Date,
): SupervisionTrigger | undefined {
  if (config.maxCostUnits !== undefined) {
    const cost = latestCostUnits(events);
    const costCeiling = config.maxCostUnits * config.budgetThresholdFraction;
    if (cost !== undefined && cost >= costCeiling) {
      return {
        kind: "budget_threshold",
        message: `reported cost ${cost} crossed ${(config.budgetThresholdFraction * 100).toFixed(0)}% of the ${config.maxCostUnits}-unit ceiling`,
      };
    }
  }

  const elapsedMs = now().getTime() - runStartedAt.getTime();
  const timeCeiling = config.timeoutMs * config.budgetThresholdFraction;
  if (elapsedMs >= timeCeiling) {
    return {
      kind: "budget_threshold",
      message: `elapsed ${elapsedMs}ms crossed ${(config.budgetThresholdFraction * 100).toFixed(0)}% of the ${config.timeoutMs}ms timeout`,
    };
  }
  return undefined;
}

/** Last reported cost. Mirrors `runtime.ts`'s `findCostUnits`, kept local to avoid a cyclic import. */
function latestCostUnits(events: readonly ExternalEvent[]): number | undefined {
  let cost: number | undefined;
  for (const event of events) {
    if (event.kind === "usage" && event.costUnits !== undefined) cost = event.costUnits;
  }
  return cost;
}

// ---------------------------------------------------------------------------
// no_progress — no canonical event within a configured interval
// ---------------------------------------------------------------------------

/**
 * `sinceLastEventMs` is supplied by the caller (see module header): a pure
 * fold over `events[]` alone has no timestamps to compute it from.
 */
function detectNoProgress(config: SupervisionConfig, sinceLastEventMs: number): SupervisionTrigger | undefined {
  if (sinceLastEventMs < config.noProgressIntervalMs) return undefined;
  return {
    kind: "no_progress",
    message: `no canonical event for ${sinceLastEventMs}ms, past the ${config.noProgressIntervalMs}ms interval`,
  };
}

// ---------------------------------------------------------------------------
// agent_asked — assistant text classified as a question rather than work
// ---------------------------------------------------------------------------

const QUESTION_STARTERS: readonly string[] = [
  "what ",
  "why ",
  "how ",
  "should ",
  "could ",
  "would ",
  "can ",
  "do you",
  "did you",
  "is it",
  "are you",
  "which ",
  "who ",
  "when ",
  "where ",
  "may i",
  "shall i",
];

/**
 * Whether an assistant message reads as a question aimed at the operator
 * rather than a work update.
 *
 * A KNOWN HEURISTIC WEAKNESS, stated rather than hidden — mirrors
 * `DENIED_CAUSE_MARKERS` in `runtime.ts`, which documents its own string-match
 * weakness the same way. A trailing "?" or a leading question word is a
 * strong but imperfect signal: a rhetorical "why does this pass?" inside an
 * explanation reads as a question, and a genuine request phrased without a
 * "?" or a listed starter reads as work. A false positive costs one
 * unnecessary parent update; a false negative costs a missed one. Neither
 * corrupts the run's result.
 */
function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith("?")) return true;
  const lower = trimmed.toLowerCase();
  return QUESTION_STARTERS.some((starter) => lower.startsWith(starter));
}

function detectAgentAsked(events: readonly ExternalEvent[]): SupervisionTrigger | undefined {
  for (const event of events) {
    if (event.kind === "assistant_text" && looksLikeQuestion(event.text)) {
      return { kind: "agent_asked", message: `assistant text reads as a question: ${firstLine(event.text)}` };
    }
  }
  return undefined;
}

function firstLine(text: string): string {
  const [first = ""] = text.trim().split("\n");
  return first;
}

// ---------------------------------------------------------------------------
// scope_drift — tool call targets a path outside the dispatch's declared scope
// ---------------------------------------------------------------------------

/**
 * Keys a tool_call's `detail` JSON is searched for a path, in priority order.
 * Deliberately narrower than `external-transcript.ts`'s `TARGET_KEYS`: that
 * list also matches `command`, `pattern`, `query`, etc. for DISPLAY purposes,
 * where a non-path value is harmless. Here a non-path value would make
 * `scope_drift` fire (or fail to fire) on the wrong grounds, so only keys that
 * are genuinely path-shaped are considered.
 */
const SCOPE_PATH_KEYS: readonly string[] = ["file_path", "notebook_path", "path"];

/**
 * Pull a candidate path out of a tool_call's detail, or `undefined` if none is
 * present. `detail` is either a raw string (codex `command_execution`) or a
 * JSON object (claude `tool_use.input`); unparseable or non-object JSON yields
 * no candidate rather than a guess, because a wrong guess here means a false
 * `scope_drift` firing, not just a cosmetic label.
 */
function extractToolCallPath(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const trimmed = detail.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  for (const key of SCOPE_PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * `scope_drift` fires only for an ABSOLUTE candidate path outside
 * `config.declaredScopePath`. A relative path or a shell command string
 * cannot be judged against a scope prefix without resolving it against a cwd
 * this function does not have, so those are skipped rather than guessed at.
 *
 * The containment check is `isPathInside` (`src/lib/fs.ts`), which compares
 * via `path.relative` and rejects a result starting with `..` — a real
 * path-boundary check, not a string prefix. `/wt/wt-1-evil` is NOT inside
 * `/wt/wt-1` under this check, even though `/wt/wt-1` is a string prefix of
 * it; a naive `.startsWith()` comparison would get that case wrong.
 */
function detectScopeDrift(
  events: readonly ExternalEvent[],
  config: SupervisionConfig,
): SupervisionTrigger | undefined {
  for (const event of events) {
    if (event.kind !== "tool_call") continue;
    const target = extractToolCallPath(event.detail);
    if (target === undefined || !target.startsWith("/")) continue;
    if (isPathInside(config.declaredScopePath, target)) continue;
    return {
      kind: "scope_drift",
      message: `tool call "${event.name}" targeted "${target}", outside the declared scope "${config.declaredScopePath}"`,
    };
  }
  return undefined;
}
