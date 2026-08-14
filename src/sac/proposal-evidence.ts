// Shared plumbing for a real GuardedOwnerWriter composition (memory, wiki, and
// eventually skill): read the proposal record SAC already durably wrote, and
// re-verify its evidence hash before any owner subsystem treats it as real.
// Each owner still decides what its own record/content looks like — this only
// gets every owner to the same hash-verified evidence body the same way, so a
// hash-mismatch or unreadable-proposal bug can't diverge between them.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeOwner } from "./guarded-owner-writer";

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
