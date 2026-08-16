import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, withFileLock, writeFileAtomic } from "../lib/fs";
import { evaluateStrictSacGuard, resolveWorkspaceReference, validateSacContract, type SacAuthorizationServer, type StrictSacGuard, type TrustedActorContext } from "./index";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "./workspace-service";
import { createTrustedWrapUpAuthority, type TrustedWrapUpAuthority, type TrustedWrapUpProvenance } from "./trusted-wrap-up";
import { createGuardedOwnerWriter, receiptMatchesIntent, type GuardedOwnerWriter, type KnowledgeOwner, type OwnerReceipt, type OwnerWriteIntent, type OwnerWriteResult, type ReviewerAuthority } from "./guarded-owner-writer";
import { resolveSessionWrapUp } from "./session-wrap-up";
import { createRealMemoryOwnerWriter } from "./memory-owner-writer";
import { createRealWikiOwnerWriter } from "./wiki-owner-writer";
import { createRealSkillOwnerWriter } from "./skill-owner-writer";
import { readWorkspaceFileNoFollow } from "./secure-resource-read";
import { guardOutput } from "../security/guard";

type Evidence = { kind: string; uri: string; revision: string; observedAt: string };
type ProposalKind = "decision" | "wiki-update" | "memory-entry" | "follow-up" | "contract-change" | "risk";
type Terminal = "accepted" | "rejected" | "dismissed" | "stale";
type Proposal = { schemaVersion: "1.0"; recordType: "proposal-created"; id: string; proposalRevision: string; correlationId: string; workspaceId: string; kind: ProposalKind; status: "proposed"; summary: string; evidence: Evidence[]; wrapUp: { id: string; source: "session" | "flow"; sourceRef: string; sourceRevision: string; issuedAt: string; expiresAt: string }; author: string; security: { gate: "pass" | "needs-approval"; redacted: true; policyRef: string; policyRevision: string }; createdAt: string };
type WriteIntent = Record<string, unknown> & { recordType: "proposal-write-intent"; intentId: string; proposalId: string; idempotencyKey: string };
type Transition = Record<string, unknown> & { recordType: "proposal-transition"; eventId: string; proposalId: string; toStatus: Terminal; idempotencyKey: string };
type LedgerRecord = WriteIntent | Transition;
type TargetOwner = KnowledgeOwner;
export type TargetWriteResult = OwnerWriteResult;
export type GuardedTargetWriter = GuardedOwnerWriter;
export type OwnerWriteAdapter = (input: OwnerWriteIntent & { owner: TargetOwner }) => Promise<Readonly<{ receiptRef: string; targetRef: string; completedAt: string }> | { ok: false; code: string }>;
type TargetWriteAttempt = Readonly<{ result: TargetWriteResult; freshnessVerifiedAt?: string }>;

