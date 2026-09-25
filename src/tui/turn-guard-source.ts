// Flow 329: the turn-guard's shell-side wiring — a per-turn collector that
// observes `AgentIO`'s existing `onToolCall`/`onToolResult`/`onAssistantText`
// hooks (no new hook added to the agent driver itself), and the adapter that
// turns one collected transcript into a `TurnGuardResult` — deterministic
// facts always, a deterministic contradiction when one exists (AC3, decided
// without Jev), otherwise Jev's two `noul` answers (AC2) when the guard is
// enabled and the turn is not trivial (AC6).
//
// `src/tui/` is a CLIENT zone (`src/lib/import-zones.ts`) and may import both
// the CORE turn-guard module (`src/review/turn-guard.ts`) and the CLIENT-zone
// Jev client (`src/harness/decision/jev-client.ts`) freely — the same
// shape `ci-triage-source.ts` and `conform-source.ts` already use.
//
// Never throws: every failure mode (guard off, trivial turn, no credential,
// budget over cap, timeout, a malformed response) resolves to a
// `TurnGuardResult` whose `verdict.flagged` is `false` and whose `skipped`/
// `skipReason` says why — the caller (`tui-shell.ts`) awaits this AFTER the
// turn has already settled and fires it with `void`, so nothing here can
// delay the user's next prompt (AC2) or crash the shell.

import {
  buildTurnGuardQuestions,
  buildTurnGuardState,
  computeTurnGuardVerdict,
  detectTurnGuardContradiction,
  extractTurnGuardFacts,
  shouldSkipTurnGuard,
  TURN_GUARD_JEV_TIMEOUT_MS,
  type TurnGuardContradiction,
  type TurnGuardFacts,
  type TurnGuardToolCall,
  type TurnGuardTranscript,
  type TurnGuardVerdict,
} from "../review/turn-guard";
import { callJevSystemOne, DEFAULT_JEV_MODEL, preflightBudget, type JevUsage } from "../harness/decision/jev-client";

/** The bounded, content-returning shape every `AgentIO.onToolResult` call carries — kept structural so this file needs no `commands/agent.ts` import. */
export interface TurnGuardToolResultLike {
  readonly output: string;
  readonly isError: boolean;
}

/**
 * Accumulates one turn's transcript from the SAME `onToolCall`/`onToolResult`/
 * `onAssistantText` events the shell already wires for rendering (AC1: "after
 * an agent turn ends" — nothing here adds a new hook to `runAgentTurn`
 * itself). `reset` is called once at the START of a turn (the user's request
 * line becomes `userRequest`); `transcript()` is read once AFTER the turn has
 * settled.
 *
 * Tool calls and results are matched FIFO by name: `runAgentTurn` executes
 * one call at a time in this codebase (no concurrent tool execution within a
 * single turn today), so the first `onToolResult` for a given name always
 * belongs to the earliest still-pending `onToolCall` of that name.
 */
export interface TurnGuardCollector {
  reset(userRequest: string): void;
  onToolCall(name: string, input: string): void;
  onToolResult(name: string, result: TurnGuardToolResultLike): void;
  onAssistantText(text: string): void;
  transcript(): TurnGuardTranscript;
}

export function createTurnGuardCollector(): TurnGuardCollector {
  let userRequest = "";
  let finalMessage = "";
  let toolCalls: TurnGuardToolCall[] = [];
  let pending: Array<{ readonly name: string; readonly input: string }> = [];

  return {
    reset(request) {
      userRequest = request;
      finalMessage = "";
      toolCalls = [];
      pending = [];
    },
    onToolCall(name, input) {
      pending.push({ name, input });
    },
    onToolResult(name, result) {
      const idx = pending.findIndex((p) => p.name === name);
      const matched = idx === -1 ? undefined : pending.splice(idx, 1)[0];
      toolCalls.push({
        name,
        output: result.output,
        isError: result.isError,
        ...(matched?.input !== undefined ? { input: matched.input } : {}),
      });
    },
    onAssistantText(text) {
      // The LAST round's text is the turn's final assistant message (AC1) —
      // a multi-round turn (tool calls between rounds) fires this once per
      // round, and only the last one is the reply the user actually reads.
      finalMessage = text;
    },
    transcript: () => ({ userRequest, finalMessage, toolCalls: [...toolCalls] }),
  };
}

/**
 * PR #720 review item 3: insert `result` into `history` (newest-`at`-first)
 * at the position that keeps it sorted by `at`, not always at the front.
 * `tui-shell.ts` fires one guard call per turn with `void` (unawaited) right
 * after that turn settles, so a turn needing a real Jev round trip can
 * resolve AFTER a later, trivial/deterministic turn's near-instant guard
 * call — completion order does not track turn order. `result.at` (recorded
 * at the very START of `runTurnGuard`, before any Jev round trip) does,
 * so insertion order must follow it instead of always prepending.
 *
 * Extracted as a pure, exported function — same reasoning
 * `forceForegroundQueueItem` (`foreground-operation.ts`) documents at its own
 * definition: logic that lives only as a closure inside the un-launchable-
 * headlessly `launchTuiAgentShell` is visible to a test at best (a source-
 * text audit), never actually executed by one. Returns a NEW array, capped
 * to `cap`; `history` itself is left untouched.
 */
