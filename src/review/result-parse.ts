import type { ParsedResult } from "./ledger";

/**
 * Flow 458 AC12: the tolerant half of reading a reviewer reply. The strict reader (`parseReviewResult` in ledger.ts) keeps
 * its rules about labels, markers and ambiguity; this one is what it falls back to when it found nothing, and accepts what
 * agents really write: a fenced ```json block, a bare object with prose before or after it, a JSON array of results (one per
 * wave), and an object wrapped in a common key (`{ "result": { … } }`, `{ "review_result": … }`). It never guesses from prose,
 * and it never merges results of different reviewers: a raw file is one reviewer's reply.
 */

/** Keys a reviewer result is commonly wrapped in, tried in order. */
export const RESULT_WRAPPER_KEYS: readonly string[] = ["result", "review_result", "reviewResult", "REVIEW_RESULT", "output", "response", "data"];
/** Keys that hold a list of results (one per wave or per reviewer). */
const RESULT_LIST_KEYS: readonly string[] = ["results", "reviews", "waves", "review_results"];

const MAX_DEPTH = 4;
const MAX_SCAN_STARTS = 400;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hasStatus = (value: unknown): value is Record<string, unknown> & { status: string } => isObject(value) && typeof value.status === "string";

/** A reviewer result: a status plus the reviewer's name, a findings array or a slices array (a slice entry carries none of them). */
function qualifies(value: unknown): value is ParsedResult & { status: string } {
  return hasStatus(value) && (typeof value.reviewer === "string" || Array.isArray(value.findings));
}

function tryParse(source: string): unknown {
  try { return JSON.parse(source); } catch { return undefined; }
}

/** The index of the bracket closing the `{` or `[` at `start`, string- and escape-aware; undefined when it never closes. */
function balancedEnd(raw: string, start: number): number | undefined {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let at = start; at < raw.length; at += 1) {
    const char = raw[at];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth += 1;
    else if ((char === "}" || char === "]") && --depth === 0) return at;
  }
  return undefined;
}

/** The JSON values standing at the top level of `text`, with prose around them ignored. */
function embeddedValues(text: string): unknown[] {
  const found: unknown[] = [];
  let starts = 0;
  for (let at = 0; at < text.length && starts < MAX_SCAN_STARTS; ) {
    const char = text[at];
    if (char !== "{" && char !== "[") { at += 1; continue; }
    starts += 1;
    const end = balancedEnd(text, at);
    if (end === undefined) { at += 1; continue; }
    // A balanced region that does not parse is skipped whole, never entered: a result-shaped object inside a broken one is not read.
    const value = tryParse(text.slice(at, end + 1));
    if (value !== undefined && value !== null && typeof value === "object") found.push(value);
    at = end + 1;
  }
  return found;
}

/** The reviewer results inside one parsed value, unwrapping lists and wrapper keys. */
export function resultsIn(value: unknown, depth = 0): Array<ParsedResult & { status: string }> {
  if (depth > MAX_DEPTH) return [];
  if (Array.isArray(value)) return value.flatMap((item) => resultsIn(item, depth + 1));
  if (!isObject(value)) return [];
  if (qualifies(value)) return [value];
  const out: Array<ParsedResult & { status: string }> = [];
  for (const key of RESULT_WRAPPER_KEYS) if (key in value) out.push(...resultsIn(value[key], depth + 1));
  for (const key of RESULT_LIST_KEYS) if (Array.isArray(value[key])) out.push(...resultsIn(value[key], depth + 1));
  // A wrapped result with only a status ({ "result": { "status": … } }) is still the labelled result of its wrapper.
  if (out.length === 0) for (const key of RESULT_WRAPPER_KEYS) if (hasStatus(value[key])) out.push(value[key] as ParsedResult & { status: string });
  return out;
}

