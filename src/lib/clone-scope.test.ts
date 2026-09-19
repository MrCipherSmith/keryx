import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalPath, gitCommonDir, gitToplevel } from "./clone-scope";

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-clone-scope-"));
  ROOTS.push(dir);
  return dir;
}

async function gitInit(cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", "init", "-b", "main"], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  expect(await proc.exited).toBe(0);
}

test("gitCommonDir and gitToplevel answer for a repository and its subdirectory", async () => {
  const repo = await tempDir();
  await gitInit(repo);
  const sub = path.join(repo, "a", "b");
  await mkdir(sub, { recursive: true });

  const common = await gitCommonDir(sub);
  expect(common).not.toBeNull();
  expect(await realpath(common as string)).toBe(await realpath(path.join(repo, ".git")));
  expect(await realpath((await gitToplevel(sub)) as string)).toBe(await realpath(repo));
});

test("outside a repository both return null", async () => {
  const dir = await tempDir();
  // A directory under tmpdir is not inside a repository unless the host's tmp is.
  if ((await gitToplevel(tmpdir())) !== null) return;
  expect(await gitCommonDir(dir)).toBeNull();
  expect(await gitToplevel(dir)).toBeNull();
});

test("canonicalPath resolves symlinks and falls back to path.resolve for a missing path", async () => {
  const dir = await tempDir();
  const real = path.join(dir, "real");
  await mkdir(real);
  await symlink(real, path.join(dir, "link"));

  expect(await canonicalPath(path.join(dir, "link"))).toBe(await realpath(real));
  expect(await canonicalPath(path.join(dir, "missing"))).toBe(path.join(dir, "missing"));
});
