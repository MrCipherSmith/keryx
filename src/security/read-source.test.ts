// F3 (review round 1, GDCTX-2): `ctx read` used to label EVERY file it read
// `trusted-project`, including a path outside the repo entirely (`/tmp`, a
// download) and a file inside the repo that was never committed (`node_modules`,
// a build artifact, a plain untracked scratch file). See `read-source.ts`'s own
// module comment for why that matters (the egress source-override allowance is
// gated on this label). These tests drive `sourceForFileRead` against a real
// temp git repository.

import { $ } from "bun";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceForFileRead } from "./read-source";

let root = "";
let outside = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-read-source-"));
  outside = await mkdtemp(path.join(tmpdir(), "keryx-read-source-outside-"));
  await $`git init -q`.cwd(root).quiet();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("a git-tracked file inside the project resolves to trusted-project", async () => {
  const file = path.join(root, "README.md");
  await writeFile(file, "hello\n", "utf8");
  await $`git -c user.email=t@t -c user.name=t add -A`.cwd(root).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m first`.cwd(root).quiet();

  expect(await sourceForFileRead(root, file)).toBe("trusted-project");
});

test("an untracked file inside the project resolves to untrusted-external", async () => {
  const file = path.join(root, "scratch.md");
  await writeFile(file, "hello\n", "utf8");
  // Never `git add`ed — deliberately left untracked.
  expect(await sourceForFileRead(root, file)).toBe("untrusted-external");
});

test("a gitignored file inside the project resolves to untrusted-external", async () => {
  await writeFile(path.join(root, ".gitignore"), "ignored.md\n", "utf8");
  const file = path.join(root, "ignored.md");
  await writeFile(file, "hello\n", "utf8");
  await $`git -c user.email=t@t -c user.name=t add -A`.cwd(root).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m first`.cwd(root).quiet();

  expect(await sourceForFileRead(root, file)).toBe("untrusted-external");
});

test("a file outside the project entirely resolves to untrusted-external", async () => {
  const file = path.join(outside, "notes.md");
  await writeFile(file, "hello\n", "utf8");

  expect(await sourceForFileRead(root, file)).toBe("untrusted-external");
});

test("a tracked file reached through a symlink still resolves to trusted-project", async () => {
  await mkdir(path.join(root, "real"), { recursive: true });
  const real = path.join(root, "real", "doc.md");
  await writeFile(real, "hello\n", "utf8");
  await $`git -c user.email=t@t -c user.name=t add -A`.cwd(root).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m first`.cwd(root).quiet();

  const { symlink } = await import("node:fs/promises");
  const linkPath = path.join(root, "link.md");
  await symlink(real, linkPath);

  expect(await sourceForFileRead(root, linkPath)).toBe("trusted-project");
});

test("a symlink inside the project pointing OUTSIDE it resolves to untrusted-external", async () => {
  const escapeTarget = path.join(outside, "secret.md");
  await writeFile(escapeTarget, "hello\n", "utf8");

  const { symlink } = await import("node:fs/promises");
  const linkPath = path.join(root, "escape.md");
  await symlink(escapeTarget, linkPath);

  expect(await sourceForFileRead(root, linkPath)).toBe("untrusted-external");
});

// R2-3 (flow 304, fix round 2): `git ls-files -- <path>` interprets pathspec
// magic by default — glob metacharacters in the path itself, and a leading
// `:(...)`/`:!`/`:^` prefix — so an UNTRACKED path can still be reported as a
// match against an unrelated TRACKED file, and a tracked directory matches a
// path that only names the directory. Each case below is a path that must
// resolve `untrusted-external` despite a tracked file/dir existing that a
// naive `git ls-files` would treat as a match for it.

test("an untracked file whose name is a glob pattern does not borrow trust from a matching tracked file", async () => {
  const tracked = path.join(root, "abc.md");
  await writeFile(tracked, "hello\n", "utf8");
  await $`git -c user.email=t@t -c user.name=t add -A`.cwd(root).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m first`.cwd(root).quiet();

  const untracked = path.join(root, "a*.md");
  await writeFile(untracked, "hello\n", "utf8");

  expect(await sourceForFileRead(root, untracked)).toBe("untrusted-external");
});

test("an untracked file named with a ? glob does not borrow trust from a matching tracked file", async () => {
  const tracked = path.join(root, "abc.md");
  await writeFile(tracked, "hello\n", "utf8");
  await $`git -c user.email=t@t -c user.name=t add -A`.cwd(root).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m first`.cwd(root).quiet();

  const untracked = path.join(root, "a?c.md");
  await writeFile(untracked, "hello\n", "utf8");

  expect(await sourceForFileRead(root, untracked)).toBe("untrusted-external");
});

test("an untracked file named with a bracket glob does not borrow trust from a matching tracked file", async () => {
  const tracked = path.join(root, "a.md");
  await writeFile(tracked, "hello\n", "utf8");
  await $`git -c user.email=t@t -c user.name=t add -A`.cwd(root).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m first`.cwd(root).quiet();

  const untracked = path.join(root, "[a].md");
  await writeFile(untracked, "hello\n", "utf8");

  expect(await sourceForFileRead(root, untracked)).toBe("untrusted-external");
});

test("a path shaped like an exclude pathspec (:!zz) resolves untrusted-external, not a vacuous match", async () => {
  const untracked = path.join(root, ":!zz");
  await writeFile(untracked, "hello\n", "utf8");

  expect(await sourceForFileRead(root, untracked)).toBe("untrusted-external");
});

test("a path shaped like a glob-magic pathspec (:(glob)**) resolves untrusted-external", async () => {
  const untracked = path.join(root, ":(glob)**");
  await writeFile(untracked, "hello\n", "utf8");

  expect(await sourceForFileRead(root, untracked)).toBe("untrusted-external");
});

test("a tracked directory resolves untrusted-external, not trusted-project", async () => {
  await mkdir(path.join(root, "sub"), { recursive: true });
  await writeFile(path.join(root, "sub", "file.md"), "hello\n", "utf8");
  await $`git -c user.email=t@t -c user.name=t add -A`.cwd(root).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m first`.cwd(root).quiet();

  expect(await sourceForFileRead(root, path.join(root, "sub"))).toBe("untrusted-external");
});

test("a plain tracked file still resolves trusted-project", async () => {
  const file = path.join(root, "plain.md");
  await writeFile(file, "hello\n", "utf8");
  await $`git -c user.email=t@t -c user.name=t add -A`.cwd(root).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m first`.cwd(root).quiet();

  expect(await sourceForFileRead(root, file)).toBe("trusted-project");
});
