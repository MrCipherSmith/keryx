// Per-dispatch token use (flow 460, H): what one reviewer dispatch cost, carried IN the saved raw result.
//
// One channel, so every host does the same thing: the raw result file (`raw/<reviewer>.txt`) may end with a line
//
//   KERYX_USAGE {"tokens_in":12345,"tokens_out":678,"model":"anthropic/claude-sonnet"}
//
// keryx shell's spawn_subagent writes it itself when it saves a child's result (`save_result_to`). A host that saves the
// reply on its own (Claude Code, Codex) appends the same line with the counts its own agent result reported. A reviewer's
// result object may instead carry `usage: {tokens_in, tokens_out, model}`; the line wins when both are present.
//
// Only the usage lines that END the file state anything (the trailing block; blank lines may sit between them): a usage
// line with reply text after it is removed from the body and states nothing, so a line quoted inside a reply never
// counts. In that block the last well-formed `KERYX_USAGE` line is the dispatch whose reply the file holds, and each
// `KERYX_USAGE_OTHER` line is one other dispatch saved to the same path: spawn_subagent writes them when a re-dispatch
// saves there, so a retry never erases what another attempt cost. A malformed or `unknown` one is a dispatch whose usage
// is unknown.
//
// The figure is a reported one, not a proof. spawn_subagent strips usage lines out of the child's own text before it
// saves it, so in keryx shell only the harness states usage. On a host where the reviewer writes its own raw file
// (Claude Code, Codex) the reviewer can write a line too, and nothing here can tell it from the host's. That is
// acceptable only because no gate decision reads usage: it is the round's stated spend, nothing more. Counts above
// MAX_DISPATCH_TOKENS are not believed. Nothing here invents a count: a dispatch with no usage is `unknown`, and a total
// over dispatches where some are unknown says how many, never folds them in as 0.

export const USAGE_MARKER = "KERYX_USAGE";
/** The marker of another dispatch's usage, kept when a re-dispatch saves to the same path. */
export const OTHER_USAGE_MARKER = "KERYX_USAGE_OTHER";

/**
 * What a dispatch that ended with no assistant text leaves as its body: spawn_subagent's display summary for it, and the
 * body of the record it saves at `save_result_to`. Every reader of a raw result (`isEmptyRecord`, and through it the
 * ledger's `isEmptyOutput`) reads a body that is exactly this as an empty reply, never as a result. This is the one copy
 * of the text the writer and the readers compare.
 */
export const NO_TEXT_PLACEHOLDER = "(subagent produced no text)";

/** The `## Token spend` heading report.md carries (see withSpendSection). */
export const SPEND_HEADING = "## Token spend";

/**
 * One dispatch's token use. `partial` marks counts taken before the dispatch finished (a child stopped at its deadline,
 * whose request in flight had not reported yet): they are a lower bound, and a total that holds one says so.
 */
export type DispatchUsage = { tokens_in: number; tokens_out: number; model?: string | undefined; partial?: true | undefined };

/** A run's usage in `dispatch.runs[].usage`: the known sums over its dispatches, and how many of them reported none. */
export type RunUsage = { tokens_in: number; tokens_out: number; model?: string; dispatches: number; unknown: number; partial?: number };

/** More tokens than one dispatch can spend: a count above it is not a measurement, so the dispatch reads as unknown. */
export const MAX_DISPATCH_TOKENS = 100_000_000;

/** One usage line: optional indent, the marker (`_OTHER` for another dispatch), whitespace, the rest. Matched one line at a time. */
const USAGE_LINE = /^[ \t]*KERYX_USAGE(_OTHER)?[ \t]+(.*)$/;
/** A usage line longer than this is not one keryx or a host wrote; it is removed from the body and states nothing. */
const MAX_USAGE_LINE_CHARS = 4096;

/** A non-negative, finite token count no larger than MAX_DISPATCH_TOKENS, rounded; undefined otherwise. */
const toTokenCount = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_DISPATCH_TOKENS ? Math.round(value) : undefined);

/** The usage the rest of a `KERYX_USAGE` line states: one JSON object and nothing else, else undefined. */
function usageOfLine(rest: string): DispatchUsage | undefined {
  const object = rest.trim();
  if (object.length > MAX_USAGE_LINE_CHARS || !object.startsWith("{") || !object.endsWith("}")) return undefined;
  try {
    return usageFrom(JSON.parse(object));
  } catch {
    return undefined;
  }
}

/** A `{tokens_in, tokens_out, model?}` object, or undefined when either count is missing or not a non-negative number. */
export function usageFrom(value: unknown): DispatchUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tokensIn = toTokenCount(record.tokens_in);
  const tokensOut = toTokenCount(record.tokens_out);
  if (tokensIn === undefined || tokensOut === undefined) return undefined;
  const model = typeof record.model === "string" && record.model.trim() !== "" ? record.model.trim() : undefined;
  return { tokens_in: tokensIn, tokens_out: tokensOut, ...(model === undefined ? {} : { model }), ...(record.partial === true ? { partial: true as const } : {}) };
}

/** The line spawn_subagent (or any host) appends to a saved result. */
export function formatUsageLine(usage: DispatchUsage): string {
  return `${USAGE_MARKER} ${JSON.stringify({ tokens_in: usage.tokens_in, tokens_out: usage.tokens_out, ...(usage.model === undefined ? {} : { model: usage.model }), ...(usage.partial === true ? { partial: true } : {}) })}`;
}

