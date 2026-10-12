// Review depth (flow 428, AC11): what a review round actually ran — the mode, which reviewers the
// mode required and which it left out (with the reason), and what the mutation pass found. The
// "Review depth" tab of `/reviews` and the readline `/reviews` text read the same `ReviewDepthRow`,
// so neither states a number the other does not. Read-only.

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { listReviewPackages, type ListedReview } from "../review/bot/packages";
import { packageHasBlastRadius, packageScopeFiles, requiredReviewers, type RequiredSet, type ReviewMode } from "../review/coverage";
import { EVIDENCE_DIR, pendingMutants, type MutantStatus, type MutationRecord } from "../review/mutate";

export const REVIEW_DEPTH_EMPTY = "No managed review has recorded a dispatch yet.";

export type ReviewDepthMutation = {
  /** Mutation passes recorded for the package. */
  passes: number;
  totals: Record<MutantStatus, number>;
  /** Proposed mutants no recorded pass has run. */
  pending: number;
};

export type ReviewDepthRow = {
  reviewId: string;
  pull: string;
  /** `unrecorded` when the package holds no dispatch record (it predates the contract, or no reviewer ran). */
  mode: ReviewMode | "unrecorded";
  /** Reviewers the dispatch record names. */
  selected: string[];
  /** Reviewers the mode requires for this package; empty when the mode is unrecorded. */
  required: string[];
  excluded: RequiredSet["excluded"];
  /** Required reviewers the dispatch record does not name. */
  missing: string[];
  filesKnown: boolean;
  mutation: ReviewDepthMutation;
  /** The operator's recorded waiver of the mutation pass, when there is one. */
  mutationWaived: boolean;
};

const ZERO: Record<MutantStatus, number> = { killed: 0, survived: 0, invalid: 0, timeout: 0 };

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function mutationOf(packageDir: string): Promise<ReviewDepthMutation> {
  const totals = { ...ZERO };
  let passes = 0;
  const dir = path.join(packageDir, EVIDENCE_DIR);
  if (existsSync(dir)) {
    for (const name of (await readdir(dir)).filter((n) => /^mutation-\d+\.json$/.test(n)).sort()) {
      const record = (await readJson(path.join(dir, name))) as MutationRecord | undefined;
      if (record === undefined || !Array.isArray(record.mutants)) continue;
      passes += 1;
      for (const status of Object.keys(ZERO) as MutantStatus[]) totals[status] += record.totals?.[status] ?? 0;
    }
  }
  return { passes, totals, pending: (await pendingMutants(packageDir)).length };
}

function pullLabel(review: ListedReview): string {
  if (review.repo !== null && review.number !== null) return `${review.repo}#${review.number}`;
  return review.manifest.target?.ref ?? review.reviewId;
}

/** One row per managed pull-request review package under `cwd`, newest first. */
export async function loadReviewDepth(cwd: string, listed?: readonly ListedReview[]): Promise<ReviewDepthRow[]> {
  const rows: ReviewDepthRow[] = [];
  for (const review of listed ?? (await listReviewPackages(cwd))) {
    const research = (await readJson(path.join(review.dir, "research.json"))) as { dispatch?: Record<string, unknown> } | undefined;
    const dispatch = research?.dispatch;
    const mode = dispatch?.mode === "all" || dispatch?.mode === "diff" ? dispatch.mode : undefined;
    const selected = Array.isArray(dispatch?.selected) ? dispatch.selected.filter((s): s is string => typeof s === "string") : [];
    const waiver = dispatch?.mutationWaiver;
    const mutationWaived = waiver !== null && typeof waiver === "object" && typeof (waiver as { operatorQuote?: unknown }).operatorQuote === "string";
    const base = { reviewId: review.reviewId, pull: pullLabel(review), selected, mutation: await mutationOf(review.dir), mutationWaived };
    if (mode === undefined) {
      rows.push({ ...base, mode: "unrecorded", required: [], excluded: [], missing: [], filesKnown: false });
      continue;
    }
    const need = await requiredReviewers(cwd, mode, await packageScopeFiles(review.dir), { blastRadius: await packageHasBlastRadius(review.dir) });
    const named = new Set(selected);
    rows.push({ ...base, mode, required: need.required, excluded: need.excluded, missing: need.required.filter((r) => !named.has(r)), filesKnown: need.filesKnown });
  }
  return rows;
}

function mutationLine(m: ReviewDepthMutation, waived: boolean): string {
  if (m.passes === 0) {
    const waiver = waived ? " (waived by the operator)" : "";
    return m.pending > 0 ? `mutation: not run, ${m.pending} proposed mutant(s) pending${waiver}` : `mutation: not run, no mutants proposed${waiver}`;
  }
  const { killed, survived, invalid, timeout } = m.totals;
  const pending = m.pending > 0 ? `, ${m.pending} pending` : "";
  return `mutation: ${killed} killed, ${survived} survived, ${invalid} invalid, ${timeout} timed out${pending}`;
}

export function formatReviewDepthRowLines(row: ReviewDepthRow): string[] {
  const head = `${row.pull}  ${row.reviewId}  mode ${row.mode}`;
  const lines = [head];
  if (row.mode === "unrecorded") {
    lines.push("  no dispatch record: the reviewer set is not known", `  ${mutationLine(row.mutation, row.mutationWaived)}`);
    return lines;
  }
  const covered = row.required.length - row.missing.length;
  lines.push(`  reviewers: ${covered} of ${row.required.length} required were dispatched${row.filesKnown ? "" : " (no scope file list, path gates not applied)"}`);
  if (row.missing.length > 0) lines.push(`  missing: ${row.missing.join(", ")}`);
  for (const e of row.excluded) lines.push(`  excluded ${e.reviewer}: ${e.reason}`);
  lines.push(`  ${mutationLine(row.mutation, row.mutationWaived)}`);
  return lines;
}

/** One block per review, a blank line between blocks. */
export function formatReviewDepthLines(rows: readonly ReviewDepthRow[]): string[] {
  if (rows.length === 0) return [REVIEW_DEPTH_EMPTY];
  return rows.flatMap((row, index) => (index === 0 ? formatReviewDepthRowLines(row) : ["", ...formatReviewDepthRowLines(row)]));
}

/** The readline shell's depth block, printed under the `/reviews` metrics. */
export function renderReviewDepthText(rows: readonly ReviewDepthRow[]): string {
  return `Review depth\n${formatReviewDepthLines(rows).join("\n")}\n`;
}
