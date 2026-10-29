import { createHash } from "node:crypto";
import { DISPLAY_ID_FORM, displayIdHasHash } from "./display-id";
import { coverageErrors, skipLine, type ReviewMode, type ReviewerSkip } from "./coverage";
import { coverageGateErrors } from "./coverage-complete";
import { dispatchErrors } from "./dispatch";
import { layersUsedFrom } from "./layers-usage";
import { INGEST_SCREENED_FILE, type IngestScreened, packageCoverageErrors, researchErrors } from "./research";
import { describeUnusableResult, holdsResultList, lenientReviewResult } from "./result-parse";
import { needsContextQuestions, readSliceIds, scopeFingerprint, sliceReadingNotes, type RetryState } from "./retry-plan";
import { type SliceManifest, packWavesByKind, waveBytesOf } from "./slice";
import { ALWAYS_ROLE, DEEP_ROLES, ROLES_RUN_WITHOUT_SLICES, ROUTABLE_ROLES, isRoutedManifest } from "./slice-routing";
import { requiredSlices, sliceGraph, summarizeWaves } from "./waves";
import { fixSliceCoverage, priorDispositionsOf } from "./round-split";
import { type DispatchUsage, type RunUsage, type UsageTotals, isEmptyRecord, splitUsage, usageFrom, usageTotals } from "./dispatch-usage";

/** Statuses of `reviewer-finding.schema.json` that mean the reviewer finished what it was given. */
const FINISHED = new Set(["DONE", "DONE_WITH_CONCERNS"]);
const CLOSED = new Set(["finding", "refuted", "out-of-scope", "narrowed"]);

/** How much of the reviewer's own list of unreadable inputs the gap quotes back. */
const CLAIM_QUOTE_CHARS = 120;

/**
 * Flow 460 D: the mandatory inputs a reviewer reply says it could not read, quoted for the gap, or undefined. Read only
 * from the result's structured `inputs_unreadable` list (reviewer-finding.schema.json), never guessed from the summary's
 * prose: a summary about a schema or a payload defect ("The payload could not be parsed when slices is empty.", "Did not
 * find any schema regressions.") is never read as the reviewer's own reading failure.
 */
export function unreadableInputClaim(result: Pick<ParsedResult, "inputs_unreadable" | "status" | "summary">): string | undefined {
  const named = Array.isArray(result.inputs_unreadable) ? result.inputs_unreadable.filter(text).map((input) => input.trim()) : [];
  return named.length === 0 ? undefined : named.join(", ").slice(0, CLAIM_QUOTE_CHARS);
}

export type ParsedResult = {
  reviewer?: string;
  status?: string;
  summary?: string;
  findings?: Array<Record<string, unknown>>;
  needs_context?: unknown;
  slices?: unknown;
  /** Work the reviewer hands back to the parent. Each entry becomes an obligation that only a disposition closes. */
  follow_ups?: unknown;
  /** The model the reviewer ran on, when the dispatcher or the reviewer recorded it. */
  model?: string;
  /** Delta round (flow 458): what the reviewer concluded about each prior finding its fix slices answer, `[{ id, disposition }]`. */
  prior_dispositions?: unknown;
  /** Flow 460: `{tokens_in, tokens_out, model}` when the result envelope carries it; a `KERYX_USAGE` line in the raw file wins. */
  usage?: unknown;
  /** Flow 460 D: the mandatory inputs the reviewer could not read; a finished status with any is not a finished run. */
  inputs_unreadable?: unknown;
};

export type RawFile = {
  /** Path relative to the input directory, e.g. `raw/review-logic.txt`. */
  name: string;
  hash: string;
  mtimeMs: number;
  /** Slice assignment from the driver explicitly naming this result file. */
  assignedSlices?: string[];
  result?: ParsedResult;
  /** True for a file a reviewer left empty (blank, or NO_TEXT_PLACEHOLDER): lost output, not a result to reconcile. */
  empty: boolean;
  /** Why no result was read from this file (what is missing), set by the loader when `result` is absent. */
  diagnosis?: string;
  /** Flow 460: the dispatch's token use, from the file's `KERYX_USAGE` line (see ./dispatch-usage.ts). */
  usage?: DispatchUsage | undefined;
  /** The other dispatches saved to the same path (its `KERYX_USAGE_OTHER` lines); an undefined entry is unknown. */
  otherUsage?: Array<DispatchUsage | undefined> | undefined;
};

export type Disposition = {
  id?: string;
  source?: string;
  question?: string;
  status?: string;
  finding?: string;
  evidence?: string;
  reason?: string;
  /** For `narrowed`: what of the finding still stands. Without it the obligation is not closed. */
  remains?: string;
};

/** `waves` is how many dispatches of the reviewer's uncovered slices remain, when the gap is about uncovered slices. */
export type LedgerGap = { reviewer?: string; detail: string; next: string; waves?: number };

export type LedgerInputs = {
  mode: ReviewMode;
  /** The round depth `required --package` recorded; absent means a full round. */
  depth?: "light" | "full" | undefined;
  selected: string[];
  /** Absent for a run that was never sliced. */
  manifest?: SliceManifest | undefined;
  /** Reviewer → slice ids named by its dispatched payloads. */
  payloadSlices: Record<string, string[]>;
  /** Only one dispatch may supply a legacy implicit assignment. */
  payloadDispatchCounts?: Record<string, number>;
  /** Reviewer → resolved rule file, only when it exists. */
  ruleFiles: Record<string, string>;
  /** Reviewer → the model its driver records (the dispatcher passes it); a result's own `model` wins. */
  models?: Record<string, string> | undefined;
  raws: RawFile[];
  /** Reviewer → the text of its tool-call log; a reviewer with no entry has `layersUsed` unknown. */
  toolLogs?: Record<string, string | undefined>;
  retry: RetryState;
  canonical: Array<Record<string, unknown>>;
  dispositions: Disposition[];
  manifestPath?: string;
  /** True when the package holds a mutation record (`research-evidence/mutation-*.json`): the round did run mutation. */
  mutationRecorded?: boolean | undefined;
  /**
   * Written to `dispatch.roles`: the roles the code that dispatched this package knew about. Absent for a package nothing
   * says that of, so a rebuild never turns an in-flight package into one that must have run a role it predates.
   */
  dispatchRoles?: readonly string[] | undefined;
  /**
   * Required reviewers the operator deliberately did not run (`ledger build --skip <reviewer> --reason`). They leave
   * `selected`, and are written to `dispatch.skipped` and as `Not run: <reviewer> — <reason>` lines to `dispatch.notRun`.
   */
  skipped?: readonly ReviewerSkip[] | undefined;
  /** Reviewer names the project's review tree holds; a fix slice's routed roles outside it are owed no read. Absent: every routed role counts as installed. */
  installed?: ReadonlySet<string> | undefined;
  /** Reviewers the required set dropped by `supersedes` or an overlap group, and the notes of the ones it refused to drop (M6). */
  superseded?: ReadonlyArray<{ reviewer: string; reason: string }> | undefined;
  supersedeNotes?: readonly string[] | undefined;
  /** Findings a delta round carried over unchanged (`round.json` `carried`): kept in the record; they cover no fix slice. */
  carried?: ReadonlyArray<{ findingId: string; disposition: string }> | undefined;
  /**
   * Flow 460: the findings `review ingest` screened out of findings.json (scope-B floor, outside the blast radius), read
   * from the package's {@link INGEST_SCREENED_FILE}. A raw finding among them closes `out-of-scope` with the screen's
   * reason, so the ledger does not go stale when ingest removes a finding. `screenedEvidence` is the file it came from.
   */
  screened?: readonly IngestScreened[] | undefined;
  screenedEvidence?: string | undefined;
};

