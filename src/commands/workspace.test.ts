import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkspaceManifest } from "../sac/workspace-service";
import { confirmTokenPath } from "../sac/review-confirm-token";
import { createSession, persistHistory } from "../session/index";

const cli = path.join(import.meta.dir, "..", "cli.ts");
async function invoke(cwd: string, args: string[], dataDir?: string) {
  const child = Bun.spawn([process.execPath, cli, "workspace", ...args], {
    cwd, stdout: "pipe", stderr: "pipe",
    ...(dataDir ? { env: { ...process.env, KERYX_DATA_DIR: dataDir } } : {}),
  });
  return { exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

test("workspace overview --explain keeps JSON on stdout and FWK labels on stderr", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-explain-"));
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "a.ts"), "export {};\n");
  const created = await invoke(cwd, ["create", "--title", "Explain workspace", "--component", "./src/a.ts"]);
  expect(created.exitCode).toBe(0);
  const manifest = JSON.parse(created.stdout) as { id: string };
  const overview = await invoke(cwd, ["overview", manifest.id, "--explain"]);
  expect(overview.exitCode).toBe(0);
  expect(JSON.parse(overview.stdout)).toHaveProperty("manifest");
  expect(overview.stderr).toContain("SAC explain (FWK — Facts / Work / Know-how)");
  expect(overview.stderr).toContain("Know-how");
  expect(overview.stderr).toContain("graph nodes/edges (navigation only)");
});

test("workspace CLI exposes only offline create/list/show/add-resource and guarded read operations", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-cli-")); await mkdir(path.join(cwd, "src")); await writeFile(path.join(cwd, "src", "a.ts"), "export {};\n");
  const created = await invoke(cwd, ["create", "--title", "CLI workspace", "--component", "./src/a.ts"]);
  expect(created.exitCode).toBe(0); const manifest = JSON.parse(created.stdout) as { id: string };
  expect((await invoke(cwd, ["list"])).stdout).toContain(manifest.id);
  expect((await invoke(cwd, ["show", manifest.id])).stdout).toContain("CLI workspace");
  const unknownActor = await invoke(cwd, ["create", "--title", "No actor flag", "--actor", "user:other"]);
  expect(unknownActor.exitCode).toBe(1);
  expect((await invoke(cwd, ["add-resource", manifest.id, "--kind", "component", "--uri", "../escape"])).exitCode).toBe(1);
});

// --- WSL-1..4 CLI subcommands (`archive`, `remove-resource`, `rename`,
// `list --include-archived`) do not exist yet — see
// docs/requirements/sac-workspace-lifecycle/specification.md. These tests are
// expected to fail red (unknown workspace command / unknown option) until
// task-implementer wires the new CLI subcommands into src/commands/workspace.ts.

test("workspace archive marks the workspace archived and hides it from list unless --include-archived is passed", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-archive-cli-"));
  const created = await invoke(cwd, ["create", "--title", "Archive Me"]);
  expect(created.exitCode).toBe(0); const manifest = JSON.parse(created.stdout) as { id: string };
  const archived = await invoke(cwd, ["archive", manifest.id]);
  expect(archived.exitCode).toBe(0);
  expect(JSON.parse(archived.stdout)).toMatchObject({ id: manifest.id, status: "archived" });
  const defaultList = await invoke(cwd, ["list"]);
  expect(defaultList.stdout).not.toContain(manifest.id);
  const withArchived = await invoke(cwd, ["list", "--include-archived"]);
  expect(withArchived.stdout).toContain(manifest.id);
});

test("workspace list --include-archived=<value> parses the `=` spelling the same as every other option in this file, and refuses an unrecognized value instead of silently hiding archived workspaces", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-includearchived-cli-"));
  const created = await invoke(cwd, ["create", "--title", "Include Archived Me"]);
  expect(created.exitCode).toBe(0); const manifest = JSON.parse(created.stdout) as { id: string };
  expect((await invoke(cwd, ["archive", manifest.id])).exitCode).toBe(0);

  const bare = await invoke(cwd, ["list", "--include-archived"]);
  expect(bare.exitCode).toBe(0); expect(bare.stdout).toContain(manifest.id);

  const equalsTrue = await invoke(cwd, ["list", "--include-archived=true"]);
  expect(equalsTrue.exitCode).toBe(0); expect(equalsTrue.stdout).toContain(manifest.id);

  const equalsFalse = await invoke(cwd, ["list", "--include-archived=false"]);
  expect(equalsFalse.exitCode).toBe(0); expect(equalsFalse.stdout).not.toContain(manifest.id);

  const noFlag = await invoke(cwd, ["list"]);
  expect(noFlag.exitCode).toBe(0); expect(noFlag.stdout).not.toContain(manifest.id);

  const unrecognized = await invoke(cwd, ["list", "--include-archived=maybe"]);
  expect(unrecognized.exitCode).toBe(1);
  expect(unrecognized.stderr).toContain("--include-archived");
});

