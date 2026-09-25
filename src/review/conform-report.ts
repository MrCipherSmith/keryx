// Reference-document conformance mode — flow 308, AC6 (report rendering) and
// AC9 (the opt-in gate). Pure/no-I/O rendering plus one small config reader —
// the config reader mirrors `src/review/ci-triage.ts`'s `readCiTriageEnabled`
// exactly, reading a sibling key (`review.jev.conform`) of the same
// `.metaproject/tasks.config.json` block.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { REVIEW_GATE_CONFIG_PATH } from "../flow/review-gate";
import {
  aggregateConformVerdicts,
  DEFAULT_MAX_HUNKS,
  type ConformClauseAggregate,
  type ConformVerdict,
  type ConformClauseStatus,
} from "./conform-jev";
import type { ReferenceClauseStateKind } from "./conform-clauses";

/**
 * AC9: opt-in per project, `review.jev.conform` in `.metaproject/tasks.config.json`
 * — same shape, same fail-closed reading (absent/unparsable -> false, never
 * throws, never defaults on) as `readCiTriageEnabled`.
 */
export async function readConformEnabled(cwd: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(cwd, REVIEW_GATE_CONFIG_PATH), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const review = (parsed as Record<string, unknown>)["review"];
    if (typeof review !== "object" || review === null) return false;
    const jev = (review as Record<string, unknown>)["jev"];
    if (typeof jev !== "object" || jev === null) return false;
    return (jev as Record<string, unknown>)["conform"] === true;
  } catch {
    return false;
  }
}

export type ConformTargetKind = "pr" | "report" | "diff";

export interface ConformTarget {
  readonly kind: ConformTargetKind;
  readonly label: string;
}

