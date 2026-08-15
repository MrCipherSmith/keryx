// Honest context-window view for /status. Keryx does not know a model limit,
// so the bar is relative to used tokens — never a guessed 128k window.

export type ContextSegment = {
  id: string;
  label: string;
  tokens: number;
};

export type ContextUsageView = {
  total: number;
  estimated: boolean;
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

export function buildContextUsage(source: ContextUsageSource): ContextUsageView {
  const lastIn = source.usage?.inputTokens;
  const lastOut = source.usage?.outputTokens;
  const last = lastTurnUsed(source.usage);
  const hasEstimate = source.estimateTokens !== undefined;
  const total = hasEstimate ? (source.estimateTokens ?? 0) : (last ?? 0);
  const estimated = hasEstimate || last === undefined;
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
  return {
    total,
    estimated,
    segments,
    bar: renderUsageBar(total),
    note:
      total === 0
        ? "No context usage yet."
        : "No model context window is known. The bar is relative to used tokens, not a billed limit.",
  };
}

export function formatContextUsageText(view: ContextUsageView): string {
  if (view.total === 0 && view.segments.every((segment) => segment.tokens === 0)) {
    return `Context\n  ${view.note}\n`;
  }
  const kind = view.estimated ? "tokens (estimate)" : "tokens";
  const width = view.segments.reduce((max, segment) => Math.max(max, segment.label.length), 0);
  const rows = view.segments.map((segment) => `  ${segment.label.padEnd(width)}  ${segment.tokens}`);
  return [`Context`, `  Used  ${view.total} ${kind}`, `  ${view.bar}`, ...rows, "", `  ${view.note}`, ""].join("\n");
}
