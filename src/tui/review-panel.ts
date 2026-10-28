// Review depth (flow 428, AC11): what a review round actually ran — the mode, which reviewers the
// mode required and which it left out (with the reason), and what the mutation pass found. The
// "Review depth" tab of `/reviews` and the readline `/reviews` text read the same `ReviewDepthRow`,
// so neither states a number the other does not. Read-only.

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { shellWord } from "../lib/shell-quote";
import { listReviewPackages, type ListedReview } from "../review/bot/packages";
import { packageHasBlastRadius, packageHasPrContext, packageScopeFiles, requiredReviewers, type RequiredSet, type ReviewMode } from "../review/coverage";
import { packageEnabledRoles } from "../review/role-switches";
import { computeChunkPass, hasChunkPlan, type ChunkPass } from "../review/chunks";
import { computeCoverage, coverageLine, readCoverageWaiver, type CoverageWaiver } from "../review/coverage-complete";
import { readLayers, type LayersFile } from "../review/layers";
import { dispatchRunRecords } from "../review/record";
import { layersDetailLines, layersSummaryLine } from "../review/layers-view";
import { LAYER_NAMES, summarizeLayersUsage, type LayersUsageSummary } from "../review/layers-usage";
import { EVIDENCE_DIR, pendingMutants, type MutantStatus, type MutationRecord } from "../review/mutate";
import { computeReadiness, readinessDepthLines, renderReadiness, type ReadinessReport } from "../review/readiness";
import { packageEstimateLine } from "../review/estimate-actual";
import { parityIsEmpty, parityLines, readReviewParity, type ReviewParityView } from "../review/parity";

export const REVIEW_DEPTH_EMPTY = "No managed review has recorded a dispatch yet.";

export type ReviewDepthMutation = {
  /** Mutation passes recorded for the package. */
  passes: number;
  totals: Record<MutantStatus, number>;
  /** Proposed mutants no recorded pass has run. */
  pending: number;
};

/** What a review knows about its layers, its chunk pass and its coverage (flow 431, AC12). One projection for every surface. */
export type ReviewLayersView = {
  /** The package directory, for the command a missing piece points at. */
  dir: string;
  layers: LayersFile | null;
  /** Null when the package records no reviewer runs. */
  usage: LayersUsageSummary | null;
  /** Null when the package has no chunk plan. */
  chunks: ChunkPass | null;
  /** False when the package holds nothing to account coverage against. */
  coverageTracked: boolean;
  uncovered: number;
  coverage: string;
  waiver: CoverageWaiver | undefined;
};

