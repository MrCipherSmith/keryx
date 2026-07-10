// Fixture-corpora CI gate (specification.md §6a; arch §6; AC0-20). The block-
// gating entry: fail (CI non-zero) when a corpus's false-negative rate regresses
// beyond a threshold, pass otherwise. Deterministic and side-effect free.

import type { CorpusReport } from "./corpus";

export interface GateOptions {
  maxFnRate: number;
}

export interface GateResult {
  status: "pass" | "fail";
  reasons: string[];
}

// Evaluate a corpus report against a max false-negative rate. Returns `fail`
// with a reason when `report.fnRate` exceeds `maxFnRate`, else `pass`.
export async function gateCorpus(
  report: CorpusReport,
  opts: GateOptions,
): Promise<GateResult> {
  const reasons: string[] = [];
  if (report.fnRate > opts.maxFnRate) {
    reasons.push(
      `corpus "${report.corpus}": fnRate ${report.fnRate.toFixed(4)} exceeds max ${opts.maxFnRate.toFixed(4)} ` +
        `(${report.falseNeg} false negative(s) of ${report.truePos + report.falseNeg} positive(s))`,
    );
  }
  return { status: reasons.length > 0 ? "fail" : "pass", reasons };
}
