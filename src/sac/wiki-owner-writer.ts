// Real "wiki" GuardedOwnerWriter composition (proposal-lifecycle.ts
// createLocalOwnerWriterAdapters ships wiki/memory/skill all `unavailable` —
// "fail closed until each owning subsystem composes its own trusted write/recovery
// implementation; SAC never edits Wiki, Memory or Skills files itself." This is
// wiki's real composition, mirroring memory-owner-writer.ts.
//
// SAC hands `persist()` only identifiers; the proposal record it reads (durably
// written by `create()` before this ever runs) carries the wrap-up's real,
// hash-verified evidence (shared plumbing: proposal-evidence.ts). This writer
// renders that evidence into a "decision" wiki page (WIKI_PAGE_TYPES in
// src/wiki/types.ts — "known decisions and ADR-like records", the natural fit
// for a reviewed SAC proposal) and writes it atomically.
//
// Unlike memory, there is no canonical "write real body content" helper to
// reuse here: `keryx wiki new` (wikiCreatePage, src/wiki/service.ts) only
// scaffolds a blank title/type template — WikiCreatePageInput has no content
// field — so this writes directly via the same `writeFileAtomic` proposal
// records already use, after running the SAME security write seam
// `keryx wiki collect` runs before publishing a generated page (src/wiki/
// service.ts, target: "wiki") — a blocked write is refused, not silently sent.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { guardOutput } from "../security/guard";
import type { KnowledgeOwner, OwnerReceipt, OwnerWriteIntent } from "./guarded-owner-writer";
import { ownerReceiptPath, readSidecarNote, readVerifiedProposalEvidence } from "./proposal-evidence";

/** Build a wiki decision page (src/wiki/templates.ts renderWikiPage's section
 * shape) from real, hash-verified evidence — never from unverified prose. */
function renderWrapUpDecisionPage(input: {
  title: string;
  evidenceUri: string;
  evidenceRevision: string;
  note: string | undefined;
  date: string;
}): string {
  const note = input.note?.trim();
  return `# ${input.title}

Version: 0.1.0
Type: decision
Status: draft

## Summary

${note && note.length > 0 ? note : `Decision record from a reviewed keryx workspace proposal — see linked evidence for the full session.`}

## Details

Recorded via a Shared Agent Context (SAC) proposal, accepted by a reviewer with
owner/editor authority. This entry's content is mechanically derived from
hash-verified evidence, not synthesized by this writer — the linked session
export is the source of truth for what actually happened.

## Related Code

- (none recorded automatically — add manually if relevant)

## Related Wiki

- [Wiki Index](../index.md)

## Provenance

- Source: sac-proposal
- Link: ${input.evidenceUri} (sha256 ${input.evidenceRevision})
- Created: ${input.date}
- Updated: ${input.date}

## Changelog

- 0.1.0 - Written by the SAC wiki owner-writer from an accepted proposal.
`;
}

function wikiPageRelativePath(proposalId: string): string {
  // "decisions" is WIKI_PAGE_TYPES's folder for Type: decision.
  return path.posix.join("decisions", `sac-${proposalId}.md`);
}

/**
 * The real wiki `GuardedOwnerWriter` composition. `note` is an optional
 * caller-supplied one-line gist (e.g. from `keryx workspace propose --note`) —
 * attributed clearly in the entry, never presented as evidence itself.
 */
export function createRealWikiOwnerWriter(cwd: string, opts?: { note?: string; now?: () => Date }): {
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
        const raw = await readFile(ownerReceiptPath(cwd, "wiki", intent.workspaceId, intent.idempotencyKey), "utf8");
        return JSON.parse(raw) as OwnerReceipt;
      } catch {
        return undefined;
      }
    },

    async persist(intent) {
      const verified = await readVerifiedProposalEvidence(cwd, intent.workspaceId, intent.proposalId);
      if (!("proposal" in verified)) return verified;
      const { proposal, evidence, content: evidenceContent } = verified;

      const titleLine = evidenceContent.split("\n").find((line) => line.startsWith("# "));
      const title = titleLine ? titleLine.slice(2).trim() : `SAC wrap-up ${proposal.id}`;
      const date = now().toISOString().slice(0, 10);
      const sidecarNote = await readSidecarNote(cwd, intent.workspaceId, intent.proposalId);
      const content = renderWrapUpDecisionPage({
        title: `SAC: ${title}`,
        evidenceUri: evidence.uri,
        evidenceRevision: evidence.revision,
        note: sidecarNote ?? opts?.note,
        date,
      });
      const relativePath = wikiPageRelativePath(proposal.id);

      const guard = await guardOutput({ cwd, content, target: "wiki", source: "tool-output", path: `wiki/${relativePath}` });
      if (!guard.allowed) return { ok: false, code: `security_gate_${guard.reason ?? "blocked"}` };

      await writeFileAtomic(path.join(cwd, ".metaproject", "wiki", relativePath), content);

      // receiptRef/targetRef are schema-typed as workspace-relative `path`s (no `#`,
      // no query strings — see workspace-proposal.schema.json's `path` pattern), so
      // this is a distinct logical path, not a URL-style fragment on targetRef.
      const receipt: OwnerReceipt = {
        receiptRef: `./wiki/${relativePath.replace(/\.md$/, "")}.receipt.json`,
        targetRef: `./wiki/${relativePath}`,
        completedAt: now().toISOString(),
      };
      await writeFileAtomic(ownerReceiptPath(cwd, "wiki", intent.workspaceId, intent.idempotencyKey), `${JSON.stringify(receipt, null, 2)}\n`);
      return receipt;
    },
  };
}
