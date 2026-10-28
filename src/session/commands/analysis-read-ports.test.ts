import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createAnalysisReadPorts, validateAnalysisReadArgv } from "./analysis-read-ports";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const result = await mkdtemp(path.join(tmpdir(), "native-analysis-ports-")); roots.push(result); return result; }

test("only source-backed GitHub read argv shapes are admitted; no mutation or arbitrary API route", () => {
  const allowed = [
    ["gh", "pr", "view", "--json", "number,headRefName"],
    ["gh", "pr", "view", "--json", "number,title"],
    ["gh", "run", "list", "--branch", "feature/example", "--json", "databaseId,conclusion,workflowName,headBranch,createdAt", "-L", "20"],
    ["gh", "run", "view", "123", "--json", "jobs,workflowName,headBranch,headSha,conclusion"],
    ["gh", "run", "view", "123", "--attempt", "2", "--json", "jobs"],
    ["gh", "run", "view", "123", "--log-failed"],
    ["gh", "run", "list", "--workflow", "CI", "--commit", "a".repeat(40), "--json", "databaseId,conclusion,createdAt,headBranch", "-L", "10"],
    ["gh", "api", "repos/{owner}/{repo}/commits/" + "b".repeat(40), "--jq", ".files[].filename"],
  ];
  for (const argv of allowed) expect(validateAnalysisReadArgv(argv).ok).toBe(true);
  for (const argv of [["sh", "-c", "anything"], ["gh", "run", "rerun", "123"], ["gh", "auth", "token"], ["gh", "api", "https://other.invalid"], ["gh", "run", "view", "--log-failed", "--json", "jobs"], ["gh", "pr", "view", "--json", "number,title", "--hostname", "other.invalid"]]) expect(validateAnalysisReadArgv(argv).ok).toBe(false);
});

test("owned runner receives immutable validated argv only for the configured checkout; streams stay separate", async () => {
  const cwd = await root(); const other = await root(); let called = 0;
  const ports = createAnalysisReadPorts({ cwd, runOwned: async (argv) => { called++; expect(Object.isFrozen(argv)).toBe(true); return { stdout: '{"number":1}', stderr: "fixture diagnostic", exitCode: 0 }; } });
  await expect(ports.ciSpawn(["gh", "auth", "token"], cwd)).rejects.toMatchObject({ code: "invalid-argv" });
  await expect(ports.ciSpawn(["gh", "pr", "view", "--json", "number,title"], other)).rejects.toMatchObject({ code: "invalid-cwd" });
  expect(called).toBe(0);
  expect(await ports.ciSpawn(["gh", "pr", "view", "--json", "number,title"], cwd)).toEqual({ stdout: '{"number":1}', stderr: "fixture diagnostic", exitCode: 0 });
});

test("project reference reader is bounded and refuses traversal, non-Markdown and parent/final symlinks", async () => {
  const cwd = await root(); const outside = await root(); await mkdir(path.join(cwd, "docs"));
  await writeFile(path.join(cwd, "project.md"), "# Actual local reference\n"); await writeFile(path.join(outside, "private.md"), "PRIVATE-DATA");
  await symlink(path.join(outside, "private.md"), path.join(cwd, "linked.md")); await symlink(outside, path.join(cwd, "foreign"));
  const ports = createAnalysisReadPorts({ cwd, runOwned: async () => { throw new Error("not-used"); } });
  expect(await ports.readReference("project.md", new AbortController().signal)).toBe("# Actual local reference\n");
  for (const file of ["docs/rules.md", "../private.md", ".env", "linked.md", "foreign/private.md", "/etc/passwd"]) await expect(ports.readReference(file, new AbortController().signal)).rejects.toMatchObject({ code: "read-denied" });
  await writeFile(path.join(cwd, "project.md"), "x".repeat(128 * 1024 + 1));
  await expect(ports.readReference("project.md", new AbortController().signal)).rejects.toMatchObject({ code: "quota-exceeded" });
});

test("read helper observes cancellation and independently caps stdout and stderr returned by its owned runner", async () => {
  const cwd = await root(); let called = false;
  const ports = createAnalysisReadPorts({ cwd, runOwned: async () => { called = true; return { stdout: "{}", stderr: "x".repeat(512 * 1024 + 1), exitCode: 0 }; } });
  await expect(ports.ciSpawn(["gh", "pr", "view", "--json", "number,title"], cwd, AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" }); expect(called).toBe(false);
  await expect(ports.ciSpawn(["gh", "pr", "view", "--json", "number,title"], cwd)).rejects.toMatchObject({ code: "quota-exceeded" });
});
