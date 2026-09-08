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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { gitCmd, gitCmdResult, resolveGitHead } from "./provenance";

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

// AFC-22 (flow 236 T13, F236-02). `gitCmdResult` separates the three git
// EVENTS; `resolveGitHead` is what turns them into the four ANSWERS a caller
// acts on, and the one that matters is `failed` — "a repository is here and
// git could not answer" — which every prior caller reported as `no-repository`
// ("this project simply has no git"). Those are opposite facts, and
// `rev-parse HEAD` fails identically for both, so nothing short of a real
// repository broken in a real way distinguishes them. Every breakage below is
// induced on disk with the real git binary; none is mocked.
//
// Delete the `failed` arm (return `no-repository` for every unresolvable HEAD)
// and the three `failed` tests here go red — as does `verifyPages`' refusal in
// `wiki/refresh.test.ts`, which is the user-visible consequence.
describe("resolveGitHead (F236-02): a broken repository is never reported as an absent one", () => {
  test("a healthy repository resolves to its real sha", async () => {
    const result = await resolveGitHead(root);
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a repository with no commits yet is `unborn` — a legitimate absence of a revision, not a fault", async () => {
    const unborn = await mkdtemp(path.join(tmpdir(), "keryx-unborn-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: unborn, stdio: "ignore" });
      const result = await resolveGitHead(unborn);
      expect(result.kind).toBe("unborn");
    } finally {
      await rm(unborn, { recursive: true, force: true });
    }
  });

  test("a directory with no git at all is `no-repository` — the supported git-free project", async () => {
    const notARepo = await mkdtemp(path.join(tmpdir(), "keryx-head-no-repo-"));
    try {
      const result = await resolveGitHead(notARepo);
      expect(result.kind).toBe("no-repository");
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });

  test("a cwd that does not exist is `no-repository` (git cannot even be started there)", async () => {
    const result = await resolveGitHead(path.join(root, "does-not-exist"));
    expect(result.kind).toBe("no-repository");
  });

  test("`.git/HEAD` pointing at a missing ref is `failed`, NOT `no-repository`", async () => {
    // The exact state measured in F236-02: `--is-inside-work-tree` still says
    // `true`, so this is unmistakably a git repository — and `rev-parse HEAD`
    // still fails, which is precisely the pair the old `string | undefined`
    // return could not express.
    await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/does-not-exist\n");
    expect((await gitCmdResult(root, ["rev-parse", "--is-inside-work-tree"])).kind).toBe("ok");

    const result = await resolveGitHead(root);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.detail).toContain("rev-parse HEAD");
  });

  test("`.git/HEAD` replaced with garbage is `failed` — even though git then denies this is a repository at all", async () => {
    // Harder than the case above: git's own `--is-inside-work-tree` answers
    // "fatal: not a git repository" here, so that probe alone would have
    // rounded a corrupt repository down to the git-free project. The `.git`
    // entry on disk is the second, independent signal that keeps it `failed`.
    await writeFile(path.join(root, ".git", "HEAD"), "corrupt");
    expect((await gitCmdResult(root, ["rev-parse", "--is-inside-work-tree"])).kind).not.toBe("ok");

    const result = await resolveGitHead(root);
    expect(result.kind).toBe("failed");
  });

  test("an unreadable object store is `failed` — a permission change is a fault to repair, not a project without git", async () => {
    await chmod(path.join(root, ".git", "objects"), 0o000);
    try {
      const result = await resolveGitHead(root);
      expect(result.kind).toBe("failed");
    } finally {
      await chmod(path.join(root, ".git", "objects"), 0o755).catch(() => undefined);
    }
  });

  test("a nested working directory inside a broken repository is still `failed`, not `no-repository`", async () => {
    // `.git` lives at the repository root, not in `cwd`. Without the
    // `--is-inside-work-tree` signal beside the on-disk `.git` check, a
    // subdirectory of a broken repo would fall through to `no-repository`.
    const nested = path.join(root, "sub", "dir");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/does-not-exist\n");

    const result = await resolveGitHead(nested);
    expect(result.kind).toBe("failed");
  });
});
