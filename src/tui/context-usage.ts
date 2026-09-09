// Honest context-window view for /status. A window is shown only when the
// provider reported one (live `/models` / Ollama `/api/show`). Missing stays
// missing — never a guessed 128k.

export type ContextSegment = {
  id: string;
  label: string;
  tokens: number;
};

export type ContextUsageView = {
  total: number;
  estimated: boolean;
  window?: number;
  usedPct?: number;
  free?: number;
  segments: ContextSegment[];
  bar: string;
  note: string;
};

export const CONTEXT_BAR_WIDTH = 28;

export type ContextUsageSource = {
  estimateTokens?: number | undefined;
  usage?:
    | {
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        totalTokens?: number | undefined;
      }
    | undefined;
  /** Provider-reported context window. Absent = unknown, not guessed. */
  contextWindow?: number | undefined;
};

function lastTurnUsed(usage: ContextUsageSource["usage"]): number | undefined {
  if (usage === undefined) {
    return undefined;
  }
  if (usage.totalTokens !== undefined) {
    return usage.totalTokens;
  }
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return undefined;
  }
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

export function renderUsageBar(filled: number, width: number = CONTEXT_BAR_WIDTH): string {
  const n = Math.max(0, Math.min(width, filled > 0 ? width : 0));
  return `[${"█".repeat(n)}${"░".repeat(width - n)}]`;
}

/** Fill `used` of `window` cells. Both zero -> empty bar, not a guessed window. */
export function renderWindowBar(used: number, window: number, width: number = CONTEXT_BAR_WIDTH): string {
  if (window <= 0) {
    return renderUsageBar(used, width);
  }
  const ratio = Math.max(0, Math.min(1, used / window));
  const filled = Math.round(ratio * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

export function buildContextUsage(source: ContextUsageSource): ContextUsageView {
  const lastIn = source.usage?.inputTokens;
  const lastOut = source.usage?.outputTokens;
  const last = lastTurnUsed(source.usage);
  const hasEstimate = source.estimateTokens !== undefined;
  const total = hasEstimate ? (source.estimateTokens ?? 0) : (last ?? 0);
  const estimated = hasEstimate || last === undefined;
  const window = source.contextWindow !== undefined && source.contextWindow > 0 ? source.contextWindow : undefined;
  const segments: ContextSegment[] = [];
  if (hasEstimate) {
    segments.push({ id: "history", label: "history (est.)", tokens: source.estimateTokens ?? 0 });
  }
  if (lastIn !== undefined) {
    segments.push({ id: "last-in", label: "last in", tokens: lastIn });
  }
  if (lastOut !== undefined) {
    segments.push({ id: "last-out", label: "last out", tokens: lastOut });
  }
  if (window !== undefined) {
    segments.push({ id: "free", label: "free", tokens: Math.max(0, window - total) });
  }
  return {
    total,
    estimated,
    ...(window !== undefined ? { window, usedPct: Math.min(100, (total / window) * 100), free: Math.max(0, window - total) } : {}),
    segments,
    bar: window === undefined ? renderUsageBar(total) : renderWindowBar(total, window),
    note:
      total === 0
        ? "No context usage yet."
        : window === undefined
          ? "No model context window is known. The bar is relative to used tokens, not a billed limit."
          : `Context window ${window.toLocaleString()} tokens (provider-reported).`,
  };
}

export function formatContextUsageText(view: ContextUsageView): string {
  if (view.total === 0 && view.segments.every((segment) => segment.tokens === 0)) {
    return `Context\n  ${view.note}\n`;
  }
  const kind = view.estimated ? "tokens (estimate)" : "tokens";
  const width = view.segments.reduce((max, segment) => Math.max(max, segment.label.length), 0);
  const rows = view.segments.map((segment) => `  ${segment.label.padEnd(width)}  ${segment.tokens}`);
  const usedLine =
    view.window !== undefined
      ? `  Used  ${view.total.toLocaleString()} / ${view.window.toLocaleString()} ${kind} (${(view.usedPct ?? 0).toFixed(1)}%)`
      : `  Used  ${view.total} ${kind}`;
  return [`Context`, usedLine, `  ${view.bar}`, ...rows, "", `  ${view.note}`, ""].join("\n");
}