test("workspace remove-resource removes a resource by uri and rejects a uri that was never added", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-removeresource-cli-")); await mkdir(path.join(cwd, "src")); await writeFile(path.join(cwd, "src", "a.ts"), "export {};\n");
  const created = await invoke(cwd, ["create", "--title", "Remove Resource Me", "--component", "./src/a.ts"]);
  expect(created.exitCode).toBe(0); const manifest = JSON.parse(created.stdout) as { id: string };
  const removed = await invoke(cwd, ["remove-resource", manifest.id, "--uri", "./src/a.ts"]);
  expect(removed.exitCode).toBe(0);
  const removedManifest = JSON.parse(removed.stdout) as { resources: unknown[] };
  expect(removedManifest.resources).toEqual([]);
  const missing = await invoke(cwd, ["remove-resource", manifest.id, "--uri", "./src/missing.ts"]);
  expect(missing.exitCode).toBe(1);
});

test("workspace rename updates the title and it is visible via a subsequent show", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-rename-cli-"));
  const created = await invoke(cwd, ["create", "--title", "Original CLI Title"]);
  expect(created.exitCode).toBe(0); const manifest = JSON.parse(created.stdout) as { id: string };
  const renamed = await invoke(cwd, ["rename", manifest.id, "--title", "New CLI Title"]);
  expect(renamed.exitCode).toBe(0);
  expect(JSON.parse(renamed.stdout)).toMatchObject({ id: manifest.id, title: "New CLI Title" });
  const shown = await invoke(cwd, ["show", manifest.id]);
  expect(shown.stdout).toContain("New CLI Title");
  expect(shown.stdout).not.toContain("Original CLI Title");
});

test("workspace CLI ships no member-management or delete subcommand (AC-7, AC-8)", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-nongoal-cli-"));
  const created = await invoke(cwd, ["create", "--title", "Non-goal Check"]);
  expect(created.exitCode).toBe(0); const manifest = JSON.parse(created.stdout) as { id: string };
  expect((await invoke(cwd, ["add-member", manifest.id, "--subject", "user:other", "--role", "editor"])).exitCode).toBe(1);
  expect((await invoke(cwd, ["remove-member", manifest.id, "--subject", "user:other"])).exitCode).toBe(1);
  expect((await invoke(cwd, ["delete", manifest.id])).exitCode).toBe(1);
});

test("F-001 fix: workspace list-proposals denies access for actor with no role in that workspace", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-listproposals-norole-"));
  const created = await invoke(cwd, ["create", "--title", "List Proposals Test"]);
  expect(created.exitCode).toBe(0);
  const manifest = JSON.parse(created.stdout) as WorkspaceManifest;

  // Manually remove the local actor from the workspace manifest to simulate
  // "no role" — the actor created it but is no longer in the members list.
  const workspaceDir = path.join(cwd, ".metaproject", "workspaces", manifest.id);
  const manifestPath = path.join(workspaceDir, "workspace.json");
  const manifestContent = await Bun.file(manifestPath).text();
  const currentManifest = JSON.parse(manifestContent) as WorkspaceManifest;
  const noActorManifest: WorkspaceManifest = { ...currentManifest, members: [], updatedAt: new Date().toISOString() };
  // Restore one owner (required by schema) that is not the local actor
  noActorManifest.members.push({ subject: "user:other-owner", role: "owner" });
  await Bun.write(manifestPath, JSON.stringify(noActorManifest, null, 2) + "\n");

  // Now try to list-proposals for this workspace — should fail with authorization error
  const listResult = await invoke(cwd, ["list-proposals", manifest.id]);
  expect(listResult.exitCode).toBe(1);
  // The authorization gate throws WorkspaceServiceError with code "access_denied",
  // but the message is the authorization result code ("role_revoked" for no role)
  expect(listResult.stderr).toContain("role_revoked");
});

