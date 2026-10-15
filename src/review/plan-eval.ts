// `keryx review plan-eval`: the old review plan against the new one, offline and model-free.
//
// For one diff and the round's roles it cuts the same slices twice: the OLD plan routes them as before slice routing
// (every role owns every slice its path gate allows), the NEW plan routes them by content and depth (slice-routing.ts).
// Both are costed with the estimate the round itself would print. Ground-truth findings (a canonical findings file, a
// findings.json or a report with a keryx:findings block) are then placed on the slices that hold their file (and line,
// when given): a finding "lands" under a plan when one of those slices is owned by its reviewer, or is deep. A
// blocker/major that lands under the old plan but not the new one is a routing regression the eval exists to show.

import { estimateRound, type RoundEstimate } from "./estimate";
import { type BuiltSlice, type SliceManifest, buildSlices, parseScopedDiff, sliceSourceFromDiff } from "./slice";
import { ROUTABLE_ROLES, routeSlices, type RoutingOptions } from "./slice-routing";
import { requiredSlices } from "./waves";

export type GroundTruthFinding = {
  id: string;
  severity: string;
  file: string;
  line?: number | undefined;
  reviewer?: string | undefined;
  category?: string | undefined;
};

export type PlanSide = {
  slices: number;
  assignments: number;
  dispatches: number;
  /** Blast-radius chunk passes this plan adds (given, not computed: the radius is computed elsewhere). */
  chunks: number;
  /** dispatches + chunks: what the plan costs in reviewer runs. */
  runs: number;
  minutes: { min: number; max: number };
  deep: number;
  light: number;
  audit: number;
  perRole: RoundEstimate["perRole"];
};

export type FindingLanding = GroundTruthFinding & {
  /** Slices that hold the finding's file (and line, when one covers it). */
  slices: string[];
  /** Under the new plan: owned by the finding's reviewer, deep, both, or neither. */
  landed: boolean;
  how: "owner" | "deep" | "owner+deep" | "none" | "not-in-diff";
  /** Under the old plan: the reviewer owned one of the slices. */
  oldLanded: boolean;
};

export type PlanEval = {
  old: PlanSide;
  new: PlanSide;
  /** 1 - new.runs / old.runs. */
  reduction: number;
  findings: FindingLanding[];
  /** Blocker and major findings: how many land under each plan. */
  serious: { total: number; landed: number; oldLanded: number };
};

export type PlanEvalInput = {
  diff: string;
  roles: readonly string[];
  findings?: readonly GroundTruthFinding[] | undefined;
  maxBytes?: number | undefined;
  waveBytes?: number | undefined;
  head?: string | undefined;
  oldChunks?: number | undefined;
  newChunks?: number | undefined;
  reach?: RoutingOptions["reach"];
  jevScores?: RoutingOptions["jevScores"];
  /** Share of light slices sampled deep; 0 measures the routing alone, without the audit sample. */
  auditRate?: number | undefined;
};

const SERIOUS = new Set(["blocker", "critical", "major"]);

const manifestOf = (base: SliceManifest, slices: readonly BuiltSlice[]): SliceManifest => ({ ...base, slices: slices.map(({ text: _text, ...entry }) => entry) });

function side(estimate: RoundEstimate, manifest: SliceManifest, chunks: number): PlanSide {
  const originals = manifest.slices.filter((s) => s.retryOf === undefined);
  return {
    slices: estimate.slices,
    assignments: estimate.assignments,
    dispatches: estimate.dispatches,
    chunks,
    runs: estimate.dispatches + chunks,
    minutes: estimate.minutes,
    deep: originals.filter((s) => s.depth === "deep").length,
    light: originals.filter((s) => s.depth === "light").length,
    audit: originals.filter((s) => s.audit === true).length,
    perRole: estimate.perRole,
  };
}

/** The reviewer a finding belongs to: its own `reviewer`, else a routable role named by its category. */
function reviewerOf(finding: GroundTruthFinding): string | undefined {
  if (finding.reviewer !== undefined && finding.reviewer !== "") return finding.reviewer;
  const category = finding.category?.trim().toLowerCase();
  if (category === undefined || category === "") return undefined;
  const direct = `review-${category}`;
  if (ROUTABLE_ROLES.has(direct)) return direct;
  return [...ROUTABLE_ROLES].find((role) => role.includes(category));
}

/** Slices holding the finding's file; narrowed to the ones whose hunk covers its line when any does. */
function slicesHolding(slices: readonly BuiltSlice[], finding: GroundTruthFinding): string[] {
  const holding = slices.filter((slice) => slice.files.includes(finding.file));
  if (finding.line === undefined) return holding.map((slice) => slice.id);
  const covering = holding.filter((slice) => parseScopedDiff(slice.text).some((region) => region.path === finding.file && region.startLine <= finding.line! && finding.line! <= region.endLine));
  return (covering.length > 0 ? covering : holding).map((slice) => slice.id);
}

