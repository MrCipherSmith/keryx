// The one gate evaluation `review complete` and `review publish` share (flow 488). Before it, publish ran the readiness
// checklist alone: a package whose round record was edited after `review start`, whose report had no evidence level, or
// whose research ledger or artifact locators were broken, was refused at complete and published without a word. Both
// commands now get their refusals from here.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { readJsonFileOr } from "../lib/json";
import { parseEvidenceLevel, REPORT_FIELD_EVIDENCE_LEVEL } from "./evidence-level";
import { computeReadiness, failingItems, readinessRefusal, type ReadinessOptions, type ReadinessReport } from "./readiness";
import { packageResearchErrorsTagged } from "./research";
import { roundRecordTampered } from "./round-record";
import { partitionWaivers, sealProblems } from "./seals";
import type { ManagedReviewManifest } from "./types";

export type CloseGateInput = {
  manifest: Pick<ManagedReviewManifest, "report_fields">;
  /** report.md as read for this close (the evidence level is parsed from it). */
  report: string;
  readiness?: ReadinessOptions | undefined;
  /** The verb the readiness refusal names: `complete the review` or `publish`. */
  action: "complete the review" | "publish";
  /**
   * `publish --partial`: a failing readiness checklist does not refuse, nor does a research error that belongs to a
   * readiness item. The tamper check, the seals, the evidence level and an integrity research error (an artifact
   * locator, a manifest/dispatch mismatch, an unreadable ledger) always do.
   */
  relaxReadiness?: boolean | undefined;
  /** `review complete` only: records the operator's readiness waivers, before the research gate and the checklist read them. */
  beforeReadiness?: (() => Promise<void>) | undefined;
};

export type CloseGateResult = { readiness: ReadinessReport; warnings: string[] };

const REFUSAL = "Cannot complete managed review;";

const readManifest = async (packageDir: string): Promise<ManagedReviewManifest> => {
  const manifest = await readJsonFileOr<ManagedReviewManifest | undefined>(path.join(packageDir, "manifest.json"), undefined);
  if (manifest === undefined) throw new Error(`Managed review package has no readable manifest.json: ${packageDir}`);
  return manifest;
};

/**
 * The research gate (flow 488, review ARCH-1): the research ledger's errors, each tagged with the readiness items that can
 * waive it. An error with no item always refuses; a tagged one refuses unless the operator's sealed waiver of one of its
 * items covers it, or `relax` (publish --partial) lets the checklist speak for it. A closed package is not re-held to the
 * live coverage gate at publish: it passed that gate at its close (readiness.ts Context.liveCoverageGate, same rule).
 */
async function researchRefusals(packageDir: string, input: CloseGateInput): Promise<string[]> {
  const manifest = await readManifest(packageDir);
  // Unreadable is not "no findings": undefined fails the ledger's "canonical findings must be an array" check.
  const findings = await readFile(path.join(packageDir, "findings.json"), "utf8").then((text): unknown => JSON.parse(text), () => undefined);
  const closedPublish = input.action === "publish" && manifest.status === "closed";
  const errors = await packageResearchErrorsTagged(packageDir, manifest.artifacts, findings, closedPublish ? { coverage: false } : {});
  const waived = new Set<string>(partitionWaivers(manifest).sealed.map((waiver) => waiver.item));
  return errors
    .filter((error) => error.items.length === 0 || (input.relaxReadiness !== true && !error.items.some((item) => waived.has(item))))
    .map((error) => error.message);
}

/** The tamper check, the seals, the evidence level, the research gate, then the readiness checklist. Throws the refusal; returns the checklist and the warnings. */
export async function evaluateCloseGates(packageDir: string, input: CloseGateInput): Promise<CloseGateResult> {
  const tampered = roundRecordTampered(packageDir);
  if (tampered !== undefined) throw new Error(`${REFUSAL} ${tampered}`);
  const sealed = sealProblems(await readManifest(packageDir));
  if (sealed.length > 0) throw new Error(`${REFUSAL} ${sealed.join("; ")}`);
  const warnings: string[] = [];
  const evidence = parseEvidenceLevel(input.report);
  if (!evidence.ok) {
    const problem = `the report's evidence level is missing or invalid: ${evidence.reason}`;
    if (input.manifest.report_fields?.includes(REPORT_FIELD_EVIDENCE_LEVEL)) {
      throw new Error(`${REFUSAL} ${problem}. Add a line \`Evidence level: static only — did not run: <what>\` or \`Evidence level: ran — <what>\` to report.md`);
    }
    warnings.push(`${problem} (this package predates the field, so it is a warning)`);
  }
  await input.beforeReadiness?.();
  const research = await researchRefusals(packageDir, input);
  if (research.length > 0) throw new Error(`${REFUSAL} ${research.join("; ")}`);
  const readiness = await computeReadiness(packageDir, input.readiness ?? {});
  if (failingItems(readiness).length > 0 && input.relaxReadiness !== true) throw new Error(readinessRefusal(readiness, input.action === "publish" ? "publish" : "complete the review"));
  return { readiness, warnings };
}
