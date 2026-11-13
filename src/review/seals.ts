// Flow 488 (AC9, review SEC-1): tamper evidence for what the close gates honour. The gates read operator decisions and
// verifier results back from package JSON an agent can write with a file tool (manifest.json, findings.json). keryx's
// own write paths therefore record, beside each such decision, a sha256 digest over its content (`manifest.seals`):
//
//   - `target`             review start/attach/ingest (createManagedReviewPackage), and `review complete` when it records
//                          the head (`--head`, with `--head-reason` when it relabels);
//   - `readinessWaivers`   `review complete --waive` and the review_waive_readiness / review_complete cards (waiveReadiness);
//   - `headOverride`       `review complete --head <sha> --head-reason "<quote>"` (terminal or --answered-by);
//   - `verifications`      `review ingest --verifications`: only the verifications the verifier merge applied in that ingest.
//
// The gates (close-gates.ts, readiness.ts) honour a waiver, a head override or a verification only when its digest
// matches. This is the level of `roundRecordTampered`: evidence that a file was edited outside keryx, not a signature —
// an agent that recomputes the digest the way this module does is not stopped (cryptography is out of scope, flow 488
// description). Packages written before the seals existed carry none: their waivers and verifications are not honoured
// (the operator accepted that such a closed package may read NOT READY; the flow 488 CHANGELOG entry says so), and their target
// is not checked, since there is no record of it to check against.

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

/** Why a finding's verification does not count, or undefined when it does: the producer's shape, and keryx's seal over it. */
export function verificationProblem(manifest: Pick<ManagedReviewManifest, "seals">, finding: Record<string, unknown>): string | undefined {
  const verification = record(finding.verification);
  if (verification === undefined) return "no verification";
  if (!filled(verification.verdict) || !filled(verification.method) || !filled(verification.evidence)) return "a verification without verdict, method and evidence";
  const key = findingKey(finding);
  if (manifest.seals?.verifications?.[key] !== sealVerification(key, finding.verification)) return "a verification keryx did not record (no matching seal: it was not applied by `keryx review ingest --verifications`)";
  return undefined;
}

/**
 * Why the manifest's target or head override cannot be trusted, or undefined. Read by the close gates of both
 * `review complete` and `review publish`. A package with no seals at all predates them, and its target is not checked.
 */
export function sealProblems(manifest: Pick<ManagedReviewManifest, "seals" | "target" | "head_override">): string[] {
  const problems: string[] = [];
  if (manifest.head_override !== undefined && manifest.seals?.headOverride !== sealHeadOverride(manifest.head_override)) {
    problems.push(
      "manifest.json head_override does not match a seal keryx wrote: a head is relabelled only by `keryx review complete <review> --head <sha> --head-reason \"<operator quote>\"` (a terminal, or --answered-by), never by editing manifest.json",
    );
  }
  if (manifest.seals !== undefined && isPrBound(manifest.target) && manifest.seals.target !== sealTarget(manifest.target)) {
    problems.push(
      `manifest.json target (head ${manifest.target.head ?? "not recorded"}) does not match the seal keryx wrote when it last recorded the target: the reviewed head changes only through \`keryx review complete <review> --head <sha> --head-reason "<operator quote>"\`, never by editing manifest.json`,
    );
  }
  return problems;
}
