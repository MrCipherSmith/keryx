// Flow 488 (AC9, review SEC-1): tamper evidence for what the close gates honour. The gates read operator decisions and
// verifier results back from package JSON an agent can write with a file tool (manifest.json, findings.json). keryx's
// own write paths therefore record, beside each such decision, a sha256 digest over its content (`manifest.seals`):
//
//   - `target`             review start/attach/ingest (createManagedReviewPackage), and `review complete` when it records
//                          the head (`--head`, with `--head-reason` when it relabels);
//   - `readinessWaivers`   `review complete --waive` and the review_waive_readiness / review_complete cards (waiveReadiness);
//   - `headOverride`       `review complete --head <sha> --head-reason "<quote>"` (terminal or --answered-by);
//   - `verifications`      `review ingest --verifications`: only the verifications the verifier merge applied in that ingest;
//   - `heavyFindings`      `review ingest`: the keys of the blocker and major findings it wrote (review SEC-2, round 2),
//                          so editing a severity in findings.json does not take a finding out of item `verifier`;
//   - `coverageWaiver`     `review complete --waive-coverage` and the review_waive_coverage card (recordCoverageWaiver):
//                          the waiver research.json holds under `dispatch.coverageWaiver` (review round 3).
//
// The gates (close-gates.ts, readiness.ts, coverage-complete.ts) honour a waiver, a head override or a verification only
// when its digest matches, and refuse a package whose blocker/major record is missing or does not match. This is the level of `roundRecordTampered`: evidence that a file was edited outside keryx, not a signature —
// an agent that recomputes the digest the way this module does is not stopped (cryptography is out of scope, flow 488
// description).
//
// Packages written before the seals existed carry none, and a missing seal is never read as "legacy, skip the check": an
// agent can delete `seals` as easily as it can edit what they cover (review round 2, SEC-1). So on such a package no
// waiver, head override or verification is honoured, a package with no blocker/major record is refused until it is
// ingested again (round 3: deleting the record let a lowered severity skip item `verifier`), and a pull-request package
// is refused until the operator records its head (`review complete --head <sha> --head-reason "<quote>"`), which writes
// the target seal. The flow 488 CHANGELOG
// entry names every case and its repair; the operator chose this strict reading over a legacy exemption (round 2,
// review-degradation-w1:F-001).

import { createHash } from "node:crypto";
import { isPrBound } from "./complete-head-gate";
import { asRecord as record } from "./record";
import { canonicalJson } from "./round-record";
import type { HeadOverride, ManagedReviewManifest, ManagedReviewTarget, ReadinessWaiver, ReviewSeals } from "./types";

const SEAL_DOMAIN = "keryx-review-seal/v1";

/** sha256 over the canonical JSON of a decision, under a domain and kind, so one kind's digest never matches another's. */
export function sealDigest(kind: string, content: unknown): string {
  return createHash("sha256").update(canonicalJson({ seal: SEAL_DOMAIN, kind, content })).digest("hex");
}

/** The target fields the head gate reads. */
export const sealTarget = (target: ManagedReviewTarget): string => sealDigest("target", { kind: target.kind, ref: target.ref, head: target.head ?? null });
export const sealWaiver = (waiver: ReadinessWaiver): string => sealDigest("readiness-waiver", waiver);
export const sealHeadOverride = (override: HeadOverride): string => sealDigest("head-override", override);
export const sealCoverageWaiver = (waiver: unknown): string => sealDigest("coverage-waiver", waiver);

/** Whether keryx sealed this coverage waiver (research.json `dispatch.coverageWaiver`) as it now reads. */
export function coverageWaiverSealed(manifest: Pick<ManagedReviewManifest, "seals"> | undefined, waiver: unknown): boolean {
  return manifest?.seals?.coverageWaiver !== undefined && manifest.seals.coverageWaiver === sealCoverageWaiver(waiver);
}

/** The key a finding's verification seal is stored under: its `global_id`, else its display `id`. */
export function findingKey(finding: unknown): string {
  const raw = record(finding);
  return String(raw?.global_id ?? raw?.id ?? "");
}

export const sealVerification = (key: string, verification: unknown): string => sealDigest("verification", { finding: key, verification });

/** The seals of a manifest with the verifications of `findings` (each `{key, verification}`) added. */
export function withVerificationSeals(seals: ReviewSeals | undefined, findings: ReadonlyArray<{ key: string; verification: unknown }>): ReviewSeals {
  const verifications = { ...(seals?.verifications ?? {}) };
  for (const { key, verification } of findings) verifications[key] = sealVerification(key, verification);
  return { ...(seals ?? {}), ...(findings.length === 0 && seals?.verifications === undefined ? {} : { verifications }) };
}

/** Whether keryx sealed this waiver as it now reads. */
export function waiverSealed(manifest: Pick<ManagedReviewManifest, "seals">, waiver: ReadinessWaiver): boolean {
  return manifest.seals?.readinessWaivers?.[waiver.item] === sealWaiver(waiver);
}

/** The waivers keryx sealed, and the ones it did not (or that changed since). */
export function partitionWaivers(manifest: Pick<ManagedReviewManifest, "seals" | "readiness_waivers">): { sealed: ReadinessWaiver[]; unsealed: ReadinessWaiver[] } {
  const sealed: ReadinessWaiver[] = [];
  const unsealed: ReadinessWaiver[] = [];
  for (const waiver of manifest.readiness_waivers ?? []) (waiverSealed(manifest, waiver) ? sealed : unsealed).push(waiver);
  return { sealed, unsealed };
}

