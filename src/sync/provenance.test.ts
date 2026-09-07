// Flow 236, phase 4, T7 (AFC-22 clause 2 / AFC-W05 clause 3: "a git failure
// yields unknown"). `gitCmdResult` is the seam this criterion traces to: it
// must separate a command that could not run at all, a command that ran and
// exited non-zero, and a command that ran and returned nothing — three
// different events the previous `gitCmd` collapsed into one `null`. These
// tests drive real `git`/real filesystem state (never mocked) so the exit
// codes and spawn behavior are the genuine ones a caller will see.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { gitCmd, gitCmdResult } from "./provenance";

let root: string;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function makeRepoWithOneCommit(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-provenance-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
  await writeFile(path.join(dir, "a.txt"), "one\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

beforeEach(async () => {
  root = await makeRepoWithOneCommit();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a command that runs and succeeds with output is `ok`", async () => {
  const result = await gitCmdResult(root, ["rev-parse", "HEAD"]);
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") {
    expect(result.stdout).toMatch(/^[0-9a-f]{40}$/);
  }
});

test("a command that runs and succeeds with NO output is still `ok`, not a failure", async () => {
  // A clean tree: `git status --porcelain` legitimately produces zero bytes.
  const result = await gitCmdResult(root, ["status", "--porcelain=v1"]);
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") {
    expect(result.stdout).toBe("");
  }
});

test("a command that runs and refuses (non-zero exit) is `exit-error`, carrying the real exit code and stderr", async () => {
  await rm(path.join(root, ".git"), { recursive: true, force: true });
  const result = await gitCmdResult(root, ["rev-parse", "HEAD"]);
  expect(result.kind).toBe("exit-error");
  if (result.kind === "exit-error") {
    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});

test("a command that could not be started at all is `spawn-error`, distinct from `exit-error`", async () => {
  // A `cwd` that does not exist makes Node's `spawn` itself fail (ENOENT for
  // the working directory) before git ever runs — the process never started,
  // which is a different event from git running and refusing.
  const missing = path.join(root, "does-not-exist");
  const result = await gitCmdResult(missing, ["rev-parse", "HEAD"]);
  expect(result.kind).toBe("spawn-error");
  if (result.kind === "spawn-error") {
    expect(result.message.length).toBeGreaterThan(0);
  }
});

test("cat-file -e's own negative answer (object not found) is still `exit-error` with a real, inspectable code", async () => {
  // Measured directly: `cat-file -e <sha>^{commit}` for a well-formed but
  // absent commit exits 128 ("fatal: Not a valid object name"), the SAME
  // code a genuinely broken repository's `rev-parse` uses — git does not
  // give plumbing callers a clean "false" exit here the way `cat-file -e
  // <sha>` (no `^{commit}` peel) or `diff --quiet` do. `gitCmdResult` does
  // not try to guess "not found" vs "broken" from the code alone; it hands
  // the caller the real code and stderr so THAT caller — which knows what a
  // negative answer means for the exact command it ran — can decide. (See
  // `page-freshness.ts`'s `revisionExists`, which treats any exit-error here
  // as AC12's legitimate "not reachable" only once the run's overall git
  // health has separately been confirmed.)
  const result = await gitCmdResult(root, ["cat-file", "-e", `${"f".repeat(40)}^{commit}`]);
  expect(result.kind).toBe("exit-error");
  if (result.kind === "exit-error") {
    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});

test("gitCmd (back-compat wrapper) still returns trimmed stdout on ok, byte-identical to before", async () => {
  const head = await gitCmd(root, ["rev-parse", "HEAD"]);
  expect(head).toMatch(/^[0-9a-f]{40}$/);
});

test("gitCmd (back-compat wrapper) still returns '' — not null — for a legitimate empty success", async () => {
  const status = await gitCmd(root, ["status", "--porcelain=v1"]);
  expect(status).toBe("");
});

test("gitCmd (back-compat wrapper) still returns null for both spawn-error and exit-error, exactly as before", async () => {
  await rm(path.join(root, ".git"), { recursive: true, force: true });
  const exitFailure = await gitCmd(root, ["rev-parse", "HEAD"]);
  expect(exitFailure).toBeNull();

  const spawnFailure = await gitCmd(path.join(root, "does-not-exist"), ["rev-parse", "HEAD"]);
  expect(spawnFailure).toBeNull();
});

test("cwd that is not a git repository never spawn-errors — git itself runs fine and refuses", async () => {
  const notARepo = await mkdtemp(path.join(tmpdir(), "keryx-not-a-repo-"));
  try {
    const result = await gitCmdResult(notARepo, ["rev-parse", "HEAD"]);
    expect(result.kind).toBe("exit-error");
  } finally {
    await rm(notARepo, { recursive: true, force: true });
  }
});
