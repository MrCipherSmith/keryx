// Per-turn model statistics for the game modals ("agent stats" panel).
//
// Pure data + formatting, no OpenTUI: tests assert on these without a
// renderer. Each model turn contributes one AgentTurnStats; the modal keeps a
// per-game AgentTurnTotals accumulator so the operator can see, at a glance,
// how much time and how many tokens the model is spending on a game — the
// point of the /game modal is to visualise agent latency and cost.

export interface AgentTurnStats {
  /** Provider that answered (e.g. "deepseek"). */
  provider: string;
  /** Model id that answered (e.g. "deepseek-chat"). */
  model: string;
  /** Milliseconds from request start to first stream byte. */
  latencyMs: number | undefined;
  /** Milliseconds from request start to completion. */
  totalMs: number | undefined;
  /** Input tokens, provider-reported. */
  inputTokens: number | undefined;
  /** Output tokens, provider-reported. */
  outputTokens: number | undefined;
  /** True when the provider emitted reasoning (chain-of-thought). */
  reasoning: boolean;
  /** True when this turn ended in a local fallback (timeout / bad reply). */
  localFallback: boolean;
  /** True when this turn ended in a hard error (no credential, provider). */
  error: boolean;
}

export interface AgentTurnTotals {
  turns: number;
  latencyMs: number | undefined;
  totalMs: number | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  localFallbacks: number;
  errors: number;
}

export function emptyTurnTotals(): AgentTurnTotals {
  return {
    turns: 0,
    latencyMs: undefined,
    totalMs: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    localFallbacks: 0,
    errors: 0,
  };
}

function addMaybe(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  return (a ?? 0) + (b ?? 0);
}

export function addTurn(totals: AgentTurnTotals, turn: AgentTurnStats): AgentTurnTotals {
  return {
    turns: totals.turns + 1,
    latencyMs: addMaybe(totals.latencyMs, turn.latencyMs),
    totalMs: addMaybe(totals.totalMs, turn.totalMs),
    inputTokens: addMaybe(totals.inputTokens, turn.inputTokens),
    outputTokens: addMaybe(totals.outputTokens, turn.outputTokens),
    localFallbacks: totals.localFallbacks + (turn.localFallback ? 1 : 0),
    errors: totals.errors + (turn.error ? 1 : 0),
  };
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) {
    return "–";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined) {
    return "–";
  }
  if (n < 1000) {
    return `${n}`;
  }
  return `${(n / 1000).toFixed(1)}k`;
}