export function evaluatePlans(input: PlanEvalInput): PlanEval {
  const built = buildSlices(sliceSourceFromDiff(input.diff), { ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }), ...(input.waveBytes === undefined ? {} : { waveBytes: input.waveBytes }) });
  const oldManifest = manifestOf(built.manifest, built.slices);
  const routed = routeSlices(built.slices, { head: input.head ?? "plan-eval", reach: input.reach, jevScores: input.jevScores, auditRate: input.auditRate });
  const newManifest = manifestOf(built.manifest, routed);
  const unlimited = { maxDispatches: Number.MAX_SAFE_INTEGER, maxMinutes: Number.MAX_SAFE_INTEGER };
  const oldSide = side(estimateRound(input.roles, oldManifest, "full", unlimited), oldManifest, input.oldChunks ?? 0);
  const newSide = side(estimateRound(input.roles, newManifest, "full", unlimited), newManifest, input.newChunks ?? 0);

  const owned = (manifest: SliceManifest, reviewer: string): Set<string> => new Set(requiredSlices(manifest, reviewer));
  const findings: FindingLanding[] = (input.findings ?? []).map((finding) => {
    const slices = slicesHolding(routed, finding);
    if (slices.length === 0) return { ...finding, slices, landed: false, how: "not-in-diff", oldLanded: false };
    const reviewer = reviewerOf(finding);
    const deep = slices.some((id) => newManifest.slices.find((s) => s.id === id)?.depth === "deep");
    // No reviewer named: the finding is a correctness one, and review-logic owns every slice under both plans.
    const byOwner = reviewer === undefined || slices.some((id) => owned(newManifest, reviewer).has(id));
    const oldLanded = reviewer === undefined || slices.some((id) => owned(oldManifest, reviewer).has(id));
    const how = byOwner && deep ? "owner+deep" : byOwner ? "owner" : deep ? "deep" : "none";
    return { ...finding, ...(reviewer === undefined ? {} : { reviewer }), slices, landed: byOwner || deep, how, oldLanded };
  });
  const serious = findings.filter((finding) => SERIOUS.has(finding.severity.toLowerCase()));
  return {
    old: oldSide,
    new: newSide,
    reduction: oldSide.runs === 0 ? 0 : Number((1 - newSide.runs / oldSide.runs).toFixed(3)),
    findings,
    serious: { total: serious.length, landed: serious.filter((f) => f.landed).length, oldLanded: serious.filter((f) => f.oldLanded).length },
  };
}

// ---------------------------------------------------------------------------
// Ground truth input
// ---------------------------------------------------------------------------

const FINDINGS_FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\bkeryx:findings\b[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/m;

function toFinding(raw: unknown, index: number): GroundTruthFinding | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const f = raw as Record<string, unknown>;
  const location = typeof f.location === "string" ? f.location : undefined;
  const file = typeof f.file === "string" && f.file !== "" ? f.file : location?.replace(/:\d+(?:[-:]\d+)*$/, "");
  if (file === undefined || file === "") return undefined;
  const lineFromLocation = location === undefined ? undefined : Number(/:(\d+)/.exec(location)?.[1]);
  const line = typeof f.line === "number" && Number.isFinite(f.line) ? f.line : lineFromLocation !== undefined && Number.isFinite(lineFromLocation) ? lineFromLocation : undefined;
  return {
    id: typeof f.id === "string" && f.id !== "" ? f.id : `finding-${index + 1}`,
    severity: typeof f.severity === "string" ? f.severity : "unknown",
    file,
    ...(line === undefined ? {} : { line }),
    ...(typeof f.reviewer === "string" && f.reviewer !== "" ? { reviewer: f.reviewer } : {}),
    ...(typeof f.category === "string" && f.category !== "" ? { category: f.category } : {}),
  };
}

/**
 * Ground-truth findings from a canonical findings array, a `{ findings: [...] }` object (findings.json), or a report
 * with one keryx:findings block. Entries without a file are left out: they cannot be placed on a slice.
 */
export function parseGroundTruth(text: string): GroundTruthFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const block = FINDINGS_FENCE.exec(text);
    if (block === null) throw new Error("the findings input is neither JSON nor a report with a keryx:findings block");
    parsed = JSON.parse(block[2]!);
  }
  const list = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { findings?: unknown }).findings) ? (parsed as { findings: unknown[] }).findings : undefined;
  if (list === undefined) throw new Error("the findings input holds no findings array");
  return list.map(toFinding).filter((finding): finding is GroundTruthFinding => finding !== undefined);
}

export function renderPlanEval(result: PlanEval): string {
  const row = (label: string, s: PlanSide): string =>
    `${label}: ${s.slices} slices, ${s.assignments} assignments, ${s.dispatches} dispatches + ${s.chunks} chunks = ${s.runs} runs, ${s.minutes.min}-${s.minutes.max} min, deep ${s.deep} / light ${s.light} / audit ${s.audit}`;
  const lines = [row("old", result.old), row("new", result.new), `reduction: ${(result.reduction * 100).toFixed(1)}% fewer runs`];
  if (result.findings.length > 0) {
    lines.push(`blocker/major landed: new ${result.serious.landed}/${result.serious.total}, old ${result.serious.oldLanded}/${result.serious.total}`);
    for (const f of result.findings) {
      lines.push(`- ${f.id} [${f.severity}] ${f.reviewer ?? "(no reviewer)"} ${f.file}${f.line === undefined ? "" : `:${f.line}`}: ${f.landed ? "lands" : "MISSES"} (${f.how}; slices ${f.slices.join(", ") || "none"})${f.oldLanded ? "" : "; old plan missed it too"}`);
    }
  }
  return lines.join("\n");
}
