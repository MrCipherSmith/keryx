// Per-turn and per-session usage totals for the TUI footer and the /status Usage tab (flow 483).
// Pure and renderer-free: the shell feeds it provider usage reports and reads a snapshot.

export interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  /** Undefined while no priced turn was seen (unknown is not zero). */
  costUsd: number | undefined;
  /** Active time in ms: the running turn counts up to `now`. */
  activeMs: number;
}

export interface UsageSnapshot {
  turn: UsageTotals;
  session: UsageTotals;
  turnRunning: boolean;
  turns: number;
}

export interface UsageReport {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}

export interface UsageTracker {
  startTurn(): void;
  addUsage(report: UsageReport): void;
  /** The turn's total cost, or undefined when the model has no known price. */
  setTurnCost(costUsd: number | undefined): void;
  endTurn(): void;
  snapshot(): UsageSnapshot;
}

interface Acc {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | undefined;
}

const emptyAcc = (): Acc => ({ tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: undefined });
const sumCost = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

export function createUsageTracker(opts: { now?: () => number } = {}): UsageTracker {
  const now = opts.now ?? Date.now;
  let turn = emptyAcc();
  let ended = emptyAcc();
  let endedMs = 0;
  let lastTurnMs = 0;
  let startedAt: number | undefined;
  let turns = 0;

  const withTurn = (): Acc => ({
    tokensIn: ended.tokensIn + turn.tokensIn,
    tokensOut: ended.tokensOut + turn.tokensOut,
    cacheRead: ended.cacheRead + turn.cacheRead,
    cacheWrite: ended.cacheWrite + turn.cacheWrite,
    costUsd: sumCost(ended.costUsd, turn.costUsd),
  });

  return {
    startTurn() {
      turn = emptyAcc();
      startedAt = now();
    },
    addUsage(report) {
      turn.tokensIn += report.inputTokens ?? 0;
      turn.tokensOut += report.outputTokens ?? 0;
      turn.cacheRead += report.cacheReadTokens ?? 0;
      turn.cacheWrite += report.cacheWriteTokens ?? 0;
    },
    setTurnCost(costUsd) {
      turn.costUsd = costUsd;
    },
    endTurn() {
      if (startedAt === undefined) return;
      lastTurnMs = Math.max(0, now() - startedAt);
      endedMs += lastTurnMs;
      ended = withTurn();
      startedAt = undefined;
      turns += 1;
    },
    snapshot() {
      const running = startedAt !== undefined;
      const turnMs = running ? Math.max(0, now() - (startedAt as number)) : lastTurnMs;
      const session = running ? withTurn() : ended;
      return {
        turn: { ...turn, activeMs: turnMs },
        session: { ...session, activeMs: endedMs + (running ? turnMs : 0) },
        turnRunning: running,
        turns,
      };
    },
  };
}
