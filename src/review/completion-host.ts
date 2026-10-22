import { createHash } from "node:crypto";
import { hiddenInCard } from "../lib/card-safe";
import { parseEvidenceLevel } from "./evidence-level";
import { isHostQuestion, type HostQuestion } from "./types";

export type ReviewCompletionContext = {
  reviewId: string; head: string; report: string; manifest: unknown;
  research: string; findings: string; decisions: string;
  dispositions: readonly unknown[]; waiveReadiness: readonly unknown[];
  waiveCoverage?: string | undefined;
  coverage?: Readonly<Record<string, string | null>>;
};

/** A question shows the decision and binds the remaining package content by digest. */
export function reviewCompletionQuestion(context: ReviewCompletionContext): string {
  const snapshot = createHash("sha256").update(JSON.stringify(context)).digest("hex");
  const manifest = context.manifest as { readiness_waivers?: unknown };
  const research = JSON.parse(context.research || "{}") as { dispatch?: { coverageWaiver?: unknown }; coverageWaiver?: unknown };
  return `Complete review ${context.reviewId} at head ${context.head}? ` + JSON.stringify({
    evidence: parseEvidenceLevel(context.report), dispositions: context.dispositions,
    readinessWaivers: manifest.readiness_waivers ?? [],
    coverageWaiver: research.dispatch?.coverageWaiver ?? research.coverageWaiver ?? null,
    requestedReadinessWaivers: context.waiveReadiness,
    requestedCoverageWaiver: context.waiveCoverage ?? null, snapshot,
  });
}

/** A host answer is reported provenance, not a cryptographic attestation by the host. */
export function validateCompletionHost(context: ReviewCompletionContext, host: HostQuestion, previous: readonly HostQuestion[]): { ok: true } | { ok: false; reason: string } {
  if (!isHostQuestion(host) || [host.ref, host.questionText, host.answerText].some(hiddenInCard)) return { ok: false, reason: "Invalid host question or hidden/control characters." };
  if (!/^(yes|y|да)$/iu.test(host.answerText.trim())) return { ok: false, reason: "Completion requires the operator's plain yes." };
  if (previous.some((item) => item.source === host.source && item.ref === host.ref)) return { ok: false, reason: "This host question was already recorded; ask again." };
  if (host.questionText.trim() !== reviewCompletionQuestion(context)) return { ok: false, reason: `Stale or incomplete question; ask the current question verbatim:\n${reviewCompletionQuestion(context)}` };
  return { ok: true };
}
