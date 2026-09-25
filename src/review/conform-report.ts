// Reference-document conformance mode — flow 308, AC6 (report rendering) and
// AC9 (the opt-in gate). Pure/no-I/O rendering plus one small config reader —
// the config reader mirrors `src/review/ci-triage.ts`'s `readCiTriageEnabled`
// exactly, reading a sibling key (`review.jev.conform`) of the same
// `.metaproject/tasks.config.json` block.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { REVIEW_GATE_CONFIG_PATH } from "../flow/review-gate";
import type { ConformVerdict, ConformClauseStatus } from "./conform-jev";
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

export interface ConformRunResult {
  readonly refPath: string;
  readonly target: ConformTarget;
  readonly threshold: number;
  readonly verdicts: readonly ConformVerdict[];
  readonly explanations?: Readonly<Record<string, string>>;
  readonly usage?: ConformUsage;
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

function renderVerdictLines(verdict: ConformVerdict, explanation: string | undefined): string[] {
  const lines: string[] = [`- [${STATUS_LABEL[verdict.status]}] ${verdict.clause_id}`];
  if (verdict.probability !== undefined) {
    lines.push(`    Jev probability (satisfies the clause): ${pct(verdict.probability)}`);
  }
  if (verdict.reason !== undefined) {
    lines.push(`    reason: ${verdict.reason}`);
  }
  for (const fact of verdict.factLines) {
    lines.push(`    evidence: ${fact}`);
  }
  if (verdict.decisive !== undefined) {
    lines.push(`    deterministic evidence alone: ${verdict.decisive.satisfied ? "satisfied" : "NOT satisfied"} — ${verdict.decisive.reason}`);
  }
  if (explanation !== undefined) {
    lines.push("    explanation (ADVISORY — not written to the PR or to findings.json):");
    for (const explainLine of explanation.split("\n")) lines.push(`      ${explainLine}`);
  }
  return lines;
}

/** AC6: markdown rendering — id, kind, checkable/not-checkable+reason, deterministic evidence, and Jev's probability, per clause; not-checkable clauses always listed. */
export function renderConformMarkdown(result: ConformRunResult): string {
  const lines: string[] = [
    `# review conform — ${result.refPath}`,
    "",
    `target: ${result.target.kind} — ${result.target.label}`,
    `threshold: ${result.threshold}`,
    `clauses: ${result.verdicts.length} total`,
    "",
  ];
  for (const kind of KIND_ORDER) {
    const inKind = result.verdicts.filter((v) => v.state_kind === kind);
    if (inKind.length === 0) continue;
    lines.push(`## ${kind}`, "");
    for (const verdict of inKind) {
      lines.push(...renderVerdictLines(verdict, result.explanations?.[verdict.clause_id]));
    }
    lines.push("");
  }
  const satisfied = result.verdicts.filter((v) => v.status === "satisfied").length;
  const likelyViolated = result.verdicts.filter((v) => v.status === "likely-violated").length;
  const notCheckable = result.verdicts.filter((v) => v.status === "not-checkable").length;
  const notEvaluated = result.verdicts.filter((v) => v.status === "not-evaluated").length;
  lines.push(
    `summary: ${satisfied} satisfied, ${likelyViolated} likely violated, ${notCheckable} not checkable, ${notEvaluated} not evaluated`,
  );
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

/** AC6's `--json` shape — one flat object, the same fields the markdown rendering reads. */
export function conformResultToJson(result: ConformRunResult): unknown {
  return {
    ref: result.refPath,
    target: result.target,
    threshold: result.threshold,
    clauses: result.verdicts.map((v) => ({
      clause_id: v.clause_id,
      state_kind: v.state_kind,
      status: v.status,
      ...(v.probability !== undefined ? { probability: v.probability } : {}),
      ...(v.reason !== undefined ? { reason: v.reason } : {}),
      evidence: v.factLines,
      ...(v.decisive !== undefined ? { decisive: v.decisive } : {}),
      ...(result.explanations?.[v.clause_id] !== undefined ? { explanation: result.explanations[v.clause_id] } : {}),
    })),
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