const filled = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

/** verificationProblem's answer for a finding that carries no verification at all (as opposed to one that is not honoured). */
export const NO_VERIFICATION = "no verification";

/** Why a finding's verification does not count, or undefined when it does: the producer's shape, and keryx's seal over it. */
export function verificationProblem(manifest: Pick<ManagedReviewManifest, "seals">, finding: Record<string, unknown>): string | undefined {
  const verification = record(finding.verification);
  if (verification === undefined) return NO_VERIFICATION;
  if (!filled(verification.verdict) || !filled(verification.method) || !filled(verification.evidence)) return "a verification without verdict, method and evidence";
  const key = findingKey(finding);
  if (manifest.seals?.verifications?.[key] !== sealVerification(key, finding.verification)) return "a verification keryx did not record (no matching seal: it was not applied by `keryx review ingest --verifications`)";
  return undefined;
}

const HEAVY = new Set(["blocker", "major"]);

/** The keys of the blocker and major findings in `findings`, sorted and unique: what `review ingest` seals. */
export function heavyFindingKeys(findings: ReadonlyArray<unknown>): string[] {
  return [...new Set(findings.filter((finding) => HEAVY.has(String(record(finding)?.severity))).map(findingKey))].sort();
}

export const sealHeavyFindings = (keys: readonly string[]): string => sealDigest("heavy-findings", [...keys]);

/** The `heavyFindings` seal for the findings `review ingest` writes. */
export function heavyFindingsSeal(findings: ReadonlyArray<unknown>): NonNullable<ReviewSeals["heavyFindings"]> {
  const keys = heavyFindingKeys(findings);
  return { keys, seal: sealHeavyFindings(keys) };
}

/**
 * The finding keys keryx recorded as blocker or major at ingest, when it recorded them and the record is intact; undefined
 * otherwise. The close gates never reach readiness on undefined (sealProblems refuses a missing or broken record); the
 * readers that report without closing (verdict, panel) then go by the severities in findings.json.
 */
export function sealedHeavyKeys(manifest: Pick<ManagedReviewManifest, "seals">): string[] | undefined {
  const heavy = manifest.seals?.heavyFindings;
  if (heavy === undefined || !Array.isArray(heavy.keys) || heavy.seal !== sealHeavyFindings(heavy.keys)) return undefined;
  return heavy.keys;
}

export type SealCheckOptions = {
  /** `review complete --head <sha> --head-reason`: the operator records the head in this close, so a missing target seal is what this close repairs. */
  headRecordedByOperator?: boolean | undefined;
};

/**
 * Why the manifest's target, head override or blocker/major record cannot be trusted. Read by the close gates of both
 * `review complete` and `review publish`. A pull-request package with no target seal is refused, whether it predates the
 * seals or had them removed: the two look the same on disk, and only the operator can vouch for the head.
 */
export function sealProblems(manifest: Pick<ManagedReviewManifest, "seals" | "target" | "head_override">, options: SealCheckOptions = {}): string[] {
  const problems: string[] = [];
  if (manifest.head_override !== undefined && manifest.seals?.headOverride !== sealHeadOverride(manifest.head_override)) {
    problems.push(
      "manifest.json head_override does not match a seal keryx wrote: a head is relabelled only by `keryx review complete <review> --head <sha> --head-reason \"<operator quote>\"` (a terminal, or --answered-by), never by editing manifest.json",
    );
  }
  if (isPrBound(manifest.target)) {
    if (manifest.seals?.target === undefined) {
      if (options.headRecordedByOperator !== true) {
        problems.push(
          `manifest.json carries no target seal (the package was written before keryx sealed it, or its \`seals\` were removed), so the reviewed head ${manifest.target.head ?? "(not recorded)"} is not trusted: the operator records it with \`keryx review complete <review> --head <sha> --head-reason "<operator quote>"\` (a terminal, or --answered-by), which seals it`,
        );
      }
    } else if (manifest.seals.target !== sealTarget(manifest.target)) {
      problems.push(
        `manifest.json target (head ${manifest.target.head ?? "not recorded"}) does not match the seal keryx wrote when it last recorded the target: it was edited outside keryx. Restore the recorded target; the reviewed head changes only through \`keryx review complete <review> --head <sha> --head-reason "<operator quote>"\``,
      );
    }
  }
  // Review round 3 (cluster A): a missing record is refused like a broken one. Read as "ingested before the record existed",
  // its absence let an agent delete it, lower a major in findings.json and close past item `verifier`.
  const heavy = manifest.seals?.heavyFindings;
  if (heavy === undefined) {
    problems.push("manifest.json carries no seals.heavyFindings, the record `review ingest` writes of the blocker and major findings (the package was ingested before keryx wrote it, or it was removed): re-run `keryx review ingest` to record the findings again");
  } else if (!Array.isArray(heavy.keys) || heavy.seal !== sealHeavyFindings(heavy.keys)) {
    problems.push("manifest.json seals.heavyFindings does not match the seal `review ingest` wrote over the blocker and major findings: it was edited outside keryx; re-run `keryx review ingest` to record the findings again");
  }
  return problems;
}
