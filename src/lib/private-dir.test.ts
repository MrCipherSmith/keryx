// Flow 313 (W4 portability) — docs/requirements/keryx-agent-platform-expansion/
// workstreams/W4-portability.md, "Cross-harness memory handoff", W4-AC8.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PRIVATE_DIR_GITIGNORE,
  checkPrivateDirGitignore,
  ensurePrivateDirGitignore,
} from "./private-dir";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "keryx-private-dir-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

test("absent .gitignore: check reports create, ensure creates it byte-identical", async () => {
  const dir = path.join(tmpRoot, "private");
  const check = await checkPrivateDirGitignore(dir);
  expect(check).toEqual({ ok: true, action: "create" });

  const ensured = await ensurePrivateDirGitignore(dir);
  expect(ensured).toEqual({ ok: true, action: "create" });
  const written = await readFile(path.join(dir, ".gitignore"), "utf8");
  expect(written).toBe(PRIVATE_DIR_GITIGNORE);
});

test("managed .gitignore already present: reports present, never rewrites", async () => {
  const dir = path.join(tmpRoot, "private");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ".gitignore"), PRIVATE_DIR_GITIGNORE, "utf8");

  const check = await checkPrivateDirGitignore(dir);
  expect(check).toEqual({ ok: true, action: "present" });

  const ensured = await ensurePrivateDirGitignore(dir);
  expect(ensured).toEqual({ ok: true, action: "present" });
});

test("AC8: conflicting existing .gitignore refuses and stays byte-for-byte unchanged", async () => {
  const dir = path.join(tmpRoot, "private");
  await mkdir(dir, { recursive: true });
  const conflicting = "node_modules/\n*.log\n";
  await writeFile(path.join(dir, ".gitignore"), conflicting, "utf8");

  const check = await checkPrivateDirGitignore(dir);
  expect(check.ok).toBe(false);
  if (!check.ok) {
    expect(check.reason).toBe("private-gitignore-conflict");
    expect(check.message).toContain(".gitignore");
  }

  const ensured = await ensurePrivateDirGitignore(dir);
  expect(ensured.ok).toBe(false);
  if (!ensured.ok) {
    expect(ensured.reason).toBe("private-gitignore-conflict");
  }

  const after = await readFile(path.join(dir, ".gitignore"), "utf8");
  expect(after).toBe(conflicting);
});

test("a symlink or non-regular-file at .gitignore refuses rather than following it", async () => {
  const dir = path.join(tmpRoot, "private");
  await mkdir(dir, { recursive: true });
  const target = path.join(tmpRoot, "elsewhere.txt");
  await writeFile(target, "not managed by keryx", "utf8");
  await symlink(target, path.join(dir, ".gitignore"));

  const check = await checkPrivateDirGitignore(dir);
  expect(check.ok).toBe(false);
  if (!check.ok) {
    expect(check.reason).toBe("private-gitignore-conflict");
  }
});

test("ensure never creates the directory or file when the check refuses", async () => {
  const dir = path.join(tmpRoot, "private");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ".gitignore"), "custom\n", "utf8");

  await ensurePrivateDirGitignore(dir);
  const after = await readFile(path.join(dir, ".gitignore"), "utf8");
  expect(after).toBe("custom\n");
});

// R1-F15 G1: the ORIGINAL bug (pre-fix, `stat` instead of `lstat`) is that a
// `.gitignore` symlinked to a file whose CONTENT happens to be byte-identical
// to the managed content reads as `{ ok: true, action: "present" }` — the
// content check above never even sees the symlink. Discriminating: the
// pre-fix code passes this exact case; the fix refuses it before reading any
// content at all.
test("R1-F15 G1: a .gitignore symlinked to byte-identical content is still refused, never followed", async () => {
  const dir = path.join(tmpRoot, "private");
  await mkdir(dir, { recursive: true });
  const target = path.join(tmpRoot, "identical.gitignore");
  await writeFile(target, PRIVATE_DIR_GITIGNORE, "utf8");
  await symlink(target, path.join(dir, ".gitignore"));

  const check = await checkPrivateDirGitignore(dir);
  expect(check.ok).toBe(false);
  if (!check.ok) {
    expect(check.reason).toBe("private-gitignore-conflict");
    expect(check.message).toContain("symlink");
  }

  const ensured = await ensurePrivateDirGitignore(dir);
  expect(ensured.ok).toBe(false);
});