/** The `KERYX_USAGE_OTHER` line recording one other dispatch to the same path; `unknown` when it reported no usage. */
export function formatOtherUsageLine(usage: DispatchUsage | undefined): string {
  return usage === undefined ? `${OTHER_USAGE_MARKER} unknown` : `${OTHER_USAGE_MARKER}${formatUsageLine(usage).slice(USAGE_MARKER.length)}`;
}

/** A raw result split into the reply and the usage its trailing block states (see splitUsage). */
export type SplitRecord = { body: string; usage?: DispatchUsage | undefined; others?: Array<DispatchUsage | undefined> };

/**
 * The reply without its usage lines; the usage the last well-formed `KERYX_USAGE` line of the trailing block states; and
 * one entry per `KERYX_USAGE_OTHER` line there, in file order (undefined: that dispatch's usage is unknown). The body is
 * what every reader of a reply parses and tests for emptiness, so a usage line can never turn an empty reply into a
 * non-empty one or add an object to the result scan. One pass over the lines, linear in the reply.
 */
export function splitUsage(raw: string): SplitRecord {
  if (!raw.includes(USAGE_MARKER)) return { body: raw };
  const lines = raw.split("\n");
  const kept: string[] = [];
  const others: Array<DispatchUsage | undefined> = [];
  let usage: DispatchUsage | undefined;
  let found = false;
  // Walked from the end: `trailing` holds while only usage lines and blank lines have been passed.
  let trailing = true;
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at]!;
    const match = line.includes(USAGE_MARKER) ? USAGE_LINE.exec(line) : null;
    if (match === null) {
      if (line.trim() !== "") trailing = false;
      kept.push(line);
      continue;
    }
    found = true;
    if (!trailing) continue;
    if (match[1] !== undefined) others.unshift(usageOfLine(match[2]!));
    else usage ??= usageOfLine(match[2]!);
  }
  if (!found) return { body: raw };
  const body = kept.reverse().join("\n").trimEnd();
  return { body, ...(usage === undefined ? {} : { usage }), ...(others.length === 0 ? {} : { others }) };
}

/** True for a record that holds no reply: blank, or exactly the no-text placeholder, once its usage lines are set aside. */
export function isEmptyRecord(raw: string): boolean {
  const body = splitUsage(raw).body.trim();
  return body === "" || body === NO_TEXT_PLACEHOLDER;
}

/** The round's spend over its dispatches: summed where known, with the unknown ones counted, never added as 0. */
export type UsageTotals = {
  dispatches: number;
  known: number;
  unknown: number;
  tokens_in: number;
  tokens_out: number;
  /** Known dispatches whose counts are partial (taken at a deadline); absent on totals written before it existed. */
  partial?: number | undefined;
  /** True when every dispatch reported its full usage; otherwise the token sums are lower bounds. */
  complete: boolean;
};

export function usageTotals(usages: ReadonlyArray<DispatchUsage | undefined>): UsageTotals {
  const known = usages.filter((usage): usage is DispatchUsage => usage !== undefined);
  const partial = known.filter((usage) => usage.partial === true).length;
  return {
    dispatches: usages.length,
    known: known.length,
    unknown: usages.length - known.length,
    tokens_in: known.reduce((sum, usage) => sum + usage.tokens_in, 0),
    tokens_out: known.reduce((sum, usage) => sum + usage.tokens_out, 0),
    ...(partial === 0 ? {} : { partial }),
    complete: known.length === usages.length && usages.length > 0 && partial === 0,
  };
}

/** One line for a terminal or a report: the totals, and the unknown and partial dispatches by count. */
export function usageTotalsLine(totals: UsageTotals): string {
  if (totals.dispatches === 0) return "token spend: unknown (no dispatch recorded)";
  if (totals.known === 0) return `token spend: unknown (${totals.dispatches} dispatch(es), none reported usage)`;
  const sums = `${totals.tokens_in} in, ${totals.tokens_out} out`;
  const partial = totals.partial ?? 0;
  const partialNote = partial === 0 ? "" : `; ${partial} stopped at a deadline (counted so far only)`;
  if (totals.unknown === 0 && partial === 0) return `token spend: ${sums} over ${totals.dispatches} dispatch(es)`;
  if (totals.unknown === 0) return `token spend: at least ${sums} over ${totals.dispatches} dispatch(es)${partialNote}`;
  return `token spend: at least ${sums} over ${totals.known} of ${totals.dispatches} dispatch(es); ${totals.unknown} unknown (no usage recorded)${partialNote}`;
}

/**
 * `report` with its `## Token spend` section set from the totals research.json carries. A section already there (up to
 * the next `## ` heading, or the end) is replaced, so a re-ingest states the current spend, never a stale one; a report
 * without one gets it appended. With no totals in `research` the report is returned unchanged.
 */
export function withSpendSection(report: string, research: unknown): string {
  const usage = research !== null && typeof research === "object" ? (research as { usage?: unknown }).usage : undefined;
  if (usage === null || typeof usage !== "object") return report;
  const totals = usage as Partial<UsageTotals>;
  if (typeof totals.dispatches !== "number" || typeof totals.known !== "number") return report;
  const section = `${SPEND_HEADING}\n\n${usageTotalsLine(totals as UsageTotals)}\n`;
  const lines = report.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === SPEND_HEADING);
  if (start === -1) return `${report.endsWith("\n") ? report : `${report}\n`}\n${section}`;
  const next = lines.findIndex((line, at) => at > start && line.startsWith("## "));
  const before = lines.slice(0, start).join("\n");
  return `${before}\n${section}${next === -1 ? "" : `\n${lines.slice(next).join("\n")}`}`;
}
