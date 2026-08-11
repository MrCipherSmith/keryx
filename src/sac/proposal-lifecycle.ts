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
type TargetOwner = "wiki" | "memory" | "skill";
export type TargetWriteResult = { ok: true; owner: TargetOwner; receiptRef: string; targetRef: string; completedAt: string; correlationId: string } | { ok: false; code: string };
export type GuardedTargetWriter = Readonly<{ owner: TargetOwner; write: (input: { proposal: Proposal; reviewer: TrustedActorContext; correlationId: string; approvalRef: string; policyRevision: string }) => Promise<TargetWriteResult> }>;
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
    targetWriters: Partial<Record<TargetOwner, GuardedTargetWriter>>;
    now?: () => Date;
    /** Test seam that simulates an evidence/ACL change immediately before write. */
    beforeTargetWrite?: () => Promise<void> | void;
  }) { this.root = path.resolve(options.workspaceRoot); this.now = options.now ?? (() => new Date()); }

  async create(input: { request: unknown; requestCorrelationId: string; workspaceId: string; id: string; proposalRevision: string; kind: ProposalKind; summary: string; evidence: Evidence[] }): Promise<Proposal> {
    const actor = await this.actor(input.request, input.requestCorrelationId);
    const policyRevision = await this.strict();
    this.assertMinimizedSummary(input.summary);
    const createdAt = this.timestamp();
    const proposal: Proposal = { schemaVersion: "1.0", recordType: "proposal-created", id: input.id, proposalRevision: input.proposalRevision, correlationId: input.requestCorrelationId, workspaceId: "", kind: input.kind, status: "proposed", summary: input.summary, evidence: input.evidence, author: actor.subject, security: { gate: "pass", redacted: true, policyRef: this.options.policyRef, policyRevision }, createdAt };
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
    const actor = await this.actor(input.request, input.requestCorrelationId); const policyRevision = await this.strict();
    return this.options.workspaces.withAuthorizedActor({ actorContext: actor, workspaceId: input.workspaceId, action: "review", execute: async (manifest) => {
      const proposal = await this.loadProposal(input.workspaceId, input.proposalId);
      const ledger = this.ledgerPath(input.workspaceId);
      await mkdir(path.dirname(ledger), { recursive: true, mode: 0o700 });
      return withFileLock(`${ledger}.lock`, async () => {
        const events = (await this.events(ledger)).filter((event) => event.proposalId === proposal.id);
        const replay = events.find((event) => event.idempotencyKey === input.idempotencyKey);
        if (replay) return { event: replay };
        if (events.length > 0) throw new ProposalLifecycleError("conflict", "proposal already has a terminal transition");
        const approval = input.decision === "accepted" ? await this.writeApproval(proposal, actor, input, policyRevision) : undefined;
        const targetAttempt = input.decision === "accepted" ? await this.targetWriteOrStale(proposal, actor, input, approval!.approvalRef, policyRevision) : undefined;
        const targetWrite = targetAttempt?.result;
        const outcome: Terminal = input.decision === "accepted" ? (targetWrite?.ok ? "accepted" : "stale") : input.decision;
        const decision = outcome === "stale" ? undefined : await this.reviewDecision(proposal, actor, input, outcome, targetWrite, policyRevision);
        if (decision) await writeFileAtomic(this.decisionPath(input.workspaceId, proposal.id), `${JSON.stringify(decision)}\n`);
        const event = await this.transition({ proposal, actor, input, events, outcome, targetWrite, freshnessVerifiedAt: targetAttempt?.freshnessVerifiedAt, reviewerAuthority: manifest.members.find((member) => member.subject === actor.subject)?.role === "owner" ? "owner" : "editor" });
        await this.validateTransition(event);
        await appendFile(ledger, `${JSON.stringify(event)}\n`, { mode: 0o600 });
        return { event };
      });
    } });
  }

  private async targetWriteOrStale(proposal: Proposal, actor: TrustedActorContext, input: { requestCorrelationId: string }, approvalRef: string, policyRevision: string): Promise<TargetWriteAttempt> {
    await this.options.beforeTargetWrite?.();
    // Evidence containment/existence and strict policy are rechecked immediately
    // before the owner write; a stale/removed reference can never be accepted.
    try { await this.strict(policyRevision); await this.options.workspaces.reauthorizeAtUse({ actorContext: actor, workspaceId: proposal.workspaceId, action: "review" }); await this.validateEvidence(proposal.evidence, true); }
    catch { return { result: { ok: false, code: "stale_evidence" } }; }
    const freshnessVerifiedAt = this.timestamp();
    const owner = ownerFor(proposal.kind); const writer = this.options.targetWriters[owner];
    if (!writer || writer.owner !== owner) return { result: { ok: false, code: "owner_writer_required" } };
    const result = await writer.write({ proposal, reviewer: actor, correlationId: input.requestCorrelationId, approvalRef, policyRevision });
    if (result.ok && (result.correlationId !== input.requestCorrelationId || result.owner !== owner || !result.targetRef.startsWith(`./${owner}`))) return { freshnessVerifiedAt, result: { ok: false, code: "invalid_owner_receipt" } };
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

  /** Immutable authorization decision, persisted before the owning writer. */
  private async writeApproval(proposal: Proposal, actor: TrustedActorContext, input: { requestCorrelationId: string; idempotencyKey: string }, policyRevision: string): Promise<{ approvalRef: string }> {
    const approvalRef = `./proposals/${proposal.id}.approval.json`;
    const approval = { proposalId: proposal.id, proposalRevision: proposal.proposalRevision, workspaceId: proposal.workspaceId, correlationId: input.requestCorrelationId, idempotencyKey: input.idempotencyKey, reviewer: actor.subject, policyRef: this.options.policyRef, policyRevision, decidedAt: this.timestamp(), decision: "approved-for-guarded-write" };
    await writeFileAtomic(this.approvalPath(proposal.workspaceId, proposal.id), `${JSON.stringify(approval)}\n`);
    return { approvalRef };
  }

  private async actor(request: unknown, correlationId: string): Promise<TrustedActorContext> { const actor = await this.options.authorizationServer.actorContextFor(request, correlationId); if (!actor) throw new ProposalLifecycleError("access_denied", "trusted ActorContext is required"); return actor; }
  private async strict(expected?: string): Promise<string> { const gate = await evaluateStrictSacGuard({ guard: this.options.guard, operation: "write" }); const revision = this.options.guard.mode === "strict" ? this.options.guard.policyRevision : undefined; if (!gate.allowed || !revision || revision !== this.options.policyRevision || (expected && revision !== expected)) throw new ProposalLifecycleError("guard_denied", "strict SAC guard/policy revision denied lifecycle write"); return revision; }
  private async validateEvidence(evidence: Evidence[], requireRevision = false): Promise<void> { for (const item of evidence) { const target = await resolveWorkspaceReference({ workspaceRoot: this.root, kind: item.kind as "evidence", uri: item.uri }); if (requireRevision && hash(await readFile(target, "utf8")) !== item.revision) throw new ProposalLifecycleError("stale", "evidence revision changed"); } }
  private assertMinimizedSummary(summary: string): void { if (!summary.trim() || /(?:prompt|transcript|hidden reasoning|chain.of.thought|secret|password|api[_ -]?key|\bssn\b|\b\d{3}-\d{2}-\d{4}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(summary)) throw new ProposalLifecycleError("invalid_proposal", "summary contains prohibited raw or personal content"); }
  private async validateProposal(proposal: Proposal): Promise<void> { const validation = await validateSacContract({ schema: "workspace-proposal", document: proposal }); if (!validation.valid) throw new ProposalLifecycleError("invalid_proposal", validation.errors.map((error) => error.code).join(",")); }
  private async validateTransition(event: Transition): Promise<void> { const validation = await validateSacContract({ schema: "workspace-proposal", document: event }); if (!validation.valid) throw new ProposalLifecycleError("invalid_proposal", validation.errors.map((error) => error.code).join(",")); }
  private async reviewDecision(proposal: Proposal, actor: TrustedActorContext, input: { requestCorrelationId: string; idempotencyKey: string; reason?: string }, decision: "accepted" | "rejected" | "dismissed", targetWrite: TargetWriteResult | undefined, policyRevision: string): Promise<Record<string, unknown>> { const base: Record<string, unknown> = { schemaVersion: "1.0", id: `review-${randomUUID().replace(/-/g, "").slice(0, 16)}`, proposalId: proposal.id, proposalRevision: proposal.proposalRevision, correlationId: input.requestCorrelationId, workspaceId: proposal.workspaceId, decision, reviewer: { subject: actor.subject, authority: "editor", trustedPrincipalRef: "./principals/local" }, decidedAt: this.timestamp(), idempotencyKey: input.idempotencyKey }; if (decision === "accepted" && targetWrite?.ok) Object.assign(base, { security: { gate: "pass", policyRef: this.options.policyRef, policyRevision }, freshness: { state: "fresh", verifiedAt: this.timestamp(), evidenceRevision: proposal.evidence[0]!.revision }, targetWrite: { receiptRef: targetWrite.receiptRef, targetRef: targetWrite.targetRef, completedAt: targetWrite.completedAt } }); else Object.assign(base, { reason: input.reason ?? "review decision" }); const validation = await validateSacContract({ schema: "review-decision", document: base }); if (!validation.valid) throw new ProposalLifecycleError("invalid_proposal", validation.errors.map((error) => error.code).join(",")); return base; }
  private async loadProposal(workspaceId: string, proposalId: string): Promise<Proposal> { try { const item = JSON.parse(await readFile(this.proposalPath(workspaceId, proposalId), "utf8")) as Proposal; await this.validateProposal(item); return item; } catch (error) { if (isNotFound(error)) throw new ProposalLifecycleError("not_found", "proposal not found"); throw error; } }
  private async events(ledger: string): Promise<Transition[]> { try { return (await readFile(ledger, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Transition); } catch (error) { if (isNotFound(error)) return []; throw error; } }
  private proposalPath(workspaceId: string, proposalId: string): string { return path.join(this.root, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.json`); }
  private decisionPath(workspaceId: string, proposalId: string): string { return path.join(this.root, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.decision.json`); }
  private approvalPath(workspaceId: string, proposalId: string): string { return path.join(this.root, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.approval.json`); }
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
  return new ProposalLifecycleService({ workspaceRoot: cwd, workspaces, authorizationServer, guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" }, policyRef: "./security/policy/local", policyRevision: "local-offline-v1", targetWriters: {} });
}

function ownerFor(kind: ProposalKind): TargetOwner { return kind === "wiki-update" ? "wiki" : kind === "memory-entry" ? "memory" : "skill"; }

export function normalizeProposalLifecycleResult<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
