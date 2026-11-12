// The one gate evaluation `review complete` and `review publish` share (flow 488). Before it, publish ran the readiness
// checklist alone: a package whose round record was edited after `review start`, or whose report had no evidence level,
// was refused at complete and published without a word. Both commands now get their refusals from here.

import { parseEvidenceLevel, REPORT_FIELD_EVIDENCE_LEVEL } from "./evidence-level";
import { computeReadiness, failingItems, readinessRefusal, type ReadinessOptions, type ReadinessReport } from "./readiness";
import { roundRecordTampered } from "./round-record";
import type { ManagedReviewManifest } from "./types";

export type CloseGateInput = {
  manifest: Pick<ManagedReviewManifest, "report_fields">;
  /** report.md as read for this close (the evidence level is parsed from it). */
  report: string;
  readiness?: ReadinessOptions | undefined;
  /** The verb the readiness refusal names: `complete the review` or `publish`. */
  action: "complete the review" | "publish";
  /** `publish --partial`: a failing readiness checklist does not refuse. The tamper check and the evidence level always do. */
  relaxReadiness?: boolean | undefined;
  /**
   * Runs after the tamper and evidence checks and before the checklist is computed. `review complete` records the
   * operator's waivers and applies the research-error gate here, so the checklist sees them.
   */
  beforeReadiness?: (() => Promise<void>) | undefined;
};

export type CloseGateResult = { readiness: ReadinessReport; warnings: string[] };

/** The tamper check, the evidence level, then the readiness checklist. Throws the refusal; returns the checklist and the warnings. */
export async function evaluateCloseGates(packageDir: string, input: CloseGateInput): Promise<CloseGateResult> {
  const tampered = roundRecordTampered(packageDir);
  if (tampered !== undefined) throw new Error(`Cannot complete managed review; ${tampered}`);
  const warnings: string[] = [];
  const evidence = parseEvidenceLevel(input.report);
  if (!evidence.ok) {
    const problem = `the report's evidence level is missing or invalid: ${evidence.reason}`;
    if (input.manifest.report_fields?.includes(REPORT_FIELD_EVIDENCE_LEVEL)) {
      throw new Error(`Cannot complete managed review; ${problem}. Add a line \`Evidence level: static only — did not run: <what>\` or \`Evidence level: ran — <what>\` to report.md`);
    }
    warnings.push(`${problem} (this package predates the field, so it is a warning)`);
  }
  await input.beforeReadiness?.();
  const readiness = await computeReadiness(packageDir, input.readiness ?? {});
  if (failingItems(readiness).length > 0 && input.relaxReadiness !== true) throw new Error(readinessRefusal(readiness, input.action === "publish" ? "publish" : "complete the review"));
  return { readiness, warnings };
}
