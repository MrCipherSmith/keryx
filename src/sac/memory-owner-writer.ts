// Real "memory" GuardedOwnerWriter composition (proposal-lifecycle.ts
// createLocalOwnerWriterAdapters ships wiki/memory/skill all `unavailable` —
// "fail closed until each owning subsystem composes its own trusted write/recovery
// implementation; SAC never edits Wiki, Memory or Skills files itself." This is
// memory's real composition.
//
// SAC's ProposalLifecycleService intentionally hands `persist()` only identifiers
// (OwnerWriteIntent has no content field — see guarded-owner-writer.ts) so the
// owner subsystem, never SAC, decides what its own record looks like. The proposal
// record itself (durably written by `create()` at accept-review time, before this
// ever runs) carries the wrap-up's real evidence — this writer reads THAT file to
// get the evidence pointer, reads the evidence file it points at (already inside
// the workspace, already hash-verified once at propose time and re-verified by
// ProposalLifecycleService immediately before every accepted write), and writes a
// real, schema-valid entry into .metaproject/memory/ via the SAME canonical writer
// (src/memory/write.ts writeCanonicalEntry) `keryx memory new` uses — including its
// security guard scan. Nothing here bypasses that path or invents a second one.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeCanonicalEntry } from "../memory/write";
import type { KnowledgeOwner, OwnerReceipt, OwnerWriteIntent } from "./guarded-owner-writer";

type ProposalRecord = {
  id: string;
  workspaceId: string;
  evidence: readonly { kind: string; uri: string; revision: string; observedAt: string }[];
};