// R1-F15 G2: a DANGLING symlink `stat`s as ENOENT — indistinguishable from
// "absent" under the pre-fix `stat`-based check — so `ensure` reported
// `{ ok: true, action: "create" }` while writing nothing at all (the
// exclusive `wx` create also sees "something" at the path and EEXISTs,
// looping back to the same false "create"). `lstat` sees the symlink itself
// and refuses before that path is ever reached.
test("R1-F15 G2: a dangling .gitignore symlink refuses rather than reporting a false create", async () => {
  const dir = path.join(tmpRoot, "private");
  await mkdir(dir, { recursive: true });
  await symlink(path.join(tmpRoot, "nowhere"), path.join(dir, ".gitignore"));

  const check = await checkPrivateDirGitignore(dir);
  expect(check).not.toEqual({ ok: true, action: "create" });
  expect(check.ok).toBe(false);

  const ensured = await ensurePrivateDirGitignore(dir);
  expect(ensured.ok).toBe(false);
  // Never silently "succeeds" while writing something in its place: the
  // dangling symlink itself is untouched (still a symlink, never replaced
  // with a real file) — the pre-fix bug's `{ ok: true, action: "create" }`
  // reported success while doing exactly this: nothing.
  const { lstat: lstatFn } = await import("node:fs/promises");
  const gitignoreStats = await lstatFn(path.join(dir, ".gitignore"));
  expect(gitignoreStats.isSymbolicLink()).toBe(true);
});

// R1-F15 G5: the memory/private DIRECTORY itself, not just its `.gitignore`,
// symlinked to a real directory that already holds a byte-identical managed
// file — pre-fix, `path.join(dir, ".gitignore")` resolves straight through
// the directory symlink and reads the REAL file's content, passing.
test("R1-F15 G5: a private dir that is itself a symlink is refused even when the real dir's .gitignore matches", async () => {
  const real = path.join(tmpRoot, "real-private");
  await mkdir(real, { recursive: true });
  await writeFile(path.join(real, ".gitignore"), PRIVATE_DIR_GITIGNORE, "utf8");
  const linkedDir = path.join(tmpRoot, "linked-private");
  await symlink(real, linkedDir);

  const check = await checkPrivateDirGitignore(linkedDir);
  expect(check.ok).toBe(false);

  const ensured = await ensurePrivateDirGitignore(linkedDir);
  expect(ensured.ok).toBe(false);
});

// R1-F27 G4: an existing regular file that cannot be READ (mode 000) used to
// throw a raw EACCES out of `checkPrivateDirGitignore`/`ensurePrivateDirGitignore`
// instead of returning a named refusal — the caller had no way to catch this
// without its own try/catch around a function whose whole contract is "never
// throws, always returns a named result".
test("R1-F27 G4: an unreadable .gitignore is a named refusal, never a thrown exception", async () => {
  const dir = path.join(tmpRoot, "private");
  await mkdir(dir, { recursive: true });
  const gitignorePath = path.join(dir, ".gitignore");
  await writeFile(gitignorePath, "x", "utf8");
  await chmod(gitignorePath, 0o000);

  try {
    let thrown = false;
    let result: Awaited<ReturnType<typeof checkPrivateDirGitignore>> | undefined;
    try {
      result = await checkPrivateDirGitignore(dir);
    } catch {
      thrown = true;
    }
    // Running as root (some CI/sandbox environments) makes chmod 0o000
    // unenforced — skip the assertion rather than false-fail on a
    // permission model this test cannot control.
    if (process.getuid?.() === 0) {
      return;
    }
    expect(thrown).toBe(false);
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.reason).toBe("private-gitignore-conflict");
    }

    let ensureThrown = false;
    try {
      await ensurePrivateDirGitignore(dir);
    } catch {
      ensureThrown = true;
    }
    expect(ensureThrown).toBe(false);
  } finally {
    await chmod(gitignorePath, 0o644);
  }
});