export type LedgerResult = {
  ledger: {
    version: 1;
    scopeReviewed: boolean;
    rawReconciled: boolean;
    obligations: Array<Record<string, unknown>>;
    dispatch: Record<string, unknown>;
    /** Files in raw/ that were set aside as not reviewer replies; written by `ledger build`, not read by the gate. */
    setAside?: string[];
    /** The audit sample of a routed round and what it caught; not read by the gate. */
    audit?: AuditRecord;
    /** Flow 460: the round's token spend over every raw result, unknown dispatches counted, never added as 0. */
    usage?: UsageTotals;
  };
  gaps: LedgerGap[];
};

export const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex").slice(0, 12);

const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** A key that names an obligation: the obligation id itself, or a global id `<reviewId>#<obligation id>`. */
const namesObligation = (key: unknown, oid: string): boolean => key === oid || (typeof key === "string" && key.endsWith(`#${oid}`));
/** A canonical finding whose `id` or `global_id` is `key`. */
const holdsKey = (finding: Record<string, unknown>, key: unknown): boolean => finding.id === key || finding.global_id === key;
/** A canonical finding the duplicate merge folded `id` into (its `merged_from` entries are `<reviewId>#<display id>`). */
const mergedFromHas = (finding: Record<string, unknown>, id: string): boolean => Array.isArray(finding.merged_from) && finding.merged_from.some((entry) => namesObligation(entry, id));

/** A `{` followed by a quote or `}`: where a JSON object with keys, or an empty one, can start. A prose brace such as `{config}` or `{ to` does not match, so it never opens a candidate. */
const OBJECT_START = /\{\s*["}]/y;

const RESULT_KEYS = new Set(["status", "reviewer", "findings"]);
const KEY_COLON = /\s*:/y;

/**
 * The brace closing the object that opens at `start`. When it never closes, `claimsResult` says whether the object
 * itself (not an object nested in it) carries a key of a reviewer result: only then is the fragment a cut-off result.
 */
function objectEnd(raw: string, start: number): { end?: number; claimsResult: boolean } {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let keyFrom = 0;
  let claimsResult = false;
  for (let end = start; end < raw.length; end += 1) {
    const char = raw[end];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        quoted = false;
        if (depth === 1 && !claimsResult && RESULT_KEYS.has(raw.slice(keyFrom, end))) {
          KEY_COLON.lastIndex = end + 1;
          claimsResult = KEY_COLON.test(raw);
        }
      }
    } else if (char === '"') { quoted = true; keyFrom = end + 1; }
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return { end, claimsResult };
  }
  return { claimsResult };
}

/** How many cut-off-looking fragments are skipped before the reply is read as truncated (no result, so the reviewer is re-dispatched): every one costs a scan to the end, about 3 ms per MB. */
const MAX_UNCLOSED = 64;

/**
 * The objects that stand at the top level of a reply. A candidate that fails to parse is skipped whole, never entered.
 * One that never closes ends the scan when it carries the result keys (a result cut off); otherwise it is prose and only
 * its brace is skipped, up to MAX_UNCLOSED times; the next one ends the scan the same way (the reply gives no result).
 * A cut-off fragment is entered again at each of its own braces, so a result key anywhere in it, even in an object nested
 * inside the cut-off one, ends the scan as truncated.
 */
function topLevelObjects(raw: string): { found: Array<{ start: number; value: unknown }>; truncated: boolean } {
  const found: Array<{ start: number; value: unknown }> = [];
  let unclosed = 0;
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start)) {
    OBJECT_START.lastIndex = start;
    if (!OBJECT_START.test(raw)) { start += 1; continue; }
    const { end, claimsResult } = objectEnd(raw, start);
    if (end === undefined) {
      if (claimsResult || (unclosed += 1) > MAX_UNCLOSED) return { found, truncated: true };
      start += 1;
      continue;
    }
    const value = tryParse(raw.slice(start, end + 1));
    if (value !== undefined) found.push({ start, value });
    start = end + 1;
  }
  return { found, truncated: false };
}

