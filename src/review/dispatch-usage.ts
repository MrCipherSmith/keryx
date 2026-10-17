// Per-dispatch token use (flow 460, H): what one reviewer dispatch cost, carried IN the saved raw result.
//
// One channel, so every host does the same thing: the raw result file (`raw/<reviewer>.txt`) may end with a line
//
//   KERYX_USAGE {"tokens_in":12345,"tokens_out":678,"model":"anthropic/claude-sonnet","by":"host"}
//
// keryx shell's spawn_subagent writes it itself when it saves a child's result (`save_result_to`). A host that saves the
// reply on its own (Claude Code, Codex) appends the same line with the counts its own agent result reported, marked
// `"by":"host"`. A reviewer's result object may instead carry `usage: {tokens_in, tokens_out, model}`; the line wins when
// both are present. A non-final save (a child stopped, timed out or ended empty) marks its line `"incomplete":true`: the
// file then holds no complete result, and a later dispatch's text may replace it (spawn_subagent's saveDispatchRecord).
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
// (Claude Code, Codex) the reviewer can write a line too. A line without the host's mark, and a result envelope's own
// `usage`, read as `reported` (stated by the reviewer, not measured), and a total says how many it holds; a reviewer
// that copies the mark is not caught. That is acceptable only because no gate decision reads usage: it is the round's
// stated spend, nothing more. Counts above
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
 * whose request in flight had not reported yet): they are a lower bound, and a total that holds one says so. `reported`
 * marks counts no host stated (a line without `"by":"host"`, or a result envelope's `usage`): the reviewer's own figure.
 */
export type DispatchUsage = { tokens_in: number; tokens_out: number; model?: string | undefined; partial?: true | undefined; reported?: true | undefined };

/** A run's usage in `dispatch.runs[].usage`: the known sums over its dispatches, and how many of them reported none. */
export type RunUsage = { tokens_in: number; tokens_out: number; model?: string; dispatches: number; unknown: number; partial?: number; reported?: number };

/** The `by` value a host (spawn_subagent, or a host following the review skill) writes on its own usage line. */
export const HOST_MARK = "host";

/** More tokens than one dispatch can spend: a count above it is not a measurement, so the dispatch reads as unknown. */
export const MAX_DISPATCH_TOKENS = 100_000_000;

/**
 * One usage line: optional indent, the marker (`_OTHER` for another dispatch), whitespace, the rest. Matched one line at a
 * time; a trailing `\r` (a file saved with CRLF line endings) is not part of the rest.
 */
const USAGE_LINE = /^[ \t]*KERYX_USAGE(_OTHER)?[ \t]+(.*?)\r?$/;
/** A usage line longer than this is not one keryx or a host wrote; it is removed from the body and states nothing. */
const MAX_USAGE_LINE_CHARS = 4096;

/** A non-negative, finite token count no larger than MAX_DISPATCH_TOKENS, rounded; undefined otherwise. */
const toTokenCount = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_DISPATCH_TOKENS ? Math.round(value) : undefined);

