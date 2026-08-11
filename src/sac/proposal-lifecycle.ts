import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "../lib/fs";
import { evaluateStrictSacGuard, resolveWorkspaceReference, validateSacContract, type SacAuthorizationServer, type StrictSacGuard, type TrustedActorContext } from "./index";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "./workspace-service";

type Evidence = { kind: string; uri: string; revision: string; observedAt: string };
type ProposalKind = "decision" | "wiki-update" | "memory-entry" | "follow-up" | "contract-change" | "risk";
type Terminal = "accepted" | "rejected" | "dismissed" | "stale";
type Proposal = { schemaVersion: "1.0"; recordType: "proposal-created"; id: string; proposalRevision: string; correlationId: string; workspaceId: string; kind: ProposalKind; status: "proposed"; summary: string; evidence: Evidence[]; author: string; security: { gate: "pass" | "needs-approval"; redacted: true; policyRef: string; policyRevision: string }; createdAt: string };
type Transition = Record<string, unknown> & { eventId: string; proposalId: string; toStatus: Terminal; idempotencyKey: string };
export type TargetWriteResult = { ok: true; receiptRef: string; targetRef: string; completedAt: string; correlationId: string } | { ok: false; code: string };
export type GuardedTargetWriter = (input: { proposal: Proposal; reviewer: TrustedActorContext; correlationId: string }) => Promise<TargetWriteResult>;
type TargetWriteAttempt = Readonly<{ result: TargetWriteResult; freshnessVerifiedAt?: string }>;

export class ProposalLifecycleError extends Error {
  constructor(readonly code: "access_denied" | "guard_denied" | "invalid_proposal" | "not_found" | "conflict" | "stale" | "target_write_failed", message: string) { super(message); }
}

/**
 * SAC owns immutable candidates and audit metadata only. Knowledge content is
 * never copied here: accepted writes are delegated to an owning guarded writer
 * which must return a correlation-bound receipt before acceptance is recorded.
 */
export class ProposalLifecycleService {
  private readonly root: string;
  private readonly now: () => Date;
  constructor(private readonly options: {
    workspaceRoot: string;
    workspaces: WorkspaceService;
    authorizationServer: SacAuthorizationServer;
    guard: StrictSacGuard;
    policyRef: string;
    policyRevision: string;
    targetWriter: GuardedTargetWriter;
    now?: () => Date;
    /** Test seam that simulates an evidence/ACL change immediately before write. */
    beforeTargetWrite?: () => Promise<void> | void;
  }) { this.root = path.resolve(options.workspaceRoot); this.now = options.now ?? (() => new Date()); }

  async create(input: { request: unknown; requestCorrelationId: string; workspaceId: string; id: string; proposalRevision: string; kind: ProposalKind; summary: string; evidence: Evidence[] }): Promise<Proposal> {
    const actor = await this.actor(input.request, input.requestCorrelationId);
    await this.strict();
    const createdAt = this.timestamp();
    const proposal: Proposal = { schemaVersion: "1.0", recordType: "proposal-created", id: input.id, proposalRevision: input.proposalRevision, correlationId: input.requestCorrelationId, workspaceId: "", kind: input.kind, status: "proposed", summary: input.summary, evidence: input.evidence, author: actor.subject, security: { gate: "pass", redacted: true, policyRef: this.options.policyRef, policyRevision: this.options.policyRevision }, createdAt };
    // The workspace is derived from the caller's explicit workspace-bound evidence
    // request in v1. The public operation accepts it through a separate field to
    // keep the stored record exactly schema-shaped.
    const workspaceId = input.workspaceId;
    proposal.workspaceId = workspaceId;
    await this.validateProposal(proposal);
    await this.validateEvidence(input.evidence);
    return this.options.workspaces.withAuthorizedActor({ actorContext: actor, workspaceId, action: "write", execute: async () => {
      const file = this.proposalPath(workspaceId, proposal.id);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      return withFileLock(`${file}.lock`, async () => {
        try { await readFile(file, "utf8"); throw new ProposalLifecycleError("conflict", "proposal already exists"); }
        catch (error) { if (error instanceof ProposalLifecycleError) throw error; if (!isNotFound(error)) throw error; }
        await writeFileAtomic(file, `${JSON.stringify(proposal, null, 2)}\n`);
        return proposal;
      });
    } });
  }

