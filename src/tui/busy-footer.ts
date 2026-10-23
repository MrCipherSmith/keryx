// The busy footer text (flow 468, AC20).
//
// While a turn runs the footer no longer repeats the busy line (that lives once,
// above the composer). It shows what is useful to act on instead: the key hints,
// the turn's tokens and cost, the context fill and the queue / job / subagent
// counts. Pure and renderer-free so the fitting rule is plain to read and test.

/** What the shell knows about the running turn; every field is optional. */
export interface BusyFooterInfo {
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  /** Passed only when the model's price is known. */
  costUsd?: number | undefined;
  contextPct?: number | undefined;
  queued?: number | undefined;
  backgroundJobs?: number | undefined;
  subagents?: number | undefined;
}

export const BUSY_FOOTER_HINTS = "Esc interrupt · Enter queue · / commands";
/** What is left of the hints on a terminal too narrow for all three. */
const HINTS_SHORT = "Esc interrupt · Enter queue";
/** The least the footer ever shows while busy: how to stop the turn. */
export const BUSY_FOOTER_MIN_HINT = "Esc interrupt";
const SEPARATOR = " · ";

function positive(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n) && n > 0;
}

/** `850`, `1.2K` (K suffix from 1000). */
function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n));
}

function tokensPart(info: BusyFooterInfo): string | undefined {
  const parts: string[] = [];
  if (positive(info.tokensIn) || positive(info.tokensOut)) {
    parts.push(`↑${formatCount(info.tokensIn ?? 0)}`, `↓${formatCount(info.tokensOut ?? 0)}`);
  }
  if (info.costUsd !== undefined && Number.isFinite(info.costUsd) && info.costUsd >= 0) {
    parts.push(`$${info.costUsd.toFixed(2)}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function contextPart(info: BusyFooterInfo): string | undefined {
  const pct = info.contextPct;
  return pct !== undefined && Number.isFinite(pct) && pct >= 0 ? `ctx ${Math.round(pct)}%` : undefined;
}

function countsPart(info: BusyFooterInfo): string | undefined {
  const counts: string[] = [];
  if (positive(info.queued)) counts.push(`queue ${info.queued}`);
  if (positive(info.backgroundJobs)) counts.push(`jobs ${info.backgroundJobs}`);
  if (positive(info.subagents)) counts.push(`agents ${info.subagents}`);
  return counts.length > 0 ? counts.join(SEPARATOR) : undefined;
}

/**
 * The footer-left text for a busy turn, fitted to `width` columns. Parts are in
 * priority order (hints, tokens + cost, context, counts) and dropped WHOLE from
 * the end until the line fits; an empty part is simply absent. The hints are
 * always kept: shortened to `Esc interrupt` on a narrow terminal and clipped only
 * when even that exceeds the width.
 */
export function formatBusyFooter(info: BusyFooterInfo | undefined, width: number): string {
  const hints = [BUSY_FOOTER_HINTS, HINTS_SHORT, BUSY_FOOTER_MIN_HINT].find((h) => h.length <= width);
  if (hints === undefined) {
    return Number.isFinite(width) && width >= 1 ? BUSY_FOOTER_MIN_HINT.slice(0, Math.floor(width)) : BUSY_FOOTER_MIN_HINT;
  }
  if (hints !== BUSY_FOOTER_HINTS) return hints;
  const optional = info === undefined ? [] : [tokensPart(info), contextPart(info), countsPart(info)];
  const parts = [hints, ...optional.filter((p): p is string => p !== undefined)];
  while (parts.length > 1 && parts.join(SEPARATOR).length > width) {
    parts.pop();
  }
  return parts.join(SEPARATOR);
}