/** Worst first: a merged wave set is only as finished as its least finished result. An unknown status ranks worst. */
const STATUS_RANK = ["DONE", "DONE_WITH_CONCERNS", "INCOMPLETE", "NEEDS_CONTEXT", "BLOCKED"];
const rankOf = (status: string): number => {
  const at = STATUS_RANK.indexOf(status.toUpperCase());
  return at === -1 ? STATUS_RANK.length : at;
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * One result from the several a reply held for the same reviewer: the least finished status, the union of covered slices,
 * and every finding, question, follow-up and prior disposition. Slice entries are kept as written (an id string or an object).
 */
export function mergeResults(items: ReadonlyArray<ParsedResult & { status: string }>): ParsedResult | undefined {
  if (items.length === 0) return undefined;
  if (items.length === 1) return items[0]!;
  const reviewers = new Set(items.map((item) => item.reviewer).filter((name): name is string => typeof name === "string" && name !== ""));
  if (reviewers.size > 1) return undefined;
  const worst = items.reduce((best, item) => (rankOf(item.status) > rankOf(best.status) ? item : best));
  const slices: unknown[] = [];
  const seenSlices = new Set<string>();
  for (const entry of items.flatMap((item) => asArray(item.slices))) {
    const id = typeof entry === "string" ? entry : isObject(entry) && typeof entry.id === "string" ? entry.id : undefined;
    if (id !== undefined) {
      if (seenSlices.has(id)) continue;
      seenSlices.add(id);
    }
    slices.push(entry);
  }
  const findings = items.flatMap((item) => asArray(item.findings)) as Array<Record<string, unknown>>;
  const needs = items.flatMap((item) => asArray(item.needs_context));
  const followUps = items.flatMap((item) => asArray(item.follow_ups));
  const dispositions = items.flatMap((item) => asArray(item.prior_dispositions));
  const model = items.map((item) => (item as { model?: unknown }).model).find((value): value is string => typeof value === "string" && value.trim() !== "");
  const summary = items.map((item) => item.summary).filter((text): text is string => typeof text === "string" && text !== "").join(" | ");
  const reviewer = [...reviewers][0];
  return {
    ...worst,
    ...(reviewer === undefined ? {} : { reviewer }),
    status: worst.status,
    ...(items.some((item) => Array.isArray(item.slices)) ? { slices } : {}),
    ...(items.some((item) => Array.isArray(item.findings)) ? { findings } : {}),
    ...(needs.length > 0 ? { needs_context: needs } : {}),
    ...(followUps.length > 0 ? { follow_ups: followUps } : {}),
    ...(dispositions.length > 0 ? { prior_dispositions: dispositions } : {}),
    ...(model === undefined ? {} : { model }),
    ...(summary === "" ? {} : { summary }),
  } as ParsedResult;
}

/** The reviewer results the lists and wrappers of a reply hold, one group per top-level value; undefined when a bare reviewer object stands in it. */
function candidateGroups(raw: string): Array<Array<ParsedResult & { status: string }>> | undefined {
  const groups: Array<Array<ParsedResult & { status: string }>> = [];
  for (const value of embeddedValues(raw)) {
    if (qualifies(value)) return undefined;
    const group = resultsIn(value);
    if (group.length > 0) groups.push(group);
  }
  return groups;
}

/** Whether a top-level JSON array (or a `results`-style list) of the reply holds reviewer results: the reply is a list, not one result. */
export function holdsResultList(raw: string): boolean {
  return embeddedValues(raw).some((value) => (Array.isArray(value) || (isObject(value) && RESULT_LIST_KEYS.some((key) => Array.isArray(value[key])))) && resultsIn(value).length > 0);
}

/**
 * The reviewer result a reply holds in any of the tolerated shapes, or undefined. Replies that disagree (separate results
 * with different statuses, or results of different reviewers) give none: a sample cannot be told from the real result.
 * A bare reviewer object anywhere in the reply is the strict reader's to judge, and it already refused this reply
 * (ambiguous statuses, a quoted marker, a cut-off result): the lenient reader never overrides that, it gives none.
 */
export function lenientReviewResult(raw: string): ParsedResult | undefined {
  const groups = candidateGroups(raw);
  if (groups === undefined || groups.length === 0) return undefined;
  if (groups.length > 1) {
    const statuses = new Set(groups.map((group) => group.map((item) => item.status).join("|")));
    if (statuses.size > 1) return undefined;
  }
  return mergeResults(groups.flat());
}

/**
 * Why a reply gave no reviewer result, in words that name what is missing. Reads the same candidates the lenient reader does;
 * the closest object (the one carrying the most of reviewer, status, slices, findings) is the one described.
 */
export function describeUnusableResult(raw: string): string {
  if (raw.trim() === "") return "the reply is empty";
  const groups = candidateGroups(raw) ?? [];
  const distinct = new Set(groups.flat().map((item) => item.reviewer).filter((name): name is string => typeof name === "string"));
  if (distinct.size > 1) return `the reply holds results of ${distinct.size} different reviewers (${[...distinct].join(", ")}); a reply is one reviewer's, save each under its own raw file`;
  if (groups.length > 1) return "the reply holds several results with different statuses; keep one (the real one) and remove the sample";
  const values = embeddedValues(raw);
  const objects: Array<Record<string, unknown>> = [];
  const collect = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(value)) { value.forEach((item) => collect(item, depth + 1)); return; }
    if (!isObject(value)) return;
    objects.push(value);
    for (const key of [...RESULT_WRAPPER_KEYS, ...RESULT_LIST_KEYS]) if (key in value) collect(value[key], depth + 1);
  };
  values.forEach((value) => collect(value, 0));
  if (objects.length === 0) return "no JSON object or array was found in the reply (a truncated or prose-only reply); emit the result as one JSON object with reviewer, status, slices and findings";
  const wanted = ["reviewer", "status", "slices", "findings"] as const;
  const score = (object: Record<string, unknown>): number => wanted.filter((key) => key in object).length;
  const best = objects.reduce((top, object) => (score(object) > score(top) ? object : top));
  const missing: string[] = wanted.filter((key) => !(key in best));
  const wrong: string[] = [];
  if ("status" in best && typeof best.status !== "string") wrong.push("status is not a string");
  if ("slices" in best && !Array.isArray(best.slices)) wrong.push("slices is not an array");
  if ("findings" in best && !Array.isArray(best.findings)) wrong.push("findings is not an array");
  if ("reviewer" in best && typeof best.reviewer !== "string") wrong.push("reviewer is not a string");
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(", ")}`);
  if (wrong.length > 0) parts.push(wrong.join(", "));
  if (parts.length === 0) parts.push("a status plus a reviewer name or a findings or slices array is needed");
  return `the closest JSON object in the reply cannot be read as a reviewer result: ${parts.join("; ")}`;
}
