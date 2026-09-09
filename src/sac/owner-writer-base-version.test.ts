// AFC-27 / flow 237 AC1, owner side. Two guarantees, held by EVERY real owner
// writer rather than by one of them:
//
//  1. Target-side optimistic concurrency. A proposal built against one base must
//     not be applied over a target that has since changed. Before this, foreign
//     bytes planted in the target were silently replaced and the accept reported
//     plain success.
//  2. Crash-window idempotency. The receipt is staged BEFORE the target bytes,
//     and `recoverReceipt` — the non-mutating restart question SAC asks (see
//     `OwnerWriteRecovery` in proposal-lifecycle.ts) — returns the ORIGINAL
//     receipt instead of re-running the write.
//
// The real crash is measured out of process with a real SIGKILL; what these
// tests pin is the contract and the ordering that makes that recovery possible.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { createGuardedOwnerWriter, type KnowledgeOwner, type OwnerReceipt, type OwnerWriteIntent } from "./guarded-owner-writer";
import {
  applyGuardedTargetWrite,
  digestOf,
  ownerReceiptPath,
  ownerStagingDir,
  readStagedOwnerWrite,
  recoverStagedOwnerWrite,
  targetAbsolutePath,
} from "./proposal-evidence";
import { createRealWikiOwnerWriter } from "./wiki-owner-writer";
import { createRealMemoryOwnerWriter } from "./memory-owner-writer";
import { createRealSkillOwnerWriter } from "./skill-owner-writer";
import { supportsOwnerWriteRecovery } from "./proposal-lifecycle";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-sac-owner-base-"));
  await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const baseIntent: OwnerWriteIntent = {
  intentRef: "./proposals/proposal-a.k1.write-intent.json",
  proposalId: "proposal-a",
  proposalRevision: "1",
  workspaceId: "workspace-a",
  correlationId: "corr-1",
  idempotencyKey: "idem-1",
  reviewerSubject: "user:reviewer",
  reviewerAuthority: "owner",
  policyRevision: "policy-r1",
};

/** `WorktreePort` is a routable skill target, so one seed serves all three owners. */
const evidenceContent = "# WorktreePort\n\n## user\n\nWhat does it do?\n\n## assistant\n\nThe git-worktree lifecycle seam.\n";

async function seedProposal(): Promise<void> {
  const evidenceDir = path.join(cwd, ".metaproject", "workspaces", "workspace-a", "session-evidence");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "session-a.md"), evidenceContent, "utf8");
  const proposalsDir = path.join(cwd, ".metaproject", "workspaces", "workspace-a", "proposals");
  await mkdir(proposalsDir, { recursive: true });
  await writeFile(
    path.join(proposalsDir, "proposal-a.json"),
    JSON.stringify({
      id: "proposal-a",
      workspaceId: "workspace-a",
      evidence: [{ kind: "session", uri: "./.metaproject/workspaces/workspace-a/session-evidence/session-a.md", revision: createHash("sha256").update(evidenceContent).digest("hex"), observedAt: "2026-08-13T00:00:00.000Z" }],
    }),
    "utf8",
  );
}

type Writer = ReturnType<typeof createRealWikiOwnerWriter>;

/**
 * Every real owner writer, found by enumerating `src/sac/*-owner-writer.ts`.
 * A guarantee that holds in one of them and not the next is the defect class
 * this programme keeps closing, so each case runs against all of them.
 */
const writers: ReadonlyArray<{ owner: KnowledgeOwner; make: (root: string) => Writer; targetRef: string }> = [
  { owner: "wiki", make: (root) => createRealWikiOwnerWriter(root), targetRef: "./wiki/decisions/sac-proposal-a.md" },
  { owner: "memory", make: (root) => createRealMemoryOwnerWriter(root), targetRef: "./memory/task-notes/sac-proposal-a.md" },
  { owner: "skill", make: (root) => createRealSkillOwnerWriter(root), targetRef: "./project-skills/sac/proposal-a/SKILL.md" },
];

