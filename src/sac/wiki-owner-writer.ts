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
import { guardOutput, prepareOutputForPersistence } from "../security/guard";
import type { KnowledgeOwner, OwnerReceipt, OwnerWriteFailure, OwnerWriteIntent } from "./guarded-owner-writer";
import { applyGuardedTargetWrite, ownerReceiptPath, readSidecarNote, readVerifiedProposalEvidence, recoverStagedOwnerWrite, targetAbsolutePath } from "./proposal-evidence";

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
Status: accepted

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
  recoverReceipt: (intent: OwnerWriteIntent & { owner: KnowledgeOwner }) => Promise<OwnerReceipt | undefined>;
  persist: (intent: OwnerWriteIntent & { owner: KnowledgeOwner }) => Promise<OwnerReceipt | OwnerWriteFailure>;
} {
  const now = opts?.now ?? (() => new Date());

  /** Replays exactly what `persist` staged — the same bytes to the same path. */
  const applyStaged = async (staged: Record<string, unknown>): Promise<{ ok: true } | OwnerWriteFailure> => {
    const relativePath = staged.relativePath as string;
    const content = staged.content as string;
    await writeFileAtomic(path.join(cwd, ".metaproject", "wiki", relativePath), content);
    return { ok: true };
  };

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

    // AFC-27 / flow 237 AC1: the non-mutating restart question. `recover` above
    // only sees a COMMITTED receipt, which is exactly the state a crash in the
    // write window does not leave; this also finishes an interrupted write from
    // this owner's own staging and returns the receipt that attempt prepared.
    async recoverReceipt(intent) {
      return recoverStagedOwnerWrite({ cwd, owner: "wiki", intent, apply: applyStaged });
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
      const output = prepareOutputForPersistence(guard, content);
      if (!output.allowed) return { ok: false, code: `security_gate_${output.reason}` };

      // receiptRef/targetRef are schema-typed as workspace-relative `path`s (no `#`,
      // no query strings — see workspace-proposal.schema.json's `path` pattern), so
      // this is a distinct logical path, not a URL-style fragment on targetRef.
      const receipt: OwnerReceipt = {
        receiptRef: `./wiki/${relativePath.replace(/\.md$/, "")}.receipt.json`,
        targetRef: `./wiki/${relativePath}`,
        completedAt: now().toISOString(),
      };
      // Compare against the base, stage the receipt, then write the page. The
      // page is no longer the first durable thing this function does, and it is
      // no longer written at all when the target holds bytes this owner cannot
      // account for.
      return applyGuardedTargetWrite({
        cwd,
        owner: "wiki",
        intent,
        receipt,
        staged: { relativePath, content: output.content },
        // This owner writes the target's bytes itself, so it knows exactly what
        // the page will hash to — which lets recovery tell "already applied"
        // from "not yet applied" without re-writing anything.
        predictedContent: output.content,
        proposedContent: output.content,
        apply: applyStaged,
      });
    },
  };
}

/** Absolute path of the wiki page a proposal writes — the target of its base-version check. */
export function wikiTargetPath(cwd: string, proposalId: string): string {
  return targetAbsolutePath(cwd, `./wiki/${wikiPageRelativePath(proposalId)}`);
}
