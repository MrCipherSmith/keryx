import { createHash, randomUUID } from "node:crypto";
import type { TrustedActorContext } from "./index";

export type WrapUpEvidence = Readonly<{ kind: string; uri: string; revision: string; observedAt: string }>;
export type WrapUpSource = "session" | "flow" | "external-slate";
export type TrustedWrapUpResolution = Readonly<{ workspaceId: string; sourceRevision: string; summary: string; evidence: readonly WrapUpEvidence[]; expiresAt: string }>;
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

// Module-scope (not per-`TrustedWrapUpAuthority`-instance) by design: every
// authority instance shares these two sets, which is load-bearing for
// `machine-wrap-up.ts`'s `proposeOneGroup` — it mints its OWN local
// authority per group rather than reusing `createHarnessProposalLifecycleService`'s
// internal one (to avoid a circular import), and that only verifies/consumes
// correctly against the SERVICE's own composed authority because both
// authorities check the same, shared, module-scope `issued`/`consumed` sets.
const issued = new WeakSet<object>();
const consumed = new WeakSet<object>();

/**
 * Server-owned capability issuer for an explicit completed session or a
 * read-only Flow wrap-up snapshot. The capability is intentionally opaque:
 * SAC accepts only objects issued by this closure, never payload fields that
 * a CLI/MCP caller can manufacture.
 */
export function createTrustedWrapUpAuthority(input: { now?: () => Date; resolveExplicitWrapUp: (request: { actor: TrustedActorContext; source: WrapUpSource; sourceRef: string }) => Promise<TrustedWrapUpResolution> }) {
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    async issue(request: { actor: TrustedActorContext; source: WrapUpSource; sourceRef: string }): Promise<TrustedWrapUpProvenance> {
      const resolved = await input.resolveExplicitWrapUp(request);
      if (!resolved.summary.trim() || resolved.evidence.length === 0 || new Date(resolved.expiresAt).getTime() <= now().getTime()) throw new Error("invalid trusted wrap-up issuance");
      const provenance = Object.freeze({ id: `wrapup-${randomUUID().replace(/-/g, "").slice(0, 16)}`, source: request.source, sourceRef: request.sourceRef, sourceRevision: resolved.sourceRevision, workspaceId: resolved.workspaceId, actorSubject: request.actor.subject, summaryDigest: digest(resolved.summary), evidence: resolved.evidence.map((item) => ({ ...item })), issuedAt: now().toISOString(), expiresAt: resolved.expiresAt });
      issued.add(provenance);
      return provenance;
    },
    verify(provenance: TrustedWrapUpProvenance, request: { actor: TrustedActorContext; workspaceId: string }): "ok" | "untrusted" | "replayed" | "expired" | "mismatch" {
      if (!issued.has(provenance)) return "untrusted";
      if (consumed.has(provenance)) return "replayed";
      if (new Date(provenance.expiresAt).getTime() <= now().getTime()) return "expired";
      if (provenance.workspaceId !== request.workspaceId || provenance.actorSubject !== request.actor.subject) return "mismatch";
      return "ok";
    },
    consume(provenance: TrustedWrapUpProvenance, request: { actor: TrustedActorContext; workspaceId: string }): "ok" | "untrusted" | "replayed" | "expired" | "mismatch" {
      const result = this.verify(provenance, request);
      if (result === "ok") consumed.add(provenance);
      return result;
    },
  });
}

export type TrustedWrapUpAuthority = ReturnType<typeof createTrustedWrapUpAuthority>;

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