for (const { owner, make, targetRef } of writers) {
  describe(`${owner} owner writer — base version and recovery`, () => {
    test("refuses to overwrite a target holding bytes it cannot account for", async () => {
      await seedProposal();
      const target = targetAbsolutePath(cwd, targetRef);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "FOREIGN CONTENT FROM ANOTHER WRITER\n", "utf8");

      const result = await make(cwd).persist({ ...baseIntent, owner });

      expect("ok" in result && result.ok === false).toBe(true);
      const failure = result as { ok: false; code: string; conflict?: { targetRef: string; expectedVersion: string | null; currentVersion: string | null } };
      expect(failure.code).toBe("version_conflict");
      // `null` is the base a fresh proposal has: its target ref is minted from
      // the immutable proposal id, so at propose time it cannot have existed.
      expect(failure.conflict?.expectedVersion).toBeNull();
      expect(failure.conflict?.currentVersion).toBe(digestOf("FOREIGN CONTENT FROM ANOTHER WRITER\n"));
      expect(failure.conflict?.targetRef).toBe(targetRef);
      // Refusing means refusing: the other writer's bytes are still there.
      expect(await readFile(target, "utf8")).toBe("FOREIGN CONTENT FROM ANOTHER WRITER\n");
    });

    test("an absent target is a create, not a conflict", async () => {
      await seedProposal();
      const result = await make(cwd).persist({ ...baseIntent, owner });

      expect("receiptRef" in result).toBe(true);
      expect((result as OwnerReceipt).targetRef).toBe(targetRef);
      expect((await readFile(targetAbsolutePath(cwd, targetRef), "utf8")).length).toBeGreaterThan(0);
    });

    test("recoverReceipt returns the original receipt for a completed write, and mutates nothing", async () => {
      await seedProposal();
      const writer = make(cwd);
      const first = await writer.persist({ ...baseIntent, owner });
      if (!("receiptRef" in first)) throw new Error(`expected a receipt, got ${JSON.stringify(first)}`);
      const written = await readFile(targetAbsolutePath(cwd, targetRef), "utf8");

      expect(await writer.recoverReceipt({ ...baseIntent, owner })).toEqual(first);
      expect(await readFile(targetAbsolutePath(cwd, targetRef), "utf8")).toBe(written);
    });

    test("recoverReceipt returns nothing when it cannot account for the intent", async () => {
      await seedProposal();
      expect(await make(cwd).recoverReceipt({ ...baseIntent, owner })).toBeUndefined();
    });

    test("recoverReceipt finishes an interrupted write from staging and returns that attempt's receipt", async () => {
      await seedProposal();
      const writer = make(cwd);
      // Run a real write, then reproduce the state a crash between the target
      // write and the receipt commit leaves: the staging journal survives, the
      // committed receipt does not. (The out-of-process probe reaches the same
      // state with a real SIGKILL; this pins the contract deterministically.)
      const first = await writer.persist({ ...baseIntent, owner });
      if (!("receiptRef" in first)) throw new Error(`expected a receipt, got ${JSON.stringify(first)}`);
      const staging = ownerStagingDir(cwd, owner, baseIntent.workspaceId, baseIntent.idempotencyKey);
      await mkdir(staging, { recursive: true });
      await writeFile(path.join(staging, "plan.json"), JSON.stringify({ schemaVersion: "1.0", recordType: "owner-write-staging", owner, proposalId: baseIntent.proposalId, workspaceId: baseIntent.workspaceId, idempotencyKey: baseIntent.idempotencyKey, targetRef, expectedVersion: null, receipt: first, staged: {}, stagedAt: first.completedAt }), "utf8");
      await rm(ownerReceiptPath(cwd, owner, baseIntent.workspaceId, baseIntent.idempotencyKey), { force: true });

      const recovered = await writer.recoverReceipt({ ...baseIntent, owner });

      expect(recovered).toEqual(first);
      // The staging journal is reclaimed only once the receipt is durable again.
      expect(await readStagedOwnerWrite(cwd, owner, baseIntent.workspaceId, baseIntent.idempotencyKey)).toBeUndefined();
      expect(JSON.parse(await readFile(ownerReceiptPath(cwd, owner, baseIntent.workspaceId, baseIntent.idempotencyKey), "utf8"))).toEqual(first);
    });

    test("the guarded writer exposes the recovery capability SAC feature-detects", () => {
      const guarded = createGuardedOwnerWriter({ owner, ...make(cwd) });
      expect(supportsOwnerWriteRecovery(guarded)).toBe(true);
    });
  });
}

