// Shared plumbing for a real GuardedOwnerWriter composition (memory, wiki, and
// eventually skill): read the proposal record SAC already durably wrote, and
// re-verify its evidence hash before any owner subsystem treats it as real.
// Each owner still decides what its own record/content looks like — this only
// gets every owner to the same hash-verified evidence body the same way, so a
// hash-mismatch or unreadable-proposal bug can't diverge between them.
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isNotFound, withFileLock, writeFileAtomic } from "../lib/fs";
import type { KnowledgeOwner, OwnerReceipt, OwnerWriteFailure, OwnerWriteIntent } from "./guarded-owner-writer";

export type ProposalEvidenceItem = { kind: string; uri: string; revision: string; observedAt: string };
export type ProposalRecord = { id: string; workspaceId: string; evidence: readonly ProposalEvidenceItem[] };

export function proposalPath(cwd: string, workspaceId: string, proposalId: string): string {
  // Must match ProposalLifecycleService's own private `proposalPath` exactly —
  // every owner writer reads a record SAC already wrote, never a second source
  // of truth.
  return path.join(cwd, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.json`);
}

export function ownerReceiptPath(cwd: string, owner: KnowledgeOwner, workspaceId: string, idempotencyKey: string): string {
  return path.join(cwd, ".metaproject", "workspaces", workspaceId, `${owner}-write-receipts`, `${idempotencyKey}.json`);
}

/** Sidecar path for a proposal's optional caller-supplied note — written at
 * propose time (see workspace.ts), read back here at accept time by whichever
 * owner writer ends up handling the proposal. Not part of the frozen
 * `workspace-proposal` JSON schema, so it lives beside the record rather than
 * in it, the same way approval/intent/decision records already do. */
export function proposalNotePath(cwd: string, workspaceId: string, proposalId: string): string {
  return path.join(cwd, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.note.txt`);
}

export type VerifiedProposalEvidence = { proposal: ProposalRecord; evidence: ProposalEvidenceItem; content: string };

/** Reads the proposal record, resolves its first evidence pointer, and
 * re-verifies the evidence file's content still hashes to what was recorded at
 * propose time — never trusts a stale or tampered evidence file. */
export async function readVerifiedProposalEvidence(
  cwd: string,
  workspaceId: string,
  proposalId: string,
): Promise<VerifiedProposalEvidence | { ok: false; code: string }> {
  let proposal: ProposalRecord;
  try {
    proposal = JSON.parse(await readFile(proposalPath(cwd, workspaceId, proposalId), "utf8")) as ProposalRecord;
  } catch {
    return { ok: false, code: "proposal_record_unreadable" };
  }
  const evidence = proposal.evidence[0];
  if (evidence === undefined) return { ok: false, code: "no_evidence_to_write" };

  let content: string;
  try {
    content = await readFile(path.join(cwd, evidence.uri), "utf8");
  } catch {
    return { ok: false, code: "evidence_file_unreadable" };
  }
  if (createHash("sha256").update(content).digest("hex") !== evidence.revision) {
    return { ok: false, code: "evidence_revision_mismatch" };
  }
  return { proposal, evidence, content };
}

export async function readSidecarNote(cwd: string, workspaceId: string, proposalId: string): Promise<string | undefined> {
  return readFile(proposalNotePath(cwd, workspaceId, proposalId), "utf8").catch(() => undefined);
}

// ---------------------------------------------------------------------------
// AFC-27 / flow 237 AC1 — target-side optimistic concurrency and crash-window
// idempotency, shared by EVERY real owner writer so the guarantee cannot hold
// in one of them and be missing in the next.
//
// Two things were absent before this. (1) Nothing compared the target against
// the base the proposal was built against: foreign bytes planted in the target
// were silently replaced and the accept reported plain success. (2) The target
// bytes were made durable BEFORE the receipt, so a crash in between left "no
// receipt" indistinguishable from "never written" and a restart re-ran the
// write with a new receipt.
//
// The base version's identity is a sha256 content digest of the bytes the OWNER
// itself last wrote to that target, recorded in the owner's own durable version
// record. artifact-lifecycle.md is explicit that this is the right identity:
// "Version — opaque owner revision, связанная с content digest ... Смена bytes
// внешним редактором инвалидирует базу, даже если он забыл поднять Version" —
// the human `Version:` line in a page's frontmatter is deliberately NOT used.
//
// An owner that has never written a target has base `null`: "the target is
// absent". That is the honest base for every fresh proposal, because the target
// path is minted from the immutable proposal id, so at propose time it cannot
// have existed. `null` is also what change-set.schema.json reserves for
// create-if-absent, so an absent target is the normal create path and never a
// conflict — while bytes the owner cannot account for are always a conflict,
// because the owner never adopts another writer's bytes as its own base.
// ---------------------------------------------------------------------------