function proposalPath(cwd: string, workspaceId: string, proposalId: string): string {
  // Must match ProposalLifecycleService's own private `proposalPath` exactly —
  // this writer reads a record SAC already wrote, never a second source of truth.
  return path.join(cwd, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.json`);
}

function receiptPath(cwd: string, workspaceId: string, idempotencyKey: string): string {
  return path.join(cwd, ".metaproject", "workspaces", workspaceId, "memory-write-receipts", `${idempotencyKey}.json`);
}

/** Sidecar path for a proposal's optional caller-supplied note — written at propose
 * time (see workspace.ts), read back here at accept time. Not part of the frozen
 * `workspace-proposal` JSON schema, so it lives beside the record rather than in it,
 * the same way approval/intent/decision records already do. */
export function proposalNotePath(cwd: string, workspaceId: string, proposalId: string): string {
  return path.join(cwd, ".metaproject", "workspaces", workspaceId, "proposals", `${proposalId}.note.txt`);
}

/** Build a schema-valid memory entry (src/memory/write.ts validateNextEntry's rules)
 * from real, hash-verified evidence — never from unverified prose. */
function renderWrapUpMemoryEntry(input: {
  title: string;
  evidenceUri: string;
  evidenceRevision: string;
  note: string | undefined;
  date: string;
}): string {
  const note = input.note?.trim();
  return `# ${input.title}

Version: 0.1.0
Type: task-note
Status: draft
Confidence: medium

## Summary

${note && note.length > 0 ? note : `Wrap-up from a reviewed keryx workspace proposal — see linked evidence for the full session.`}

## Details

Recorded via a Shared Agent Context (SAC) proposal, accepted by a reviewer with
owner/editor authority. This entry's content is mechanically derived from
hash-verified evidence, not synthesized by this writer — the linked session export
is the source of truth for what actually happened.

## Provenance

- Source: sac-proposal
- Link: ${input.evidenceUri} (sha256 ${input.evidenceRevision})
- Created: ${input.date}
- Updated: ${input.date}

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

- sac-wrap-up

## Changelog

- 0.1.0 - Written by the SAC memory owner-writer from an accepted proposal.
`;
}

/**
 * The real memory `GuardedOwnerWriter` composition. `note` is an optional
 * caller-supplied one-line gist (e.g. from `keryx workspace propose --note`) —
 * attributed clearly in the entry, never presented as evidence itself.
 */
export function createRealMemoryOwnerWriter(cwd: string, opts?: { note?: string; now?: () => Date }): {
  authorize: (intent: OwnerWriteIntent) => Promise<boolean>;
  recover: (intent: OwnerWriteIntent & { owner: KnowledgeOwner }) => Promise<OwnerReceipt | undefined>;
  persist: (intent: OwnerWriteIntent & { owner: KnowledgeOwner }) => Promise<OwnerReceipt | { ok: false; code: string }>;
} {
  const now = opts?.now ?? (() => new Date());

  return {
    async authorize(intent) {
      // Defense in depth: ProposalLifecycleService already required owner/editor
      // authority before reaching here (authorityFor); refuse to write for anyone
      // else even if that ever changes upstream.
      return intent.reviewerAuthority === "owner" || intent.reviewerAuthority === "editor";
    },

    async recover(intent) {
      try {
        const raw = await readFile(receiptPath(cwd, intent.workspaceId, intent.idempotencyKey), "utf8");
        return JSON.parse(raw) as OwnerReceipt;
      } catch {
        return undefined;
      }
    },

    async persist(intent) {
      let proposal: ProposalRecord;
      try {
        proposal = JSON.parse(await readFile(proposalPath(cwd, intent.workspaceId, intent.proposalId), "utf8")) as ProposalRecord;
      } catch {
        return { ok: false, code: "proposal_record_unreadable" };
      }
      const evidence = proposal.evidence[0];
      if (evidence === undefined) return { ok: false, code: "no_evidence_to_write" };

      let evidenceContent: string;
      try {
        evidenceContent = await readFile(path.join(cwd, evidence.uri), "utf8");
      } catch {
        return { ok: false, code: "evidence_file_unreadable" };
      }
      if (createHash("sha256").update(evidenceContent).digest("hex") !== evidence.revision) {
        return { ok: false, code: "evidence_revision_mismatch" };
      }

      const titleLine = evidenceContent.split("\n").find((line) => line.startsWith("# "));
      const title = titleLine ? titleLine.slice(2).trim() : `SAC wrap-up ${proposal.id}`;
      const date = now().toISOString().slice(0, 10);
      // The note is a propose-time input but this write happens at accept time
      // (possibly a different process/reviewer) — read it back from the sidecar
      // `workspace.ts` wrote at propose time; `opts.note` remains a direct-call
      // fallback for callers that already hold the writer.
      const sidecarNote = await readFile(proposalNotePath(cwd, intent.workspaceId, intent.proposalId), "utf8").catch(() => undefined);
      const content = renderWrapUpMemoryEntry({
        title: `SAC: ${title}`,
        evidenceUri: evidence.uri,
        evidenceRevision: evidence.revision,
        note: sidecarNote ?? opts?.note,
        date,
      });
      const relativePath = `task-notes/sac-${proposal.id}.md`;

      const result = await writeCanonicalEntry({ cwd, relativePath, content });
      if (result.status !== "written") {
        return { ok: false, code: result.status === "skipped" ? `security_gate_${result.reason}` : `memory_write_failed_${result.error.code}` };
      }

      // receiptRef/targetRef are schema-typed as workspace-relative `path`s (no `#`,
      // no query strings — see workspace-proposal.schema.json's `path` pattern), so
      // this is a distinct logical path, not a URL-style fragment on targetRef.
      const receipt: OwnerReceipt = {
        receiptRef: `./memory/${result.path.replace(/\.md$/, "")}.receipt.json`,
        targetRef: `./memory/${result.path}`,
        completedAt: now().toISOString(),
      };
      await mkdir(path.dirname(receiptPath(cwd, intent.workspaceId, intent.idempotencyKey)), { recursive: true });
      await writeFile(receiptPath(cwd, intent.workspaceId, intent.idempotencyKey), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      return receipt;
    },
  };
}
