import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRealSkillOwnerWriter } from "./skill-owner-writer";
import { proposalNotePath } from "./proposal-evidence";
import type { OwnerWriteIntent } from "./guarded-owner-writer";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-sac-skill-writer-"));
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

async function seedProposal(cwd: string, evidenceContent: string): Promise<void> {
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

describe("createRealSkillOwnerWriter.authorize", () => {
  test("allows owner and editor, denies anyone else", async () => {
    const writer = createRealSkillOwnerWriter(cwd);
    expect(await writer.authorize(baseIntent)).toBe(true);
    expect(await writer.authorize({ ...baseIntent, reviewerAuthority: "editor" })).toBe(true);
    expect(await writer.authorize({ ...baseIntent, reviewerAuthority: "viewer" as never })).toBe(false);
  });
});

describe("createRealSkillOwnerWriter.persist", () => {
  test("writes a real project skill under the sac module from hash-verified evidence", async () => {
    await seedProposal(cwd, "# Explain WorktreePort\n\n## user\n\nWhat does it do?\n\n## assistant\n\nIt's the git-worktree lifecycle seam.\n");
    const writer = createRealSkillOwnerWriter(cwd, { note: "WorktreePort is the real create/remove/merge seam." });
    const result = await writer.persist({ ...baseIntent, owner: "skill" });

    if (!("receiptRef" in result)) throw new Error(`expected a receipt, got ${JSON.stringify(result)}`);
    expect(result.targetRef).toBe("./project-skills/sac/proposal-a/SKILL.md");

    const written = await readFile(path.join(cwd, ".metaproject", "project-skills", "sac", "proposal-a", "SKILL.md"), "utf8");
    expect(written).toContain("Module: sac");
    expect(written).toContain("Explain WorktreePort");
    expect(written).toContain("WorktreePort is the real create/remove/merge seam.");
  });

  test("refuses to write when the evidence file's content no longer matches its recorded hash", async () => {
    await seedProposal(cwd, "original content");
    await writeFile(
      path.join(cwd, ".metaproject", "workspaces", "workspace-a", "session-evidence", "session-a.md"),
      "tampered content",
      "utf8",
    );
    const writer = createRealSkillOwnerWriter(cwd);
    const result = await writer.persist({ ...baseIntent, owner: "skill" });
    expect(result).toEqual({ ok: false, code: "evidence_revision_mismatch" });
  });

  test("refuses to write when the proposal record itself cannot be read", async () => {
    const writer = createRealSkillOwnerWriter(cwd);
    const result = await writer.persist({ ...baseIntent, owner: "skill" });
    expect(result).toEqual({ ok: false, code: "proposal_record_unreadable" });
  });

  test("recover() finds the receipt persist() wrote, without re-persisting", async () => {
    await seedProposal(cwd, "# Recover check\n\ncontent\n");
    const writer = createRealSkillOwnerWriter(cwd);
    const first = await writer.persist({ ...baseIntent, owner: "skill" });
    if (!("receiptRef" in first)) throw new Error("expected a receipt");
    const recovered = await writer.recover({ ...baseIntent, owner: "skill" });
    expect(recovered).toEqual(first);
  });

  test("prefers the propose-time sidecar note over a constructor-supplied note (propose and accept are separate processes)", async () => {
    await seedProposal(cwd, "# Sidecar note check\n\n## user\n\nWhat changed?\n\n## assistant\n\nWired the sidecar note path.\n");
    await mkdir(path.dirname(proposalNotePath(cwd, "workspace-a", "proposal-a")), { recursive: true });
    await writeFile(proposalNotePath(cwd, "workspace-a", "proposal-a"), "Note written at propose time, read back at accept time.", "utf8");
    const writer = createRealSkillOwnerWriter(cwd);
    const result = await writer.persist({ ...baseIntent, owner: "skill" });

    if (!("receiptRef" in result)) throw new Error(`expected a receipt, got ${JSON.stringify(result)}`);
    const written = await readFile(path.join(cwd, ".metaproject", "project-skills", "sac", "proposal-a", "SKILL.md"), "utf8");
    expect(written).toContain("Note written at propose time, read back at accept time.");
  });

  test("a proposal whose derived skill content trips the security gate in enforced mode is refused, nothing written", async () => {
    // The writer's `target` (and so the rendered SKILL.md) is built from the
    // evidence's title line, not its full body — so the secret has to be IN
    // the title to reach the guarded content.
    const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
    await seedProposal(cwd, `# aws_key = ${AWS_KEY}\n\ncontent\n`);
    await writeFile(
      path.join(cwd, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: { security: { enabled: true } } }),
      "utf8",
    );
    await writeFile(path.join(cwd, ".metaproject", "security.config.json"), JSON.stringify({ mode: "enforced" }), "utf8");

    const writer = createRealSkillOwnerWriter(cwd);
    const result = await writer.persist({ ...baseIntent, owner: "skill" });
    expect("ok" in result && result.ok === false).toBe(true);

    const exists = await readFile(path.join(cwd, ".metaproject", "project-skills", "sac", "proposal-a", "SKILL.md"), "utf8").then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
  });
});
