// G-5 / AC6 (flow 356, audit remediation 3): the safety boundary is the
// point of this module — a worktree with unmerged commits or uncommitted
// changes must NEVER be a prune candidate, no matter its age, and
// `.claude/worktrees` must resolve to the same place from the main checkout
// and from a linked worktree.

import { mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  claudeWorktreesDir,
  commitsAheadOfMain,
  findStaleWorktrees,
  hasUncommittedChanges,
  pruneWorktree,
  resolveMainCheckoutRoot,
} from "./git-worktrees";

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const ok = (await proc.exited) === 0;
  if (!ok) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return { ok, stdout, stderr };
}

/** Set a directory's mtime `days` in the past, so age-based checks see it as stale (or not). */
async function ageDir(dirPath: string, days: number): Promise<void> {
  const past = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await utimes(dirPath, past, past);
}

let mainRoot: string;

beforeEach(async () => {
  mainRoot = await mkdtemp(path.join(tmpdir(), "keryx-git-worktrees-main-"));
  await git(mainRoot, ["init", "-q", "-b", "main"]);
  await git(mainRoot, ["config", "user.email", "test@example.com"]);
  await git(mainRoot, ["config", "user.name", "Test"]);
  await writeFile(path.join(mainRoot, "README.md"), "root\n", "utf8");
  await git(mainRoot, ["add", "."]);
  await git(mainRoot, ["commit", "-q", "-m", "initial"]);
});

afterEach(async () => {
  await rm(mainRoot, { recursive: true, force: true });
});

async function addWorktree(name: string, branch: string): Promise<string> {
  const worktreesDir = path.join(mainRoot, ".claude", "worktrees");
  await mkdir(worktreesDir, { recursive: true });
  const worktreePath = path.join(worktreesDir, name);
  await git(mainRoot, ["worktree", "add", "-q", "-b", branch, worktreePath, "main"]);
  return worktreePath;
}

/**
 * A worktree branched from a `main` that already carries `gitignore` as a
 * COMMITTED `.gitignore` — so the worktree starts zero commits ahead, and
 * whatever the test writes afterward that matches those rules is genuinely
 * gitignored-but-uncommitted, not merely untracked. Committing `.gitignore`
 * IN the worktree itself would put it one commit ahead of `main`, which is
 * exactly the confound REG-2's tests need to avoid.
 */
async function addWorktreeWithGitignore(name: string, branch: string, gitignore: string): Promise<string> {
  await writeFile(path.join(mainRoot, ".gitignore"), gitignore, "utf8");
  await git(mainRoot, ["add", ".gitignore"]);
  await git(mainRoot, ["commit", "-q", "-m", "add .gitignore"]);
  return addWorktree(name, branch);
}