  async review(input: { request: unknown; requestCorrelationId: string; workspaceId: string; proposalId: string; decision: "accepted" | "rejected" | "dismissed"; idempotencyKey: string; reason?: string }): Promise<{ event: Transition }> {
    const actor = await this.actor(input.request, input.requestCorrelationId); await this.strict();
    return this.options.workspaces.withAuthorizedActor({ actorContext: actor, workspaceId: input.workspaceId, action: "review", execute: async (manifest) => {
      const proposal = await this.loadProposal(input.workspaceId, input.proposalId);
      const ledger = this.ledgerPath(input.workspaceId);
      await mkdir(path.dirname(ledger), { recursive: true, mode: 0o700 });
      return withFileLock(`${ledger}.lock`, async () => {
        const events = (await this.events(ledger)).filter((event) => event.proposalId === proposal.id);
        const replay = events.find((event) => event.idempotencyKey === input.idempotencyKey);
        if (replay) return { event: replay };
        if (events.length > 0) throw new ProposalLifecycleError("conflict", "proposal already has a terminal transition");
        const targetAttempt = input.decision === "accepted" ? await this.targetWriteOrStale(proposal, actor, input) : undefined;
        const targetWrite = targetAttempt?.result;
        const outcome: Terminal = input.decision === "accepted" ? (targetWrite?.ok ? "accepted" : "stale") : input.decision;
        const decision = outcome === "stale" ? undefined : await this.reviewDecision(proposal, actor, input, outcome, targetWrite);
        if (decision) await writeFileAtomic(this.decisionPath(input.workspaceId, proposal.id), `${JSON.stringify(decision)}\n`);
        const event = await this.transition({ proposal, actor, input, events, outcome, targetWrite, freshnessVerifiedAt: targetAttempt?.freshnessVerifiedAt, reviewerAuthority: manifest.members.find((member) => member.subject === actor.subject)?.role === "owner" ? "owner" : "editor" });
        await this.validateTransition(event);
        await appendFile(ledger, `${JSON.stringify(event)}\n`, { mode: 0o600 });
        return { event };
      });
    } });
  }

  private async targetWriteOrStale(proposal: Proposal, actor: TrustedActorContext, input: { requestCorrelationId: string }): Promise<TargetWriteAttempt> {
    await this.options.beforeTargetWrite?.();
    // Evidence containment/existence and strict policy are rechecked immediately
    // before the owner write; a stale/removed reference can never be accepted.
    try { await this.strict(); await this.validateEvidence(proposal.evidence); }
    catch { return { result: { ok: false, code: "stale_evidence" } }; }
    const freshnessVerifiedAt = this.timestamp();
    const result = await this.options.targetWriter({ proposal, reviewer: actor, correlationId: input.requestCorrelationId });
    return { freshnessVerifiedAt, result: result.ok && result.correlationId !== input.requestCorrelationId ? { ok: false, code: "correlation_mismatch" } : result };
  }

  private async transition(input: { proposal: Proposal; actor: TrustedActorContext; input: { requestCorrelationId: string; idempotencyKey: string; reason?: string }; events: Transition[]; outcome: Terminal; targetWrite?: TargetWriteResult; freshnessVerifiedAt?: string; reviewerAuthority: "owner" | "editor" }): Promise<Transition> {
    const previous = input.events.at(-1); const base: Record<string, unknown> = { schemaVersion: "1.0", recordType: "proposal-transition", eventId: `event-${randomUUID().replace(/-/g, "").slice(0, 16)}`, proposalId: input.proposal.id, proposalRevision: input.proposal.proposalRevision, correlationId: input.input.requestCorrelationId, workspaceId: input.proposal.workspaceId, sequence: input.events.length + 1, priorEventHash: previous ? eventHash(previous) : hash("GENESIS"), fromStatus: "proposed", toStatus: input.outcome, occurredAt: this.timestamp(), idempotencyKey: input.input.idempotencyKey };
    if (input.outcome === "accepted") {
      const write = input.targetWrite;
      if (!write?.ok) return this.transition({ ...input, outcome: "stale" });
      Object.assign(base, { acceptance: { reviewDecisionRef: `./proposals/${input.proposal.id}.decision.json`, reviewer: { subject: input.actor.subject, authority: input.reviewerAuthority, trustedPrincipalRef: "./principals/local" }, security: { gate: "pass", policyRef: this.options.policyRef, policyRevision: this.options.policyRevision }, freshness: { state: "fresh", verifiedAt: input.freshnessVerifiedAt ?? this.timestamp(), maxEvidenceAgeSeconds: 3600 }, targetWrite: { receiptRef: write.receiptRef, targetRef: write.targetRef, completedAt: write.completedAt }, evidence: input.proposal.evidence, idempotencyKey: input.input.idempotencyKey } });
    } else Object.assign(base, { reason: input.input.reason ?? (input.outcome === "stale" ? "evidence, policy, or guarded target write did not remain fresh" : "review decision" ) });
    return base as Transition;
  }

