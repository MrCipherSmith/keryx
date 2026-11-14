// Fixtures shared by the flow 488 close-gate tests: a package that passes every readiness item, so a test breaks exactly one.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrLookup } from "./complete-head-gate";
import { READY_COVERAGE_MD, READY_DISPATCH } from "./dispatch.test-helpers";
import { createManagedReviewPackage } from "./managed";
import { findingKey, heavyFindingsSeal, sealTarget, withVerificationSeals } from "./seals";
import type { ManagedReviewManifest } from "./types";

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

export const readManifest = async (cwd: string, ref: string): Promise<ManagedReviewManifest> =>
  JSON.parse(await readFile(path.join(path.resolve(cwd, ref), "manifest.json"), "utf8"));

/** A hand edit of manifest.json. Untyped on purpose: the tests write fields and shapes the manifest type forbids. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ManifestEdit = (manifest: Record<string, any>) => void;

/** Applies `edit` to the package's manifest.json and writes it back: the hand edit a gate must catch. */
export async function editManifest(cwd: string, ref: string, edit: ManifestEdit): Promise<void> {
  const manifest = await readManifest(cwd, ref) as unknown as Parameters<ManifestEdit>[0];
  edit(manifest);
  await writeFile(path.join(path.resolve(cwd, ref), "manifest.json"), JSON.stringify(manifest, null, 2));
}

/** A `review publish` post/confirm pair that records each posted body and always confirms. */
export const sink = () => {
  const posts: string[] = [];
  return { posts, post: async (_ref: string, _event: string, body: string) => { posts.push(body); return { ok: true, detail: "ok" }; }, confirm: async () => true };
};

export function lookup(pr: { state?: string; headSha?: string } | null): PrLookup & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (ref: string) => { calls.push(ref); return pr === null ? null : { exists: true, state: pr.state ?? "OPEN", headSha: pr.headSha ?? HEAD }; }) as PrLookup & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** A verification in the shape review-verifier's merge writes (verdict, method, evidence, verifier). */
export const VERIFIED = { verdict: "confirmed", method: "site-check", evidence: "enumerated the sites", verifier: "review-verifier" } as const;

/**
 * Stands in for `review ingest --verifications` in a test whose subject is not the seal: writes the seal keryx writes over
 * every verification findings.json holds now. A test of the seal itself never calls this (see seals.test.ts).
 */
export async function sealVerificationsAsIngest(packageDir: string): Promise<void> {
  const findings = JSON.parse(await readFile(path.join(packageDir, "findings.json"), "utf8")) as Array<Record<string, unknown>>;
  const file = path.join(packageDir, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as ManagedReviewManifest;
  const applied = findings.filter((finding) => finding.verification !== undefined).map((finding) => ({ key: findingKey(finding), verification: finding.verification }));
  // An ingest seals the target and the blocker/major record in the same write; a hand-built fixture that had no seals gets them too.
  await writeFile(file, JSON.stringify({ ...manifest, seals: { ...withVerificationSeals(manifest.seals, applied), target: manifest.seals?.target ?? sealTarget(manifest.target), heavyFindings: manifest.seals?.heavyFindings ?? heavyFindingsSeal(findings) } }, null, 2));
}

/** A blocker/major finding nobody verified: item 4 (`verifier`) fails on it. */
export const UNVERIFIED_MAJOR = { id: "f-1", severity: "major", title: "unverified claim" };
