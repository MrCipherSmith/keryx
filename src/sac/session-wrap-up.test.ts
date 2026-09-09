import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
    //
    // `diff-unavailable`, not `diff` (AFC-22, flow 236 T13): this fixture's
    // cwd is a bare temp directory with no git in it, so no working-tree diff
    // was ever taken. Recording `diff` here — as this did — put a zero-byte
    // file under a kind that asserts a measurement, hashing to the same
    // `e3b0c442…` a genuinely clean tree produces.
    expect(resolution.evidence.map((item) => item.kind)).toEqual(["wrap-up", "diff-unavailable", "session"]);

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

  // --- The redaction floor's own announcement (flow 236 T6) ----------------
  //
  // This producer always ran the floor. What it did not do was say so: it wrote
  // the rewritten bytes, recorded `revision` as the sha256 OF the rewritten
  // bytes, and returned a resolution in which nothing distinguished a scrubbed
  // record from an untouched one — so every downstream verifier
  // (`readVerifiedProposalEvidence`, `validateEvidence`,
  // `scanEvidenceSecurityGate`) re-verified the scrubbed form and reported a
  // clean, intact record.
  //
  // The trigger is real: an actual uncommitted change in an actual git repo,
  // collected by the real `gitDiff` and masked by the real guard seam.
  const PLANTED_SECRET = "AKIAIOSFODNN7EXAMPLE";

  test("a wrap-up whose diff evidence the floor rewrote says so, in a hash-verified redaction notice", async () => {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(path.join(cwd, "README.md"), "seed content\n", "utf8");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd });
    await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
    await writeFile(path.join(cwd, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { security: { enabled: true } } }), "utf8");
    await writeFile(path.join(cwd, ".metaproject", "security.config.json"), JSON.stringify({ mode: "advisory" }), "utf8");
    await writeFile(path.join(cwd, "README.md"), `seed content\naws_key = ${PLANTED_SECRET}\n`, "utf8");

    const handle = realSession("Deploy notes");
    const resolution = await resolveSessionWrapUp({ cwd, workspaceId: "workspace-a", sourceRef: sessionEvidenceRef("workspace-a", handle.summary.id) });

    // The diff evidence really was rewritten — still a diff of the real change,
    // with the credential masked.
    const diffItem = resolution.evidence.find((item) => item.kind === "diff")!;
    const diffBody = await readFile(path.join(cwd, diffItem.uri.slice(2)), "utf8");
    expect(diffBody).toContain("aws_key = ");
    expect(diffBody).not.toContain(PLANTED_SECRET);

    // And the resolution says so, rather than leaving the reader to notice.
    const notice = resolution.evidence.find((item) => item.kind === "redaction-notice");
    expect(notice).toBeDefined();
    // Appended last: evidence[0] is still the wrap-up doc every owner writer reads.
    expect(resolution.evidence[0]!.kind).toBe("wrap-up");
    expect(resolution.evidence.at(-1)).toBe(notice!);

    const noticeBody = await readFile(path.join(cwd, notice!.uri.slice(2)), "utf8");
    expect(noticeBody).toContain("## Rewritten");
    expect(noticeBody).toContain(`- ${path.posix.basename(diffItem.uri)}`);
    expect(noticeBody).toMatch(/secret:\d/);
    expect(noticeBody).not.toContain(PLANTED_SECRET);
    expect(notice!.revision).toBe(createHash("sha256").update(noticeBody).digest("hex"));
  });

  test("a wrap-up the floor did not touch carries no redaction notice", async () => {
    const handle = realSession("Nothing sensitive here");
    const resolution = await resolveSessionWrapUp({ cwd, workspaceId: "workspace-a", sourceRef: sessionEvidenceRef("workspace-a", handle.summary.id) });
    expect(resolution.evidence.map((item) => item.kind)).toEqual(["wrap-up", "diff-unavailable", "session"]);
  });

  // --- AFC-22 (flow 236 T13, F236-03) --------------------------------------
  //
  // Measured before this fix, with the real `gitDiff`:
  //
  //   cwd=<not a git repo>                     bytes=0 "no working-tree changes" sha256=e3b0c442…
  //   cwd=<.git/HEAD replaced with "corrupt">  bytes=0 "no working-tree changes" sha256=e3b0c442…
  //   cwd=<a genuinely CLEAN git tree>         bytes=0 "no working-tree changes" sha256=e3b0c442…
  //
  // Three different facts, one byte-identical record — and `revision` was the
  // sha256 of "", so `readVerifiedProposalEvidence`/`validateEvidence` then
  // confirmed an intact record of a measurement that never happened. These two
  // tests induce the corruption for real and pin that the corrupt case and the
  // clean case are no longer the same record.
  test("a CORRUPT repository records an explicit not-measured marker, never an empty diff", async () => {
    execFileSync("git", ["init", "-q"], { cwd });
    await writeFile(path.join(cwd, ".git", "HEAD"), "corrupt", "utf8");

    const handle = realSession("Wrap up over a broken repo");
    const resolution = await resolveSessionWrapUp({ cwd, workspaceId: "workspace-a", sourceRef: sessionEvidenceRef("workspace-a", handle.summary.id) });

    const item = resolution.evidence[1]!;
    expect(item.kind).toBe("diff-unavailable");
    const body = await readFile(path.join(cwd, item.uri.slice(2)), "utf8");
    expect(body).toContain("NOT MEASURED");
    expect(body.length).toBeGreaterThan(0);
    // The hash verifies the marker, so nothing downstream can verify a
    // measurement: it is not the hash of the empty string.
    expect(item.revision).toBe(createHash("sha256").update(body).digest("hex"));
    expect(item.revision).not.toBe(createHash("sha256").update("").digest("hex"));

    // And the wrap-up doc a reviewer reads says so in words rather than
    // reporting a clean tree.
    const wrapUp = await readFile(path.join(cwd, resolution.evidence[0]!.uri.slice(2)), "utf8");
    expect(wrapUp).toContain("NOT MEASURED");
    expect(wrapUp).not.toContain("no working-tree changes");
  });

  test("a genuinely CLEAN git tree still records a real, measured, empty diff", async () => {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(path.join(cwd, "README.md"), "seed content\n", "utf8");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd });

    const handle = realSession("Wrap up over a clean tree");
    const resolution = await resolveSessionWrapUp({ cwd, workspaceId: "workspace-a", sourceRef: sessionEvidenceRef("workspace-a", handle.summary.id) });

    expect(resolution.evidence[1]!.kind).toBe("diff");
    const body = await readFile(path.join(cwd, resolution.evidence[1]!.uri.slice(2)), "utf8");
    expect(body).toBe("");
    const wrapUp = await readFile(path.join(cwd, resolution.evidence[0]!.uri.slice(2)), "utf8");
    expect(wrapUp).toContain("no working-tree changes");
  });
});