  private async actor(request: unknown, correlationId: string): Promise<TrustedActorContext> { const actor = await this.options.authorizationServer.actorContextFor(request, correlationId); if (!actor) throw new ProposalLifecycleError("access_denied", "trusted ActorContext is required"); return actor; }
  private async strict(): Promise<void> { const gate = await evaluateStrictSacGuard({ guard: this.options.guard, operation: "write" }); if (!gate.allowed) throw new ProposalLifecycleError("guard_denied", "strict SAC guard denied lifecycle write"); }
  private async validateEvidence(evidence: Evidence[]): Promise<void> { for (const item of evidence) await resolveWorkspaceReference({ workspaceRoot: this.root, kind: item.kind as "evidence", uri: item.uri }); }
  private async validateProposal(proposal: Proposal): Promise<void> { const validation = await validateSacContract({ schema: "workspace-proposal", document: proposal }); if (!validation.valid) throw new ProposalLifecycleError("invalid_proposal", validation.errors.map((error) => error.code).join(",")); }
  private async validateTransition(event: Transition): Promise<void> { const validation = await validateSacContract({ schema: "workspace-proposal", document: event }); if (!validation.valid) throw new ProposalLifecycleError("invalid_proposal", validation.errors.map((error) => error.code).join(",")); }
  private async reviewDecision(proposal: Proposal, actor: TrustedActorContext, input: { requestCorrelationId: string; idempotencyKey: string; reason?: string }, decision: "accepted" | "rejected" | "dismissed", targetWrite?: TargetWriteResult): Promise<Record<string, unknown>> { const base: Record<string, unknown> = { schemaVersion: "1.0", id: `review-${randomUUID().replace(/-/g, "").slice(0, 16)}`, proposalId: proposal.id, proposalRevision: proposal.proposalRevision, correlationId: input.requestCorrelationId, workspaceId: proposal.workspaceId, decision, reviewer: { subject: actor.subject, authority: "editor", trustedPrincipalRef: "./principals/local" }, decidedAt: this.timestamp(), idempotencyKey: input.idempotencyKey }; if (decision === "accepted" && targetWrite?.ok) Object.assign(base, { security: { gate: "pass", policyRef: this.options.policyRef, policyRevision: this.options.policyRevision }, freshness: { state: "fresh", verifiedAt: this.timestamp(), evidenceRevision: proposal.evidence[0]!.revision }, targetWrite: { receiptRef: targetWrite.receiptRef, targetRef: targetWrite.targetRef, completedAt: targetWrite.completedAt } }); else Object.assign(base, { reason: input.reason ?? "review decision" }); const validation = await validateSacContract({ schema: "review-decision", document: base }); if (!validation.valid) throw new ProposalLifecycleError("invalid_proposal", validation.errors.map((error) => error.code).join(",")); return base; }
  private async loadProposal(workspaceId: string, proposalId: string): Promise<Proposal> { try { const item = JSON.parse(await readFile(this.proposalPath(workspaceId, proposalId), "utf8")) as Proposal; await this.validateProposal(item); return item; } catch (error) { if (isNotFound(error)) throw new ProposalLifecycleError("not_found", "proposal not found"); throw error; } }
  private async events(ledger: string): Promise<Transition[]> { try { return (await readFile(ledger, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Transition); } catch (error) { if (isNotFound(error)) return []; throw error; } }
  private proposalPath(workspaceId: string, proposalId: string): string { return path.join(this.root, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.json`); }
  private decisionPath(workspaceId: string, proposalId: string): string { return path.join(this.root, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.decision.json`); }
  private ledgerPath(workspaceId: string): string { return path.join(this.root, ".metaproject", "workspaces", workspaceId, "activity.jsonl"); }
  private timestamp(): string { return this.now().toISOString(); }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function eventHash(value: Transition): string { return hash(JSON.stringify(value)); }
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }

/** Local CLI/stdin MCP composition has no owning knowledge writer, so it can
 * record proposals and non-accepting decisions but can never self-accept. */
export function createLocalProposalLifecycleService(cwd: string): ProposalLifecycleService {
  const authorizationServer = localWorkspaceAuthorizationServer();
  const workspaces = new WorkspaceService({ workspaceRoot: cwd, authorizationServer, strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } });
  return new ProposalLifecycleService({ workspaceRoot: cwd, workspaces, authorizationServer, guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" }, policyRef: "./security/policy/local", policyRevision: "local-offline-v1", targetWriter: async () => ({ ok: false, code: "owner_writer_required" }) });
}

export function normalizeProposalLifecycleResult<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