/** An opening line: up to 3 spaces, 3 or more backticks, and no further backtick (an inline mention is not a fence). */
const FENCE_OPEN = /^ {0,3}(`{3,})[^`]*$/;
/** A closing line: up to 3 spaces and a run of backticks, nothing else on the line. */
const FENCE_CLOSE = /^ {0,3}(`{3,})[ \t]*$/;

/**
 * `from` inclusive, `to` exclusive, of each fenced block, read line by line as CommonMark does: an opening line starts it, a
 * line holding only a run of at least as many backticks ends it, and an opening that never closes runs to the end of the reply.
 * A triple backtick inside a sentence therefore never changes which lines are fenced. One forward pass over the lines.
 */
function fenceRanges(raw: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let opened: { from: number; length: number } | undefined;
  for (let lineStart = 0; lineStart < raw.length; ) {
    const newline = raw.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? raw.length : newline;
    const line = raw.slice(lineStart, raw.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd);
    if (opened === undefined) {
      const open = FENCE_OPEN.exec(line);
      if (open !== null) opened = { from: lineStart, length: open[1]!.length };
    } else {
      const close = FENCE_CLOSE.exec(line);
      if (close !== null && close[1]!.length >= opened.length) {
        ranges.push([opened.from, lineEnd] as const);
        opened = undefined;
      }
    }
    lineStart = lineEnd + 1;
  }
  if (opened !== undefined) ranges.push([opened.from, raw.length] as const);
  return ranges;
}

/** Whether a position lies inside a fenced block. Positions must be asked in ascending order: one forward pass over the ranges. */
function fenceTester(raw: string): (position: number) => boolean {
  const ranges = fenceRanges(raw);
  let next = 0;
  return (position) => {
    while (next < ranges.length && ranges[next]![1] <= position) next += 1;
    return next < ranges.length && position >= ranges[next]![0];
  };
}

/** Any top-level JSON object with a string `status`: the first rule every kind of result shares. */
export function hasStatus(value: unknown): value is ParsedResult & { status: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as { status?: unknown }).status === "string";
}

/** A reviewer's own result: a status, and either the reviewer's name or a `findings` array (a slice entry carries neither). */
export function isReviewerResult(value: unknown): value is ParsedResult {
  if (!hasStatus(value)) return false;
  const object = value as Record<string, unknown>;
  return typeof object.reviewer === "string" || Array.isArray(object.findings);
}

/** `at` is where the label that starts the result begins in the reply. */
type Decision = { result: ParsedResult | undefined; at: number };

/** A line that only closes a fence. A JSON string cannot hold a raw newline, so such a line is never inside the object. */
const LINE_CLOSE = /^ {0,3}```[ \t]*\r?$/gm;

/**
 * The last ```REVIEW_RESULT block. It keeps the status-only rule: the label already says what the block is.
 * The block ends at the first triple backtick; when that cuts the object short (a triple backtick written inside a JSON
 * string) it is read again up to the first line that holds only a closing fence.
 */
function labelledFence(raw: string): Decision | undefined {
  const labelled = [...raw.matchAll(/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi)];
  if (labelled.length === 0) return undefined;
  const last = labelled[labelled.length - 1]!;
  let parsed = tryParse(last[1]!);
  if (parsed === undefined) {
    const bodyStart = last.index! + last[0].length - last[1]!.length - 3;
    LINE_CLOSE.lastIndex = bodyStart;
    const close = LINE_CLOSE.exec(raw);
    if (close !== null) parsed = tryParse(raw.slice(bodyStart, close.index));
  }
  return { result: hasStatus(parsed) ? parsed : undefined, at: last.index! };
}

function tryParse(source: string): unknown {
  try { return JSON.parse(source); } catch { return undefined; }
}

/** How many of the last markers are tried (older ones are not read at all, and the scan of rule 3 follows): each one whose object never closes costs a scan to the end. */
const MAX_MARKERS = 64;

/** A marker counts where it starts its line, after at most a quote, list or heading prefix: a mention inside a sentence is prose. */
const MARKER = /(?<![^\n])[ \t>*#-]*REVIEW_RESULT(?:[ \t]*[:=])?\s*(?=\{)/g;

/**
 * The reviewer result right after the last `REVIEW_RESULT` marker that starts a line outside a fenced block and has one.
 * A marker followed by something that is not a reviewer result (prose such as `REVIEW_RESULT {contract}`, a cut-off
 * object) is passed over for the one before it.
 */
function afterMarker(raw: string): { result: ParsedResult; at: number } | undefined {
  const inFence = fenceTester(raw);
  const markers = [...raw.matchAll(MARKER)].filter((marker) => !inFence(marker.index!)).slice(-MAX_MARKERS);
  for (let at = markers.length - 1; at >= 0; at -= 1) {
    const marker = markers[at]!;
    const start = marker.index! + marker[0].length;
    const { end } = objectEnd(raw, start);
    if (end === undefined) continue;
    const parsed = tryParse(raw.slice(start, end + 1));
    if (isReviewerResult(parsed)) return { result: parsed, at: marker.index! };
  }
  return undefined;
}

/** No label, and no marker that gave a reviewer result: the reviewer-shaped objects at the top level, fenced ones first. */
function scannedResult(raw: string): ParsedResult | undefined {
  const { found, truncated } = topLevelObjects(raw);
  if (truncated) return undefined;
  const inFence = fenceTester(raw);
  const fenced: unknown[] = [];
  const bare: unknown[] = [];
  for (const { start, value } of found) (inFence(start) ? fenced : bare).push(value);
  const fencedResults = fenced.filter(isReviewerResult);
  if (fencedResults.length > 0) {
    const last = fencedResults[fencedResults.length - 1]!;
    return bare.filter(isReviewerResult).some((value) => value.status !== last.status) ? undefined : last;
  }
  if (new Set(bare.filter(hasStatus).map((value) => value.status)).size > 1) return undefined;
  const accepted = bare.filter(isReviewerResult);
  return accepted[accepted.length - 1];
}

/**
 * The reviewer's result, in this order; the first rule that applies decides.
 * 1. The last ```REVIEW_RESULT fence: any object with a status.
 * 2. The object after the last bare REVIEW_RESULT marker (at the start of a line, outside a fence; only the last
 *    MAX_MARKERS are read) whose object is a reviewer result: a status plus a reviewer or a findings array. A marker
 *    followed by anything else is passed over for the one before it.
 * 3. Otherwise the top-level objects of the reply:
 *    - a cut-off object that carries the result keys gives no result; prose that merely opens a brace is skipped, up to
 *      MAX_UNCLOSED times, and the next one gives no result either;
 *    - the last reviewer-shaped object inside a fenced block wins, unless a reviewer-shaped bare object carries a
 *      different status (then none: a fenced sample cannot be told from the real result);
 *    - with no fenced one, the last reviewer-shaped bare object, unless the bare objects (any with a status) carry
 *      different statuses (then none; the same status twice is not ambiguous).
 * Never guessed from prose.
 * When none of that gives a result, the lenient reader (./result-parse.ts) is tried: a JSON array of results (one per
 * wave), a result wrapped in `result` / `review_result`, a fenced ```json block or a bare object with prose around it.
 * It is skipped for a reply that looks cut off, and gives none for disagreeing results.
 */
export function parseReviewResult(reply: string): ParsedResult | undefined {
  // A host's `KERYX_USAGE` line (flow 460) is not part of the reviewer's reply.
  const raw = splitUsage(reply).body;
  const labelled = labelledFence(raw);
  if (labelled !== undefined) return labelled.result ?? lenientReviewResult(raw.slice(labelled.at));
  const marked = afterMarker(raw)?.result;
  if (marked !== undefined) return marked;
  // A reply that looks cut off gives no result, whatever complete list or object stands before the cut: the lost part may
  // hold findings (`[{DONE, slices:[s1]}]` followed by a cut-off `{…findings:[{"id":"F1"…` must not read as DONE).
  const { truncated } = topLevelObjects(raw);
  if (truncated) return undefined;
  // A JSON list of results (one per wave) is merged, not read as its last object. A list beside a bare reviewer result, or
  // a bare result that merely has a `waves` field, is not a list reply (`holdsResultList` says so): the strict reader judges it.
  if (holdsResultList(raw)) return lenientReviewResult(raw);
  const strict = scannedResult(raw);
  if (strict !== undefined) return strict;
  return lenientReviewResult(raw);
}

/** Why `parseReviewResult` found nothing in a reply, naming what is missing (reviewer, status, slices, findings). */
export function explainUnparsedResult(raw: string): string {
  return describeUnusableResult(raw);
}

/** A line that starts with `Parent follow-up:` (after at most a quote, list or emphasis prefix); the rest of the line is the follow-up. */
const PARENT_FOLLOW_UP = /^[ \t>*_-]*Parent follow-up[ \t]*\**:\**[ \t]*(.*\S)[ \t]*$/i;

/**
 * The `Parent follow-up:` lines a reviewer wrote after its REVIEW_RESULT block. Only lines below the label that starts
 * the parsed result count (the last ```REVIEW_RESULT fence, else the marker the result was read after), so a line quoted
 * in the reviewer's own prose before the block is not read as an obligation, and a later mention of the word does not
 * move the start. A reply with no such label (a bare result object) is read whole.
 */
export function parentFollowUps(raw: string): string[] {
  const label = labelledFence(raw) ?? afterMarker(raw);
  const lines = (label === undefined ? raw : raw.slice(label.at)).split(/\r?\n/);
  const found: string[] = [];
  for (const line of label === undefined ? lines : lines.slice(1)) {
    const hit = PARENT_FOLLOW_UP.exec(line);
    if (hit !== null) found.push(hit[1]!);
  }
  return found;
}

/** The follow-ups of a result: its `follow_ups` strings, then the `Parent follow-up:` lines after the block, each distinct text once. */
export function followUpsOf(result: ParsedResult, raw?: string): string[] {
  const own = Array.isArray(result.follow_ups) ? result.follow_ups.filter(text).map((s) => s.trim()) : [];
  return [...new Set([...own, ...(raw === undefined ? [] : parentFollowUps(raw))])];
}

/** A blank reply or the no-text placeholder; a usage line (flow 460) records what it cost and does not make it a reply. */
export function isEmptyOutput(reply: string): boolean {
  return isEmptyRecord(reply);
}

/** A raw result's token use: the host's `KERYX_USAGE` line, else the result envelope's own `usage`; undefined is unknown. */
export function rawUsage(raw: RawFile): DispatchUsage | undefined {
  return raw.usage ?? usageFrom(raw.result?.usage);
}

/** Every dispatch a raw file records, one entry each: the other ones saved to the same path, then the one whose reply it holds. */
export function rawDispatchUsages(raw: RawFile): Array<DispatchUsage | undefined> {
  return [...(raw.otherUsage ?? []), rawUsage(raw)];
}

const sliceIdsOf = (value: unknown): string[] => readSliceIds(value).ids;

/** Ids a set of dispatched slices accounts for: themselves, and an original whose smaller retry slices were all covered. */
function accountedFor(manifest: SliceManifest, reviewer: string, ids: Iterable<string>): Set<string> {
  return sliceGraph(manifest, reviewer).accounted(ids);
}

function retryNext(reviewer: string, raw: RawFile, manifestPath: string | undefined): string {
  return `keryx review retry-plan --manifest ${manifestPath ?? "<slices/manifest.json>"} --result ${raw.name} --reviewer ${reviewer}`;
}

/** The dispatches still owed to a reviewer: its uncovered required slices, packed under the manifest's wave budget. */
function wavesLeft(manifest: SliceManifest, reviewer: string, seen: ReadonlySet<string>): { slices: number; waves: number; bytes: number } {
  const graph = sliceGraph(manifest, reviewer);
  return summarizeWaves(packWavesByKind(graph.open(requiredSlices(manifest, reviewer), seen), waveBytesOf(manifest)));
}

function waveNext(reviewer: string, manifestPath: string | undefined, processed: RawFile | undefined): string {
  const manifest = manifestPath ?? "<slices/manifest.json>";
  const result = processed === undefined ? "" : ` --result ${processed.name}`;
  return `keryx review retry-plan --manifest ${manifest} --reviewer ${reviewer}${result} --next-wave  (hands out the next wave of uncovered slices; dispatch-check it, save the reply under raw/, run this again until it prints accepted)`;
}

/**
 * Build the research ledger from what actually happened. Nothing is declared that no file backs: a reviewer that
 * did not finish its slices stays incomplete, an unmatched raw finding stays an unresolved obligation, and the gaps
 * name the next step for each.
 */
export function buildLedger(input: LedgerInputs): LedgerResult {
  const gaps: LedgerGap[] = [];
  const skipped = input.skipped ?? [];
  const skippedNames = new Set(skipped.map((skip) => skip.reviewer));
  const selected = input.selected.filter((reviewer) => !skippedNames.has(reviewer));
  const { manifest, raws } = input;
  const attributed = raws.filter((r) => r.result?.reviewer !== undefined && text(r.result.reviewer));
  // Delta round (flow 458, M4): a `prior_dispositions` entry counts only for the reviewer that gave it, and only from a
  // finished result of this scope (a result stamped with another scope fingerprint is a stale round's). Carried findings
  // keep their recorded disposition for the report; they are never attached to a fix slice, so they cover none.
  const fingerprintNow = manifest === undefined ? undefined : scopeFingerprint(manifest);
  const dispositionsBy = new Map<string, Map<string, string>>();
  for (const raw of [...attributed].sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))) {
    const result = raw.result!;
    const open = needsContextQuestions(result.needs_context).length > 0;
    const stamped = (result as { scopeFingerprint?: unknown }).scopeFingerprint;
    if (!FINISHED.has(String(result.status ?? "").toUpperCase()) || open || (typeof stamped === "string" && stamped !== fingerprintNow)) continue;
    const mine = dispositionsBy.get(result.reviewer!) ?? new Map<string, string>();
    for (const [id, disposition] of priorDispositionsOf(result)) mine.set(id, disposition);
    dispositionsBy.set(result.reviewer!, mine);
  }
  const priorDispositions = new Map<string, string>();
  for (const carried of input.carried ?? []) if (text(carried.findingId) && text(carried.disposition)) priorDispositions.set(carried.findingId, carried.disposition);
  for (const given of dispositionsBy.values()) for (const [id, disposition] of given) priorDispositions.set(id, disposition);
  /** Slices each reviewer's finished run read. */
  const readBy = new Map<string, ReadonlySet<string>>();
  for (const raw of raws) {
    if (raw.empty) continue;
    if (raw.result === undefined) gaps.push({ detail: `${raw.name}: no parseable REVIEW_RESULT block${raw.diagnosis === undefined ? "" : ` (${raw.diagnosis})`}`, next: `re-dispatch the reviewer that produced ${raw.name}, or remove the file if it is not a reviewer result` });
    else if (!text(raw.result.reviewer)) gaps.push({ detail: `${raw.name}: the result names no reviewer, so it cannot be attributed`, next: `have the reviewer re-emit its result with "reviewer" set` });
  }

  const runs: Array<Record<string, unknown>> = [];
  const complete = new Map<string, Set<string>>();
  for (const reviewer of selected) {
    const mine = attributed.filter((r) => r.result!.reviewer === reviewer).sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    const latest = mine[mine.length - 1];
    const fingerprint = manifest === undefined ? undefined : scopeFingerprint(manifest);
    const known = fingerprint !== undefined && input.retry.scopeFingerprint === fingerprint ? input.retry.reviewers[reviewer] : undefined;
    if (known?.notRun === true) {
      runs.push({ reviewer, executionId: `${reviewer}:not-run`, status: "not-run", notRunReason: `${known.status} after the allowed retry (retry-state)`, scopeComplete: false });
      gaps.push({ reviewer, detail: `${reviewer}: not run (${known.status} after the allowed retry)`, next: "no retry is left; the report carries the Not run line, and only the operator can accept a smaller set (dispatch override with their own quote)" });
      continue;
    }
    if (latest === undefined && manifest !== undefined && routedOut(manifest, reviewer)) {
      // Slice routing gave this role no slice: there is nothing for it to read, and the manifest's routing is the evidence.
      const anchor = `${input.manifestPath ?? "slices/manifest.json"}#roles`;
      runs.push({ reviewer, executionId: `${reviewer}:routed-out:${routingHash(manifest)}`, status: "complete", scopeComplete: true, routedOut: true, coveredSlices: [], rawEvidence: anchor, ruleEvidence: [input.ruleFiles[reviewer] ?? anchor], executionRequired: false, executionReason: "slice routing gave this role no slice: no changed line's content or path needs it, so there was nothing to dispatch", layersUsed: layersUsedFrom(undefined) });
      continue;
    }
    if (latest === undefined) {
      runs.push({ reviewer, executionId: `${reviewer}:not-run`, status: "not-run", notRunReason: "no reviewer result recorded", scopeComplete: false });
      const left = manifest === undefined ? undefined : wavesLeft(manifest, reviewer, accountedFor(manifest, reviewer, known?.covered ?? []));
      gaps.push({
        reviewer,
        detail: `${reviewer}: no result recorded${left === undefined ? "" : `; ${left.slices} slice(s) to cover in ${left.waves} wave(s) of at most ${waveBytesOf(manifest!)} bytes`}`,
        next: manifest === undefined ? `dispatch ${reviewer} on its slices, save the reply to raw/${reviewer}.txt, run keryx review dispatch-check first` : waveNext(reviewer, input.manifestPath, undefined),
        ...(left === undefined ? {} : { waves: left.waves }),
      });
      continue;
    }
    const result = latest.result!;
    const status = String(result.status ?? "").toUpperCase();
    const asked = needsContextQuestions(result.needs_context);
    const unreadable = unreadableInputClaim(result);
    const finished = FINISHED.has(status) && asked.length === 0 && unreadable === undefined;
    const run: Record<string, unknown> = { reviewer, executionId: `${reviewer}:${latest.hash}`, rawEvidence: `${latest.name}#sha256:${latest.hash}`, executionRequired: false, layersUsed: layersUsedFrom(input.toolLogs?.[reviewer]) };
    const recorded = [...mine].reverse().map((raw) => raw.result?.model).find(text) ?? input.models?.[reviewer];
    if (text(recorded)) run.model = recorded.trim();
    run.usage = runUsage(mine);
    const rule = input.ruleFiles[reviewer];
    run.ruleEvidence = rule === undefined ? [] : [rule];
    if (rule === undefined) gaps.push({ reviewer, detail: `${reviewer}: no resolved rule file (driver payload names none that exists)`, next: `write drivers/${reviewer}.json with the reviewer's definition path` });
    const claimed = new Set<string>();
    if (manifest !== undefined) {
      for (const raw of mine) {
        const reply = raw.result!;
        const assigned = raw.assignedSlices ?? (mine.length === 1 && input.payloadDispatchCounts?.[reviewer] === 1 ? input.payloadSlices[reviewer] : undefined);
        if (assigned === undefined) continue;
        const allowed = new Set(assigned);
        // Flow 460 D: a reply that names no `slices` claims none; a DONE status alone is not coverage of a manifest.
        const ids = sliceIdsOf(reply.slices);
        for (const id of ids) if (allowed.has(id)) claimed.add(id);
      }
      for (const id of known?.covered ?? []) claimed.add(id);
    }
    const seen = manifest === undefined ? new Set<string>() : new Set(accountedFor(manifest, reviewer, claimed));
    if (finished) readBy.set(reviewer, seen);
    if (manifest !== undefined) run.coveredSlices = [...seen].sort();
    const dropped = [...new Set(mine.flatMap((raw) => sliceReadingNotes(readSliceIds(raw.result!.slices))))];
    const droppedTail = dropped.length === 0 ? "" : ` (${dropped.join("; ")})`;
    if (!finished) {
      run.status = "incomplete";
      run.scopeComplete = false;
      run.executionReason = "not claimed: the reviewer did not finish its scope";
      const why = asked.length > 0 ? `open needs_context (${asked.length}): ${asked.slice(0, 3).join(" | ")}` : unreadable !== undefined && FINISHED.has(status) ? `the reply states a mandatory input could not be read ("${unreadable}")` : status;
      const left = manifest === undefined ? undefined : wavesLeft(manifest, reviewer, seen);
      const tail = left === undefined || left.slices === 0 ? "" : `; ${left.slices} slice(s) uncovered, ${left.waves} wave(s) left`;
      gaps.push({ reviewer, detail: `${reviewer}: ${why}; scope not closed${tail}${droppedTail}`, next: retryNext(reviewer, latest, input.manifestPath), ...(left === undefined ? {} : { waves: left.waves }) });
      runs.push(run);
      continue;
    }
    run.status = "complete";
    run.executionReason = "source-only review: the result is DONE with no open needs_context, and nothing it was asked to do required running a command";
    let scopeComplete = true;
    if (manifest !== undefined) {
      const missing = requiredSlices(manifest, reviewer).filter((id) => !seen.has(id));
      if (missing.length > 0) {
        scopeComplete = false;
        const shown = missing.slice(0, 8).join(", ") + (missing.length > 8 ? `, … (+${missing.length - 8})` : "");
        const left = wavesLeft(manifest, reviewer, seen);
        const processed = known?.covered !== undefined && sliceIdsOf(result.slices).every((id) => known.covered!.includes(id)) ? undefined : latest;
        gaps.push({ reviewer, detail: `${reviewer}: ${missing.length} slice(s) not covered by any dispatched payload: ${shown}; ${left.waves} wave(s) of at most ${waveBytesOf(manifest)} bytes left${droppedTail}`, next: waveNext(reviewer, input.manifestPath, processed), waves: left.waves });
      } else complete.set(reviewer, seen);
    } else complete.set(reviewer, new Set());
    run.scopeComplete = scopeComplete;
    runs.push(run);
  }

  // A fix slice is covered only when every reviewer on its roster (but a skip the operator confirmed) read it AND every
  // finding attached to it has a disposition from a reviewer on that roster (M4).
  const fix = manifest === undefined ? { covered: [], gaps: [] } : fixSliceCoverage(manifest, readBy, dispositionsBy, skippedNames, input.installed ?? new Set(manifest.slices.flatMap((slice) => slice.roles ?? [])));
  const fixCovered = new Set(fix.covered);
  gaps.push(...fix.gaps);

  const unresolvedRules = selected.filter((r) => input.ruleFiles[r] === undefined);
  const notRun = [...(input.depth === "light" && input.mutationRecorded !== true ? ["Not run: mutation (light round)"] : []), ...skipped.map(skipLine)];
  const superseded = (input.superseded ?? []).map((entry) => ({ reviewer: entry.reviewer, reason: entry.reason }));
  const dispatch = { version: 1, mode: input.mode, ...(superseded.length === 0 ? {} : { superseded }), ...((input.supersedeNotes ?? []).length === 0 ? {} : { supersedeNotes: [...input.supersedeNotes!] }), ...(fixCovered.size === 0 ? {} : { fixSlicesCovered: [...fixCovered].sort() }), ...(priorDispositions.size === 0 ? {} : { priorDispositions: Object.fromEntries([...priorDispositions].sort(([a], [b]) => a.localeCompare(b))) }), ...(input.depth === "light" ? { depth: "light" } : input.depth === "full" ? { depth: "full" } : {}), ...(notRun.length === 0 ? {} : { notRun }), selected, ...(skipped.length === 0 ? {} : { skipped: skipped.map((skip) => ({ reviewer: skip.reviewer, reason: skip.reason })) }), ...(input.dispatchRoles === undefined || input.dispatchRoles.length === 0 ? {} : { roles: [...input.dispatchRoles] }), unresolvedRules, runs };

  const obligations: Array<Record<string, unknown>> = [];
  const derived = new Set<string>();
  // A raw finding the ingest merged into another reviewer's (flow 458 AC5) is found through `reported_by` + `merged_from`.
  const absorbedInto = (f: Record<string, unknown>, reviewer: string, id: string): boolean =>
    Array.isArray(f.reported_by) && f.reported_by.includes(reviewer) && mergedFromHas(f, id);
  const canonicalByReviewer = (reviewer: string, id: string) => {
    const own = input.canonical.filter((f) => f.reviewer === reviewer && f.id === id);
    return own.length > 0 ? own : input.canonical.filter((f) => absorbedInto(f, reviewer, id));
  };
  // Flow 460: canonical findings are commonly named after the raw file and the reviewer's id (`<raw stem>:<id>`, the
  // obligation id itself). Such a finding links by that id, and one the duplicate merge folded into a survivor links to
  // the survivor through its `merged_from` (whose entries are `<reviewId>#<display id>`).
  const canonicalByObligation = (oid: string) => {
    const own = input.canonical.filter((f) => holdsKey(f, oid));
    return own.length > 0 ? own : input.canonical.filter((f) => mergedFromHas(f, oid));
  };
  // A reviewer's display ids restart in every wave (review-logic-w3:F-001 and review-logic-w4:F-001 are two findings), so
  // the reviewer plus a bare id names one raw finding only when exactly one raw file of that reviewer carries the id.
  const carrierKey = (reviewer: string, id: string): string => `${reviewer}\u0000${id}`;
  const carriers = new Map<string, number>();
  for (const raw of attributed) {
    const ids = new Set<string>();
    for (const finding of Array.isArray(raw.result!.findings) ? raw.result!.findings! : []) if (finding && typeof finding.id === "string") ids.add(finding.id);
    for (const id of ids) {
      const key = carrierKey(raw.result!.reviewer!, id);
      carriers.set(key, (carriers.get(key) ?? 0) + 1);
    }
  }
  /** The canonical findings a raw finding resolves to: the same reviewer and id first (when no other wave reuses the id), else by its obligation id. */
  const resolveCanonical = (reviewer: string, fid: string, oid: string) => {
    const byReviewer = carriers.get(carrierKey(reviewer, fid)) === 1 ? canonicalByReviewer(reviewer, fid) : [];
    return byReviewer.length === 1 ? byReviewer : canonicalByObligation(oid);
  };
  const keyOf = (f: Record<string, unknown>): string | undefined => (text(f.global_id) ? f.global_id : text(f.id) ? f.id : undefined);
  const resolvesOnce = (key: string | undefined): key is string => text(key) && input.canonical.filter((f) => holdsKey(f, key)).length === 1;
  // Only the exact raw obligation (`<raw stem>:<id>`, or a global id ending in it) matches a screened entry. A reviewer's
  // display ids restart in every wave, so the reviewer plus a bare id would close another wave's finding.
  const screenedAs = (oid: string) => (input.screened ?? []).find((entry) => namesObligation(entry.id, oid) || namesObligation(entry.global_id, oid));
  for (const raw of attributed) {
    const reviewer = raw.result!.reviewer!;
    for (const finding of Array.isArray(raw.result!.findings) ? raw.result!.findings! : []) {
      const fid = finding && typeof finding.id === "string" ? finding.id : undefined;
      if (fid === undefined) continue;
      if (displayIdHasHash(fid)) gaps.push({ reviewer, detail: `${raw.name}: finding id "${fid}" holds "#"; ingest refuses it`, next: `have ${reviewer} re-emit its result with ids that hold no "#" (${DISPLAY_ID_FORM})` });
      const id = `${raw.name.replace(/^raw\//, "").replace(/\.txt$/, "")}:${fid}`;
      derived.add(id);
      const base = { id, source: raw.name, question: `Is ${reviewer} finding ${fid} (${String(finding.problem ?? finding.title ?? "").slice(0, 100)}) real, and where is it reported?` };
      const given = input.dispositions.find((d) => d.id === id);
      const hit = resolveCanonical(reviewer, fid, id);
      const key = hit.length === 1 ? keyOf(hit[0]!) : undefined;
      const closure = closeWith(given, input.canonical, resolvesOnce(key) ? key : undefined);
      if (closure !== undefined) { obligations.push({ ...base, ...closure }); continue; }
      if (resolvesOnce(key)) {
        const merged = hit[0]!.id !== fid && hit[0]!.id !== id && hit[0]!.global_id !== id;
        obligations.push({ ...base, status: "finding", finding: key, evidence: `${raw.name}#sha256:${raw.hash}`, reason: merged ? `reported by ${reviewer} as ${fid}; review ingest merged it as a duplicate into canonical ${key}` : `reported by ${reviewer} as ${fid}; the same finding is canonical ${key}` });
        continue;
      }
      const screened = screenedAs(id);
      if (screened !== undefined) {
        obligations.push({ ...base, status: "out-of-scope", evidence: input.screenedEvidence ?? INGEST_SCREENED_FILE, reason: `review ingest's scope-B screen kept it out of findings.json (${screened.rule}): ${screened.detail}` });
        continue;
      }
      obligations.push({ ...base, status: "unresolved" });
      gaps.push({ detail: `${id}: raw finding is not in the canonical findings and has no closure`, next: `add a disposition {"id":"${id}","status":"finding|refuted|out-of-scope|narrowed","evidence":…,"reason":…,"remains":… (narrowed only)} to --dispositions` });
    }
    followUpsOf(raw.result!).forEach((followUp, at) => {
      const id = `${raw.name.replace(/^raw\//, "").replace(/\.txt$/, "")}:fu${at + 1}`;
      derived.add(id);
      const base = { id, source: raw.name, question: `Is the parent follow-up from ${reviewer} done or ruled out, and where is that recorded? ${followUp.slice(0, 200)}` };
      const closure = closeWith(input.dispositions.find((d) => d.id === id), input.canonical);
      if (closure !== undefined) { obligations.push({ ...base, ...closure }); return; }
      obligations.push({ ...base, status: "unresolved" });
      gaps.push({ detail: `${id}: parent follow-up is open (${followUp.slice(0, 100)})`, next: `do it or rule it out, then add a disposition {"id":"${id}","status":"finding|refuted|out-of-scope|narrowed","evidence":…,"reason":…,"remains":… (narrowed only)} to --dispositions` });
    });
  }
  for (const given of input.dispositions) {
    if (text(given.id) && !derived.has(given.id) && text(given.source) && text(given.question)) {
      const closure = closeWith(given, input.canonical);
      obligations.push({ id: given.id, source: given.source, question: given.question, ...(closure ?? { status: "unresolved" }) });
    }
  }

  const reconciled = raws.every((r) => r.empty || (r.result !== undefined && text(r.result.reviewer))) && obligations.every((o) => CLOSED.has(String(o.status)));
  let scopeReviewed = selected.length > 0 && runs.every((r) => r.scopeComplete === true) && fix.gaps.length === 0;
  if (scopeReviewed && manifest !== undefined) {
    const covered = new Set<string>();
    for (const seen of complete.values()) seen.forEach((id) => covered.add(id));
    const uncovered = manifest.slices.filter((s) => s.retryOf === undefined && !covered.has(s.id)).map((s) => s.id);
    if (uncovered.length > 0) {
      scopeReviewed = false;
      gaps.push({ detail: `${uncovered.length} slice(s) are covered by no finished reviewer: ${uncovered.slice(0, 8).join(", ")}`, next: "dispatch a reviewer whose path gate matches those slices" });
    }
  }
  const audit = manifest === undefined ? undefined : auditRecord(manifest, attributed);
  // Every dispatch counts, an empty or unparseable one included (it was paid for either way): one per raw result, plus
  // each other dispatch a re-dispatch to the same path recorded on it.
  const usage = usageTotals(raws.flatMap(rawDispatchUsages));
  return { ledger: { version: 1, scopeReviewed, rawReconciled: reconciled, obligations, dispatch, ...(audit === undefined ? {} : { audit }), usage }, gaps };
}

