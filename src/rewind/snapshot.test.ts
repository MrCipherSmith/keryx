import { expect, test } from "bun:test";
import path from "node:path";
import { existsSync } from "node:fs";
import { exists, makeProject, write } from "./rewind.test-helpers";
import { initShadow, REWIND_MAX_FILE_BYTES, shadowRepo } from "./shadow";
import { captureTree, changedFiles } from "./snapshot";

async function fresh() {
  const project = makeProject();
  const repo = shadowRepo(project.rewindDir, project.root);
  await initShadow(repo);
  return { project, repo };
}

test("shadow repo lives under the rewind dir and initShadow is idempotent", async () => {
  const { project, repo } = await fresh();
  expect(repo.gitDir.startsWith(project.rewindDir)).toBe(true);
  expect(existsSync(path.join(repo.gitDir, "HEAD"))).toBe(true);
  await initShadow(repo);
  expect(exists(project.root, ".git/rewind")).toBe(false);
});

test("captureTree is stable for an unchanged work tree and differs after an edit", async () => {
  const { project, repo } = await fresh();
  const first = await captureTree(repo);
  const again = await captureTree(repo);
  expect(again.tree).toBe(first.tree);
  write(project.root, "a.txt", "changed\n");
  const next = await captureTree(repo);
  expect(next.tree).not.toBe(first.tree);
  expect(await changedFiles(repo, first.tree, next.tree)).toEqual(["a.txt"]);
});

test("captureTree records created files, deleted files and untracked files", async () => {
  const { project, repo } = await fresh();
  const before = await captureTree(repo);
  write(project.root, "new/dir/c.txt", "c\n");
  const { rmSync } = await import("node:fs");
  rmSync(path.join(project.root, "src/b.ts"));
  const after = await captureTree(repo);
  expect((await changedFiles(repo, before.tree, after.tree)).sort()).toEqual(["new/dir/c.txt", "src/b.ts"]);
});

test("gitignored paths, .git, node_modules and .metaproject/data are never captured", async () => {
  const { project, repo } = await fresh();
  const before = await captureTree(repo);
  write(project.root, "ignored.log", "x");
  write(project.root, "build/out.js", "x");
  write(project.root, "node_modules/pkg/index.js", "x");
  write(project.root, ".metaproject/data/state.json", "{}");
  write(project.root, ".git/extra", "x");
  const after = await captureTree(repo);
  expect(after.tree).toBe(before.tree);
});

test("files over 5 MB are skipped and reported by name", async () => {
  const { project, repo } = await fresh();
  write(project.root, "big.bin", new Uint8Array(REWIND_MAX_FILE_BYTES + 1));
  write(project.root, "small.txt", "s");
  const result = await captureTree(repo);
  expect(result.skipped).toEqual(["big.bin"]);
  const empty = await captureTree(repo);
  const names = await changedFiles(repo, (await captureTree(repo)).tree, empty.tree);
  expect(names).toEqual([]);
});

test("a run with GIT_DIR and GIT_WORK_TREE in the parent env behaves the same", async () => {
  const { project, repo } = await fresh();
  const clean = await captureTree(repo);
  const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE, index: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = path.join(project.root, ".git");
  process.env.GIT_WORK_TREE = project.root;
  process.env.GIT_INDEX_FILE = path.join(project.root, ".git", "index");
  try {
    const hooked = await captureTree(repo);
    expect(hooked.tree).toBe(clean.tree);
  } finally {
    for (const [key, value] of [["GIT_DIR", saved.dir], ["GIT_WORK_TREE", saved.tree], ["GIT_INDEX_FILE", saved.index]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
