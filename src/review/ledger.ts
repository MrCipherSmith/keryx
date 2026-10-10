import { createHash } from "node:crypto";
import { BUNDLED_PATH_GATES, coverageErrors, type ReviewMode } from "./coverage";
import { dispatchErrors } from "./dispatch";
import { researchErrors } from "./research";
import type { RetryState } from "./retry-plan";
import type { SliceManifest } from "./slice";

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

export type LedgerGap = { reviewer?: string; detail: string; next: string };

export type LedgerInputs = {
  mode: ReviewMode;
  selected: string[];
  /** Absent for a run that was never sliced. */
  manifest?: SliceManifest | undefined;
  /** Reviewer → slice ids named by its dispatched payloads. */
  payloadSlices: Record<string, string[]>;
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
  };
  gaps: LedgerGap[];
};

export const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex").slice(0, 12);

const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** The reviewer's result: the last fenced block that parses to an object carrying `status`. Never guessed from prose. */
export function parseReviewResult(raw: string): ParsedResult | undefined {
  const candidates: string[] = [];
  for (const match of raw.matchAll(/```[A-Za-z_]*[ \t]*\r?\n([\s\S]*?)\r?\n```/g)) candidates.push(match[1]!);
  const marker = raw.indexOf("REVIEW_RESULT");
  if (marker >= 0) {
    const start = raw.indexOf("{", marker);
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  }
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.status === "string") return parsed as ParsedResult;
    } catch {
      /* not this block */
    }
  }
  return undefined;
}

export function isEmptyOutput(raw: string): boolean {
  return raw.trim() === "" || /^\(subagent produced no text\)$/.test(raw.trim());
}

function sliceIdsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : (v as { id?: unknown })?.id)).filter(text) : [];
}

/** Slices a reviewer must have seen: the manifest's original slices, narrowed to the files its path gate matches. */
function requiredSlices(manifest: SliceManifest, reviewer: string): string[] {
  const gate = BUNDLED_PATH_GATES[reviewer];
  return manifest.slices.filter((s) => s.retryOf === undefined && (gate === undefined || s.files.some(gate))).map((s) => s.id);
}

/** Ids a set of dispatched slices accounts for: themselves, and the originals a smaller retry slice was cut from. */
function accountedFor(manifest: SliceManifest, ids: Iterable<string>): Set<string> {
  const byId = new Map(manifest.slices.map((s) => [s.id, s]));
  const out = new Set<string>();
  for (const id of ids) {
    out.add(id);
    for (const origin of byId.get(id)?.retryOf ?? []) out.add(origin);
  }
  return out;
}

function retryNext(reviewer: string, raw: RawFile, manifestPath: string | undefined): string {
  return `keryx review retry-plan --manifest ${manifestPath ?? "<slices/manifest.json>"} --result ${raw.name} --reviewer ${reviewer}`;
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
    const known = input.retry.reviewers[reviewer];
    if (known?.notRun === true) {
      runs.push({ reviewer, executionId: `${reviewer}:not-run`, status: "not-run", notRunReason: `${known.status} after the allowed retry (retry-state)`, scopeComplete: false });
      gaps.push({ reviewer, detail: `${reviewer}: not run (${known.status} after the allowed retry)`, next: "no retry is left; the report carries the Not run line, and only the operator can accept a smaller set (dispatch override with their own quote)" });
      continue;
    }
    if (latest === undefined) {
      runs.push({ reviewer, executionId: `${reviewer}:not-run`, status: "not-run", notRunReason: "no reviewer result recorded", scopeComplete: false });
      gaps.push({ reviewer, detail: `${reviewer}: no result recorded`, next: `dispatch ${reviewer} on its slices, save the reply to raw/${reviewer}.txt, run keryx review dispatch-check first` });
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
    if (!finished) {
      run.status = "incomplete";
      run.scopeComplete = false;
      run.executionReason = "not claimed: the reviewer did not finish its scope";
      const why = asked.length > 0 ? `open needs_context (${asked.length}): ${asked.slice(0, 3).join(" | ")}` : status;
      gaps.push({ reviewer, detail: `${reviewer}: ${why}; scope not closed`, next: retryNext(reviewer, latest, input.manifestPath) });
      runs.push(run);
      continue;
    }
    run.status = "complete";
    run.executionReason = "source-only review: the result is DONE with no open needs_context, and nothing it was asked to do required running a command";
    let scopeComplete = true;
    if (manifest !== undefined) {
      const claimed = new Set<string>(sliceIdsOf(result.slices));
      for (const id of input.payloadSlices[reviewer] ?? []) if (result.slices === undefined) claimed.add(id);
      for (const earlier of mine.slice(0, -1)) if (FINISHED.has(String(earlier.result?.status).toUpperCase())) sliceIdsOf(earlier.result?.slices).forEach((id) => claimed.add(id));
      const seen = accountedFor(manifest, claimed);
      const missing = requiredSlices(manifest, reviewer).filter((id) => !seen.has(id));
      if (missing.length > 0) {
        scopeComplete = false;
        const shown = missing.slice(0, 8).join(", ") + (missing.length > 8 ? `, … (+${missing.length - 8})` : "");
        gaps.push({ reviewer, detail: `${reviewer}: ${missing.length} slice(s) not covered by any dispatched payload: ${shown}`, next: `dispatch ${reviewer} on those slices (keryx review dispatch-check --payload … --manifest ${input.manifestPath ?? "<manifest>"}), then rebuild` });
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
export async function ledgerBlockers(ledger: LedgerResult["ledger"], canonical: unknown, options: { root: string; files: readonly string[] | undefined }): Promise<string[]> {
  const dispatch = dispatchErrors(ledger.dispatch);
  const coverage = dispatch.length === 0 ? await coverageErrors(ledger.dispatch, options) : [];
  return [...researchErrors(ledger, canonical), ...dispatch, ...coverage];
}