/** sha256 of the target's bytes, or `null` when the target does not exist. */
export type TargetVersion = string | null;

export function digestOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function readTargetVersion(absolutePath: string): Promise<TargetVersion> {
  try {
    return digestOf(await readFile(absolutePath, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** The owner's durable "this is the revision I last wrote to this target" record. */
export type OwnerTargetVersionRecord = Readonly<{
  schemaVersion: "1.0";
  recordType: "owner-target-version";
  owner: KnowledgeOwner;
  targetRef: string;
  version: string;
  proposalId: string;
  idempotencyKey: string;
  recordedAt: string;
}>;

/** `targetRef` is `./wiki/decisions/x.md`; the stored path is relative to `.metaproject/`. */
function targetRelPath(targetRef: string): string {
  return targetRef.replace(/^\.\//, "");
}

export function targetAbsolutePath(cwd: string, targetRef: string): string {
  return path.join(cwd, ".metaproject", targetRelPath(targetRef));
}

function targetKey(targetRef: string): string {
  return digestOf(targetRelPath(targetRef)).slice(0, 32);
}

export function ownerTargetVersionPath(cwd: string, owner: KnowledgeOwner, workspaceId: string, targetRef: string): string {
  return path.join(cwd, ".metaproject", "workspaces", workspaceId, `${owner}-target-versions`, `${targetKey(targetRef)}.json`);
}

/**
 * Serialises compare-then-write for one logical target. Project-scoped rather
 * than workspace-scoped: the lock protects the target file, which is shared by
 * every workspace, so a per-workspace lock would not be a lock at all.
 */
export function ownerTargetLockPath(cwd: string, owner: KnowledgeOwner, targetRef: string): string {
  return path.join(cwd, ".metaproject", "data", "sac", "target-locks", owner, `${targetKey(targetRef)}.lock`);
}

export function ownerStagingDir(cwd: string, owner: KnowledgeOwner, workspaceId: string, idempotencyKey: string): string {
  return path.join(cwd, ".metaproject", "workspaces", workspaceId, `${owner}-write-staging`, digestOf(idempotencyKey).slice(0, 32));
}

export function ownerConflictDir(cwd: string, owner: KnowledgeOwner, workspaceId: string, idempotencyKey: string): string {
  return path.join(cwd, ".metaproject", "workspaces", workspaceId, `${owner}-write-conflicts`, digestOf(idempotencyKey).slice(0, 32));
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * The owner's journal entry for one in-flight write. Durable BEFORE the target
 * bytes, and it carries the prepared receipt, so a restart returns the receipt
 * the interrupted attempt would have returned rather than minting a new one.
 */
export type StagedOwnerWrite = Readonly<{
  schemaVersion: "1.0";
  recordType: "owner-write-staging";
  owner: KnowledgeOwner;
  proposalId: string;
  workspaceId: string;
  idempotencyKey: string;
  targetRef: string;
  expectedVersion: TargetVersion;
  /**
   * The exact digest the target will hold once applied, when the owner writes
   * bytes it fully controls. Absent when the owner delegates the write to a
   * subsystem that may transform the content (memory's canonical writer, the
   * project-skill package writer); recovery then relies on the version record
   * instead, and finishes from staging when even that is missing.
   */
  predictedVersion?: string;
  receipt: OwnerReceipt;
  /** Owner-specific instructions, replayed verbatim by `apply` on recovery. */
  staged: Record<string, unknown>;
  stagedAt: string;
}>;

export type OwnerApply = (staged: Record<string, unknown>) => Promise<{ ok: true } | OwnerWriteFailure>;

async function commit(cwd: string, owner: KnowledgeOwner, intent: OwnerWriteIntent, staged: StagedOwnerWrite): Promise<OwnerReceipt> {
  const observed = await readTargetVersion(targetAbsolutePath(cwd, staged.targetRef));
  if (observed !== null) {
    const record: OwnerTargetVersionRecord = {
      schemaVersion: "1.0",
      recordType: "owner-target-version",
      owner,
      targetRef: staged.targetRef,
      version: observed,
      proposalId: intent.proposalId,
      idempotencyKey: intent.idempotencyKey,
      recordedAt: staged.receipt.completedAt,
    };
    await writeFileAtomic(ownerTargetVersionPath(cwd, owner, intent.workspaceId, staged.targetRef), `${JSON.stringify(record, null, 2)}\n`);
  }
  // The receipt is the commit marker: `recover()` and `recoverReceipt()` both
  // treat its presence as "this write is complete". Staging is the journal and
  // is reclaimed only after the marker is durable.
  await writeFileAtomic(ownerReceiptPath(cwd, owner, intent.workspaceId, intent.idempotencyKey), `${JSON.stringify(staged.receipt, null, 2)}\n`);
  await rm(ownerStagingDir(cwd, owner, intent.workspaceId, intent.idempotencyKey), { recursive: true, force: true }).catch(() => {});
  return staged.receipt;
}

async function finishFromStaging(cwd: string, owner: KnowledgeOwner, intent: OwnerWriteIntent, staged: StagedOwnerWrite, apply: OwnerApply): Promise<OwnerReceipt | undefined> {
  const observed = await readTargetVersion(targetAbsolutePath(cwd, staged.targetRef));
  const recorded = await readJson<OwnerTargetVersionRecord>(ownerTargetVersionPath(cwd, owner, intent.workspaceId, staged.targetRef));
  const alreadyApplied = (recorded?.idempotencyKey === intent.idempotencyKey && recorded.version === observed)
    || (staged.predictedVersion !== undefined && observed === staged.predictedVersion);
  if (!alreadyApplied) {
    // Finishing the SAME write from its own staged instructions — not a second
    // change and not a second receipt. The staged receipt below is byte-for-byte
    // the one the interrupted attempt prepared.
    const applied = await apply(staged.staged);
    if (!applied.ok) return undefined;
  }
  return commit(cwd, owner, intent, staged);
}

/**
 * The one write path every real owner writer goes through: compare the target
 * against the base, stage the receipt, apply, then commit.
 *
 * `expectedVersion` is read BEFORE the target lock is taken, which is what makes
 * this optimistic concurrency rather than last-writer-wins: two processes that
 * start from the same base both capture it, then serialise, and the second sees
 * a target that no longer matches what it read.
 */
export async function applyGuardedTargetWrite(input: {
  cwd: string;
  owner: KnowledgeOwner;
  intent: OwnerWriteIntent & { owner: KnowledgeOwner };
  receipt: OwnerReceipt;
  /** Owner-specific instructions, replayable from staging. */
  staged: Record<string, unknown>;
  /** Exact bytes the target will hold, when the owner controls them fully. */
  predictedContent?: string;
  /** Rendered proposal content used as the conflict's diff reference. */
  proposedContent?: string;
  apply: OwnerApply;
}): Promise<OwnerReceipt | OwnerWriteFailure> {
  const { cwd, owner, intent, receipt } = input;
  // A staged attempt for this exact key means a previous process already crossed
  // the target lock and may have applied. Finish it instead of re-deciding.
  const inflight = await readStagedOwnerWrite(cwd, owner, intent.workspaceId, intent.idempotencyKey);
  if (inflight) {
    const finished = await withFileLock(ownerTargetLockPath(cwd, owner, inflight.targetRef), async () => finishFromStaging(cwd, owner, intent, inflight, input.apply));
    if (finished) return finished;
    return { ok: false, code: "owner_write_staging_unfinishable" };
  }

  const expectedVersion = (await readJson<OwnerTargetVersionRecord>(ownerTargetVersionPath(cwd, owner, intent.workspaceId, receipt.targetRef)))?.version ?? null;

  return withFileLock(ownerTargetLockPath(cwd, owner, receipt.targetRef), async () => {
    const currentVersion = await readTargetVersion(targetAbsolutePath(cwd, receipt.targetRef));
    if (currentVersion !== expectedVersion) {
      const conflict = await recordConflict({ cwd, owner, intent, targetRef: receipt.targetRef, expectedVersion, currentVersion, ...(input.proposedContent !== undefined ? { proposedContent: input.proposedContent } : {}) });
      return { ok: false, code: "version_conflict", conflict };
    }
    const staged: StagedOwnerWrite = {
      schemaVersion: "1.0",
      recordType: "owner-write-staging",
      owner,
      proposalId: intent.proposalId,
      workspaceId: intent.workspaceId,
      idempotencyKey: intent.idempotencyKey,
      targetRef: receipt.targetRef,
      expectedVersion,
      ...(input.predictedContent !== undefined ? { predictedVersion: digestOf(input.predictedContent) } : {}),
      receipt,
      staged: input.staged,
      stagedAt: receipt.completedAt,
    };
    await writeFileAtomic(path.join(ownerStagingDir(cwd, owner, intent.workspaceId, intent.idempotencyKey), "plan.json"), `${JSON.stringify(staged, null, 2)}\n`);
    const applied = await input.apply(input.staged);
    if (!applied.ok) {
      await rm(ownerStagingDir(cwd, owner, intent.workspaceId, intent.idempotencyKey), { recursive: true, force: true }).catch(() => {});
      return applied;
    }
    return commit(cwd, owner, intent, staged);
  });
}

/**
 * The non-mutating restart answer (`OwnerWriteRecovery` in
 * proposal-lifecycle.ts): can this owner account for this exact intent?
 *
 * Returns the ORIGINAL receipt when the write is complete or completable from
 * the owner's own staging, and `undefined` when there is nothing on record —
 * which SAC turns into a refusal, never a second mutation.
 */
export async function recoverStagedOwnerWrite(input: {
  cwd: string;
  owner: KnowledgeOwner;
  intent: OwnerWriteIntent & { owner: KnowledgeOwner };
  apply: OwnerApply;
}): Promise<OwnerReceipt | undefined> {
  const { cwd, owner, intent } = input;
  const committed = await readJson<OwnerReceipt>(ownerReceiptPath(cwd, owner, intent.workspaceId, intent.idempotencyKey));
  if (committed) return committed;
  const staged = await readStagedOwnerWrite(cwd, owner, intent.workspaceId, intent.idempotencyKey);
  if (!staged) return undefined;
  return withFileLock(ownerTargetLockPath(cwd, owner, staged.targetRef), async () => {
    // Another process may have finished between the read above and this lock.
    const raced = await readJson<OwnerReceipt>(ownerReceiptPath(cwd, owner, intent.workspaceId, intent.idempotencyKey));
    if (raced) return raced;
    return finishFromStaging(cwd, owner, intent, staged, input.apply);
  });
}

export async function readStagedOwnerWrite(cwd: string, owner: KnowledgeOwner, workspaceId: string, idempotencyKey: string): Promise<StagedOwnerWrite | undefined> {
  return readJson<StagedOwnerWrite>(path.join(ownerStagingDir(cwd, owner, workspaceId, idempotencyKey), "plan.json"));
}

/**
 * Writes the refused write's own rendered bytes beside the workspace so the
 * conflict carries a real diff reference, per artifact-lifecycle.md ("Conflict
 * возвращает текущую доступную revision и diff reference, но не скрытые
 * targets"). Only this proposal's own content is written; the target's current
 * bytes are left exactly where they are and are never copied.
 */
async function recordConflict(input: {
  cwd: string;
  owner: KnowledgeOwner;
  intent: OwnerWriteIntent;
  targetRef: string;
  expectedVersion: TargetVersion;
  currentVersion: TargetVersion;
  proposedContent?: string;
}): Promise<{ targetRef: string; expectedVersion: TargetVersion; currentVersion: TargetVersion; diffRef?: string }> {
  const base = { targetRef: input.targetRef, expectedVersion: input.expectedVersion, currentVersion: input.currentVersion };
  if (input.proposedContent === undefined) return base;
  const dir = ownerConflictDir(input.cwd, input.owner, input.intent.workspaceId, input.intent.idempotencyKey);
  await writeFileAtomic(path.join(dir, "proposed"), input.proposedContent);
  const diffRef = `./workspaces/${input.intent.workspaceId}/${input.owner}-write-conflicts/${path.basename(dir)}/proposed`;
  return { ...base, diffRef };
}
