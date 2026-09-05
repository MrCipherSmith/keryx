import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertAnswerUnreachable,
  commitReachable,
  createIsolatedCheckout,
  remotesOf,
} from "./retrieval-checkout";

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

/** A repository with a parent commit and the commit under test after it. */
async function repoWithAnswer(): Promise<{ root: string; sha: string; parent: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-checkout-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "charge.ts"), "export const rate = 1;\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "before"]);
  const parent = git(root, ["rev-parse", "HEAD"]);

  await writeFile(path.join(root, "src", "charge.ts"), "export const rate = 2;\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fix(core): refunds double on retry (#1)"]);
  return { root, sha: git(root, ["rev-parse", "HEAD"]), parent };
}

describe("createIsolatedCheckout", () => {
  test("the commit under test is NOT in the tree's object store", async () => {
    // The bug this replaces. A `git worktree` shares the object database and
    // every ref of its parent repository, so from a tree checked out at the
    // parent, `git show <sha>` returned the full diff — the answer — and
    // `git log --all --grep` found that commit from the prompt's own words,
    // because the prompt IS the commit subject.
    //
    // Both arms could have done it, so it would not have biased the comparison.
    // It would have destroyed it.
    const { root, sha, parent } = await repoWithAnswer();
    const tree = await mkdtemp(path.join(tmpdir(), "keryx-checkout-tree-"));
    try {
      await createIsolatedCheckout({ repoRoot: root, path: path.join(tree, "t"), ref: parent });
      expect(commitReachable(path.join(tree, "t"), sha)).toBe(false);
      expect(commitReachable(path.join(tree, "t"), parent)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(tree, { recursive: true, force: true });
    }
  });

  test("checks out the parent's content, not the commit's", async () => {
    const { root, parent } = await repoWithAnswer();
    const tree = await mkdtemp(path.join(tmpdir(), "keryx-checkout-tree-"));
    try {
      const at = path.join(tree, "t");
      await createIsolatedCheckout({ repoRoot: root, path: at, ref: parent });
      const content = await Bun.file(path.join(at, "src", "charge.ts")).text();
      expect(content).toContain("rate = 1");
      expect(content).not.toContain("rate = 2");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(tree, { recursive: true, force: true });
    }
  });

  test("no remote is left behind", async () => {
    // Otherwise `git fetch origin main` reaches the answer in one command, and
    // the isolation is decorative.
    const { root, parent } = await repoWithAnswer();
    const tree = await mkdtemp(path.join(tmpdir(), "keryx-checkout-tree-"));
    try {
      const at = path.join(tree, "t");
      await createIsolatedCheckout({ repoRoot: root, path: at, ref: parent });
      expect(remotesOf(at)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(tree, { recursive: true, force: true });
    }
  });

  test("git still works in the tree — history is shallow, not absent", async () => {
    // Removing git entirely would also work, and would take a legitimate tool
    // away from both arms. Fetching a commit brings its ancestors and never its
    // descendants, so depth is enough.
    const { root, parent } = await repoWithAnswer();
    const tree = await mkdtemp(path.join(tmpdir(), "keryx-checkout-tree-"));
    try {
      const at = path.join(tree, "t");
      await createIsolatedCheckout({ repoRoot: root, path: at, ref: parent });
      expect(git(at, ["rev-parse", "HEAD"])).toBe(parent);
      expect(Number(git(at, ["rev-list", "--count", "HEAD"]))).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(tree, { recursive: true, force: true });
    }
  });
});

describe("assertAnswerUnreachable", () => {
  test("refuses a tree that can still see the commit under test", async () => {
    // A real git worktree, which is what the harness used to build.
    const { root, sha, parent } = await repoWithAnswer();
    const tree = await mkdtemp(path.join(tmpdir(), "keryx-checkout-wt-"));
    const at = path.join(tree, "wt");
    try {
      git(root, ["worktree", "add", "-q", "--detach", at, parent]);
      expect(() => assertAnswerUnreachable(at, sha)).toThrow(/reachable/);
    } finally {
      git(root, ["worktree", "remove", "--force", at]);
      await rm(root, { recursive: true, force: true });
      await rm(tree, { recursive: true, force: true });
    }
  });

  test("passes for a properly isolated checkout", async () => {
    const { root, sha, parent } = await repoWithAnswer();
    const tree = await mkdtemp(path.join(tmpdir(), "keryx-checkout-tree-"));
    try {
      const at = path.join(tree, "t");
      await createIsolatedCheckout({ repoRoot: root, path: at, ref: parent });
      expect(() => assertAnswerUnreachable(at, sha)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(tree, { recursive: true, force: true });
    }
  });
});
