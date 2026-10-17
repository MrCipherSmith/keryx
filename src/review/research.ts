import { dispatchErrors } from "./dispatch";
import { pendingMutants } from "./mutate";
import { coverageErrors, packageChangedLines, packageHasBlastRadius, packageHasPrContext, packageScopeFiles, projectRootOfPackage } from "./coverage";
import { coverageGateErrors } from "./coverage-complete";
import { readFile } from "node:fs/promises";
import path from "node:path";
export const PENDING_RESEARCH = { version: 1, scopeReviewed: false, rawReconciled: false, obligations: [] };

/** One `dispatch.runs[]` entry of research.json as `ledger build` writes it (./ledger.ts `buildLedger`), read leniently. */
export type DispatchRun = {
  reviewer: string;
  /** `complete`, `incomplete` or `not-run`; anything else is passed through as written. */
  status?: string | undefined;
  scopeComplete?: boolean | undefined;
  /** True for a role slice routing gave no slice: recorded complete, never dispatched. */
  routedOut?: boolean | undefined;
  rawEvidence?: string | undefined;
  notRunReason?: string | undefined;
  executionReason?: string | undefined;
};

/** The reviewer runs research.json's dispatch record holds, each with a reviewer name; [] when there is none. */
export function dispatchRuns(research: unknown): DispatchRun[] {
  const record = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
  const runs = record(record(research)?.dispatch)?.runs;
  if (!Array.isArray(runs)) return [];
  const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  return runs.flatMap((value): DispatchRun[] => {
    const run = record(value);
    if (run === undefined || typeof run.reviewer !== "string" || run.reviewer === "") return [];
    return [{
      reviewer: run.reviewer,
      status: str(run.status),
      scopeComplete: typeof run.scopeComplete === "boolean" ? run.scopeComplete : undefined,
      routedOut: run.routedOut === true ? true : undefined,
      rawEvidence: str(run.rawEvidence),
      notRunReason: str(run.notRunReason),
      executionReason: str(run.executionReason),
    }];
  });
}
export function researchErrors(value: unknown, findings: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["research ledger must be an object"];
  const ledger = value as Record<string, unknown>;
  const errors: string[] = [];
  if (ledger.version !== 1) errors.push("research ledger version must be 1");
  if (ledger.scopeReviewed !== true) errors.push("research scope census is incomplete");
  if (ledger.rawReconciled !== true) errors.push("raw observations are not reconciled");
  if (!Array.isArray(ledger.obligations)) return [...errors, "research obligations must be an array"];
  if (!Array.isArray(findings)) return [...errors, "canonical findings must be an array"];
  const ids = new Set<string>();
  const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  for (const item of ledger.obligations) {
    if (!item || typeof item !== "object" || Array.isArray(item)) { errors.push("invalid research obligation"); continue; }
    const o = item as Record<string, unknown>;
    const id = nonempty(o.id) ? o.id : "<missing-id>";
    if (!nonempty(o.id) || ids.has(id)) errors.push(`${id}: missing or duplicate obligation id`);
    ids.add(id);
    if (!nonempty(o.source) || !nonempty(o.question)) errors.push(`${id}: source and question are required`);
    if (!["finding", "refuted", "out-of-scope", "narrowed"].includes(String(o.status))) errors.push(`${id}: unresolved research (${String(o.status)})`);
    if (!nonempty(o.evidence) || !nonempty(o.reason)) errors.push(`${id}: closure needs evidence and reason`);
    if (o.status === "narrowed" && !nonempty(o.remains)) errors.push(`${id}: narrowed needs a "what remains" text`);
    if (o.status === "finding") {
      const matches = findings.filter(f => f && typeof f === "object" && (f.id === o.finding || f.global_id === o.finding));
      if (!nonempty(o.finding) || matches.length !== 1) errors.push(`${id}: finding link must resolve uniquely in canonical findings`);
    }
  }
  return errors;
}
/**
 * The coverage gate over a package's recorded dispatch, with the options read from the package. `review complete`
 * (through `packageResearchErrors`) and `review readiness` both call this, so they cannot disagree on the reviewer set
 * or the round depth (flow 460).
 */
export async function packageCoverageErrors(packageDir: string, dispatch: unknown): Promise<string[]> {
  return coverageErrors(dispatch, {
    root: projectRootOfPackage(packageDir),
    packageDir,
    files: await packageScopeFiles(packageDir),
    changedLines: await packageChangedLines(packageDir),
    blastRadius: await packageHasBlastRadius(packageDir),
    prContext: packageHasPrContext(packageDir),
    pendingMutants: (await pendingMutants(packageDir)).length,
  });
}

/**
 * Absent artifact identifies packages predating this contract, not completed research. `completeness: false` skips the
 * layer/chunk coverage-completeness gate, for a round that was closed before that gate existed.
 */
export async function packageResearchErrors(packageDir: string, artifacts: unknown, findings: unknown, options: { coverage?: boolean; completeness?: boolean } = {}): Promise<string[]> {
  const a = artifacts && typeof artifacts === "object" ? artifacts as Record<string, unknown> : {};
  if (a.research === undefined) return a.reviewerDispatch === undefined ? [] : ["dispatch requires a research artifact"];
  if (a.reviewerDispatch !== undefined && a.reviewerDispatch !== "research.json") return ["invalid dispatch artifact locator"];
  if (a.research !== "research.json") return ["invalid research artifact locator"];
  try {
    const ledger = JSON.parse(await readFile(path.join(packageDir, "research.json"), "utf8"));
    // A dispatch block in research.json is checked whatever the manifest says: dropping the manifest's locator must not skip the gate.
    const recorded = ledger?.dispatch !== undefined;
    const checked = a.reviewerDispatch !== undefined || recorded;
    const mismatch = recorded && a.reviewerDispatch === undefined
      ? ['research.json records a reviewer dispatch but manifest.json does not declare it: restore artifacts.reviewerDispatch "research.json"']
      : [];
    const dispatch = checked ? dispatchErrors(ledger?.dispatch) : [];
    const coverage = !checked || options.coverage === false || dispatch.length
      ? []
      : await packageCoverageErrors(packageDir, ledger?.dispatch);
    const completeness = !checked || options.coverage === false || options.completeness === false || dispatch.length ? [] : await coverageGateErrors(packageDir, ledger);
    return [...researchErrors(ledger, findings), ...mismatch, ...dispatch, ...coverage, ...completeness];
  }
  catch { return ["research ledger unreadable or invalid JSON"]; }
}
