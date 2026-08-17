import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { createSession, persistHistory } from "../session/store";
import { resolveSessionWrapUp, sessionEvidenceRef, SessionWrapUpError } from "./session-wrap-up";

let cwd: string;
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-sac-wrapup-cwd-"));
  dataDir = await mkdtemp(path.join(tmpdir(), "keryx-sac-wrapup-data-"));
  originalDataDir = process.env.KERYX_DATA_DIR;
  process.env.KERYX_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (originalDataDir !== undefined) process.env.KERYX_DATA_DIR = originalDataDir;
  else delete process.env.KERYX_DATA_DIR;
  await rm(cwd, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

function realSession(title: string) {
  const handle = createSession({ cwd, title, provider: "deepseek", model: "deepseek-v4-flash" });
  return persistHistory(handle, [
    { role: "user", content: "What does the WorktreePort interface do?", provenance: "project" },
    { role: "assistant", content: "It's the create/remove/merge git-worktree lifecycle seam.", provenance: "model" },
  ]);
}

describe("resolveSessionWrapUp", () => {
  test("rejects a session that does not exist", async () => {
    await expect(
      resolveSessionWrapUp({ cwd, workspaceId: "workspace-a", sourceRef: sessionEvidenceRef("workspace-a", "no-such-session") }),
    ).rejects.toThrow(SessionWrapUpError);
  });

  test("rejects a sourceRef that does not match the canonical path for a real session (spoofed workspace segment)", async () => {
    const handle = realSession("real one");
    await expect(
      resolveSessionWrapUp({ cwd, workspaceId: "workspace-a", sourceRef: sessionEvidenceRef("workspace-OTHER", handle.summary.id) }),
    ).rejects.toThrow(SessionWrapUpError);
  });

  test("rejects a freshly-created session with no real exchange", async () => {
    const handle = createSession({ cwd, title: "empty" });
    await expect(
      resolveSessionWrapUp({ cwd, workspaceId: "workspace-a", sourceRef: sessionEvidenceRef("workspace-a", handle.summary.id) }),
    ).rejects.toThrow(/nothing to wrap up/);
  });

  test("exports the real session archive into the workspace and hash-verifies it", async () => {
    const handle = realSession("Explain WorktreePort");
    const resolution = await resolveSessionWrapUp({ cwd, workspaceId: "workspace-a", sourceRef: sessionEvidenceRef("workspace-a", handle.summary.id) });

    expect(resolution.workspaceId).toBe("workspace-a");
    expect(resolution.summary).toContain("Explain WorktreePort");

    // SLATE-21: primary evidence (evidence[0], what readVerifiedProposalEvidence
    // hands every owner writer) is the compact wrap-up doc, never the raw
    // transcript — the full transcript is still exported and hash-verified,
    // but only as the LAST, reference/attachment evidence item.
    expect(resolution.evidence.map((item) => item.kind)).toEqual(["wrap-up", "diff", "session"]);

    const wrapUp = resolution.evidence[0]!;
    expect(wrapUp.uri.startsWith("./.metaproject/workspaces/workspace-a/session-evidence/")).toBe(true);
    const wrapUpContent = await readFile(path.join(cwd, wrapUp.uri.slice(2)), "utf8");
    expect(wrapUpContent).toContain("# Explain WorktreePort");
    expect(wrapUpContent).toContain("## Course");
    expect(wrapUpContent).toContain("## Seeds");
    expect(wrapUpContent).toContain("## Working-tree diff");
    expect(createHash("sha256").update(wrapUpContent).digest("hex")).toBe(wrapUp.revision);

    const sessionEvidence = resolution.evidence[2]!;
    expect(sessionEvidence.uri.startsWith("./.metaproject/workspaces/workspace-a/session-evidence/")).toBe(true);
    const exportedContent = await readFile(path.join(cwd, sessionEvidence.uri.slice(2)), "utf8");
    expect(exportedContent).toContain("WorktreePort");
    expect(createHash("sha256").update(exportedContent).digest("hex")).toBe(sessionEvidence.revision);

    // Real expiry, not a fabricated far-future date.
    expect(new Date(resolution.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test("two resolutions of the same session are independently re-exported and re-hashed (idempotent content)", async () => {
    const handle = realSession("Second look");
    const ref = sessionEvidenceRef("workspace-a", handle.summary.id);
    const first = await resolveSessionWrapUp({ cwd, workspaceId: "workspace-a", sourceRef: ref });
    const second = await resolveSessionWrapUp({ cwd, workspaceId: "workspace-a", sourceRef: ref });
    expect(first.evidence[0]!.revision).toBe(second.evidence[0]!.revision);
    expect(first.evidence[2]!.revision).toBe(second.evidence[2]!.revision);
  });

  test("a session with no Slate engagement still wraps up — sparse Course/Seeds, never a thrown error", async () => {
    const handle = realSession("Plain chat, no slate opened");
    const resolution = await resolveSessionWrapUp({ cwd, workspaceId: "workspace-a", sourceRef: sessionEvidenceRef("workspace-a", handle.summary.id) });
    const wrapUpContent = await readFile(path.join(cwd, resolution.evidence[0]!.uri.slice(2)), "utf8");
    expect(wrapUpContent).toContain("flow: unbound");
    expect(wrapUpContent).toContain("(no Seeds captured this session)");
  });
});
