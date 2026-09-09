import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { collectIsolationReport } from "./provenance";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-isolation-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  const [stdout, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return stdout.trim();
}

/** A worktree checked out at the parent snapshot, with no remotes: the isolated case. */
async function makeRepo(): Promise<{ parent: string; answer: string }> {
  await git(root, ["init", "--quiet", "-b", "main"]);
  await writeFile(path.join(root, "a.txt"), "parent\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "parent snapshot"]);
  const parent = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(path.join(root, "a.txt"), "answer\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "the answer"]);
  const answer = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["checkout", "--quiet", parent]);
  return { parent, answer };
}

const UNREACHABLE_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("collectIsolationReport", () => {
  test("a standalone checkout at the parent snapshot with no remotes is verified", async () => {
    const { parent } = await makeRepo();
    const report = await collectIsolationReport({
      agentRoot: root,
      parentSnapshotCommit: parent,
      answerCommit: UNREACHABLE_SHA,
    });
    expect(report.status).toBe("verified");
    expect(report.remotes).toEqual([]);
    expect(report.checkoutMatchesParent).toBe(true);
    expect(report.answerCommitReachable).toBe(false);
  });

  test("any remote at all is a violation: absence of remotes is the only proof offered", async () => {
    const { parent } = await makeRepo();
    await git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    const report = await collectIsolationReport({
      agentRoot: root,
      parentSnapshotCommit: parent,
      answerCommit: UNREACHABLE_SHA,
    });
    expect(report.status).toBe("violated");
    expect(report.remotes).toEqual(["origin"]);
  });

  test("a checkout that is not the parent snapshot is a violation", async () => {
    const { parent, answer } = await makeRepo();
    await git(root, ["checkout", "--quiet", answer]);
    const report = await collectIsolationReport({
      agentRoot: root,
      parentSnapshotCommit: parent,
      answerCommit: UNREACHABLE_SHA,
    });
    expect(report.status).toBe("violated");
    expect(report.checkoutMatchesParent).toBe(false);
  });

  test("an answer commit still reachable in the object store is a violation", async () => {
    const { parent, answer } = await makeRepo();
    const report = await collectIsolationReport({
      agentRoot: root,
      parentSnapshotCommit: parent,
      answerCommit: answer,
    });
    expect(report.status).toBe("violated");
    expect(report.answerCommitReachable).toBe(true);
  });

  // Absence of remotes does not prove a full sandbox, and a directory that is not
  // a repository at all proves nothing whatsoever.
  test("a directory that is not a git repository is unverified, never verified", async () => {
    const report = await collectIsolationReport({
      agentRoot: root,
      parentSnapshotCommit: "c0ffee",
      answerCommit: null,
    });
    expect(report.status).toBe("unverified");
    expect(report.headCommit).toBeNull();
  });

  test("skipping the answer-commit check leaves it unverified, not proven absent", async () => {
    const { parent } = await makeRepo();
    const report = await collectIsolationReport({
      agentRoot: root,
      parentSnapshotCommit: parent,
      answerCommit: null,
    });
    expect(report.status).toBe("unverified");
    expect(report.answerCommitReachable).toBeNull();
  });
});
