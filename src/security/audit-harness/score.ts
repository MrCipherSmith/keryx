// Flow 308 (W8 Design part A, Lane A) — score.ts: deterministic score/grade.
// Pure: `scoreFindings` takes the UNSUPPRESSED findings only (the caller
// filters) and derives score, grade and per-severity counts. No I/O, no clock.

import type { AuditFinding, AuditSeverity, Summary } from "./types";

const WEIGHT: Record<AuditSeverity, number> = {
  critical: 25,
  high: 10,
  medium: 4,
  low: 1,
};

function gradeForScore(score: number): Summary["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

const GRADE_RANK: Record<Summary["grade"], number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };

function worseGrade(a: Summary["grade"], b: Summary["grade"]): Summary["grade"] {
  return GRADE_RANK[a] <= GRADE_RANK[b] ? a : b;
}

/**
 * `unsuppressedFindings` must already be filtered to the ones that count
 * toward the score — unsuppressed, and above any `--severity-floor` the
 * caller applies. `totalFindings` is supplied separately because the schema
 * defines it as the COMPLETE finding count (`findings.length`, suppressed
 * included) — a different population from the one the score is computed
 * over. Pure and deterministic: same inputs, same output, every run.
 */
export function scoreFindings(
  unsuppressedFindings: readonly AuditFinding[],
  totalFindings: number = unsuppressedFindings.length,
): Summary {
  const counts: Record<AuditSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of unsuppressedFindings) {
    counts[finding.severity] += 1;
  }
  const penalty =
    counts.critical * WEIGHT.critical +
    counts.high * WEIGHT.high +
    counts.medium * WEIGHT.medium +
    counts.low * WEIGHT.low;
  const score = Math.max(0, 100 - penalty);
  let grade = gradeForScore(score);
  if (counts.critical > 0) {
    grade = worseGrade(grade, "C");
  }
  return {
    score,
    grade,
    countsBySeverity: counts,
    totalFindings,
  };
}
