import { dispatchErrors } from "./dispatch";
import { coverageErrors, packageScopeFiles, projectRootOfPackage } from "./coverage";
import { readFile } from "node:fs/promises";
import path from "node:path";
export const PENDING_RESEARCH = { version: 1, scopeReviewed: false, rawReconciled: false, obligations: [] };
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
    if (!["finding", "refuted", "out-of-scope"].includes(String(o.status))) errors.push(`${id}: unresolved research (${String(o.status)})`);
    if (!nonempty(o.evidence) || !nonempty(o.reason)) errors.push(`${id}: closure needs evidence and reason`);
    if (o.status === "finding") {
      const matches = findings.filter(f => f && typeof f === "object" && (f.id === o.finding || f.global_id === o.finding));
      if (!nonempty(o.finding) || matches.length !== 1) errors.push(`${id}: finding link must resolve uniquely in canonical findings`);
    }
  }
  return errors;
}
/** Absent artifact identifies packages predating this contract, not completed research. */
export async function packageResearchErrors(packageDir: string, artifacts: unknown, findings: unknown, options: { coverage?: boolean } = {}): Promise<string[]> {
  const a = artifacts && typeof artifacts === "object" ? artifacts as Record<string, unknown> : {};
  if (a.research === undefined) return a.reviewerDispatch === undefined ? [] : ["dispatch requires a research artifact"];
  if (a.reviewerDispatch !== undefined && a.reviewerDispatch !== "research.json") return ["invalid dispatch artifact locator"];
  if (a.research !== "research.json") return ["invalid research artifact locator"];
  try {
    const ledger = JSON.parse(await readFile(path.join(packageDir, "research.json"), "utf8"));
    const dispatch = a.reviewerDispatch === undefined ? [] : dispatchErrors(ledger?.dispatch);
    const coverage = a.reviewerDispatch === undefined || options.coverage === false || dispatch.length
      ? []
      : await coverageErrors(ledger?.dispatch, { root: projectRootOfPackage(packageDir), files: await packageScopeFiles(packageDir) });
    return [...researchErrors(ledger, findings), ...dispatch, ...coverage];
  }
  catch { return ["research ledger unreadable or invalid JSON"]; }
}
