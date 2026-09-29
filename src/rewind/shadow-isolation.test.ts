import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import { makeProject, projectGitFingerprint, runGit, write } from "./rewind.test-helpers";
import { initShadow, shadowRepo } from "./shadow";
import { captureTree } from "./snapshot";
import { restoreTree } from "./restore";

const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE, index: process.env.GIT_INDEX_FILE };
afterEach(() => {
  for (const [key, value] of [["GIT_DIR", saved.dir], ["GIT_WORK_TREE", saved.tree], ["GIT_INDEX_FILE", saved.index]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function cycle(root: string, rewindDir: string): Promise<void> {
  const repo = shadowRepo(rewindDir, root);
  await initShadow(repo);
  const before = await captureTree(repo);
  write(root, "a.txt", "edited\n");
  write(root, "fresh.txt", "new\n");
  await captureTree(repo);
  await restoreTree(repo, before.tree);
}

test("project .git is byte-identical after snapshot and restore", async () => {
  const project = makeProject();
  runGit(project.root, ["stash", "list"]);
  const before = projectGitFingerprint(project.root);
  await cycle(project.root, project.rewindDir);
  expect(projectGitFingerprint(project.root)).toEqual(before);
  expect(runGit(project.root, ["stash", "list"])).toBe("");
});

test("project .git is byte-identical when the parent env points GIT_DIR at it", async () => {
  const project = makeProject();
  const before = projectGitFingerprint(project.root);
  process.env.GIT_DIR = path.join(project.root, ".git");
  process.env.GIT_WORK_TREE = project.root;
  process.env.GIT_INDEX_FILE = path.join(project.root, ".git", "index");
  await cycle(project.root, project.rewindDir);
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_INDEX_FILE;
  expect(projectGitFingerprint(project.root)).toEqual(before);
});
