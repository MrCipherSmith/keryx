import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContainedWriteError } from "./contained-write";
import {
  findLegacyMemoryArtifacts,
  formatLegacyMemoryMigrationAdvisory,
  renderMetaprojectGitignoreBlock,
  syncMetaprojectGitignore,
} from "./metaproject-gitignore";

// Flow 313 (W4): the bundle ledger (applied-state.json) and any staged bundle
// artifacts under .metaproject/data/bundles/ are local runtime state, not
// something a project commits.
test("the managed gitignore block covers the bundle ledger runtime state", () => {
  const block = renderMetaprojectGitignoreBlock();

  expect(block).toContain(".metaproject/data/bundles/");
});

test("legacy memory migration diagnostics classify paths without mutating them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-migration-"));
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["git", "config", "user.email", "test@example.invalid"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    const artifactRoot = path.join(root, ".metaproject", "data", "memory", "artifacts");
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(path.join(artifactRoot, "latest.md"), "user report\n", "utf8");
    await writeFile(path.join(artifactRoot, "latest.json"), "{}\n", "utf8");
    Bun.spawnSync(["git", "add", "--", ".metaproject/data/memory/artifacts/latest.md"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["git", "commit", "-qm", "legacy"], { cwd: root, stdout: "ignore", stderr: "ignore" });

    const artifacts = await findLegacyMemoryArtifacts(root);
    expect(artifacts).toEqual([
      { path: ".metaproject/data/memory/artifacts/latest.md", tracked: true },
      { path: ".metaproject/data/memory/artifacts/latest.json", tracked: false },
    ]);
    const advisory = formatLegacyMemoryMigrationAdvisory(artifacts);
    expect(advisory).toContain("tracked legacy reports");
    expect(advisory).toContain("existing legacy reports");
    expect(advisory).toContain("never delete files or mutate the Git index");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the managed block ignores W3's per-machine learning paths (W3-AC9)", () => {
  const block = renderMetaprojectGitignoreBlock();
  expect(block).toContain(".metaproject/data/learning/observations/\n");
  expect(block).toContain(".metaproject/data/learning/candidates/\n");
});

// Flow 315 T5 (R5-F1 minor): a project's own `.gitignore` can be a symlink —
// deliberately, or planted by something hostile — pointing outside the
// project. The pre-fix raw `writeFile(gitignorePath, ...)` followed it and
// overwrote whatever it pointed at. `syncMetaprojectGitignore` now refuses
// (ContainedWriteError, reason "escaping-symlink") rather than writing
// through it, leaving the outside file byte-for-byte unchanged.
test("syncMetaprojectGitignore refuses to write through a .gitignore symlink that escapes the project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-gitignore-escape-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "keryx-gitignore-escape-outside-"));
  try {
    const sentinelPath = path.join(outsideRoot, "victim.gitignore");
    await writeFile(sentinelPath, "ORIGINAL\n");
    await symlink(sentinelPath, path.join(root, ".gitignore"));

    let caught: unknown;
    try {
      await syncMetaprojectGitignore(root);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ContainedWriteError);
    expect((caught as ContainedWriteError).reason).toBe("escaping-symlink");
    expect(await readFile(sentinelPath, "utf8")).toBe("ORIGINAL\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});
