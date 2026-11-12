// Fixtures shared by the flow 488 close-gate tests: a package that passes every readiness item, so a test breaks exactly one.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrLookup } from "./complete-head-gate";
import { READY_COVERAGE_MD, READY_DISPATCH } from "./dispatch.test-helpers";
import { createManagedReviewPackage } from "./managed";

export const HEAD = "a".repeat(40);
export const MOVED = "b".repeat(40);
export const PR = "https://github.com/acme/app/pull/7";
export const EVIDENCE = "Evidence level: static only — did not run: tests";
export const OPERATOR_WORDS = "the operator read the finding and accepts it for this round";

const ready = { version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: READY_DISPATCH };

/** An ingested package whose research, dispatch and coverage.md pass; the report ends with the evidence level. Returns its path relative to `cwd`. */
export async function ingestReady(cwd: string, report: string, target: { kind: "pr" | "report"; ref: string; head?: string }, reviewId = "gate-fixture"): Promise<string> {
  const result = await createManagedReviewPackage({ cwd, mode: "ingest", reportText: `${report}\n${EVIDENCE}\n`, reviewId, target });
  await writeFile(path.join(path.resolve(cwd, result.path), "research.json"), JSON.stringify(ready));
  await writeFile(path.join(path.resolve(cwd, result.path), "coverage.md"), READY_COVERAGE_MD);
  return result.path;
}

/** Replaces the package's findings.json. */
export const writeFindings = (cwd: string, ref: string, findings: unknown[]): Promise<void> =>
  writeFile(path.join(path.resolve(cwd, ref), "findings.json"), JSON.stringify(findings, null, 2));

export const readManifest = async (cwd: string, ref: string): Promise<Record<string, any>> =>
  JSON.parse(await readFile(path.join(path.resolve(cwd, ref), "manifest.json"), "utf8"));

export function lookup(pr: { state?: string; headSha?: string } | null): PrLookup & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (ref: string) => { calls.push(ref); return pr === null ? null : { exists: true, state: pr.state ?? "OPEN", headSha: pr.headSha ?? HEAD }; }) as PrLookup & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** A blocker/major finding nobody verified: item 4 (`verifier`) fails on it. */
export const UNVERIFIED_MAJOR = { id: "f-1", severity: "major", title: "unverified claim" };
