// G-2 (flow 356, audit remediation 3): `keryx security scan .` used to stop
// at the byte limit on this repository's own tree and report coverage
// `incomplete` — because the traversal opened `.metaproject/data/**/storage/`
// (gitignored build output) before the operator's own source, burning the
// budget on generated content nobody asked to scan. These tests pin the fix
// on a real fixture project (a real `git init`, a real `.gitignore`) rather
// than a synthetic in-memory traversal.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scanContainedPath } from "./path-scan";

let root: string;

async function initGitFixture(): Promise<void> {
  const init = Bun.spawn(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
  await init.exited;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-path-scan-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scanContainedPath: respects the repository's own ignore rules by default (G-2)", () => {
  test("an ignored large file never counts against the byte limit, and coverage stays complete", async () => {
    await initGitFixture();
    await writeFile(path.join(root, ".gitignore"), "build/\n", "utf8");
    await mkdir(path.join(root, "build"), { recursive: true });
    // "large" relative to a small maxBytes below — well past the limit if it
    // were ever opened.
    await writeFile(path.join(root, "build", "artifact.json"), "x".repeat(5_000), "utf8");
    await writeFile(path.join(root, "src.ts"), "export const ok = 1;\n", "utf8");

    const result = await scanContainedPath({
      ownerRoot: root,
      targetPath: root,
      limits: { maxBytes: 1_000 },
    });

    expect(result.coverage.status).toBe("complete");
    expect(result.coverage.reasons).toEqual([]);
    expect(result.contents.map((c) => c.path).sort()).toEqual([".gitignore", "src.ts"]);
    expect(result.contents.some((c) => c.path.startsWith("build/"))).toBe(false);
    expect(result.coverage.skipped).toEqual([".git", "build"]);
    const buildRow = result.files.find((f) => f.path === "build");
    expect(buildRow).toEqual({ path: "build", status: "skipped", reason: "excluded by ignore rules" });
  });

  test("--no-ignore (respectIgnoreRules: false) restores the old behaviour: the ignored file is opened and can exhaust the byte limit", async () => {
    await initGitFixture();
    await writeFile(path.join(root, ".gitignore"), "build/\n", "utf8");
    await mkdir(path.join(root, "build"), { recursive: true });
    await writeFile(path.join(root, "build", "artifact.json"), "x".repeat(5_000), "utf8");
    await writeFile(path.join(root, "src.ts"), "export const ok = 1;\n", "utf8");

    const result = await scanContainedPath({
      ownerRoot: root,
      targetPath: root,
      limits: { maxBytes: 1_000 },
      respectIgnoreRules: false,
    });

    expect(result.coverage.status).toBe("incomplete");
    expect(result.coverage.reasons).toContain("byte limit exceeded");
    expect(result.coverage.skipped).toBeUndefined();
  });

  test("a directory nothing gitignores today, .claude/worktrees, is still always skipped", async () => {
    await initGitFixture();
    // No .gitignore entry for .claude/worktrees at all — the hardcoded rule
    // is the only thing that can exclude it.
    await mkdir(path.join(root, ".claude", "worktrees", "stale-one"), { recursive: true });
    await writeFile(path.join(root, ".claude", "worktrees", "stale-one", "big.log"), "x".repeat(5_000), "utf8");
    await writeFile(path.join(root, "src.ts"), "export const ok = 1;\n", "utf8");

    const result = await scanContainedPath({
      ownerRoot: root,
      targetPath: root,
      limits: { maxBytes: 1_000 },
    });

    expect(result.coverage.status).toBe("complete");
    expect(result.contents.map((c) => c.path)).toEqual(["src.ts"]);
    expect(result.coverage.skipped).toContain(".claude/worktrees");
  });

  test("a node_modules symlink pointing outside the project root is skipped, not reported as incomplete coverage", async () => {
    // Nothing gitignores `node_modules` in this fixture either — same shape
    // as `.claude/worktrees`. Before the hardcoded rule, this resolved via
    // `realpath()` to outside `ownerRoot` and reported
    // `incomplete("external target refused")`.
    const outside = await mkdtemp(path.join(tmpdir(), "keryx-path-scan-outside-"));
    try {
      await mkdir(path.join(outside, "some-package"), { recursive: true });
      await writeFile(path.join(outside, "some-package", "index.js"), "module.exports = 1;\n", "utf8");
      const { symlink } = await import("node:fs/promises");
      await symlink(outside, path.join(root, "node_modules"), "dir");
      await writeFile(path.join(root, "src.ts"), "export const ok = 1;\n", "utf8");

      const result = await scanContainedPath({ ownerRoot: root, targetPath: root });

      expect(result.coverage.status).toBe("complete");
      expect(result.coverage.reasons).toEqual([]);
      expect(result.contents.map((c) => c.path)).toEqual(["src.ts"]);
      expect(result.coverage.skipped).toContain("node_modules");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("no git repository at all: no error, scans as if nothing were ignored (only the hardcoded worktrees rule applies)", async () => {
    // Deliberately no `git init` — a non-git project must still scan.
    await mkdir(path.join(root, "plain"), { recursive: true });
    await writeFile(path.join(root, "plain", "file.ts"), "export const ok = 1;\n", "utf8");

    const result = await scanContainedPath({ ownerRoot: root, targetPath: root });

    expect(result.coverage.status).toBe("complete");
    expect(result.contents.map((c) => c.path)).toEqual(["plain/file.ts"]);
  });
});

describe("scanContainedPath: a secret-bearing filename is scanned even when ignored (SEC-356-01, review round 1)", () => {
  test("the reviewer's own repro — a gitignored .env holding fake credentials — is found, and coverage stays complete", async () => {
    await initGitFixture();
    await writeFile(path.join(root, ".gitignore"), ".env\n", "utf8");
    await writeFile(
      path.join(root, ".env"),
      "AWS_SECRET_ACCESS_KEY=not-a-real-secret\nGITHUB_TOKEN=ghp_not-a-real-token\n",
      "utf8",
    );
    await writeFile(path.join(root, "src.ts"), "export const ok = 1;\n", "utf8");

    const result = await scanContainedPath({ ownerRoot: root, targetPath: root });

    expect(result.coverage.status).toBe("complete");
    expect(result.contents.some((c) => c.path === ".env")).toBe(true);
    const envContent = result.contents.find((c) => c.path === ".env");
    expect(envContent?.content).toContain("AWS_SECRET_ACCESS_KEY");
    expect(result.coverage.skipped ?? []).not.toContain(".env");
    const envRow = result.files.find((f) => f.path === ".env");
    expect(envRow?.status).toBe("scanned");
  });

  test("a variant secret-bearing name (.env.production) at the top level is scanned too", async () => {
    await initGitFixture();
    await writeFile(path.join(root, ".gitignore"), ".env.production\n", "utf8");
    await writeFile(path.join(root, ".env.production"), "API_KEY=not-a-real-key\n", "utf8");

    const result = await scanContainedPath({ ownerRoot: root, targetPath: root });

    expect(result.contents.some((c) => c.path === ".env.production")).toBe(true);
  });

  test("a secret-bearing file nested inside an otherwise-ignored directory is found up to the documented depth", async () => {
    await initGitFixture();
    await writeFile(path.join(root, ".gitignore"), "config/\n", "utf8");
    await mkdir(path.join(root, "config", "deploy", "prod"), { recursive: true });
    await writeFile(path.join(root, "config", "deploy", "prod", "id_rsa"), "not-a-real-key\n", "utf8");
    // A non-secret-named file at the same nesting stays unscanned — the
    // carve-out is name-driven, not "everything under an ignored dir once
    // ANY secret name is found inside it".
    await writeFile(path.join(root, "config", "deploy", "prod", "notes.txt"), "unrelated\n", "utf8");

    const result = await scanContainedPath({ ownerRoot: root, targetPath: root });

    expect(result.contents.some((c) => c.path === "config/deploy/prod/id_rsa")).toBe(true);
    expect(result.contents.some((c) => c.path === "config/deploy/prod/notes.txt")).toBe(false);
    // The ignored directory itself is still reported as skipped (the
    // carve-out is a peek, not a blanket unskip).
    expect(result.coverage.skipped ?? []).toContain("config");
  });

  test("the hardcoded always-ignored directories (node_modules, .git, .claude/worktrees) are never peeked into for secret names", async () => {
    await initGitFixture();
    await mkdir(path.join(root, "node_modules", "some-package"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "some-package", ".env"), "SHOULD_NOT_BE_SCANNED=1\n", "utf8");
    await writeFile(path.join(root, "src.ts"), "export const ok = 1;\n", "utf8");

    const result = await scanContainedPath({ ownerRoot: root, targetPath: root });

    expect(result.contents.some((c) => c.path.includes("node_modules"))).toBe(false);
    expect(result.coverage.status).toBe("complete");
  });
});
