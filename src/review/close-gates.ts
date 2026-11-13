// The one gate evaluation `review complete` and `review publish` share (flow 488). Before it, publish ran the readiness
// checklist alone: a package whose round record was edited after `review start`, whose report had no evidence level, or
// whose research ledger or artifact locators were broken, was refused at complete and published without a word. Both
// commands now get their refusals from here.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { readJsonFileOr } from "../lib/json";
import { parseEvidenceLevel, REPORT_FIELD_EVIDENCE_LEVEL } from "./evidence-level";
import { computeReadiness, failingItems, readinessRefusal, runsLiveCoverageGate, type ReadinessOptions, type ReadinessReport } from "./readiness";
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
  /** `review complete --head <sha> --head-reason`: the operator records the head in this close, which seals a target keryx never sealed (seals.ts). */
  headRecordedByOperator?: boolean | undefined;
};

export type CloseGateResult = { readiness: ReadinessReport; warnings: string[] };

const REFUSAL = "Cannot complete managed review;";

/** Whether this evaluation is `review complete` closing the package (as opposed to publishing one). */
const closes = (input: Pick<CloseGateInput, "action">): boolean => input.action === "complete the review";

const readManifest = async (packageDir: string): Promise<ManagedReviewManifest> => {
  const manifest = await readJsonFileOr<ManagedReviewManifest | undefined>(path.join(packageDir, "manifest.json"), undefined);
  if (manifest === undefined) throw new Error(`Managed review package has no readable manifest.json: ${packageDir}`);
  return manifest;
};

const UNREADABLE_FINDINGS = "findings.json is missing or not JSON: the gates cannot read the findings this round recorded; re-run `keryx review ingest`";

/**
 * findings.json as parsed, or undefined when it is missing or not JSON. `.catch` after the parse, not `.then(parse, onError)`:
 * the second argument of `.then` never sees what the first one throws, which is how a truncated file used to escape as a
 * bare SyntaxError (review round 2, DEG-1).
 */
const readFindings = (packageDir: string): Promise<unknown> =>
  readFile(path.join(packageDir, "findings.json"), "utf8").then((text): unknown => JSON.parse(text)).catch(() => undefined);

/**
 * The research gate (flow 488, review ARCH-1): the research ledger's errors, each tagged with the readiness items that can
 * waive it. An error with no item always refuses; a tagged one refuses unless the operator's sealed waiver of one of its
 * items covers it, or `relax` (publish --partial) lets the checklist speak for it. Publishing a closed package does not
 * re-hold it to the live coverage gate: it passed that gate at its close. `review complete` always runs it, whatever
 * manifest.json's unsealed `status` says (readiness.ts runsLiveCoverageGate, the one rule for both; review round 3).
 */
async function researchRefusals(packageDir: string, input: CloseGateInput, findings: unknown): Promise<string[]> {
  const manifest = await readManifest(packageDir);
  const live = runsLiveCoverageGate(manifest, closes(input));
  const errors = await packageResearchErrorsTagged(packageDir, manifest.artifacts, findings, live ? {} : { coverage: false });
  const waived = new Set<string>(partitionWaivers(manifest).sealed.map((waiver) => waiver.item));
  return errors
    .filter((error) => error.items.length === 0 || (input.relaxReadiness !== true && !error.items.some((item) => waived.has(item))))
    .map((error) => error.message);
}

/** The tamper check, the seals, the evidence level, the research gate, then the readiness checklist. Throws the refusal; returns the checklist and the warnings. */
export async function evaluateCloseGates(packageDir: string, input: CloseGateInput): Promise<CloseGateResult> {
  // Review round 2 (DEG-1): an unreadable findings.json is an integrity failure like an unreadable ledger, so no waiver
  // and no --partial lifts it. It is checked first: the round-record check and the ledger read findings.json too, and
  // would otherwise fail on a bare parse error, or (the ledger) return an error tagged `ledger`, which a waiver covers.
  if ((await readFindings(packageDir)) === undefined) throw new Error(`${REFUSAL} ${UNREADABLE_FINDINGS}`);
  const tampered = roundRecordTampered(packageDir);
  if (tampered !== undefined) throw new Error(`${REFUSAL} ${tampered}`);
  const sealed = sealProblems(await readManifest(packageDir), { headRecordedByOperator: input.headRecordedByOperator });
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
  // Read again: beforeReadiness may have written since, and an unreadable file is refused with the same message.
  const findings = await readFindings(packageDir);
  if (findings === undefined) throw new Error(`${REFUSAL} ${UNREADABLE_FINDINGS}`);
  const research = await researchRefusals(packageDir, input, findings);
  if (research.length > 0) throw new Error(`${REFUSAL} ${research.join("; ")}`);
  const readiness = await computeReadiness(packageDir, { ...(input.readiness ?? {}), closing: closes(input) });
  if (failingItems(readiness).length > 0 && input.relaxReadiness !== true) throw new Error(readinessRefusal(readiness, input.action));
  return { readiness, warnings };
}
