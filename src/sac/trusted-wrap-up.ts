import { createHash, randomUUID } from "node:crypto";
import type { TrustedActorContext } from "./index";

export type WrapUpEvidence = Readonly<{ kind: string; uri: string; revision: string; observedAt: string }>;
export type WrapUpSource = "session" | "flow";
export type TrustedWrapUpProvenance = Readonly<{
  id: string;
  source: WrapUpSource;
  sourceRef: string;
  sourceRevision: string;
  workspaceId: string;
  actorSubject: string;
  summaryDigest: string;
  evidence: readonly WrapUpEvidence[];
  issuedAt: string;
  expiresAt: string;
}>;

const issued = new WeakSet<object>();
const consumed = new WeakSet<object>();

/**
 * Server-owned capability issuer for an explicit completed session or a
 * read-only Flow wrap-up snapshot. The capability is intentionally opaque:
 * SAC accepts only objects issued by this closure, never payload fields that
 * a CLI/MCP caller can manufacture.
 */
export function createTrustedWrapUpAuthority(input: { now?: () => Date }) {
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    issue(request: { actor: TrustedActorContext; source: WrapUpSource; sourceRef: string; sourceRevision: string; workspaceId: string; summary: string; evidence: readonly WrapUpEvidence[]; expiresAt: string }): TrustedWrapUpProvenance {
      if (!request.summary.trim() || request.evidence.length === 0 || new Date(request.expiresAt).getTime() <= now().getTime()) throw new Error("invalid trusted wrap-up issuance");
      const provenance = Object.freeze({ id: `wrapup-${randomUUID().replace(/-/g, "").slice(0, 16)}`, source: request.source, sourceRef: request.sourceRef, sourceRevision: request.sourceRevision, workspaceId: request.workspaceId, actorSubject: request.actor.subject, summaryDigest: digest(request.summary), evidence: request.evidence.map((item) => ({ ...item })), issuedAt: now().toISOString(), expiresAt: request.expiresAt });
      issued.add(provenance);
      return provenance;
    },
    verify(provenance: TrustedWrapUpProvenance, request: { actor: TrustedActorContext; workspaceId: string; summary: string; evidence: readonly WrapUpEvidence[] }): "ok" | "untrusted" | "replayed" | "expired" | "mismatch" {
      if (!issued.has(provenance)) return "untrusted";
      if (consumed.has(provenance)) return "replayed";
      if (new Date(provenance.expiresAt).getTime() <= now().getTime()) return "expired";
      if (provenance.workspaceId !== request.workspaceId || provenance.actorSubject !== request.actor.subject || provenance.summaryDigest !== digest(request.summary) || !sameEvidence(provenance.evidence, request.evidence)) return "mismatch";
      return "ok";
    },
    consume(provenance: TrustedWrapUpProvenance, request: { actor: TrustedActorContext; workspaceId: string; summary: string; evidence: readonly WrapUpEvidence[] }): "ok" | "untrusted" | "replayed" | "expired" | "mismatch" {
      const result = this.verify(provenance, request);
      if (result === "ok") consumed.add(provenance);
      return result;
    },
  });
}

export type TrustedWrapUpAuthority = ReturnType<typeof createTrustedWrapUpAuthority>;

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sameEvidence(left: readonly WrapUpEvidence[], right: readonly WrapUpEvidence[]): boolean {
  return left.length === right.length && left.every((item, index) => item.kind === right[index]?.kind && item.uri === right[index]?.uri && item.revision === right[index]?.revision && item.observedAt === right[index]?.observedAt);
}
