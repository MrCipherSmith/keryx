import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRealMemoryOwnerWriter, proposalNotePath } from "./memory-owner-writer";
import type { OwnerWriteIntent } from "./guarded-owner-writer";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-sac-memory-writer-"));
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

async function seedProposal(evidenceContent: string): Promise<void> {
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
      evidence: [
        {
          kind: "session",
          uri: "./.metaproject/workspaces/workspace-a/session-evidence/session-a.md",
          revision: createHash("sha256").update(evidenceContent).digest("hex"),
          observedAt: "2026-08-13T00:00:00.000Z",
        },
      ],
    }),
    "utf8",
  );
}

describe("createRealMemoryOwnerWriter.authorize", () => {
  test("allows owner and editor, denies anyone else", async () => {
    const writer = createRealMemoryOwnerWriter(cwd);
    expect(await writer.authorize(baseIntent)).toBe(true);
    expect(await writer.authorize({ ...baseIntent, reviewerAuthority: "editor" })).toBe(true);
    expect(await writer.authorize({ ...baseIntent, reviewerAuthority: "viewer" as never })).toBe(false);
  });
});

describe("createRealMemoryOwnerWriter.persist", () => {
  test("writes a real, schema-valid memory entry from hash-verified evidence", async () => {
    await seedProposal("# Explain WorktreePort\n\n## user\n\nWhat does it do?\n\n## assistant\n\nIt's the git-worktree lifecycle seam.\n");
    const writer = createRealMemoryOwnerWriter(cwd, { note: "WorktreePort is the real create/remove/merge seam." });
    const result = await writer.persist({ ...baseIntent, owner: "memory" });

    if (!("receiptRef" in result)) throw new Error(`expected a receipt, got ${JSON.stringify(result)}`);
    expect(result.targetRef).toBe("./memory/task-notes/sac-proposal-a.md");

    const written = await readFile(path.join(cwd, ".metaproject", "memory", "task-notes", "sac-proposal-a.md"), "utf8");
    expect(written).toContain("Type: task-note");
    // Written only after an owner/editor has already accepted the proposal —
    // the entry must not claim "draft" while its own body says "accepted by
    // a reviewer".
    expect(written).toContain("Status: accepted");
    expect(written).toContain("WorktreePort is the real create/remove/merge seam.");
    expect(written).toContain("./.metaproject/workspaces/workspace-a/session-evidence/session-a.md");
  });

  test("refuses to write when the evidence file's content no longer matches its recorded hash", async () => {
    await seedProposal("original content");
    // Tamper with the evidence after the proposal recorded its hash.
    await writeFile(
      path.join(cwd, ".metaproject", "workspaces", "workspace-a", "session-evidence", "session-a.md"),
      "tampered content",
      "utf8",
    );
    const writer = createRealMemoryOwnerWriter(cwd);
    const result = await writer.persist({ ...baseIntent, owner: "memory" });
    expect(result).toEqual({ ok: false, code: "evidence_revision_mismatch" });
  });

  test("refuses to write when the proposal record itself cannot be read", async () => {
    const writer = createRealMemoryOwnerWriter(cwd);
    const result = await writer.persist({ ...baseIntent, owner: "memory" });
    expect(result).toEqual({ ok: false, code: "proposal_record_unreadable" });
  });

  test("recover() finds the receipt persist() wrote, without re-persisting", async () => {
    await seedProposal("# Recover check\n\ncontent\n");
    const writer = createRealMemoryOwnerWriter(cwd);
    const first = await writer.persist({ ...baseIntent, owner: "memory" });
    if (!("receiptRef" in first)) throw new Error("expected a receipt");
    const recovered = await writer.recover({ ...baseIntent, owner: "memory" });
    expect(recovered).toEqual(first);
  });

  test("prefers the propose-time sidecar note over a constructor-supplied note (propose and accept are separate processes)", async () => {
    await seedProposal("# Sidecar note check\n\n## user\n\nWhat changed?\n\n## assistant\n\nWired the sidecar note path.\n");
    await mkdir(path.dirname(proposalNotePath(cwd, "workspace-a", "proposal-a")), { recursive: true });
    await writeFile(proposalNotePath(cwd, "workspace-a", "proposal-a"), "Note written at propose time, read back at accept time.", "utf8");
    // A fresh writer instance with NO constructor note, exactly like the `review`
    // CLI handler which composes a new service without the propose-time note.
    const writer = createRealMemoryOwnerWriter(cwd);
    const result = await writer.persist({ ...baseIntent, owner: "memory" });

    if (!("receiptRef" in result)) throw new Error(`expected a receipt, got ${JSON.stringify(result)}`);
    const written = await readFile(path.join(cwd, ".metaproject", "memory", "task-notes", "sac-proposal-a.md"), "utf8");
    expect(written).toContain("Note written at propose time, read back at accept time.");
    expect(written).not.toContain("Wrap-up from a reviewed keryx workspace proposal");
  });
});
