import { createHash } from "node:crypto";
import { coverageErrors, type ReviewMode } from "./coverage";
import { dispatchErrors } from "./dispatch";
import { researchErrors } from "./research";
import { readSliceIds, scopeFingerprint, sliceReadingNotes, type RetryState } from "./retry-plan";
import { type SliceManifest, packWaves, waveBytesOf } from "./slice";
import { requiredSlices, sliceGraph, summarizeWaves } from "./waves";

/** Statuses of `reviewer-finding.schema.json` that mean the reviewer finished what it was given. */
const FINISHED = new Set(["DONE", "DONE_WITH_CONCERNS"]);
const CLOSED = new Set(["finding", "refuted", "out-of-scope"]);

export type ParsedResult = {
  reviewer?: string;
  status?: string;
  summary?: string;
  findings?: Array<Record<string, unknown>>;
  needs_context?: unknown;
  slices?: unknown;
};

export type RawFile = {
  /** Path relative to the input directory, e.g. `raw/review-logic.txt`. */
  name: string;
  hash: string;
  mtimeMs: number;
  /** Slice assignment from the driver explicitly naming this result file. */
  assignedSlices?: string[];
  result?: ParsedResult;
  /** True for a file a reviewer left empty ("(subagent produced no text)"): lost output, not a result to reconcile. */
  empty: boolean;
};

export type Disposition = {
  id?: string;
  source?: string;
  question?: string;
  status?: string;
  finding?: string;
  evidence?: string;
  reason?: string;
};

/** `waves` is how many dispatches of the reviewer's uncovered slices remain, when the gap is about uncovered slices. */
export type LedgerGap = { reviewer?: string; detail: string; next: string; waves?: number };

export type LedgerInputs = {
  mode: ReviewMode;
  selected: string[];
  /** Absent for a run that was never sliced. */
  manifest?: SliceManifest | undefined;
  /** Reviewer → slice ids named by its dispatched payloads. */
  payloadSlices: Record<string, string[]>;
  /** Only one dispatch may supply a legacy implicit assignment. */
  payloadDispatchCounts?: Record<string, number>;
  /** Reviewer → resolved rule file, only when it exists. */
  ruleFiles: Record<string, string>;
  raws: RawFile[];
  retry: RetryState;
  canonical: Array<Record<string, unknown>>;
  dispositions: Disposition[];
  manifestPath?: string;
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
  };
  gaps: LedgerGap[];
};

export const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex").slice(0, 12);

const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

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
    try { found.push({ start, value: JSON.parse(raw.slice(start, end + 1)) }); } catch { /* not JSON: skipped whole */ }
    start = end + 1;
  }
  return { found, truncated: false };
}