/** One finding of the degradation reviewer (flow 479): its class, its evidence kind, and whether ingest lowered it as unproven. */
export type ReviewDegradationFinding = {
  id: string;
  severity: string;
  degradationClass: string | undefined;
  evidenceKind: string | undefined;
  /** True when the ingest evidence screen lowered the finding: it carries `evidence_screen`. */
  unproven: boolean;
  /** The severity the reviewer filed before the screen lowered it; set only when `unproven`. */
  originalSeverity: string | undefined;
  file: string | undefined;
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
  /** Roles switched off for the review (default-off roles, `reviewRoles.disabled`); absent when none. */
  rolesOff?: string[];
  /** Required reviewers the dispatch record does not name. */
  missing: string[];
  filesKnown: boolean;
  mutation: ReviewDepthMutation;
  /** The operator's recorded waiver of the mutation pass, when there is one. */
  mutationWaived: boolean;
  layersView?: ReviewLayersView;
  /** Not run candidates, held severity notes and open follow-ups; absent when the package has none. */
  parity?: ReviewParityView;
  /** Findings of `review-degradation`; absent when the package holds none. */
  degradation?: ReviewDegradationFinding[];
  /** The readiness checklist, from the same projection `keryx review readiness` prints; absent when the package could not be read. */
  readiness?: ReadinessReport | undefined;
  /** The plan estimate against the time of the raw replies; absent when the package holds neither. */
  timing?: string | undefined;
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

async function layersViewOf(dir: string, dispatch: Record<string, unknown> | undefined): Promise<ReviewLayersView> {
  const runs = dispatchRunRecords(dispatch);
  const coverage = await computeCoverage(dir).catch(() => undefined);
  return {
    dir,
    layers: await readLayers(dir).catch(() => null),
    usage: runs.length === 0 ? null : summarizeLayersUsage(runs),
    chunks: hasChunkPlan(dir) ? await computeChunkPass(dir).catch(() => null) : null,
    coverageTracked: coverage?.tracked ?? false,
    uncovered: coverage?.counts.uncovered ?? 0,
    coverage: coverage === undefined ? "coverage: unreadable" : coverageLine(coverage),
    waiver: readCoverageWaiver(dispatch),
  };
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * The findings of the degradation reviewer in the package's `findings.json`: those it filed, or any that carry a
 * degradation class, an evidence kind or the evidence-screen marker. Absent or unreadable `findings.json` reads as none.
 */
export async function readDegradationFindings(packageDir: string): Promise<ReviewDegradationFinding[]> {
  const parsed = await readJson(path.join(packageDir, "findings.json"));
  if (!Array.isArray(parsed)) return [];
  const out: ReviewDegradationFinding[] = [];
  for (const raw of parsed) {
    if (raw === null || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    const screen = f.evidence_screen !== null && typeof f.evidence_screen === "object" ? (f.evidence_screen as Record<string, unknown>) : undefined;
    const hasField = f.degradation_class !== undefined || f.evidence_kind !== undefined || screen !== undefined;
    if (f.reviewer !== "review-degradation" && !hasField) continue;
    out.push({
      id: str(f.id) ?? "?",
      severity: str(f.severity) ?? "?",
      degradationClass: str(f.degradation_class),
      evidenceKind: str(f.evidence_kind),
      unproven: screen !== undefined,
      originalSeverity: str(screen?.original_severity),
      file: str(f.file),
    });
  }
  return out;
}

/**
 * `degradation: ...` lines: one per finding with its class and evidence kind. A finding the evidence screen lowered
 * reads `UNPROVEN (was major)` where the evidence kind would be, so it is never mistaken for a shown one.
 */
export function degradationLines(findings: readonly ReviewDegradationFinding[] | undefined): string[] {
  if (findings === undefined || findings.length === 0) return [];
  const unproven = findings.filter((f) => f.unproven).length;
  const head = `degradation: ${findings.length} finding(s)${unproven > 0 ? `, ${unproven} unproven` : ""}`;
  return [
    head,
    ...findings.map((f) => {
      const proof = f.unproven ? `UNPROVEN${f.originalSeverity === undefined ? "" : ` (was ${f.originalSeverity})`}` : `evidence ${f.evidenceKind ?? "none"}`;
      return `  ${f.id} ${f.severity} ${f.degradationClass ?? "no class"}, ${proof}${f.file === undefined ? "" : ` ${f.file}`}`;
    }),
  ];
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
    const parity = await readReviewParity(review.dir);
    const degradation = await readDegradationFindings(review.dir);
    const timing = await packageEstimateLine(review.dir, { open: review.manifest.status !== "closed" });
    const base = { reviewId: review.reviewId, pull: pullLabel(review), selected, mutation: await mutationOf(review.dir), mutationWaived, layersView: await layersViewOf(review.dir, dispatch), readiness: await computeReadiness(review.dir).catch(() => undefined), ...(parityIsEmpty(parity) ? {} : { parity }), ...(degradation.length === 0 ? {} : { degradation }), ...(timing === undefined ? {} : { timing }) };
    if (mode === undefined) {
      rows.push({ ...base, mode: "unrecorded", required: [], excluded: [], missing: [], filesKnown: false });
      continue;
    }
    const need = await requiredReviewers(cwd, mode, await packageScopeFiles(review.dir), { blastRadius: await packageHasBlastRadius(review.dir), prContext: packageHasPrContext(review.dir), enabledRoles: await packageEnabledRoles(review.dir) });
    const named = new Set(selected);
    rows.push({ ...base, mode, required: need.required, excluded: need.excluded, missing: need.required.filter((r) => !named.has(r)), filesKnown: need.filesKnown, ...(need.rolesOff === undefined ? {} : { rolesOff: need.rolesOff }) });
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

/** The one-line form: `graph@<sha7> = head|differs; wiki …; memory …; layers used n/m; unknown k; chunks d/t, uncovered u`. */
export function layersLine(view: ReviewLayersView | undefined): string {
  if (view === undefined) return "layers: not read";
  const parts = [view.layers === null ? "layers: not refreshed" : layersSummaryLine(view.layers)];
  if (view.usage !== null) {
    parts.push(`layers used ${view.usage.usedAny}/${view.usage.total}`);
    if (view.usage.unknown > 0) parts.push(`unknown ${view.usage.unknown}`);
  }
  if (view.chunks !== null) parts.push(`chunks ${view.chunks.totals.done}/${view.chunks.totals.chunks}, uncovered ${view.uncovered}`);
  else if (view.coverageTracked) parts.push(`chunks 0/0, uncovered ${view.uncovered}`);
  return parts.join("; ");
}

/** The full lines: `layers.json`, who used which layer, the chunk pass, the coverage counts and the waiver. */
export function layersDepthLines(view: ReviewLayersView | undefined): string[] {
  if (view === undefined) return [];
  const lines = view.layers === null ? [`layers: not refreshed; run \`keryx review layers refresh --package ${shellWord(view.dir)}\``] : layersDetailLines(view.layers);
  if (view.usage !== null) {
    const used = view.usage;
    const per = LAYER_NAMES.map((name) => `${name} ${used.perLayer[name]}`).join(", ");
    lines.push(`layers used: ${used.usedAny} of ${used.total} reviewer(s) (${per}); unknown ${used.unknown}${used.unknown > 0 ? " (no tool-call log)" : ""}`);
  }
  if (view.chunks !== null) {
    const { totals } = view.chunks;
    lines.push(`chunk pass (${view.chunks.reviewer}, ${view.chunks.tier} tier): ${totals.done}/${totals.chunks} done, ${totals.failed} failed, ${totals.pending} pending, ${view.uncovered} uncovered`);
    for (const chunk of view.chunks.chunks) lines.push(`  ${chunk.id}: ${chunk.state}, ${chunk.files.length} file(s), ${chunk.attempts} attempt(s)`);
  } else lines.push("chunk pass: no plan (no dropped files)");
  lines.push(view.coverage);
  if (view.waiver !== undefined) lines.push(`coverage waived by the operator (${view.waiver.time}): "${view.waiver.operatorQuote}"; ${view.waiver.files.length} file(s) not reviewed`);
  return lines;
}

export function formatReviewDepthRowLines(row: ReviewDepthRow): string[] {
  const head = `${row.pull}  ${row.reviewId}  mode ${row.mode}`;
  const lines = [head];
  const layers = [...readinessDepthLines(row.readiness), ...layersDepthLines(row.layersView), ...parityLines(row.parity), ...degradationLines(row.degradation), ...(row.timing === undefined ? [] : [row.timing])].map((line) => `  ${line}`);
  if (row.mode === "unrecorded") {
    lines.push("  no dispatch record: the reviewer set is not known", `  ${mutationLine(row.mutation, row.mutationWaived)}`, ...layers);
    return lines;
  }
  const covered = row.required.length - row.missing.length;
  lines.push(`  reviewers: ${covered} of ${row.required.length} required were dispatched${row.filesKnown ? "" : " (no scope file list, path gates not applied)"}`);
  if (row.missing.length > 0) lines.push(`  missing: ${row.missing.join(", ")}`);
  if (row.rolesOff !== undefined && row.rolesOff.length > 0) lines.push(`  roles off: ${row.rolesOff.join(", ")} (--style or --with-role <role> at \`keryx review start|required\`, or reviewRoles in routing.config.json, brings them back)`);
  for (const e of row.excluded) lines.push(`  excluded ${e.reviewer}: ${e.reason}`);
  lines.push(`  ${mutationLine(row.mutation, row.mutationWaived)}`, ...layers);
  return lines;
}

/** `/review layers` and the readline text: the one-line form and the full lines of every review. */
export function renderReviewLayersText(rows: readonly ReviewDepthRow[]): string {
  if (rows.length === 0) return `${REVIEW_DEPTH_EMPTY}\n`;
  const blocks = rows.map((row) => [`${row.pull}  ${row.reviewId}`, `  ${layersLine(row.layersView)}`, ...layersDepthLines(row.layersView).map((line) => `  ${line}`)].join("\n"));
  return `Review layers\n${blocks.join("\n\n")}\n`;
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

/** `/review parity` and the readline text: what each review left behind, one block per review that left anything. */
export function renderReviewParityText(rows: readonly ReviewDepthRow[]): string {
  if (rows.length === 0) return `${REVIEW_DEPTH_EMPTY}\n`;
  const blocks = rows.filter((row) => row.parity !== undefined).map((row) => [`${row.pull}  ${row.reviewId}`, ...parityLines(row.parity).map((line) => `  ${line}`)].join("\n"));
  return `Review parity\n${blocks.length === 0 ? "No Not run candidates, held severity notes or open follow-ups." : blocks.join("\n\n")}\n`;
}

/** The degradation findings of every review that has any, one block per review. */
export function renderReviewDegradationText(rows: readonly ReviewDepthRow[]): string {
  const blocks = rows.filter((row) => row.degradation !== undefined).map((row) => [`${row.pull}  ${row.reviewId}`, ...degradationLines(row.degradation).map((line) => `  ${line}`)].join("\n"));
  return `Review degradation\n${blocks.length === 0 ? "No degradation findings." : blocks.join("\n\n")}\n`;
}

/** `/review readiness` and the readline text: the whole checklist of every managed review, as `keryx review readiness` prints it. */
export function renderReviewReadinessText(rows: readonly ReviewDepthRow[]): string {
  if (rows.length === 0) return `${REVIEW_DEPTH_EMPTY}\n`;
  const blocks = rows.map((row) => [`${row.pull}  ${row.reviewId}`, ...(row.readiness === undefined ? ["  readiness: not read"] : renderReadiness(row.readiness).map((line) => `  ${line}`))].join("\n"));
  return `Review readiness\n${blocks.join("\n\n")}\n`;
}
