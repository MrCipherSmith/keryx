// AC3 and AC4 of flow 214, demonstrated the way the criteria demand: by
// driving the real command to a non-zero exit, "not by a unit test over the
// predicate".
//
// The distinction earns its keep. `base-branch-gate.test.ts` proves the
// condition decides correctly; it cannot prove the condition is WIRED into
// `flow complete`, reaches the exit code, or prints where an operator can see
// it. Those are three separate ways for a correct predicate to change nothing,
// and this repository has shipped each of them.
//
// `src/cli.ts` is spawned from the working tree, never the installed `keryx`,
// which is a released build that predates this condition.

import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { uniqueTestRoot } from "../lib/test-tmp";

const CLI = path.join(import.meta.dir, "..", "cli.ts");

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

/**
 * A real repository with a real `origin`, because the condition resolves
 * `origin/<base>` with git and a fixture that fakes that would be testing the
 * fake.
 */
async function repoWithTwoBranches(): Promise<{ root: string; commitOnMain: string }> {
  const root = uniqueTestRoot(tmpdir(), "keryx-base-branch");
  const remote = path.join(root, "remote");
  const work = path.join(root, "work");

  await mkdir(remote, { recursive: true });
  await git(remote, ["init", "-q", "--bare"]);

  await mkdir(work, { recursive: true });
  await git(work, ["init", "-q", "-b", "main"]);
  await git(work, ["config", "user.email", "t@example.com"]);
  await git(work, ["config", "user.name", "t"]);
  await writeFile(path.join(work, "a.txt"), "one\n", "utf8");
  await git(work, ["add", "."]);
  await git(work, ["commit", "-q", "-m", "base"]);
  await git(work, ["remote", "add", "origin", remote]);
  await git(work, ["push", "-q", "origin", "main"]);

  // A second branch that does NOT contain what lands on main afterwards. This
  // is the converged-target case inverted: the two really do differ, so the
  // condition has something to catch.
  await git(work, ["branch", "release/2"]);
  await git(work, ["push", "-q", "origin", "release/2"]);

  await writeFile(path.join(work, "b.txt"), "two\n", "utf8");
  await git(work, ["add", "."]);
  await git(work, ["commit", "-q", "-m", "landed on main only"]);
  await git(work, ["push", "-q", "origin", "main"]);
  await git(work, ["fetch", "-q", "origin"]);

  return { root: work, commitOnMain: await git(work, ["rev-parse", "HEAD"]) };
}

async function keryx(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${out}${err}` };
}

/** Create a flow, optionally recording a base. */
async function newFlow(cwd: string, base?: string): Promise<{ id: string; dir: string }> {
  await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
  const init = await keryx(cwd, [
    "flow",
    "init",
    "--title",
    "Base branch check",
    ...(base === undefined ? [] : ["--base", base]),
  ]);
  expect(init.code).toBe(0);
  const id = /Created flow (\d+)/.exec(init.output)?.[1];
  expect(id).toBeDefined();

  const dirs = await Array.fromAsync(
    new Bun.Glob("*/").scan({ cwd: path.join(cwd, ".metaproject", "flows"), onlyFiles: false }),
  );
  return { id: id ?? "", dir: (dirs[0] ?? "").replace(/\/$/, "") };
}

/**
 * Drive a flow to `in-progress`, which is the only status `complete --merged`
 * accepts. Written out with the real commands rather than by editing
 * `flow.json`, so the test cannot pass against a state the CLI would refuse to
 * produce.
 */
async function flowRecordingBase(cwd: string, base?: string): Promise<string> {
  const { id, dir } = await newFlow(cwd, base);
  await writeFile(
    path.join(cwd, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    "# Acceptance Criteria\n\n## Criteria\n\n- AC1: the base branch condition is reached\n",
    "utf8",
  );
  expect((await keryx(cwd, ["flow", "freeze", id])).code).toBe(0);
  expect((await keryx(cwd, ["flow", "start", id])).code).toBe(0);
  return id;
}

describe("the recorded base reaches the real command", () => {
  test("`flow init --base` writes it to the record, read back from disk", async () => {
    // AC1 says "verified by reading flow.json after each, not by reading the
    // code" — so this reads the file the command wrote.
    const { root } = await repoWithTwoBranches();
    try {
      const id = await flowRecordingBase(root, "release/2");
      const status = await keryx(root, ["flow", "status", id]);

      const dirs = await Array.fromAsync(
        new Bun.Glob("*/flow.json").scan({ cwd: path.join(root, ".metaproject", "flows") }),
      );
      expect(dirs.length).toBe(1);
      const raw = await Bun.file(
        path.join(root, ".metaproject", "flows", dirs[0] as string),
      ).json();

      expect(raw.baseBranch).toBe("release/2");
      expect(status.code).toBe(0);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  }, 60_000);

  test("a merge that landed off the recorded base exits non-zero and names both branches", async () => {
    const { root, commitOnMain } = await repoWithTwoBranches();
    try {
      const id = await flowRecordingBase(root, "release/2");

      // The commit is on main. The flow said release/2. Nothing about the
      // content is wrong — this is the case content cannot catch.
      const done = await keryx(root, ["flow", "complete", id, "--merged", commitOnMain]);

      expect(done.code).not.toBe(0);
      expect(done.output).toContain("base-branch");
      // Both sides named, so the operator does not have to go and find out
      // which two branches disagreed.
      expect(done.output).toContain("release/2");
      expect(done.output).toContain(commitOnMain.slice(0, 7));
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  }, 60_000);

  test("a base that cannot be resolved fails as unobserved and names the remedy", async () => {
    // AC4: verified with the ref genuinely absent, not with a stubbed failure.
    const { root, commitOnMain } = await repoWithTwoBranches();
    try {
      const id = await flowRecordingBase(root, "release/never-pushed");
      const done = await keryx(root, ["flow", "complete", id, "--merged", commitOnMain]);

      expect(done.code).not.toBe(0);
      expect(done.output).toContain("unobserved");
      expect(done.output).toContain("git fetch origin release/never-pushed");
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  }, 60_000);

  test("a flow with no recorded base is not failed by this condition", async () => {
    // The other direction, and the one that would break every existing
    // package if `not recorded` were treated as a violation.
    const { root, commitOnMain } = await repoWithTwoBranches();
    try {
      const id = await flowRecordingBase(root);

      const done = await keryx(root, ["flow", "complete", id, "--merged", commitOnMain]);

      // It may well fail for OTHER reasons — unfrozen criteria, open tasks —
      // but never with this one's violation text.
      expect(done.output).not.toContain("violated: this flow recorded base");
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  }, 60_000);
});
