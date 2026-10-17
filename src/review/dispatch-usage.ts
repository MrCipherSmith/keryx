// Per-dispatch token use (flow 460, H): what one reviewer dispatch cost, carried IN the saved raw result.
//
// One channel, so every host does the same thing: the raw result file (`raw/<reviewer>.txt`) may end with a line
//
//   KERYX_USAGE {"tokens_in":12345,"tokens_out":678,"model":"anthropic/claude-sonnet"}
//
// keryx shell's spawn_subagent writes it itself when it saves a child's result (`save_result_to`). A host that saves the
// reply on its own (Claude Code, Codex) appends the same line with the counts its own agent result reported. A reviewer's
// result object may instead carry `usage: {tokens_in, tokens_out, model}`; the line wins when both are present, because
// the host measured it and the reviewer cannot. Nothing here invents a count: a dispatch with no usage is `unknown`, and a
// total over dispatches where some are unknown says how many, never folds them in as 0.

export const USAGE_MARKER = "KERYX_USAGE";

export type DispatchUsage = { tokens_in: number; tokens_out: number; model?: string | undefined };

/** A usage line at the start of a line, with the JSON object after it. Anchored per line; the last one wins. */
const USAGE_LINE = /^[ \t]*KERYX_USAGE[ \t]+(\{[^\n]*\})[ \t]*\r?$/gm;

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);

/** A `{tokens_in, tokens_out, model?}` object, or undefined when either count is missing or not a non-negative number. */
export function usageFrom(value: unknown): DispatchUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tokensIn = count(record.tokens_in);
  const tokensOut = count(record.tokens_out);
  if (tokensIn === undefined || tokensOut === undefined) return undefined;
  const model = typeof record.model === "string" && record.model.trim() !== "" ? record.model.trim() : undefined;
  return { tokens_in: tokensIn, tokens_out: tokensOut, ...(model === undefined ? {} : { model }) };
}

/** The line spawn_subagent (or any host) appends to a saved result. */
export function formatUsageLine(usage: DispatchUsage): string {
  return `${USAGE_MARKER} ${JSON.stringify({ tokens_in: usage.tokens_in, tokens_out: usage.tokens_out, ...(usage.model === undefined ? {} : { model: usage.model }) })}`;
}

/**
 * The reply without its usage lines, and the usage the last well-formed one states. The body is what every reader of a
 * reply parses and tests for emptiness, so a usage line can never turn an empty reply into a non-empty one or add an
 * object to the result scan.
 */
export function splitUsage(raw: string): { body: string; usage?: DispatchUsage | undefined } {
  if (!raw.includes(USAGE_MARKER)) return { body: raw };
  let usage: DispatchUsage | undefined;
  let found = false;
  for (const match of raw.matchAll(USAGE_LINE)) {
    found = true;
    try {
      usage = usageFrom(JSON.parse(match[1]!)) ?? usage;
    } catch {
      // A malformed line states nothing; it is still removed from the body.
    }
  }
  if (!found) return { body: raw };
  const body = raw.replace(USAGE_LINE, "").replace(/\s+$/, "");
  return usage === undefined ? { body } : { body, usage };
}

/** The round's spend over its dispatches: summed where known, with the unknown ones counted, never added as 0. */
export type UsageTotals = {
  dispatches: number;
  known: number;
  unknown: number;
  tokens_in: number;
  tokens_out: number;
  /** True when every dispatch reported usage; otherwise the token sums are lower bounds. */
  complete: boolean;
};

export function usageTotals(usages: ReadonlyArray<DispatchUsage | undefined>): UsageTotals {
  const known = usages.filter((usage): usage is DispatchUsage => usage !== undefined);
  return {
    dispatches: usages.length,
    known: known.length,
    unknown: usages.length - known.length,
    tokens_in: known.reduce((sum, usage) => sum + usage.tokens_in, 0),
    tokens_out: known.reduce((sum, usage) => sum + usage.tokens_out, 0),
    complete: known.length === usages.length && usages.length > 0,
  };
}

/** One line for a terminal or a report: the totals, and the unknown dispatches by count. */
export function usageTotalsLine(totals: UsageTotals): string {
  if (totals.dispatches === 0) return "token spend: unknown (no dispatch recorded)";
  if (totals.known === 0) return `token spend: unknown (${totals.dispatches} dispatch(es), none reported usage)`;
  const sums = `${totals.tokens_in} in, ${totals.tokens_out} out`;
  return totals.unknown === 0
    ? `token spend: ${sums} over ${totals.dispatches} dispatch(es)`
    : `token spend: at least ${sums} over ${totals.known} of ${totals.dispatches} dispatch(es); ${totals.unknown} unknown (no usage recorded)`;
}

/** `## Token spend` for report.md, from the totals research.json carries; empty when it carries none. */
export function renderSpendMarkdown(research: unknown): string {
  const usage = research !== null && typeof research === "object" ? (research as { usage?: unknown }).usage : undefined;
  if (usage === null || typeof usage !== "object") return "";
  const totals = usage as Partial<UsageTotals>;
  if (typeof totals.dispatches !== "number" || typeof totals.known !== "number") return "";
  return `\n## Token spend\n\n${usageTotalsLine(totals as UsageTotals)}\n`;
}