/**
 * Flow 460: a run's token use over every raw result of its reviewer (one per dispatch/wave). `"unknown"` when none
 * reported usage; otherwise the known sums with the count of dispatches that reported none, never folded in as 0.
 */
function runUsage(mine: readonly RawFile[]): RunUsage | "unknown" {
  const usages = mine.flatMap(rawDispatchUsages);
  const totals = usageTotals(usages);
  if (totals.known === 0) return "unknown";
  const model = [...usages].reverse().find((usage) => usage?.model !== undefined)?.model;
  return { tokens_in: totals.tokens_in, tokens_out: totals.tokens_out, ...(model === undefined ? {} : { model }), dispatches: totals.dispatches, unknown: totals.unknown, ...(totals.partial === undefined ? {} : { partial: totals.partial }), ...(totals.reported === undefined ? {} : { reported: totals.reported }) };
}

/** A routable role that slice routing gave no slice, in a routed manifest; the regression reviewer always runs (scope B). */
function routedOut(manifest: SliceManifest, reviewer: string): boolean {
  return isRoutedManifest(manifest) && ROUTABLE_ROLES.has(reviewer) && !ROLES_RUN_WITHOUT_SLICES.has(reviewer) && requiredSlices(manifest, reviewer).length === 0;
}

function routingHash(manifest: SliceManifest): string {
  return sha(JSON.stringify(manifest.slices.filter((s) => s.retryOf === undefined).map((s) => [s.id, s.roles ?? null, s.depth ?? null])));
}