/** The JSON object the rest of a usage line holds, and nothing else; undefined otherwise. */
function objectOfLine(rest: string): unknown {
  const object = rest.trim();
  if (object.length > MAX_USAGE_LINE_CHARS || !object.startsWith("{") || !object.endsWith("}")) return undefined;
  try {
    return JSON.parse(object);
  } catch {
    return undefined;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A `{tokens_in, tokens_out, model?, partial?, by?}` object as usage, or undefined when either count is missing or not a
 * non-negative number. Counts without `by: "host"` (a reviewer's own line, a result envelope's `usage`) are `reported`.
 */
export function usageFrom(value: unknown): DispatchUsage | undefined {
  if (!isObject(value)) return undefined;
  const tokensIn = toTokenCount(value.tokens_in);
  const tokensOut = toTokenCount(value.tokens_out);
  if (tokensIn === undefined || tokensOut === undefined) return undefined;
  const model = typeof value.model === "string" && value.model.trim() !== "" ? value.model.trim() : undefined;
  return { tokens_in: tokensIn, tokens_out: tokensOut, ...(model === undefined ? {} : { model }), ...(value.partial === true ? { partial: true as const } : {}), ...(value.by === HOST_MARK ? {} : { reported: true as const }) };
}

/** The JSON of a usage line a host writes: the counts as given, the host's mark, and `incomplete` for a non-final save. */
function hostLineJson(usage: DispatchUsage | undefined, incomplete: boolean): string {
  const counts = usage === undefined ? {} : { tokens_in: usage.tokens_in, tokens_out: usage.tokens_out, ...(usage.model === undefined ? {} : { model: usage.model }), ...(usage.partial === true ? { partial: true } : {}) };
  // Counts a reviewer stated stay unmarked when a host copies them into another line: the mark never launders them.
  return JSON.stringify({ ...counts, ...(usage?.reported === true ? {} : { by: HOST_MARK }), ...(incomplete ? { incomplete: true } : {}) });
}

/** The line spawn_subagent (or any host) appends to a saved result. */
export function formatUsageLine(usage: DispatchUsage): string {
  return `${USAGE_MARKER} ${hostLineJson(usage, false)}`;
}

/**
 * The own line of a record a host saves: its usage, and `incomplete` for a non-final save. Undefined for a final record
 * with no usage (nothing to state); an incomplete one with no usage still gets a line, which reads as unknown usage.
 */
export function formatRecordLine(usage: DispatchUsage | undefined, options: { incomplete: boolean }): string | undefined {
  if (usage === undefined && !options.incomplete) return undefined;
  return `${USAGE_MARKER} ${hostLineJson(usage, options.incomplete)}`;
}

/** The `KERYX_USAGE_OTHER` line recording one other dispatch to the same path; `unknown` when it reported no usage. */
export function formatOtherUsageLine(usage: DispatchUsage | undefined): string {
  return usage === undefined ? `${OTHER_USAGE_MARKER} unknown` : `${OTHER_USAGE_MARKER} ${hostLineJson(usage, false)}`;
}

/**
 * A raw result split into the reply and the usage its trailing block states (see splitUsage). `incomplete` is true when
 * the file's own line (its last `KERYX_USAGE` line) marks a non-final save: the reply is not a complete result.
 */
export type SplitRecord = { body: string; usage?: DispatchUsage | undefined; others?: Array<DispatchUsage | undefined>; incomplete?: true };

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
  let incomplete = false;
  let ownSeen = false;
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
    const object = objectOfLine(match[2]!);
    if (match[1] !== undefined) {
      others.unshift(usageFrom(object));
      continue;
    }
    if (!ownSeen) incomplete = isObject(object) && object.incomplete === true;
    ownSeen = true;
    usage ??= usageFrom(object);
  }
  if (!found) return { body: raw };
  const body = kept.reverse().join("\n").trimEnd();
  return { body, ...(usage === undefined ? {} : { usage }), ...(others.length === 0 ? {} : { others }), ...(incomplete ? { incomplete: true as const } : {}) };
}

/** True for a reply body that holds nothing: blank, or exactly the no-text placeholder. */
export function isEmptyBody(body: string): boolean {
  const trimmed = body.trim();
  return trimmed === "" || trimmed === NO_TEXT_PLACEHOLDER;
}

/** True for a record that holds no reply: blank, or exactly the no-text placeholder, once its usage lines are set aside. */
export function isEmptyRecord(raw: string): boolean {
  return isEmptyBody(splitUsage(raw).body);
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
  /** Known dispatches whose counts no host stated (the reviewer's own figure); absent when there are none. */
  reported?: number | undefined;
  /** True when every dispatch reported its full usage; otherwise the token sums are lower bounds. */
  complete: boolean;
};

export function usageTotals(usages: ReadonlyArray<DispatchUsage | undefined>): UsageTotals {
  const known = usages.filter((usage): usage is DispatchUsage => usage !== undefined);
  const partial = known.filter((usage) => usage.partial === true).length;
  const reported = known.filter((usage) => usage.reported === true).length;
  return {
    dispatches: usages.length,
    known: known.length,
    unknown: usages.length - known.length,
    tokens_in: known.reduce((sum, usage) => sum + usage.tokens_in, 0),
    tokens_out: known.reduce((sum, usage) => sum + usage.tokens_out, 0),
    ...(partial === 0 ? {} : { partial }),
    ...(reported === 0 ? {} : { reported }),
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
  const reported = totals.reported ?? 0;
  const reportedNote = reported === 0 ? "" : `; ${reported} stated by the reviewer, not measured by a host`;
  if (totals.unknown === 0 && partial === 0) return `token spend: ${sums} over ${totals.dispatches} dispatch(es)${reportedNote}`;
  if (totals.unknown === 0) return `token spend: at least ${sums} over ${totals.dispatches} dispatch(es)${partialNote}${reportedNote}`;
  return `token spend: at least ${sums} over ${totals.known} of ${totals.dispatches} dispatch(es); ${totals.unknown} unknown (no usage recorded)${partialNote}${reportedNote}`;
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
