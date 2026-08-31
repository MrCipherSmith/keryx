// Real "skill" GuardedOwnerWriter composition (proposal-lifecycle.ts
// createLocalOwnerWriterAdapters ships wiki/memory/skill all `unavailable` —
// "fail closed until each owning subsystem composes its own trusted write/recovery
// implementation; SAC never edits Wiki, Memory or Skills files itself." This is
// skill's real composition, mirroring memory-owner-writer.ts / wiki-owner-writer.ts.
//
// Unlike memory and wiki, this owner had a SECOND, independent blocker beyond
// "no composition exists": `createProjectSkill` (src/gdskills/project-skills.ts)
// ran no security scan at all before this same change added `guardOutput({
// target: "skill" })` to it. Both prerequisites — the guard, and
// `ProposalLifecycleService.targetWriteOrStale`'s owner-prefix check knowing
// that real skills live under `.metaproject/project-skills/`, not
// `.metaproject/skill/` (see `ownerTargetPrefix` in proposal-lifecycle.ts) —
// are what made this composition possible at all.
//
// SAC hands `persist()` only identifiers; the proposal record it reads (durably
// written by `create()` before this ever runs) carries the wrap-up's real,
// hash-verified evidence (shared plumbing: proposal-evidence.ts). This writer
// reuses `createProjectSkill` itself — including its own security guard,
// evidence collection, manifest/catalog update, and file locking — rather than
// writing `.metaproject/project-skills/` files a second, parallel way.
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../lib/fs";
import { createProjectSkill, isRoutableSkillTarget } from "../gdskills/project-skills";
import type { KnowledgeOwner, OwnerReceipt, OwnerWriteIntent } from "./guarded-owner-writer";
import { ownerReceiptPath, readSidecarNote, readVerifiedProposalEvidence } from "./proposal-evidence";

function titleFrom(evidenceContent: string, proposalId: string): string {
  const titleLine = evidenceContent.split("\n").find((line) => line.startsWith("# "));
  return titleLine ? titleLine.slice(2).trim() : `proposal ${proposalId}`;
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "error";
}

/**
 * The real skill `GuardedOwnerWriter` composition. Every SAC-derived skill lands
 * under the fixed `sac` module so it is always distinguishable from a skill a
 * person created via `keryx skills create` directly.
 *
 * `note` — an optional caller-supplied one-line gist, e.g. from
 * `keryx workspace propose --note` — used to be folded into the skill's
 * `target`, described in this comment as a "description". That one word was the
 * defect: `target` is a ROUTING KEY, not a description. `keryx skills route`
 * matches queries against it and `verify` resolves it as a path, so a prose
 * sentence there produces a skill that matches nothing and verifies as
 * permanently stale. Two such skills reached the registry on `main`, each
 * carrying a whole wrap-up sentence as its target and `Target exists: false`.
 *
 * The note itself is not the problem and is still written — it is the one piece
 * of human context a wrap-up carries — but through `createProjectSkill`'s own
 * `note` field, which renders it under Purpose and keeps it out of `target`,
 * the frontmatter description, and the match list.
 *
 * What IS refused now is an unroutable title. This owner has no structured
 * target to fall back on — the proposal record carries `{ id, workspaceId,
 * evidence }` and nothing else — so a skill it cannot name properly is a skill
 * it should not write. That is the fail-closed posture the rest of this file
 * already takes, and an absent skill is cheaper than a permanently stale one.
 */
export function createRealSkillOwnerWriter(cwd: string, opts?: { note?: string; now?: () => Date }): {
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
        const raw = await readFile(ownerReceiptPath(cwd, "skill", intent.workspaceId, intent.idempotencyKey), "utf8");
        return JSON.parse(raw) as OwnerReceipt;
      } catch {
        return undefined;
      }
    },

    async persist(intent) {
      const verified = await readVerifiedProposalEvidence(cwd, intent.workspaceId, intent.proposalId);
      if (!("proposal" in verified)) return verified;
      const { proposal, content: evidenceContent } = verified;

      const target = titleFrom(evidenceContent, proposal.id).trim();
      const sidecarNote = await readSidecarNote(cwd, intent.workspaceId, intent.proposalId);
      const note = (sidecarNote ?? opts?.note)?.trim();
      if (!isRoutableSkillTarget(target)) {
        // A wrap-up title is usually a summary of work, not the name of a thing
        // a reviewer or implementer would later look up. When it is a summary,
        // the honest result is no skill at all: an unroutable skill is worse
        // than a missing one, because it occupies the registry, fails every
        // verification, and reads to the next author as coverage of something.
        return { ok: false, code: "skill_write_refused_unroutable_target" };
      }

      let result: Awaited<ReturnType<typeof createProjectSkill>>;
      try {
        result = await createProjectSkill(cwd, { target, note, module: "sac", name: proposal.id, format: "single" });
      } catch (cause) {
        // createProjectSkill throws when its own security guard blocks the
        // write (or on other real failures, e.g. metaproject not initialized) —
        // never silently swallowed, but always surfaced as a normal `{ok:false}`
        // through this owner's contract rather than an uncaught exception.
        return { ok: false, code: `skill_write_failed_${slug(cause instanceof Error ? cause.message : String(cause))}` };
      }

      // `result.skillPath` is relative to `cwd` and already includes the
      // leading `.metaproject/` segment (createProjectSkill computes it via
      // `path.relative(projectRoot, packageRoot)`) — strip it, since
      // receiptRef/targetRef are relative to `.metaproject/` itself, the same
      // convention memory/wiki already use (`./memory/...`, `./wiki/...`).
      const withoutMetaprojectPrefix = result.skillPath.replace(/^\.metaproject\//, "");
      const receipt: OwnerReceipt = {
        receiptRef: `./${withoutMetaprojectPrefix}/SKILL.md.receipt.json`,
        targetRef: `./${withoutMetaprojectPrefix}/SKILL.md`,
        completedAt: now().toISOString(),
      };
      await writeFileAtomic(ownerReceiptPath(cwd, "skill", intent.workspaceId, intent.idempotencyKey), `${JSON.stringify(receipt, null, 2)}\n`);
      return receipt;
    },
  };
}