export type AuditRecord = {
  /** Light slices sampled to run deep. */
  slices: string[];
  /** Per audit slice, the findings the core roles the audit added (all but review-logic) reported on it. */
  caught: Array<{ slice: string; findings: string[] }>;
  /** Share of audit slices on which the audit roles found something the light routing would not have dispatched. */
  catchRate: number;
};

const AUDIT_ROLES = new Set(DEEP_ROLES.filter((role) => role !== ALWAYS_ROLE));

/** Which audit slices the audit's extra roles found something on: how often light routing would have missed a finding. */
export function auditRecord(manifest: SliceManifest, raws: readonly RawFile[]): AuditRecord | undefined {
  const audited = manifest.slices.filter((s) => s.retryOf === undefined && s.audit === true);
  if (audited.length === 0) return undefined;
  const caught = audited.map((slice) => {
    const found: string[] = [];
    for (const raw of raws) {
      const reviewer = raw.result?.reviewer;
      if (reviewer === undefined || !AUDIT_ROLES.has(reviewer)) continue;
      for (const finding of Array.isArray(raw.result!.findings) ? raw.result!.findings! : []) {
        const named = finding.slice === slice.id || (Array.isArray(finding.slices) && finding.slices.includes(slice.id));
        const file = typeof finding.file === "string" ? finding.file : typeof finding.location === "string" ? finding.location.replace(/:\d+(?:[-:]\d+)*$/, "") : undefined;
        if (named || (file !== undefined && slice.files.includes(file))) found.push(`${reviewer}:${typeof finding.id === "string" ? finding.id : "?"}`);
      }
    }
    return { slice: slice.id, findings: [...new Set(found)] };
  });
  const hits = caught.filter((entry) => entry.findings.length > 0).length;
  return { slices: audited.map((s) => s.id), caught: caught.filter((entry) => entry.findings.length > 0), catchRate: Number((hits / audited.length).toFixed(3)) };
}