export interface ConformUsage {
  readonly jevCalls: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

/** Flow 326, AC3: how many hunks this run judged vs skipped under `--max-hunk-calls`, and which clauses were affected. */
export interface ConformHunkBudget {
  readonly maxHunkCalls: number;
  readonly totalHunks: number;
  readonly hunksJudged: number;
  readonly hunksSkipped: number;
  readonly truncatedClauses: readonly string[];
}

export interface ConformRunResult {
  readonly refPath: string;
  readonly target: ConformTarget;
  readonly threshold: number;
  readonly verdicts: readonly ConformVerdict[];
  readonly explanations?: Readonly<Record<string, string>>;
  readonly usage?: ConformUsage;
  readonly hunkBudget?: ConformHunkBudget;
}

/** Flow 326, AC1: `--max-hunks` (further violating hunk locations shown) and `--detail` (full per-hunk breakdown in the text report). */
export interface ConformRenderOptions {
  readonly maxHunks?: number;
  readonly detail?: boolean;
}

const STATUS_LABEL: Readonly<Record<ConformClauseStatus, string>> = {
  satisfied: "satisfied",
  "likely-violated": "likely violated",
  "not-checkable": "not checkable",
  "not-evaluated": "not evaluated",
};

const KIND_ORDER: readonly ReferenceClauseStateKind[] = ["pr", "report", "hunk"];

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function locationLabel(loc: { readonly path: string; readonly startLine: number; readonly endLine: number }): string {
  return `${loc.path}:${loc.startLine}-${loc.endLine}`;
}

/**
 * Flow 326, AC1: one row per clause. A hunk-kind clause's row carries how
 * many hunks were judged and how many fell below threshold, the single worst
 * hunk (location + probability), and up to `--max-hunks` further violating
 * hunk locations — never the full hunk × clause cross-product. A pr/report
 * clause (already one verdict) renders the same as before flow 326.
 */
function renderAggregateLines(
  agg: ConformClauseAggregate,
  explanation: string | undefined,
  detail: boolean,
  hunkBudget?: ConformHunkBudget,
): string[] {
  const lines: string[] = [`- [${STATUS_LABEL[agg.status]}] ${agg.clause_id}`];
  const truncatedByBudget = hunkBudget !== undefined && hunkBudget.truncatedClauses.includes(agg.clause_id);
  if (agg.hunksJudged > 0) {
    lines.push(`    hunks judged: ${agg.hunksJudged}, below threshold: ${agg.hunksBelowThreshold}`);
    // Flow 326, AC3: a clause judged on a SUBSET of the diff's hunks (the
    // budget's per-clause floor gave it fewer than the diff has) still stays
    // satisfied/likely-violated as usual — but the subset is never silent.
    if (truncatedByBudget) {
      lines.push(`    judged on ${agg.hunksJudged} of ${hunkBudget!.totalHunks} hunks (--max-hunk-calls ${hunkBudget!.maxHunkCalls})`);
    }
  }
  if (agg.worst !== undefined) {
    lines.push(`    worst hunk: ${locationLabel(agg.worst.location)} (${pct(agg.worst.probability)})`);
  }
  if (agg.furtherViolations.length > 0) {
    lines.push("    further violating hunks:");
    for (const v of agg.furtherViolations) {
      lines.push(`      - ${locationLabel(v.location)} (${pct(v.probability)})`);
    }
  }
  if (agg.probability !== undefined) {
    lines.push(`    Jev probability (satisfies the clause): ${pct(agg.probability)}`);
  }
  if (agg.reason !== undefined) {
    lines.push(`    reason: ${agg.reason}`);
  }
  lines.push(`    tag source: ${agg.tag_source}`);
  for (const fact of agg.factLines) {
    lines.push(`    evidence: ${fact}`);
  }
  if (agg.decisive !== undefined) {
    lines.push(`    deterministic evidence alone: ${agg.decisive.satisfied ? "satisfied" : "NOT satisfied"} — ${agg.decisive.reason}`);
  }
  if (explanation !== undefined) {
    lines.push("    explanation (ADVISORY — not written to the PR or to findings.json):");
    for (const explainLine of explanation.split("\n")) lines.push(`      ${explainLine}`);
  }
  if (detail && agg.state_kind === "hunk" && agg.detail.length > 0) {
    lines.push("    detail (--detail):");
    for (const v of agg.detail) {
      const loc = v.location !== undefined ? locationLabel(v.location) : "(no location)";
      lines.push(`      - [${STATUS_LABEL[v.status]}] ${loc}${v.probability !== undefined ? ` (${pct(v.probability)})` : ""}`);
    }
  }
  return lines;
}

/** AC6/flow 326 AC1: markdown rendering — id, kind, checkable/not-checkable+reason, deterministic evidence, and Jev's probability, per CLAUSE (not per hunk × clause); not-checkable clauses always listed. */
export function renderConformMarkdown(result: ConformRunResult, options: ConformRenderOptions = {}): string {
  const maxHunks = options.maxHunks ?? DEFAULT_MAX_HUNKS;
  const detail = options.detail ?? false;
  const aggregates = aggregateConformVerdicts(result.verdicts, maxHunks);
  const lines: string[] = [
    `# review conform — ${result.refPath}`,
    "",
    `target: ${result.target.kind} — ${result.target.label}`,
    `threshold: ${result.threshold}`,
    `clauses: ${aggregates.length} total`,
    "",
  ];
  for (const kind of KIND_ORDER) {
    const inKind = aggregates.filter((a) => a.state_kind === kind);
    if (inKind.length === 0) continue;
    lines.push(`## ${kind}`, "");
    for (const agg of inKind) {
      lines.push(...renderAggregateLines(agg, result.explanations?.[agg.clause_id], detail, result.hunkBudget));
    }
    lines.push("");
  }
  const satisfied = aggregates.filter((a) => a.status === "satisfied").length;
  const likelyViolated = aggregates.filter((a) => a.status === "likely-violated").length;
  const notCheckable = aggregates.filter((a) => a.status === "not-checkable").length;
  const notEvaluated = aggregates.filter((a) => a.status === "not-evaluated").length;
  lines.push(
    `summary: ${satisfied} satisfied, ${likelyViolated} likely violated, ${notCheckable} not checkable, ${notEvaluated} not evaluated`,
  );
  if (result.hunkBudget !== undefined && result.hunkBudget.hunksSkipped > 0) {
    lines.push(
      `hunk budget: judged ${result.hunkBudget.hunksJudged}/${result.hunkBudget.totalHunks} hunk(s) (--max-hunk-calls ` +
        `${result.hunkBudget.maxHunkCalls}); ${result.hunkBudget.hunksSkipped} hunk(s) skipped for clause(s): ` +
        `${result.hunkBudget.truncatedClauses.join(", ")}`,
    );
  }
  if (result.usage !== undefined) {
    lines.push(
      `cost: jev calls ${result.usage.jevCalls}` +
        (result.usage.inputTokens !== undefined ? `, input tokens ${result.usage.inputTokens}` : "") +
        (result.usage.outputTokens !== undefined ? `, output tokens ${result.usage.outputTokens}` : "") +
        (result.usage.costUsd !== undefined ? `, spent $${result.usage.costUsd.toFixed(4)}` : ""),
    );
  }
  return lines.join("\n");
}

/** AC6/flow 326 AC1's `--json` shape — one object per clause, the same aggregate the markdown rendering reads, plus (hunk-kind clauses only) the full per-hunk detail nested under `hunks`. */
export function conformResultToJson(result: ConformRunResult, options: ConformRenderOptions = {}): unknown {
  const maxHunks = options.maxHunks ?? DEFAULT_MAX_HUNKS;
  const aggregates = aggregateConformVerdicts(result.verdicts, maxHunks);
  return {
    ref: result.refPath,
    target: result.target,
    threshold: result.threshold,
    clauses: aggregates.map((a) => ({
      clause_id: a.clause_id,
      state_kind: a.state_kind,
      status: a.status,
      tag_source: a.tag_source,
      ...(a.probability !== undefined ? { probability: a.probability } : {}),
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
      evidence: a.factLines,
      ...(a.decisive !== undefined ? { decisive: a.decisive } : {}),
      ...(a.hunksJudged > 0 ? { hunksJudged: a.hunksJudged, hunksBelowThreshold: a.hunksBelowThreshold } : {}),
      // Flow 326, AC3: visible in JSON too — only when the budget actually
      // cut this clause down to fewer hunks than the diff has.
      ...(a.hunksJudged > 0 && result.hunkBudget !== undefined && result.hunkBudget.truncatedClauses.includes(a.clause_id)
        ? { hunksTotal: result.hunkBudget.totalHunks }
        : {}),
      ...(a.worst !== undefined ? { worst: a.worst } : {}),
      ...(a.furtherViolations.length > 0 ? { furtherViolations: a.furtherViolations } : {}),
      ...(result.explanations?.[a.clause_id] !== undefined ? { explanation: result.explanations[a.clause_id] } : {}),
      // AC1: the full per-hunk detail stays available under --json, nested per
      // clause — but only for a hunk-kind clause. A pr/report-kind clause is
      // never scored per-hunk (its single verdict already renders above as
      // `probability`/`decisive`/`evidence`), so `hunks: []` there was noise,
      // not data (flow 326 nit).
      ...(a.state_kind === "hunk"
        ? {
            hunks: a.detail.map((v) => ({
              status: v.status,
              ...(v.probability !== undefined ? { probability: v.probability } : {}),
              ...(v.location !== undefined ? { location: v.location } : {}),
              evidence: v.factLines,
            })),
          }
        : {}),
    })),
    ...(result.hunkBudget !== undefined ? { hunkBudget: result.hunkBudget } : {}),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
  };
}

// ---------------------------------------------------------------------------
// AC8: "recent [reference documents] remembered" for the TUI picker.
// ---------------------------------------------------------------------------

export const CONFORM_RECENTS_PATH = ".metaproject/data/review-conform/recent-docs.json";
export const CONFORM_RECENTS_MAX = 8;

/** Move `refPath` to the front of the recents list, deduplicated, capped at {@link CONFORM_RECENTS_MAX}. */
export function withRecentDoc(current: readonly string[], refPath: string): readonly string[] {
  return [refPath, ...current.filter((p) => p !== refPath)].slice(0, CONFORM_RECENTS_MAX);
}