export function insertTurnGuardResult(history: readonly TurnGuardResult[], result: TurnGuardResult, cap: number): TurnGuardResult[] {
  const insertAt = history.findIndex((existing) => existing.at <= result.at);
  const next = insertAt === -1 ? [...history, result] : [...history.slice(0, insertAt), result, ...history.slice(insertAt)];
  return next.slice(0, cap);
}

export interface TurnGuardResult {
  /** Wall-clock ms this result was produced (history ordering/display only). */
  readonly at: number;
  readonly userRequest: string;
  readonly finalMessage: string;
  readonly facts: TurnGuardFacts;
  readonly verdict: TurnGuardVerdict;
  readonly usage?: JevUsage;
  /** True when Jev was never asked — guard off, trivial turn, or a Jev-side failure (see `skipReason`). */
  readonly skipped: boolean;
  readonly skipReason?: string;
}

export interface RunTurnGuardOptions {
  readonly enabled: boolean;
  readonly fetchFn?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dir?: string;
  readonly now?: () => number;
  /** Overrides {@link TURN_GUARD_JEV_TIMEOUT_MS} — a test-only seam (a hermetic test needs a short bound, not the real 8s). */
  readonly timeoutMs?: number;
}

function baseResult(transcript: TurnGuardTranscript, facts: TurnGuardFacts, at: number): Pick<TurnGuardResult, "at" | "userRequest" | "finalMessage" | "facts"> {
  return { at, userRequest: transcript.userRequest, finalMessage: transcript.finalMessage, facts };
}

/**
 * AC1-AC3/AC6: the one entry point `tui-shell.ts` calls after a turn settles.
 * Order of decisions, each one short-circuiting the rest:
 *
 * 1. Guard disabled (AC5, default) → facts only, nothing sent anywhere.
 * 2. A deterministic contradiction (AC3) → flagged immediately, no Jev call
 *    at all (saves the budget for turns that actually need Jev's judgement,
 *    and means AC3 holds even with `OPENROUTER_API_KEY` unset).
 * 3. A trivial turn (AC6: no tools, short exchange) → skipped, no Jev call.
 * 4. Otherwise, Jev's two `noul` questions (AC2), budget-preflighted and
 *    bounded by {@link TURN_GUARD_JEV_TIMEOUT_MS}. Any failure (no
 *    credential, over budget, timeout, malformed response) degrades to an
 *    unflagged, `skipped: true` result with the failure's message as
 *    `skipReason` — the guard never throws into the shell.
 */
export async function runTurnGuard(transcript: TurnGuardTranscript, opts: RunTurnGuardOptions): Promise<TurnGuardResult> {
  const now = opts.now ?? Date.now;
  const facts = extractTurnGuardFacts(transcript);
  const at = now();

  if (opts.enabled !== true) {
    return { ...baseResult(transcript, facts, at), verdict: { flagged: false, reason: "the guard is off." }, skipped: true, skipReason: "off" };
  }

  const contradiction: TurnGuardContradiction | undefined = detectTurnGuardContradiction(facts, transcript.finalMessage);
  if (contradiction !== undefined) {
    return { ...baseResult(transcript, facts, at), verdict: computeTurnGuardVerdict({ contradiction }), skipped: false };
  }

  if (shouldSkipTurnGuard(transcript, facts)) {
    return {
      ...baseResult(transcript, facts, at),
      verdict: { flagged: false, reason: "a trivial turn (no tools called, short exchange) — skipped." },
      skipped: true,
      skipReason: "trivial",
    };
  }

  const state = buildTurnGuardState(transcript, facts);
  const questions = buildTurnGuardQuestions();
  try {
    preflightBudget(state, questions);
    const result = await callJevSystemOne(
      opts.fetchFn ?? globalThis.fetch,
      { model: DEFAULT_JEV_MODEL, state, questions },
      {
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
        timeoutMs: opts.timeoutMs ?? TURN_GUARD_JEV_TIMEOUT_MS,
      },
    );
    const doneAnswer = result.answers.done;
    const contradictionAnswer = result.answers.contradiction;
    const verdict = computeTurnGuardVerdict({
      jevAnswers: {
        ...(doneAnswer?.type === "noul" ? { done: doneAnswer.noul } : {}),
        ...(contradictionAnswer?.type === "noul" ? { contradiction: contradictionAnswer.noul } : {}),
      },
    });
    return { ...baseResult(transcript, facts, at), verdict, usage: result.usage, skipped: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ...baseResult(transcript, facts, at), verdict: { flagged: false, reason: `not checked (${reason})` }, skipped: true, skipReason: reason };
  }
}
