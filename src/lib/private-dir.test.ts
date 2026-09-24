// Flow 313 (W4 portability) — docs/requirements/keryx-agent-platform-expansion/
// workstreams/W4-portability.md, "Cross-harness memory handoff", W4-AC8.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