// The security acknowledgement has to be REAL. `consumeConfirmToken` refuses a
// `needs-approval` proposal unless the token carries `securityAcknowledged:
// true`, and the CLI used to pass that literal on every invocation — so the gate
// could not fire, and the error text promising "explicit human acknowledgement
// of the proposal security findings" described something that never happened.
//
// Reverting to the pre-0.2.74 shape is not the fix either: with no flag at all,
// a `needs-approval` proposal could never be accepted by any route. A dead end
// and a silent bypass are both wrong. These two tests pin the middle: the gate
// refuses without the flag, and honours it with one.
async function seedProposal(cwd: string, workspaceId: string, proposalId: string, gate: "pass" | "needs-approval"): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "workspaces", workspaceId, "proposals");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${proposalId}.json`),
    `${JSON.stringify({ schemaVersion: "1.0", id: proposalId, workspaceId, security: { gate, redacted: true }, evidence: [{ uri: "./evidence/secret.txt" }] })}\n`,
  );
}

test("confirm-review refuses a needs-approval proposal until the reviewer acknowledges the finding", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-confirm-review-gate-"));
  await seedProposal(cwd, "workspace-a", "proposal-a", "needs-approval");

  const refused = await invoke(cwd, ["confirm-review", "workspace-a", "proposal-a"]);
  expect(refused.exitCode).toBe(1);
  // The reviewer is told WHAT they would be acknowledging — an acknowledgement
  // of something never shown is the defect, not the fix.
  expect(refused.stderr).toContain("needs-approval");
  expect(refused.stderr).toContain("./evidence/secret.txt");
  expect(refused.stderr).toContain("--acknowledge-security");

  const acknowledged = await invoke(cwd, ["confirm-review", "workspace-a", "proposal-a", "--acknowledge-security"]);
  expect(acknowledged.exitCode).toBe(0);
  const minted = JSON.parse(acknowledged.stdout) as { token: string; securityGate: string; securityAcknowledged: boolean };
  expect(minted.token).toBeTruthy();
  expect(minted.securityGate).toBe("needs-approval");
  expect(minted.securityAcknowledged).toBe(true);
  // Assert the STORED token, not the printed line. The first draft of this test
  // checked stdout only, and restoring the exact shipped
  // `securityAcknowledged: true` left it green — a test that reads the report
  // instead of the thing, which is the same defect it was written to catch.
  const stored = JSON.parse(await readFile(confirmTokenPath(cwd, "workspace-a", "proposal-a"), "utf8")) as { securityAcknowledged?: boolean };
  expect(stored.securityAcknowledged).toBe(true);
});

test("confirm-review does not claim an acknowledgement a clean proposal never needed, and refuses one it cannot read", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-confirm-review-pass-"));
  await seedProposal(cwd, "workspace-a", "proposal-clean", "pass");

  const clean = await invoke(cwd, ["confirm-review", "workspace-a", "proposal-clean"]);
  expect(clean.exitCode).toBe(0);
  const minted = JSON.parse(clean.stdout) as { securityGate: string; securityAcknowledged: boolean };
  expect(minted.securityGate).toBe("pass");
  // Not `true`: a token for a clean proposal must not carry a claim that a human
  // reviewed findings, because there were none and nobody did. Checked on disk,
  // because the printed value and the persisted value are different claims.
  expect(minted.securityAcknowledged).toBe(false);
  const storedClean = JSON.parse(await readFile(confirmTokenPath(cwd, "workspace-a", "proposal-clean"), "utf8")) as { securityAcknowledged?: boolean };
  expect(storedClean.securityAcknowledged).toBeUndefined();

  // "I could not read the gate" is not "the gate passed".
  const missing = await invoke(cwd, ["confirm-review", "workspace-a", "proposal-absent"]);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain("security gate is unknown");
});

test("workspace propose refuses a note the security gate blocks, and creates no proposal", async () => {
  // The same guard exists in two places — this CLI handler and the harness
  // `workspace_propose` tool — and only the harness copy had a test. A guard
  // duplicated across write paths is only as good as its least-tested copy, and
  // this is the copy a human runs.
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-blocked-note-"));
  await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
  await writeFile(path.join(cwd, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { security: { enabled: true } } }), "utf8");
  await writeFile(path.join(cwd, ".metaproject", "security.config.json"), JSON.stringify({ mode: "enforced" }), "utf8");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "a.ts"), "export {};\n");

  const created = await invoke(cwd, ["create", "--title", "Blocked note workspace", "--component", "./src/a.ts"]);
  expect(created.exitCode).toBe(0);
  const { id: workspaceId } = JSON.parse(created.stdout) as { id: string };

  // A REAL session, in a data dir the child process shares. Without it, propose
  // fails on "no session matching" — which is exit 1 either way, so the first
  // draft of this test passed while the mutation went unnoticed. The control
  // below proves the session is good, so the failure that follows can only come
  // from the note.
  const dataDir = await mkdtemp(path.join(tmpdir(), "keryx-workspace-blocked-note-data-"));
  const handle = createSession({ cwd, title: "Blocked note session", dataDir, provider: "deepseek", model: "deepseek-v4-flash" });
  persistHistory(handle, [
    { role: "user", content: "What does the WorktreePort interface do?", provenance: "project" },
    { role: "assistant", content: "It's the create/remove/merge git-worktree lifecycle seam.", provenance: "model" },
  ]);

  const clean = await invoke(cwd, ["propose", workspaceId, "--kind", "memory-entry", "--session", handle.summary.id, "--note", "an ordinary note"], dataDir);
  if (clean.exitCode !== 0) throw new Error(`control propose failed: ${clean.stderr}`);
  expect(clean.exitCode).toBe(0);

  const proposed = await invoke(cwd, [
    "propose", workspaceId, "--kind", "memory-entry", "--session", handle.summary.id, "--note", `aws_key = AKIA${"A".repeat(16)}`,
  ], dataDir);
  expect(proposed.exitCode).toBe(1);

  // Refusal must be more than a message: nothing durable may exist afterwards.
  // Exactly one proposal exists — the clean one. The blocked note added nothing.
  const landed = await readdir(path.join(cwd, ".metaproject", "workspaces", workspaceId, "proposals")).catch(() => [] as string[]);
  expect(landed.filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
});