describe("resolveMainCheckoutRoot / claudeWorktreesDir", () => {
  test("from the main checkout, resolves to itself", async () => {
    expect(await resolveMainCheckoutRoot(mainRoot)).toBe(mainRoot);
  });

  test("from a linked worktree, still resolves to the MAIN checkout, not the worktree itself", async () => {
    const worktreePath = await addWorktree("w1", "agent/w1");
    await ageDir(worktreePath, 10);
    expect(await resolveMainCheckoutRoot(worktreePath)).toBe(mainRoot);
    expect(await claudeWorktreesDir(worktreePath)).toBe(path.join(mainRoot, ".claude", "worktrees"));
  });

  test("outside a git repository, resolves to undefined rather than throwing", async () => {
    const plain = await mkdtemp(path.join(tmpdir(), "keryx-git-worktrees-plain-"));
    try {
      expect(await resolveMainCheckoutRoot(plain)).toBeUndefined();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe("the safety boundary: commits ahead of main, or uncommitted changes, are NEVER pruned", () => {
  test("BOUNDARY — a worktree with an unmerged commit ahead of main is excluded even when old and clean", async () => {
    const worktreePath = await addWorktree("ahead", "agent/ahead");
    await writeFile(path.join(worktreePath, "new-file.txt"), "work in progress\n", "utf8");
    await git(worktreePath, ["add", "."]);
    await git(worktreePath, ["commit", "-q", "-m", "unmerged work"]);
    await ageDir(worktreePath, 30);

    expect(await commitsAheadOfMain(worktreePath, "main")).toBe(1);
    expect(await hasUncommittedChanges(worktreePath)).toBe(false);

    const worktreesDir = path.join(mainRoot, ".claude", "worktrees");
    const stale = await findStaleWorktrees(worktreesDir, { maxAgeDays: 7 });
    expect(stale.map((s) => s.name)).not.toContain("ahead");
  });

  test("BOUNDARY — a worktree with uncommitted changes is excluded even when old and merged", async () => {
    const worktreePath = await addWorktree("dirty", "agent/dirty");
    await writeFile(path.join(worktreePath, "scratch.txt"), "not committed\n", "utf8");
    await ageDir(worktreePath, 30);

    expect(await commitsAheadOfMain(worktreePath, "main")).toBe(0);
    expect(await hasUncommittedChanges(worktreePath)).toBe(true);

    const worktreesDir = path.join(mainRoot, ".claude", "worktrees");
    const stale = await findStaleWorktrees(worktreesDir, { maxAgeDays: 7 });
    expect(stale.map((s) => s.name)).not.toContain("dirty");
  });

  test("a worktree that is old, merged (zero commits ahead) and clean IS a stale candidate", async () => {
    const worktreePath = await addWorktree("stale", "agent/stale");
    await ageDir(worktreePath, 30);

    const worktreesDir = path.join(mainRoot, ".claude", "worktrees");
    const stale = await findStaleWorktrees(worktreesDir, { maxAgeDays: 7 });
    expect(stale.map((s) => s.name)).toContain("stale");
  });

  test("a worktree younger than the age threshold is excluded even when merged and clean", async () => {
    const worktreePath = await addWorktree("fresh", "agent/fresh");
    await ageDir(worktreePath, 1);

    const worktreesDir = path.join(mainRoot, ".claude", "worktrees");
    const stale = await findStaleWorktrees(worktreesDir, { maxAgeDays: 7 });
    expect(stale.map((s) => s.name)).not.toContain("fresh");
  });

  test("no local main branch at all: commitsAheadOfMain is undefined, never treated as zero", async () => {
    const worktreePath = await addWorktree("orphan", "agent/orphan");
    expect(await commitsAheadOfMain(worktreePath, "no-such-branch")).toBeUndefined();
  });
});

describe("review round 1, REG-2: a gitignored file is NOT invisible to hasUncommittedChanges", () => {
  test("the reviewer's own repro — a committed .gitignore listing .env plus a real, uncommitted, gitignored .env — blocks pruning", async () => {
    const worktreePath = await addWorktreeWithGitignore("secret-env", "agent/secret-env", ".env\n");
    await writeFile(path.join(worktreePath, ".env"), "AWS_SECRET_ACCESS_KEY=not-a-real-secret\n", "utf8");
    await ageDir(worktreePath, 30);

    // Before REG-2, plain `git status --porcelain` never reports .env at
    // all (it's gitignored) — this is exactly the false "clean" the bug
    // relied on.
    expect(await commitsAheadOfMain(worktreePath, "main")).toBe(0);
    expect(await hasUncommittedChanges(worktreePath)).toBe(true);

    const worktreesDir = path.join(mainRoot, ".claude", "worktrees");
    const stale = await findStaleWorktrees(worktreesDir, { maxAgeDays: 7 });
    expect(stale.map((s) => s.name)).not.toContain("secret-env");
  });

  test("a worktree whose only ignored content is a node_modules symlink IS still prunable", async () => {
    const worktreePath = await addWorktreeWithGitignore("nm-symlink", "agent/nm-symlink", "node_modules\n");
    const target = await mkdtemp(path.join(tmpdir(), "keryx-git-worktrees-nm-target-"));
    try {
      await symlink(target, path.join(worktreePath, "node_modules"));
      await ageDir(worktreePath, 30);

      expect(await commitsAheadOfMain(worktreePath, "main")).toBe(0);
      expect(await hasUncommittedChanges(worktreePath)).toBe(false);

      const worktreesDir = path.join(mainRoot, ".claude", "worktrees");
      const stale = await findStaleWorktrees(worktreesDir, { maxAgeDays: 7 });
      expect(stale.map((s) => s.name)).toContain("nm-symlink");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("an ignored file OUTSIDE the allowlist (a local override, not node_modules/.metaproject/data/dist) still blocks pruning", async () => {
    const worktreePath = await addWorktreeWithGitignore(
      "local-override",
      "agent/local-override",
      "local.settings.json\n",
    );
    await writeFile(path.join(worktreePath, "local.settings.json"), "{}\n", "utf8");
    await ageDir(worktreePath, 30);

    expect(await hasUncommittedChanges(worktreePath)).toBe(true);
  });

  test("ignored .metaproject/data and dist directories are allowlisted carry-overs, same as node_modules", async () => {
    const worktreePath = await addWorktreeWithGitignore(
      "carry-overs",
      "agent/carry-overs",
      ".metaproject/data/\ndist/\n",
    );
    await mkdir(path.join(worktreePath, ".metaproject", "data"), { recursive: true });
    await writeFile(path.join(worktreePath, ".metaproject", "data", "scratch.json"), "{}\n", "utf8");
    await mkdir(path.join(worktreePath, "dist"), { recursive: true });
    await writeFile(path.join(worktreePath, "dist", "cli.js"), "// built\n", "utf8");
    await ageDir(worktreePath, 30);

    expect(await hasUncommittedChanges(worktreePath)).toBe(false);
  });
});

describe("pruneWorktree", () => {
  test("removes a safe candidate via git worktree remove, and it disappears from the worktree list", async () => {
    const worktreePath = await addWorktree("removable", "agent/removable");
    await ageDir(worktreePath, 30);

    const result = await pruneWorktree(mainRoot, worktreePath);
    expect(result.ok).toBe(true);

    const worktreesDir = path.join(mainRoot, ".claude", "worktrees");
    const stale = await findStaleWorktrees(worktreesDir, { maxAgeDays: 7 });
    expect(stale.map((s) => s.name)).not.toContain("removable");
  });
});