export class ProposalLifecycleError extends Error {
  constructor(readonly code: "access_denied" | "guard_denied" | "non_interactive_accept_denied" | "invalid_proposal" | "trusted_wrap_up_required" | "not_found" | "conflict" | "stale" | "target_write_failed", message: string) { super(message); }
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
    wrapUpAuthority: TrustedWrapUpAuthority;
    now?: () => Date;
    /** Test seam that simulates an evidence/ACL change immediately before write. */
    beforeTargetWrite?: () => Promise<void> | void;
    /**
     * Test seam: fires once, inside the proposal's own file lock, immediately
     * before the security gate is (re)scanned and the record is persisted —
     * lets tests simulate an evidence swap landing in the TOCTOU window
     * between `create()`'s early phases (authorization, wrap-up consumption,
     * lock acquisition) and the actual write.
     */
    beforeCreateWrite?: () => Promise<void> | void;
    /**
     * Test seam: swaps the safe descriptor-chain evidence read
     * (`readWorkspaceFileNoFollow` by default). Overridden by tests to force
     * a specific error class out of the read step — e.g. a platform-
     * unavailable safe-read bridge — without needing a real non-POSIX host.
     */
    readEvidenceFile?: (workspaceRoot: string, absolutePath: string) => Buffer;
  }) { this.root = path.resolve(options.workspaceRoot); this.now = options.now ?? (() => new Date()); }

  async create(input: { request: unknown; requestCorrelationId: string; workspaceId: string; id: string; proposalRevision: string; kind: ProposalKind; wrapUp: TrustedWrapUpProvenance }): Promise<Proposal> {
    const actor = await this.actor(input.request, input.requestCorrelationId);
    const policyRevision = await this.strict();
    const wrapUp = this.options.wrapUpAuthority.verify(input.wrapUp, { actor, workspaceId: input.workspaceId });
    if (wrapUp !== "ok") throw new ProposalLifecycleError("trusted_wrap_up_required", `trusted wrap-up ${wrapUp}`);
    const createdAt = this.timestamp();
    // `security.gate` is deliberately NOT computed here. Scanning this early
    // would leave a wide TOCTOU window before the persisted write —
    // authorization, workspace lock acquisition, wrap-up consumption, the
    // proposal-already-exists check — during which evidence could be swapped
    // without ever being rescanned (finding 3). The real gate is computed at
    // write-time instead, immediately before `writeFileAtomic`, inside the
    // already-acquired file lock, below. "needs-approval" here is only a
    // fail-closed placeholder for the pre-lock schema validation a few lines
    // down; it is always overwritten before the record is ever persisted.
    const proposal: Proposal = { schemaVersion: "1.0", recordType: "proposal-created", id: input.id, proposalRevision: input.proposalRevision, correlationId: input.requestCorrelationId, workspaceId: "", kind: input.kind, status: "proposed", summary: "trusted wrap-up reference", evidence: [...input.wrapUp.evidence], wrapUp: { id: input.wrapUp.id, source: input.wrapUp.source, sourceRef: input.wrapUp.sourceRef, sourceRevision: input.wrapUp.sourceRevision, issuedAt: input.wrapUp.issuedAt, expiresAt: input.wrapUp.expiresAt }, author: actor.subject, security: { gate: "needs-approval", redacted: true, policyRef: this.options.policyRef, policyRevision }, createdAt };
    // The workspace is derived from the caller's explicit workspace-bound evidence
    // request in v1. The public operation accepts it through a separate field to
    // keep the stored record exactly schema-shaped.
    const workspaceId = input.workspaceId;
    proposal.workspaceId = workspaceId;
    await this.validateProposal(proposal);
    await this.validateEvidence(proposal.evidence);
    return this.options.workspaces.withAuthorizedActor({ actorContext: actor, workspaceId, action: "write", execute: async (manifest) => {
      // KNOWN RISK: kept as an inline check rather than centralized in
      // `withAuthorizedActor` — `review()` below uses the same `action:
      // "write"`/"review" plumbing and must NOT be gated on archived status
      // (frozen by spec: docs/requirements/sac-workspace-lifecycle/
      // specification.md WSL-1; already covered by tests). The identical
      // inline check lives in workspace-service.ts's `addResource`. Any new
      // write operation that should reject on an archived workspace must add
      // this check itself.
      if (manifest.status === "archived") throw new ProposalLifecycleError("guard_denied", "workspace is archived");
      const file = this.proposalPath(workspaceId, proposal.id);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      return withFileLock(`${file}.lock`, async () => {
        const consume = this.options.wrapUpAuthority.consume(input.wrapUp, { actor, workspaceId });
        if (consume !== "ok") throw new ProposalLifecycleError("trusted_wrap_up_required", `trusted wrap-up ${consume}`);
        try { await readFile(file, "utf8"); throw new ProposalLifecycleError("conflict", "proposal already exists"); }
        catch (error) { if (error instanceof ProposalLifecycleError) throw error; if (!isNotFound(error)) throw error; }
        await this.options.beforeCreateWrite?.();
        // Scanned here, not at the top of `create()`: this is the last point
        // before the bytes are persisted, inside the same file lock the write
        // itself uses, so nothing can swap the evidence out from under the
        // recorded gate between the scan and the write (finding 3).
        proposal.security.gate = await this.scanEvidenceSecurityGate(proposal.evidence);
        await writeFileAtomic(file, `${JSON.stringify(proposal, null, 2)}\n`);
        return proposal;
      });
    } });
  }

  async review(input: { request: unknown; requestCorrelationId: string; workspaceId: string; proposalId: string; decision: "accepted" | "rejected" | "dismissed"; idempotencyKey: string; reason?: string; interactive: boolean }): Promise<{ event: Transition }> {
    const actor = await this.actor(input.request, input.requestCorrelationId); const policyRevision = await this.strict();
    return this.options.workspaces.withAuthorizedActor({ actorContext: actor, workspaceId: input.workspaceId, action: "review", execute: async (manifest) => {
      const proposal = await this.loadProposal(input.workspaceId, input.proposalId);
      const ledger = this.ledgerPath(input.workspaceId);
      await mkdir(path.dirname(ledger), { recursive: true, mode: 0o700 });
      return withFileLock(`${ledger}.lock`, async () => {
        const records = (await this.records(ledger)).filter((record) => record.proposalId === proposal.id);
        const events = records.filter((record): record is Transition => record.recordType === "proposal-transition");
        const replay = events.find((event) => event.idempotencyKey === input.idempotencyKey);
        // Idempotency replay is checked BEFORE the SLATE-8 interactive gate
        // below. A replay is not a fresh authorization decision — it returns
        // an outcome this exact idempotency key already committed to the
        // ledger — so it must short-circuit regardless of the *current*
        // call's `interactive` value. Without this ordering, a legitimate
        // retry of an already-accepted transition that happens to arrive
        // with a different `interactive` value than the original request
        // (e.g. a crash-recovery replay issued from a different boundary)
        // would be wrongly denied instead of replayed.
        if (replay) return { event: replay };
        if (events.length > 0) throw new ProposalLifecycleError("conflict", "proposal already has a terminal transition");
        // SLATE-8 unattended checkpoint. Mirrors `checkApproval` rule (h)
        // (src/harness/mutation/approval.ts:148-149, `interactive === false ->
        // invalid`): a genuinely NEW `accept` decision (i.e. not a replay —
        // the replay short-circuit above already returned) is denied
        // whenever the caller-supplied `interactive` context field is
        // `false`. `propose`/`create()` and any decision other than
        // "accepted" (e.g. "rejected"/"dismissed") never reach this branch
        // (AC6). `interactive` is REQUIRED on `input` and consulted exactly
        // as the caller passed it — never derived from `actor`,
        // `clientClaims`, or any proposal-authored content — so a session
        // cannot flip its own `interactive` field at runtime (AC5); the real
        // CLI/MCP boundaries (`src/commands/workspace.ts`'s `review`
        // handler, `src/mcp/tools.ts`'s `sac.review` handler) are the only
        // real call sites and both pass `interactive: true`, matching
        // current human-at-the-terminal trust posture. This check runs
        // before any reviewer-role resolution below (`authorityFor`) and
        // before any write action, so the denial is unconditional on role or
        // `PolicyProfile` (AC4) — every `keryx serve` session resolves
        // `interactive: false` here via the same honest value
        // `runRemoteTurn` already hardcodes for every remote turn
        // (src/lib/serve-turn.ts:605, `deps.interactive = false`). It does
        // run after `withAuthorizedActor`'s own actor/workspace-access
        // authorization (which only decides whether this actor may call
        // `review` at all, never whether an accept is honored) — that
        // authorization outcome is orthogonal to, and never a substitute
        // for, this gate.
        if (input.decision === "accepted" && input.interactive === false) {
          throw new ProposalLifecycleError("non_interactive_accept_denied", "accept is denied for a non-interactive session (interactive: false) — SLATE-8 unattended checkpoint; propose remains available, retry review from a session where interactive is honestly true");
        }
        const reviewerAuthority = authorityFor(manifest, actor.subject);
        const approval = input.decision === "accepted" ? await this.writeApproval(proposal, actor, reviewerAuthority, input, policyRevision) : undefined;
        // The intent is durable before crossing into the owning subsystem. A
        // process crash after that boundary is recovered by reusing this exact
        // idempotency key; owners must return their original receipt, never a
        // second mutation.
        const intent = input.decision === "accepted" ? await this.ensureWriteIntent(proposal, actor, reviewerAuthority, input, approval!.approvalRef, policyRevision, ledger, records) : undefined;
        const targetAttempt = input.decision === "accepted" ? await this.targetWriteOrStale(proposal, actor, reviewerAuthority, input, approval!.approvalRef, intent!, policyRevision) : undefined;
        const targetWrite = targetAttempt?.result;
        const outcome: Terminal = input.decision === "accepted" ? (targetWrite?.ok ? "accepted" : "stale") : input.decision;
        const decision = outcome === "stale" ? undefined : await this.reviewDecision(proposal, actor, reviewerAuthority, input, outcome, targetWrite, policyRevision);
        if (decision) await this.writeImmutable(this.decisionPath(input.workspaceId, proposal.id, input.idempotencyKey), decision);
        const event = await this.transition({ proposal, actor, input, records: await this.records(ledger).then((all) => all.filter((record) => record.proposalId === proposal.id)), outcome, ...(targetWrite ? { targetWrite } : {}), ...(intent ? { writeIntentRef: intent.intentRef } : {}), ...(targetAttempt?.freshnessVerifiedAt ? { freshnessVerifiedAt: targetAttempt.freshnessVerifiedAt } : {}), reviewerAuthority });
        await this.validateTransition(event);
        await appendFile(ledger, `${JSON.stringify(event)}\n`, { mode: 0o600 });
        return { event };
      });
    } });
  }

  private async targetWriteOrStale(proposal: Proposal, actor: TrustedActorContext, reviewerAuthority: ReviewerAuthority, input: { requestCorrelationId: string; idempotencyKey: string }, approvalRef: string, writeIntent: { intentRef: string }, policyRevision: string): Promise<TargetWriteAttempt> {
    await this.options.beforeTargetWrite?.();
    // Evidence containment/existence and strict policy are rechecked immediately
    // before the owner write; a stale/removed reference can never be accepted.
    try { await this.strict(policyRevision); await this.validateEvidence(proposal.evidence, true, actor, proposal.workspaceId); }
    catch { return { result: { ok: false, code: "stale_evidence" } }; }
    const freshnessVerifiedAt = this.timestamp();
    const owner = ownerFor(proposal.kind); const writer = this.options.targetWriters[owner];
    if (!writer || writer.owner !== owner) return { result: { ok: false, code: "owner_writer_required" } };
    const intent: OwnerWriteIntent = { intentRef: writeIntent.intentRef, proposalId: proposal.id, proposalRevision: proposal.proposalRevision, workspaceId: proposal.workspaceId, correlationId: input.requestCorrelationId, idempotencyKey: input.idempotencyKey, reviewerSubject: actor.subject, reviewerAuthority, policyRevision };
    const saved = await this.loadWriteResult(proposal.workspaceId, proposal.id, input.idempotencyKey);
    if (saved) return { freshnessVerifiedAt, result: saved.ok && !receiptMatchesIntent({ owner, receipt: saved.receipt, intent }) ? { ok: false, code: "invalid_owner_receipt" } : saved };
    const result = await writer.write(intent);
    if (result.ok && !receiptMatchesIntent({ owner, receipt: result.receipt, intent })) return { freshnessVerifiedAt, result: { ok: false, code: "invalid_owner_receipt" } };
    await this.writeImmutable(this.writeResultPath(proposal.workspaceId, proposal.id, input.idempotencyKey), result);
    if (result.ok && (!result.receipt.targetRef.startsWith(`${ownerTargetPrefix(owner)}/`) || result.owner !== owner)) return { freshnessVerifiedAt, result: { ok: false, code: "invalid_owner_receipt" } };
    return { freshnessVerifiedAt, result };
  }

  private async transition(input: { proposal: Proposal; actor: TrustedActorContext; input: { requestCorrelationId: string; idempotencyKey: string; reason?: string }; records: LedgerRecord[]; outcome: Terminal; targetWrite?: TargetWriteResult; writeIntentRef?: string; freshnessVerifiedAt?: string; reviewerAuthority: "owner" | "editor" }): Promise<Transition> {
    const previous = input.records.at(-1); const base: Record<string, unknown> = { schemaVersion: "1.0", recordType: "proposal-transition", eventId: `event-${randomUUID().replace(/-/g, "").slice(0, 16)}`, proposalId: input.proposal.id, proposalRevision: input.proposal.proposalRevision, correlationId: input.input.requestCorrelationId, workspaceId: input.proposal.workspaceId, sequence: input.records.length + 1, priorEventHash: previous ? recordHash(previous) : hash("GENESIS"), fromStatus: "proposed", toStatus: input.outcome, occurredAt: this.timestamp(), idempotencyKey: input.input.idempotencyKey };
    if (input.outcome === "accepted") {
      const write = input.targetWrite;
      if (!write?.ok) return this.transition({ ...input, outcome: "stale" });
      // Persist the full receipt binding, not merely its hash-derived summary.
      // This keeps every terminal acceptance independently auditable after a
      // restart and makes receipt substitution detectable from the ledger alone.
      Object.assign(base, { acceptance: { reviewDecisionRef: this.decisionRef(input.proposal.id, input.input.idempotencyKey), writeIntentRef: input.writeIntentRef, reviewer: { subject: input.actor.subject, authority: input.reviewerAuthority, trustedPrincipalRef: "./principals/local" }, security: { gate: "pass", policyRef: this.options.policyRef, policyRevision: this.options.policyRevision }, freshness: { state: "fresh", verifiedAt: input.freshnessVerifiedAt ?? this.timestamp(), maxEvidenceAgeSeconds: 3600 }, targetWrite: { receiptRef: write.receipt.receiptRef, targetRef: write.receipt.targetRef, completedAt: write.receipt.completedAt, binding: write.receipt.binding }, evidence: input.proposal.evidence, idempotencyKey: input.input.idempotencyKey } });
    } else Object.assign(base, { reason: input.input.reason ?? (input.outcome === "stale" ? "evidence, policy, or guarded target write did not remain fresh" : "review decision" ) });
    return base as Transition;
  }

  /** Immutable authorization decision, persisted before the owning writer. */
  private async writeApproval(proposal: Proposal, actor: TrustedActorContext, reviewerAuthority: ReviewerAuthority, input: { requestCorrelationId: string; idempotencyKey: string }, policyRevision: string): Promise<{ approvalRef: string }> {
    const approvalRef = this.approvalRef(proposal.id, input.idempotencyKey);
    const approvalPath = this.approvalPath(proposal.workspaceId, proposal.id, input.idempotencyKey);
    try {
      const existing = JSON.parse(await readFile(approvalPath, "utf8")) as Record<string, unknown>;
      if (existing.proposalId !== proposal.id || existing.proposalRevision !== proposal.proposalRevision || existing.workspaceId !== proposal.workspaceId || existing.correlationId !== input.requestCorrelationId || existing.idempotencyKey !== input.idempotencyKey || existing.policyRevision !== policyRevision || JSON.stringify(existing.reviewer) !== JSON.stringify({ subject: actor.subject, authority: reviewerAuthority })) throw new ProposalLifecycleError("conflict", "approval does not match the recovery request");
      return { approvalRef };
    } catch (error) { if (error instanceof ProposalLifecycleError) throw error; if (!isNotFound(error)) throw error; }
    const approval = { proposalId: proposal.id, proposalRevision: proposal.proposalRevision, workspaceId: proposal.workspaceId, correlationId: input.requestCorrelationId, idempotencyKey: input.idempotencyKey, reviewer: { subject: actor.subject, authority: reviewerAuthority }, policyRef: this.options.policyRef, policyRevision, decidedAt: this.timestamp(), decision: "approved-for-guarded-write" };
    await this.writeImmutable(approvalPath, approval);
    return { approvalRef };
  }

  private async ensureWriteIntent(proposal: Proposal, actor: TrustedActorContext, reviewerAuthority: ReviewerAuthority, input: { requestCorrelationId: string; idempotencyKey: string }, approvalRef: string, policyRevision: string, ledger: string, records: LedgerRecord[]): Promise<{ intentRef: string }> {
    const intentRef = this.intentRef(proposal.id, input.idempotencyKey);
    const existing = records.find((record): record is WriteIntent => record.recordType === "proposal-write-intent" && record.idempotencyKey === input.idempotencyKey);
    if (existing) return { intentRef };
    try {
      const recovered = JSON.parse(await readFile(this.intentPath(proposal.workspaceId, proposal.id, input.idempotencyKey), "utf8")) as WriteIntent;
      await this.validateRecord(recovered);
      if (recovered.proposalId !== proposal.id || recovered.proposalRevision !== proposal.proposalRevision || recovered.correlationId !== input.requestCorrelationId || recovered.idempotencyKey !== input.idempotencyKey || recovered.workspaceId !== proposal.workspaceId) throw new ProposalLifecycleError("conflict", "write intent does not match the recovery request");
      await appendFile(ledger, `${JSON.stringify(recovered)}\n`, { mode: 0o600 });
      return { intentRef };
    } catch (error) { if (error instanceof ProposalLifecycleError) throw error; if (!isNotFound(error)) throw error; }
    const intent: WriteIntent = { schemaVersion: "1.0", recordType: "proposal-write-intent", intentId: `intent-${randomUUID().replace(/-/g, "").slice(0, 16)}`, proposalId: proposal.id, proposalRevision: proposal.proposalRevision, correlationId: input.requestCorrelationId, workspaceId: proposal.workspaceId, sequence: records.length + 1, priorEventHash: records.length ? recordHash(records.at(-1)!) : hash("GENESIS"), idempotencyKey: input.idempotencyKey, reviewer: { subject: actor.subject, authority: reviewerAuthority, trustedPrincipalRef: "./principals/local" }, approvalRef, security: { gate: "pass", policyRef: this.options.policyRef, policyRevision }, evidence: proposal.evidence, createdAt: this.timestamp() };
    await this.validateRecord(intent);
    await this.writeImmutable(this.intentPath(proposal.workspaceId, proposal.id, input.idempotencyKey), intent);
    await appendFile(ledger, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
    return { intentRef };
  }

  private async actor(request: unknown, correlationId: string): Promise<TrustedActorContext> { const actor = await this.options.authorizationServer.actorContextFor(request, correlationId); if (!actor) throw new ProposalLifecycleError("access_denied", "trusted ActorContext is required"); return actor; }
  private async strict(expected?: string): Promise<string> { const gate = await evaluateStrictSacGuard({ guard: this.options.guard, operation: "write" }); const revision = this.options.guard.mode === "strict" ? this.options.guard.policyRevision : undefined; if (!gate.allowed || !revision || revision !== this.options.policyRevision || (expected && revision !== expected)) throw new ProposalLifecycleError("guard_denied", "strict SAC guard/policy revision denied lifecycle write"); return revision; }
  private async validateEvidence(evidence: Evidence[], requireRevision = false, actor?: TrustedActorContext, workspaceId?: string): Promise<void> { for (const item of evidence) { if (requireRevision) { if (!actor || !workspaceId) throw new ProposalLifecycleError("stale", "missing owner-use actor"); const content = await this.options.workspaces.readEvidenceAtUse({ actorContext: actor, workspaceId, uri: item.uri }); if (hash(content.toString("utf8")) !== item.revision) throw new ProposalLifecycleError("stale", "evidence revision changed"); } else await resolveWorkspaceReference({ workspaceRoot: this.root, kind: item.kind as "evidence", uri: item.uri }); } }
  /**
   * `security.gate` set at proposal creation (SLATE-12), computed at
   * write-time (finding 3) via `guardOutput()` — the same shared write-seam
   * (src/security/guard.ts) `wiki-owner-writer.ts`/`memory-owner-writer.ts`
   * already run before their own writes, instead of calling
   * `detectSecrets`/`detectPii` directly (finding 4/1). That gives evidence
   * scanning the full `runDetectors`/`runDetectorsAsync` pipeline (secrets +
   * entropy + PII + prompt-injection + egress, not just two hand-picked
   * detectors), and it respects `config.policies.*.enabled` toggles the same
   * way every other guarded write in this codebase does. `target: "unknown"`
   * is used because evidence content isn't bound for any of
   * `SecurityTarget`'s real destinations (memory/wiki/skill/report/model/
   * external/task) — it is scanned here for gate purposes only and is never
   * written anywhere by this call.
   *
   * Escalation reads `guard.decision.findings.length > 0`, deliberately NOT
   * `guard.decision.gate`/`.allowed`. `.allowed` only reflects whether the
   * *current* security mode would block a write (advisory never blocks,
   * `guardOutput` also swallows an internal analysis error to `allowed:
   * true`), and `.decision.gate` is weighted by each policy's configured
   * `action` (e.g. the default PII policy action is `"redact"`, which alone
   * never reaches `"needs-approval"`/`"fail"`). This method's own contract —
   * unchanged since SLATE-12 — is "any detector match on the pinned evidence
   * escalates for reviewer visibility", the same confidence/severity/action-
   * agnostic check the old direct `detectSecrets(...).length > 0 ||
   * detectPii(...).length > 0` performed. `findings` is built from every raw
   * match regardless of action/severity, so this is a strict superset of the
   * old check (same secrets/PII sensitivity, plus entropy/prompt-injection/
   * egress) rather than a downgrade gated behind each policy's write-time
   * action.
   *
   * Evidence content is resolved the same containment-checked way
   * `validateEvidence`'s non-revision branch does — never
   * `workspaces.readEvidenceAtUse`, which requires `action: "review"`
   * authorization `create()`'s actor (authorized for `"write"`) may not hold
   * — and is read through `readWorkspaceFileNoFollow` (descriptor-chain,
   * O_NOFOLLOW at every path component) rather than a plain `readFile`, to
   * close the same TOCTOU/symlink-follow gap `readEvidenceAtUse` already
   * closes for its own read.
   *
   * Before trusting a scan result, the read content is hashed and compared
   * against `item.revision` — the sha256 the evidence was pinned to when the
   * trusted wrap-up issued it (the same comparison `validateEvidence`'s
   * revision-check branch and `transition()` already perform via `hash()`).
   * Content can legitimately or maliciously differ between when `revision`
   * was computed and when this scan runs moments later; if it no longer
   * matches, a "nothing found" result from the detectors would be dishonest
   * (we did not actually scan the evidence the proposal is pinned to), so
   * that item is treated as a "needs approval" signal and the detectors are
   * not consulted for it — fail-closed, matching the posture the rest of
   * this file already takes for the identical situation.
   *
   * A read/resolve failure on an individual item (binary content, an item
   * that fails containment, ENOENT, etc.) is treated as "nothing scannable"
   * for that item rather than crashing `create()` or auto-escalating to
   * `needs-approval` — escalating on every unreadable item would make a
   * binary/missing evidence file indistinguishable from a real secret/PII
   * finding for a reviewer. Evidence containment/existence is validated
   * separately by `validateEvidence()` right after this call. This is
   * distinct from — and unaffected by — the revision-mismatch case above,
   * which only applies once content was read successfully.
   *
   * The ONE read/resolve failure that is NOT folded into "nothing scannable"
   * (finding 1): `readWorkspaceFileNoFollow`'s own safe descriptor-chain
   * bridge being unavailable on this host (no Bun/POSIX FFI bridge — e.g.
   * Windows, or musl/Alpine Linux). `secure-resource-read.ts` documents that
   * SAC is "deliberately fail-closed" on such hosts; a blanket `catch {
   * continue }` would instead make every evidence item look unscannable and
   * silently fall through to `"pass"`, which is the opposite of fail-closed.
   * That one error is distinguished by message and escalates straight to
   * `"needs-approval"` — it is host-wide, so every remaining item would fail
   * identically anyway.
   */
  private async scanEvidenceSecurityGate(evidence: readonly Evidence[]): Promise<"pass" | "needs-approval"> {
    const readEvidenceFile = this.options.readEvidenceFile ?? readWorkspaceFileNoFollow;
    for (const item of evidence) {
      let content: string;
      try {
        const resolved = await resolveWorkspaceReference({ workspaceRoot: this.root, kind: item.kind as "evidence", uri: item.uri });
        content = readEvidenceFile(this.root, resolved).toString("utf8");
      } catch (error) {
        if (isPlatformUnavailableSecureReadError(error)) return "needs-approval";
        // Couldn't read/resolve this item at all (binary, ENOENT, containment
        // failure, etc.) — "nothing scannable" for this item, not a finding.
        // validateEvidence() re-checks containment/existence right after this
        // call, so a missing/unreadable item is never silently accepted.
        continue;
      }
      if (hash(content) !== item.revision) return "needs-approval";
      const guard = await guardOutput({ cwd: this.root, content, target: "unknown", source: "tool-output" });
      if (guard.decision.findings.length > 0) return "needs-approval";
    }
    return "pass";
  }
  private async validateProposal(proposal: Proposal): Promise<void> { const validation = await validateSacContract({ schema: "workspace-proposal", document: proposal }); if (!validation.valid) throw new ProposalLifecycleError("invalid_proposal", validation.errors.map((error) => error.code).join(",")); }
  private async validateRecord(record: LedgerRecord): Promise<void> { const validation = await validateSacContract({ schema: "workspace-proposal", document: record }); if (!validation.valid) throw new ProposalLifecycleError("invalid_proposal", validation.errors.map((error) => error.code).join(",")); }
  private async validateTransition(event: Transition): Promise<void> { const validation = await validateSacContract({ schema: "workspace-proposal", document: event }); if (!validation.valid) throw new ProposalLifecycleError("invalid_proposal", validation.errors.map((error) => error.code).join(",")); }
  private async reviewDecision(proposal: Proposal, actor: TrustedActorContext, reviewerAuthority: ReviewerAuthority, input: { requestCorrelationId: string; idempotencyKey: string; reason?: string }, decision: "accepted" | "rejected" | "dismissed", targetWrite: TargetWriteResult | undefined, policyRevision: string): Promise<Record<string, unknown>> { const base: Record<string, unknown> = { schemaVersion: "1.0", id: `review-${randomUUID().replace(/-/g, "").slice(0, 16)}`, proposalId: proposal.id, proposalRevision: proposal.proposalRevision, correlationId: input.requestCorrelationId, workspaceId: proposal.workspaceId, decision, reviewer: { subject: actor.subject, authority: reviewerAuthority, trustedPrincipalRef: "./principals/local" }, decidedAt: this.timestamp(), idempotencyKey: input.idempotencyKey }; if (decision === "accepted" && targetWrite?.ok) Object.assign(base, { security: { gate: "pass", policyRef: this.options.policyRef, policyRevision }, freshness: { state: "fresh", verifiedAt: this.timestamp(), evidenceRevision: proposal.evidence[0]!.revision }, targetWrite: { receiptRef: targetWrite.receipt.receiptRef, targetRef: targetWrite.receipt.targetRef, completedAt: targetWrite.receipt.completedAt } }); else Object.assign(base, { reason: input.reason ?? "review decision" }); const validation = await validateSacContract({ schema: "review-decision", document: base }); if (!validation.valid) throw new ProposalLifecycleError("invalid_proposal", validation.errors.map((error) => error.code).join(",")); return base; }
  private async loadProposal(workspaceId: string, proposalId: string): Promise<Proposal> { try { const item = JSON.parse(await readFile(this.proposalPath(workspaceId, proposalId), "utf8")) as Proposal; await this.validateProposal(item); return item; } catch (error) { if (isNotFound(error)) throw new ProposalLifecycleError("not_found", "proposal not found"); throw error; } }
  private async records(ledger: string): Promise<LedgerRecord[]> { try { return (await readFile(ledger, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerRecord); } catch (error) { if (isNotFound(error)) return []; throw error; } }
  private proposalPath(workspaceId: string, proposalId: string): string { return path.join(this.root, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.json`); }
  private decisionRef(proposalId: string, key: string): string { return `./proposals/${proposalId}.${hash(key)}.decision.json`; }
  private decisionPath(workspaceId: string, proposalId: string, key: string): string { return path.join(this.root, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.${hash(key)}.decision.json`); }
  private approvalRef(proposalId: string, key: string): string { return `./proposals/${proposalId}.${hash(key)}.approval.json`; }
  private approvalPath(workspaceId: string, proposalId: string, key: string): string { return path.join(this.root, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.${hash(key)}.approval.json`); }
  private writeResultPath(workspaceId: string, proposalId: string, key: string): string { return path.join(this.root, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.${hash(key)}.write-result.json`); }
  private intentRef(proposalId: string, key: string): string { return `./proposals/${proposalId}.${hash(key)}.write-intent.json`; }
  private intentPath(workspaceId: string, proposalId: string, key: string): string { return path.join(this.root, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.${hash(key)}.write-intent.json`); }
  private async loadWriteResult(workspaceId: string, proposalId: string, key: string): Promise<TargetWriteResult | undefined> { try { return JSON.parse(await readFile(this.writeResultPath(workspaceId, proposalId, key), "utf8")) as TargetWriteResult; } catch (error) { if (isNotFound(error)) return undefined; throw error; } }
  private async writeImmutable(file: string, record: unknown): Promise<void> { try { const existing = await readFile(file, "utf8"); if (existing !== `${JSON.stringify(record)}\n`) throw new ProposalLifecycleError("conflict", "immutable lifecycle record already exists"); } catch (error) { if (error instanceof ProposalLifecycleError) throw error; if (!isNotFound(error)) throw error; await writeFileAtomic(file, `${JSON.stringify(record)}\n`); } }
  private ledgerPath(workspaceId: string): string { return path.join(this.root, ".metaproject", "workspaces", workspaceId, "activity.jsonl"); }
  private timestamp(): string { return this.now().toISOString(); }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function eventHash(value: Transition): string { return hash(JSON.stringify(value)); }
function recordHash(value: LedgerRecord): string { return hash(JSON.stringify(value)); }

/**
 * True only for `readWorkspaceFileNoFollow`'s own "the safe descriptor-chain
 * bridge is unavailable on this host" failure (secure-resource-read.ts) —
 * never for an ordinary per-item read/resolve failure (ENOENT, containment,
 * binary content, a bad component). Matched by exact message because that
 * function throws a plain `Error` with no dedicated error class/code.
 */
function isPlatformUnavailableSecureReadError(error: unknown): boolean {
  return error instanceof Error && error.message === "safe descriptor source reads are unavailable on this platform";
}

/**
 * NOT a self-accept protection in the real request path: `src/commands/workspace.ts`
 * and `src/mcp/tools.ts` never construct this composition — both exclusively call
 * `createHarnessProposalLifecycleService` for every real CLI/MCP `propose`/`review`
 * request. What this composition actually evaluates to, for any caller that did
 * construct it directly, is the fail-closed local owner-writer adapters from
 * `createLocalOwnerWriterAdapters()` below: it can still record proposals and
 * non-accepting decisions, but a `review({ decision: "accepted" })` against it always
 * fails at the owner write, since every local adapter's `persist` unconditionally
 * returns `owner_writer_unavailable`. That is a property of this specific
 * composition, not a guarantee enforced anywhere along the live request path.
 */
export function createLocalProposalLifecycleService(cwd: string): ProposalLifecycleService {
  const authorizationServer = localWorkspaceAuthorizationServer();
  const workspaces = new WorkspaceService({ workspaceRoot: cwd, authorizationServer, strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } });
  // Local adapters deliberately do not receive this authority. Their propose
  // command remains fail-closed; trusted Harness/session composition injects it.
  return new ProposalLifecycleService({ workspaceRoot: cwd, workspaces, authorizationServer, guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" }, policyRef: "./security/policy/local", policyRevision: "local-offline-v1", targetWriters: createLocalOwnerWriterAdapters(), wrapUpAuthority: createTrustedWrapUpAuthority({ now: () => new Date(0), resolveExplicitWrapUp: async () => { throw new Error("trusted wrap-up boundary unavailable"); } }) });
}

/**
 * The "trusted Harness/session composition" the comment above points to. Unlike
 * `createLocalProposalLifecycleService`, this one is real and NOT fail-closed for
 * `source: "session"`: `resolveSessionWrapUp` (src/sac/session-wrap-up.ts) exports a
 * real, already-completed keryx shell session's archive into the workspace and
 * returns a hash-verified pointer to it, and the `memory-entry` target owner is a
 * real writer (src/sac/memory-owner-writer.ts) that lands an accepted proposal in
 * `.metaproject/memory/` through the SAME guarded canonical writer `keryx memory
 * new` uses. `wiki-update` is likewise real (src/sac/wiki-owner-writer.ts): it
 * lands a "decision" page in `.metaproject/wiki/decisions/`, guarded by the same
 * security scan `keryx wiki collect` runs before publishing a generated page.
 * `skill` is likewise real (src/sac/skill-owner-writer.ts): it composes
 * `createProjectSkill` (`keryx skills create`'s own write path, itself now
 * guarded by `guardOutput({ target: "skill" })`) into a `sac`-module project
 * skill under `.metaproject/project-skills/sac/<proposalId>/`.
 *
 * `workspaceId` is bound at construction because `resolveExplicitWrapUp` must
 * return a `workspaceId` it did not receive on the request (see trusted-wrap-up.ts)
 * — the CLI/caller already knows which workspace it is proposing into, so it is
 * captured here rather than trusted from caller-suppliable request fields.
 */
export function createHarnessProposalLifecycleService(
  cwd: string,
  opts: { workspaceId: string; note?: string },
): { service: ProposalLifecycleService; wrapUpAuthority: TrustedWrapUpAuthority; authorizationServer: SacAuthorizationServer } {
  const authorizationServer = localWorkspaceAuthorizationServer();
  const workspaces = new WorkspaceService({ workspaceRoot: cwd, authorizationServer, strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } });
  const wrapUpAuthority = createTrustedWrapUpAuthority({
    resolveExplicitWrapUp: async (request) => {
      if (request.source !== "session") throw new Error(`this composition only resolves "session" wrap-ups, got "${request.source}"`);
      return resolveSessionWrapUp({ cwd, workspaceId: opts.workspaceId, sourceRef: request.sourceRef });
    },
  });
  const noteOpt = opts.note !== undefined ? { note: opts.note } : {};
  const targetWriters = {
    ...createLocalOwnerWriterAdapters(),
    memory: createMemoryGuardedTargetWriter(createRealMemoryOwnerWriter(cwd, noteOpt)),
    wiki: createWikiGuardedTargetWriter(createRealWikiOwnerWriter(cwd, noteOpt)),
    skill: createSkillGuardedTargetWriter(createRealSkillOwnerWriter(cwd, noteOpt)),
  };
  const service = new ProposalLifecycleService({ workspaceRoot: cwd, workspaces, authorizationServer, guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" }, policyRef: "./security/policy/local", policyRevision: "local-offline-v1", targetWriters, wrapUpAuthority });
  return { service, wrapUpAuthority, authorizationServer };
}

/**
 * Concrete composition seams for the owning Wiki, Memory and Skills writers.
 * They deliberately execute owner supplied code; SAC only verifies the owner
 * label and correlation-bound receipt and never writes source knowledge.
 */
type OwnerWriterComposition = Readonly<{
  authorize: (intent: OwnerWriteIntent) => Promise<boolean>;
  /** Durable receipt lookup owned by the target subsystem. */
  recover: (intent: OwnerWriteIntent & { owner: TargetOwner }) => Promise<OwnerReceipt | undefined>;
  persist: OwnerWriteAdapter;
}>;
export function createWikiGuardedTargetWriter(input: OwnerWriterComposition): GuardedTargetWriter { return createGuardedOwnerWriter({ owner: "wiki", ...input }); }
export function createMemoryGuardedTargetWriter(input: OwnerWriterComposition): GuardedTargetWriter { return createGuardedOwnerWriter({ owner: "memory", ...input }); }
export function createSkillGuardedTargetWriter(input: OwnerWriterComposition): GuardedTargetWriter { return createGuardedOwnerWriter({ owner: "skill", ...input }); }

/**
 * Local CLI/stdio deliberately registers the real owner seams instead of an
 * empty writer map. They fail closed until each owning subsystem composes its
 * own trusted write/recovery implementation; SAC never edits Wiki, Memory or
 * Skills files itself.
 */
export function createLocalOwnerWriterAdapters(): Record<TargetOwner, GuardedTargetWriter> {
  const unavailable = async (): Promise<{ ok: false; code: string }> => ({ ok: false, code: "owner_writer_unavailable" });
  const denied = async (): Promise<boolean> => false;
  const noReceipt = async (): Promise<OwnerReceipt | undefined> => undefined;
  return Object.freeze({
    wiki: createWikiGuardedTargetWriter({ authorize: denied, recover: noReceipt, persist: unavailable }),
    memory: createMemoryGuardedTargetWriter({ authorize: denied, recover: noReceipt, persist: unavailable }),
    skill: createSkillGuardedTargetWriter({ authorize: denied, recover: noReceipt, persist: unavailable }),
  });
}

function ownerFor(kind: ProposalKind): TargetOwner { return kind === "wiki-update" ? "wiki" : kind === "memory-entry" ? "memory" : "skill"; }

/**
 * The real workspace-relative folder each owner's receipt `targetRef` must
 * live under. NOT simply `./${owner}` — that literal assumption happened to
 * hold for memory (`.metaproject/memory/`) and wiki (`.metaproject/wiki/`)
 * but is false for skill: `keryx skills create` stores real skills under
 * `.metaproject/project-skills/`, not `.metaproject/skill/`. A receipt whose
 * `targetRef` doesn't start with its owner's real prefix is rejected as
 * `invalid_owner_receipt` either way — this only fixes WHICH prefix is
 * required per owner, not whether the check still defends against a
 * substituted/cross-owner receipt.
 */
function ownerTargetPrefix(owner: TargetOwner): string {
  return owner === "skill" ? "./project-skills" : `./${owner}`;
}
function authorityFor(manifest: { members: Array<{ subject: string; role: "owner" | "editor" | "viewer" }> }, subject: string): ReviewerAuthority {
  const role = manifest.members.find((member) => member.subject === subject)?.role;
  if (role === "owner" || role === "editor") return role;
  throw new ProposalLifecycleError("access_denied", "fresh reviewer authority is required");
}

export function normalizeProposalLifecycleResult<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