describe("applyGuardedTargetWrite — the ordering every owner writer inherits", () => {
  const intent = { ...baseIntent, owner: "wiki" as const };
  const receipt: OwnerReceipt = { receiptRef: "./wiki/decisions/sac-proposal-a.receipt.json", targetRef: "./wiki/decisions/sac-proposal-a.md", completedAt: "2026-09-07T00:00:00.000Z" };

  test("the receipt is durable in staging before the target bytes are applied", async () => {
    let stagedAtApplyTime: OwnerReceipt | undefined;
    let receiptCommittedAtApplyTime = true;

    const result = await applyGuardedTargetWrite({
      cwd,
      owner: "wiki",
      intent,
      receipt,
      staged: { content: "page" },
      apply: async (staged) => {
        stagedAtApplyTime = (await readStagedOwnerWrite(cwd, "wiki", intent.workspaceId, intent.idempotencyKey))?.receipt;
        receiptCommittedAtApplyTime = await readFile(ownerReceiptPath(cwd, "wiki", intent.workspaceId, intent.idempotencyKey), "utf8").then(() => true, () => false);
        await mkdir(path.dirname(targetAbsolutePath(cwd, receipt.targetRef)), { recursive: true });
        await writeFile(targetAbsolutePath(cwd, receipt.targetRef), staged.content as string, "utf8");
        return { ok: true };
      },
    });

    expect(result).toEqual(receipt);
    // This is the whole fix: "no receipt on disk" no longer means "nothing was
    // written", because the receipt is staged first and the commit is last.
    expect(stagedAtApplyTime).toEqual(receipt);
    expect(receiptCommittedAtApplyTime).toBe(false);
  });

  test("a failed apply leaves no staging behind, so a later attempt is a fresh one", async () => {
    const result = await applyGuardedTargetWrite({ cwd, owner: "wiki", intent, receipt, staged: {}, apply: async () => ({ ok: false, code: "owner_refused" }) });

    expect(result).toEqual({ ok: false, code: "owner_refused" });
    expect(await readStagedOwnerWrite(cwd, "wiki", intent.workspaceId, intent.idempotencyKey)).toBeUndefined();
  });

  test("recoverStagedOwnerWrite applies the staged bytes when the crash landed before the target write", async () => {
    const staging = ownerStagingDir(cwd, "wiki", intent.workspaceId, intent.idempotencyKey);
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, "plan.json"), JSON.stringify({ schemaVersion: "1.0", recordType: "owner-write-staging", owner: "wiki", proposalId: intent.proposalId, workspaceId: intent.workspaceId, idempotencyKey: intent.idempotencyKey, targetRef: receipt.targetRef, expectedVersion: null, receipt, staged: { content: "recovered page" }, stagedAt: receipt.completedAt }), "utf8");

    const recovered = await recoverStagedOwnerWrite({
      cwd,
      owner: "wiki",
      intent,
      apply: async (staged) => {
        await mkdir(path.dirname(targetAbsolutePath(cwd, receipt.targetRef)), { recursive: true });
        await writeFile(targetAbsolutePath(cwd, receipt.targetRef), staged.content as string, "utf8");
        return { ok: true };
      },
    });

    expect(recovered).toEqual(receipt);
    expect(await readFile(targetAbsolutePath(cwd, receipt.targetRef), "utf8")).toBe("recovered page");
  });

  test("recovery never re-applies a write that already landed", async () => {
    const staging = ownerStagingDir(cwd, "wiki", intent.workspaceId, intent.idempotencyKey);
    await mkdir(path.dirname(targetAbsolutePath(cwd, receipt.targetRef)), { recursive: true });
    await writeFile(targetAbsolutePath(cwd, receipt.targetRef), "already applied", "utf8");
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, "plan.json"), JSON.stringify({ schemaVersion: "1.0", recordType: "owner-write-staging", owner: "wiki", proposalId: intent.proposalId, workspaceId: intent.workspaceId, idempotencyKey: intent.idempotencyKey, targetRef: receipt.targetRef, expectedVersion: null, predictedVersion: digestOf("already applied"), receipt, staged: { content: "already applied" }, stagedAt: receipt.completedAt }), "utf8");

    let applied = 0;
    const recovered = await recoverStagedOwnerWrite({ cwd, owner: "wiki", intent, apply: async () => { applied += 1; return { ok: true }; } });

    expect(recovered).toEqual(receipt);
    expect(applied).toBe(0);
  });
});