/** `from` inclusive, `to` exclusive, of each ``` block that has an opening line and a closing ```. One forward pass, so a reply of many fences costs no more than its length. */
function fenceRanges(raw: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  for (let open = raw.indexOf("```"); open !== -1; ) {
    const lineEnd = raw.indexOf("\n", open + 3);
    if (lineEnd === -1) break;
    const close = raw.indexOf("```", lineEnd + 1);
    if (close === -1) break;
    ranges.push([open, close + 3] as const);
    open = raw.indexOf("```", close + 3);
  }
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

type Decision = { result: ParsedResult | undefined };

/** The last ```REVIEW_RESULT block. It keeps the status-only rule: the label already says what the block is. */
function labelledFence(raw: string): Decision | undefined {
  const labelled = [...raw.matchAll(/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi)];
  if (labelled.length === 0) return undefined;
  try {
    const parsed = JSON.parse(labelled[labelled.length - 1]![1]!);
    return { result: hasStatus(parsed) ? parsed : undefined };
  } catch { return { result: undefined }; }
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
function afterMarker(raw: string): ParsedResult | undefined {
  const inFence = fenceTester(raw);
  const markers = [...raw.matchAll(MARKER)].filter((marker) => !inFence(marker.index!)).slice(-MAX_MARKERS);
  for (let at = markers.length - 1; at >= 0; at -= 1) {
    const marker = markers[at]!;
    const start = marker.index! + marker[0].length;
    const { end } = objectEnd(raw, start);
    if (end === undefined) continue;
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (isReviewerResult(parsed)) return parsed;
    } catch { /* prose after the word: try the marker before */ }
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
 */
export function parseReviewResult(raw: string): ParsedResult | undefined {
  const labelled = labelledFence(raw);
  if (labelled !== undefined) return labelled.result;
  return afterMarker(raw) ?? scannedResult(raw);
}

export function isEmptyOutput(raw: string): boolean {
  return raw.trim() === "" || /^\(subagent produced no text\)$/.test(raw.trim());
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
  return summarizeWaves(packWaves(graph.open(requiredSlices(manifest, reviewer), seen), waveBytesOf(manifest)));
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
  const { manifest, raws } = input;
  const attributed = raws.filter((r) => r.result?.reviewer !== undefined && text(r.result.reviewer));
  for (const raw of raws) {
    if (raw.empty) continue;
    if (raw.result === undefined) gaps.push({ detail: `${raw.name}: no parseable REVIEW_RESULT block`, next: `re-dispatch the reviewer that produced ${raw.name}, or remove the file if it is not a reviewer result` });
    else if (!text(raw.result.reviewer)) gaps.push({ detail: `${raw.name}: the result names no reviewer, so it cannot be attributed`, next: `have the reviewer re-emit its result with "reviewer" set` });
  }

  const runs: Array<Record<string, unknown>> = [];
  const complete = new Map<string, Set<string>>();
  for (const reviewer of input.selected) {
    const mine = attributed.filter((r) => r.result!.reviewer === reviewer).sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    const latest = mine[mine.length - 1];
    const fingerprint = manifest === undefined ? undefined : scopeFingerprint(manifest);
    const known = fingerprint !== undefined && input.retry.scopeFingerprint === fingerprint ? input.retry.reviewers[reviewer] : undefined;
    if (known?.notRun === true) {
      runs.push({ reviewer, executionId: `${reviewer}:not-run`, status: "not-run", notRunReason: `${known.status} after the allowed retry (retry-state)`, scopeComplete: false });
      gaps.push({ reviewer, detail: `${reviewer}: not run (${known.status} after the allowed retry)`, next: "no retry is left; the report carries the Not run line, and only the operator can accept a smaller set (dispatch override with their own quote)" });
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
    const asked = Array.isArray(result.needs_context) ? result.needs_context.filter(text) : [];
    const finished = FINISHED.has(status) && asked.length === 0;
    const run: Record<string, unknown> = { reviewer, executionId: `${reviewer}:${latest.hash}`, rawEvidence: `${latest.name}#sha256:${latest.hash}`, executionRequired: false };
    const rule = input.ruleFiles[reviewer];
    run.ruleEvidence = rule === undefined ? [] : [rule];
    if (rule === undefined) gaps.push({ reviewer, detail: `${reviewer}: no resolved rule file (driver payload names none that exists)`, next: `write drivers/${reviewer}.json with the reviewer's definition path` });
    const claimed = new Set<string>();
    if (manifest !== undefined) {
      for (const raw of mine) {
        const reply = raw.result!;
        const closed = FINISHED.has(String(reply.status).toUpperCase()) && (!Array.isArray(reply.needs_context) || reply.needs_context.filter(text).length === 0);
        const assigned = raw.assignedSlices ?? (mine.length === 1 && input.payloadDispatchCounts?.[reviewer] === 1 ? input.payloadSlices[reviewer] : undefined);
        if (assigned === undefined) continue;
        const allowed = new Set(assigned);
        const ids = reply.slices === undefined && closed ? assigned : sliceIdsOf(reply.slices);
        for (const id of ids) if (allowed.has(id)) claimed.add(id);
      }
      for (const id of known?.covered ?? []) claimed.add(id);
    }
    const seen = manifest === undefined ? new Set<string>() : accountedFor(manifest, reviewer, claimed);
    const dropped = [...new Set(mine.flatMap((raw) => sliceReadingNotes(readSliceIds(raw.result!.slices))))];
    const droppedTail = dropped.length === 0 ? "" : ` (${dropped.join("; ")})`;
    if (!finished) {
      run.status = "incomplete";
      run.scopeComplete = false;
      run.executionReason = "not claimed: the reviewer did not finish its scope";
      const why = asked.length > 0 ? `open needs_context (${asked.length}): ${asked.slice(0, 3).join(" | ")}` : status;
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

  const unresolvedRules = input.selected.filter((r) => input.ruleFiles[r] === undefined);
  const dispatch = { version: 1, mode: input.mode, selected: input.selected, unresolvedRules, runs };

  const obligations: Array<Record<string, unknown>> = [];
  const derived = new Set<string>();
  const canonicalByReviewer = (reviewer: string, id: string) => input.canonical.filter((f) => f.reviewer === reviewer && f.id === id);
  for (const raw of attributed) {
    const reviewer = raw.result!.reviewer!;
    for (const finding of Array.isArray(raw.result!.findings) ? raw.result!.findings! : []) {
      const fid = finding && typeof finding.id === "string" ? finding.id : undefined;
      if (fid === undefined) continue;
      const id = `${raw.name.replace(/^raw\//, "").replace(/\.txt$/, "")}:${fid}`;
      derived.add(id);
      const base = { id, source: raw.name, question: `Is ${reviewer} finding ${fid} (${String(finding.problem ?? finding.title ?? "").slice(0, 100)}) real, and where is it reported?` };
      const given = input.dispositions.find((d) => d.id === id);
      const closure = closeWith(given, input.canonical);
      if (closure !== undefined) { obligations.push({ ...base, ...closure }); continue; }
      const hit = canonicalByReviewer(reviewer, fid);
      const link = hit.length === 1 ? hit[0]! : undefined;
      const key = link === undefined ? undefined : (text(link.global_id) ? link.global_id : link.id);
      if (text(key) && input.canonical.filter((f) => f.id === key || f.global_id === key).length === 1) {
        obligations.push({ ...base, status: "finding", finding: key, evidence: `${raw.name}#sha256:${raw.hash}`, reason: `reported by ${reviewer} as ${fid}; the same finding is canonical ${key}` });
        continue;
      }
      obligations.push({ ...base, status: "unresolved" });
      gaps.push({ detail: `${id}: raw finding is not in the canonical findings and has no closure`, next: `add a disposition {"id":"${id}","status":"finding|refuted|out-of-scope","evidence":…,"reason":…} to --dispositions` });
    }
  }
  for (const given of input.dispositions) {
    if (text(given.id) && !derived.has(given.id) && text(given.source) && text(given.question)) {
      const closure = closeWith(given, input.canonical);
      obligations.push({ id: given.id, source: given.source, question: given.question, ...(closure ?? { status: "unresolved" }) });
    }
  }

  const reconciled = raws.every((r) => r.empty || (r.result !== undefined && text(r.result.reviewer))) && obligations.every((o) => CLOSED.has(String(o.status)));
  let scopeReviewed = input.selected.length > 0 && runs.every((r) => r.scopeComplete === true);
  if (scopeReviewed && manifest !== undefined) {
    const covered = new Set<string>();
    for (const seen of complete.values()) seen.forEach((id) => covered.add(id));
    const uncovered = manifest.slices.filter((s) => s.retryOf === undefined && !covered.has(s.id)).map((s) => s.id);
    if (uncovered.length > 0) {
      scopeReviewed = false;
      gaps.push({ detail: `${uncovered.length} slice(s) are covered by no finished reviewer: ${uncovered.slice(0, 8).join(", ")}`, next: "dispatch a reviewer whose path gate matches those slices" });
    }
  }
  return { ledger: { version: 1, scopeReviewed, rawReconciled: reconciled, obligations, dispatch }, gaps };
}

function closeWith(given: Disposition | undefined, canonical: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  if (given === undefined || !CLOSED.has(String(given.status)) || !text(given.evidence) || !text(given.reason)) return undefined;
  if (given.status === "finding" && !(text(given.finding) && canonical.filter((f) => f.id === given.finding || f.global_id === given.finding).length === 1)) return undefined;
  return { status: given.status, evidence: given.evidence, reason: given.reason, ...(given.status === "finding" ? { finding: given.finding } : {}) };
}

/** The gate's own validators over the built ledger, so "ready" cannot disagree with `keryx review complete`. */
export async function ledgerBlockers(ledger: LedgerResult["ledger"], canonical: unknown, options: { root: string; files: readonly string[] | undefined; blastRadius?: boolean | undefined; pendingMutants?: number | undefined }): Promise<string[]> {
  const dispatch = dispatchErrors(ledger.dispatch);
  const coverage = dispatch.length === 0 ? await coverageErrors(ledger.dispatch, options) : [];
  return [...researchErrors(ledger, canonical), ...dispatch, ...coverage];
}
