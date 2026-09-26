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

test("the managed block ignores the self-learning loop's per-machine paths", () => {
  const block = renderMetaprojectGitignoreBlock();
  expect(block).toContain(".metaproject/data/learning/observations/\n");
  expect(block).toContain(".metaproject/data/learning/candidates/\n");
});

// R700-06/R700-10: skills stocktake writes dated reports plus a cache file
// under .metaproject/data/skills/stocktake/ — per-machine runtime output,
// not something a project commits.
test("the managed block ignores skills stocktake reports and cache", () => {
  const block = renderMetaprojectGitignoreBlock();
  expect(block).toContain(".metaproject/data/skills/stocktake/\n");
});

// R700-10: the managed block's comments used to carry internal program
// labels ("Flow 313 (W4)", "(W3-AC9)") that meant nothing to a user reading
// their own .gitignore. They must be gone from the rendered block.
test("the managed block carries no internal program labels", () => {
  const block = renderMetaprojectGitignoreBlock();
  expect(block).not.toMatch(/\bW\d\b/);
  expect(block).not.toMatch(/\bW\d-AC\d+\b/);
  expect(block).not.toMatch(/Flow \d{3}/);
});

// R700-10: `keryx update` must replace, not duplicate, a PRE-EXISTING
// managed block that still carries the old internal-label comment text —
// the sentinel markers (`# keryx:begin` / `# keryx:end`) are what the
// replace logic keys off, not the comment text inside, so this must hold
// even though the comments themselves changed.
test("syncMetaprojectGitignore replaces an old managed block (with the retired internal-label comments) rather than duplicating it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-gitignore-upgrade-"));
  try {
    const oldBlock = [
      "# keryx:begin",
      "# Metaproject: keep agent-facing context versioned, ignore executable/generated internals.",
      ".metaproject/runtime/",
      "# Flow 313 (W4): the bundle ledger and staged/inspected bundle artifacts are",
      "# local runtime state (applied-state.json, temp audit copies), not something",
      "# a project commits.",
      ".metaproject/data/bundles/",
      "# W3 self-learning loop: passive observation events and not-yet-reviewed",
      "# candidate patterns are per-machine, never meant to be shared/committed",
      "# (W3-AC9). \".metaproject/data/\" is not blanket-ignored, so these two get",
      "# their own entries rather than inheriting coverage that does not exist.",
      ".metaproject/data/learning/observations/",
      ".metaproject/data/learning/candidates/",
      "# keryx:end",
      "",
    ].join("\n");
    await writeFile(path.join(root, ".gitignore"), oldBlock, "utf8");

    await syncMetaprojectGitignore(root);

    const result = await readFile(path.join(root, ".gitignore"), "utf8");
    expect(countOccurrences(result, "# keryx:begin")).toBe(1);
    expect(countOccurrences(result, "# keryx:end")).toBe(1);
    expect(result).not.toContain("Flow 313");
    expect(result).not.toContain("W3-AC9");
    expect(result).toContain(".metaproject/data/bundles/");
    expect(result).toContain(".metaproject/data/skills/stocktake/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

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

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-gitignore-blanket-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  return root;
}

test("a blanket .metaproject/ ignore survives when the project keeps .metaproject out of git", async () => {
  const root = await gitRepo();
  try {
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n.metaproject/\n");
    await syncMetaprojectGitignore(root);
    const next = await readFile(path.join(root, ".gitignore"), "utf8");
    expect(next.split("\n")).toContain(".metaproject/");
    expect(next).toContain("# keryx:begin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a blanket .metaproject/ ignore is dropped where .metaproject is already tracked", async () => {
  const root = await gitRepo();
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "index.md"), "# index\n");
    Bun.spawnSync(["git", "add", ".metaproject/index.md"], { cwd: root });
    Bun.spawnSync(["git", "-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", "track"], { cwd: root });
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n.metaproject/\n");
    await syncMetaprojectGitignore(root);
    const next = await readFile(path.join(root, ".gitignore"), "utf8");
    expect(next.split("\n")).not.toContain(".metaproject/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