/** Keys a list of dispositions is commonly wrapped in, tried in order (`obligations` is what an earlier `ledger build` wrote). */
export const DISPOSITION_WRAPPER_KEYS: readonly string[] = ["dispositions", "items", "results", "data", "entries", "obligations"];

/** The one schema of a `ledger build --dispositions` row, worded for an error. */
export const DISPOSITION_SCHEMA = `{"id":"<raw stem>:<Fn>","status":"finding|refuted|out-of-scope|narrowed","evidence":…,"reason":…,"finding":… (status finding; optional: defaults to the canonical finding whose id is the row's id, or the one the raw finding resolves to),"remains":… (status narrowed)}`;

/**
 * The dispositions of a `--dispositions` input: an array, or an object holding one under a wrapper key (`dispositions`,
 * `items`, `results`, `data`, `entries`, `obligations`; wrappers may nest). Rows are `Disposition`s of the one schema:
 * an `id`, a `status` that closes (`finding`, `refuted`, `out-of-scope`, `narrowed`), and for `narrowed` the `remains`
 * that still stands. `strict` (an input the caller wrote, as opposed to the obligations of an earlier build, whose still
 * open rows are `unresolved`) collects every row that breaks the schema in `bad`, one line each, instead of reading it.
 */
export function normalizeDispositions(given: unknown, options: { strict: boolean }): { rows: Disposition[]; bad: string[] } {
  const bad: string[] = [];
  const find = (value: unknown, depth: number): unknown[] | undefined => {
    if (Array.isArray(value)) return value;
    if (value === null || typeof value !== "object" || depth > 3) return undefined;
    for (const key of DISPOSITION_WRAPPER_KEYS) {
      const inner = find((value as Record<string, unknown>)[key], depth + 1);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  const list = find(given, 0);
  if (list === undefined) {
    if (given === undefined || !options.strict) return { rows: [], bad };
    bad.push(`not a list of dispositions: expected an array, or an object holding one under ${DISPOSITION_WRAPPER_KEYS.map((key) => `"${key}"`).join(", ")}`);
    return { rows: [], bad };
  }
  const rows: Disposition[] = [];
  list.forEach((row, at) => {
    const label = row !== null && typeof row === "object" && text((row as Disposition).id) ? `row ${at + 1} (${(row as Disposition).id})` : `row ${at + 1}`;
    if (row === null || typeof row !== "object" || Array.isArray(row)) { bad.push(`${label}: not an object`); return; }
    const given = row as Disposition;
    if (options.strict) {
      const problems: string[] = [];
      if (!text(given.id)) problems.push('no "id"');
      const status = String(given.status);
      if (!CLOSED.has(status) && status !== "unresolved") problems.push(`status "${status === "undefined" ? "" : status}" is not one of finding, refuted, out-of-scope, narrowed`);
      else if (status === "narrowed" && !text(given.remains)) problems.push('narrowed needs "remains" (what of the finding still stands)');
      if (problems.length > 0) { bad.push(`${label}: ${problems.join("; ")}`); return; }
    }
    rows.push(given);
  });
  return { rows, bad };
}

/**
 * The closure a disposition gives, or undefined. A `status: finding` row with no `finding` link (flow 460) links to the
 * canonical finding whose id (or global_id) is the row's own id, else to `defaultLink`, the canonical finding the raw
 * finding already resolves to; a link that resolves to no single canonical finding does not close.
 */
function closeWith(given: Disposition | undefined, canonical: Array<Record<string, unknown>>, defaultLink?: string): Record<string, unknown> | undefined {
  if (given === undefined || !CLOSED.has(String(given.status)) || !text(given.evidence) || !text(given.reason)) return undefined;
  const matching = (key: unknown) => canonical.filter((f) => holdsKey(f, key));
  let finding = given.finding;
  if (given.status === "finding" && !text(finding)) {
    const same = matching(given.id);
    const linked = same.length === 1 ? same[0]! : undefined;
    finding = linked === undefined ? defaultLink : text(linked.global_id) ? linked.global_id : String(linked.id);
  }
  if (given.status === "finding" && !(text(finding) && matching(finding).length === 1)) return undefined;
  if (given.status === "narrowed" && !text(given.remains)) return undefined;
  return { status: given.status, evidence: given.evidence, reason: given.reason, ...(given.status === "finding" ? { finding } : {}), ...(given.status === "narrowed" ? { remains: given.remains } : {}) };
}

/**
 * The gate's validators over the ledger just built (research, dispatch, coverage). With a `packageDir` they are the ones
 * `review complete` runs (`packageResearchErrors`, ./research.ts): the coverage check with its options read from the
 * package, then the layer/chunk completeness gate (`coverageGateErrors`) over this ledger, so READY here is what complete
 * accepts. Without one (a ledger built outside a package) only the coverage check runs, with the options the caller passes.
 */
export async function ledgerBlockers(ledger: LedgerResult["ledger"], canonical: unknown, options: { root: string; packageDir?: string | undefined; files: readonly string[] | undefined; changedLines?: number | undefined; blastRadius?: boolean | undefined; pendingMutants?: number | undefined }): Promise<string[]> {
  const dispatch = dispatchErrors(ledger.dispatch);
  if (dispatch.length > 0) return [...researchErrors(ledger, canonical), ...dispatch];
  if (options.packageDir === undefined) return [...researchErrors(ledger, canonical), ...await coverageErrors(ledger.dispatch, options)];
  const coverage = await packageCoverageErrors(options.packageDir, ledger.dispatch);
  return [...researchErrors(ledger, canonical), ...coverage, ...await coverageGateErrors(options.packageDir, ledger)];
}
