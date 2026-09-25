// Flow 313 (W4 portability), re-plan lane C1: coverage for the contained
// write primitive — every reason `ContainedWriteError` can name, plus the
// happy paths (write/remove/mkdir/rename) each retrofitted call site now
// depends on.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendContained,
  ContainedWriteError,
  mkdirContained,
  removeContained,
  renameContained,
  rmdirIfEmptyContained,
  writeContained,
} from "./contained-write";

let root = "";
let outsideDir = "";

beforeEach(async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-cw-")));
  root = path.join(base, "project");
  outsideDir = path.join(base, "elsewhere");
  await mkdir(root, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
});

afterEach(async () => {
  if (root.length > 0) await rm(path.dirname(root), { recursive: true, force: true });
});

async function reasonOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ContainedWriteError) return error.reason;
    throw error;
  }
  throw new Error("expected ContainedWriteError");
}

describe("writeContained", () => {
  test("creates parent directories and writes the file", async () => {
    await writeContained(root, "a/b/c.txt", "hello\n");
    expect(await readFile(path.join(root, "a/b/c.txt"), "utf8")).toBe("hello\n");
  });

  test("is atomic: no temp file survives a successful write", async () => {
    await writeContained(root, "note.txt", "one");
    const dirents = await import("node:fs/promises").then((m) => m.readdir(root));
    expect(dirents).toEqual(["note.txt"]);
  });

  test("overwrites an existing regular file", async () => {
    await writeContained(root, "note.txt", "one");
    await writeContained(root, "note.txt", "two");
    expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("two");
  });

  test("exclusive refuses an existing file", async () => {
    await writeContained(root, "note.txt", "one");
    expect(await reasonOf(() => writeContained(root, "note.txt", "two", { exclusive: true }))).toBe(
      "already-exists",
    );
  });

  test("refuses an absolute rel path", async () => {
    expect(await reasonOf(() => writeContained(root, "/etc/passwd", "x"))).toBe("absolute-path");
  });

  test("refuses a lexical .. segment", async () => {
    expect(await reasonOf(() => writeContained(root, "../escape.txt", "x"))).toBe("lexical-traversal");
  });

  test("refuses a .git path segment", async () => {
    expect(await reasonOf(() => writeContained(root, ".git/hooks/pre-commit", "x"))).toBe("git-directory");
  });

  // R4-F2: the `.git` refusal is case-insensitive (`.GIT`, `.Git` are the
  // same directory on a case-insensitive filesystem) and applies at ANY
  // depth, not only directly under root.
  test("refuses a case-variant .git path segment", async () => {
    expect(await reasonOf(() => writeContained(root, ".GIT/config", "x"))).toBe("git-directory");
    expect(await reasonOf(() => writeContained(root, ".Git/hooks/pre-commit", "x"))).toBe("git-directory");
  });

  test("refuses a nested .git path segment at any depth", async () => {
    expect(await reasonOf(() => writeContained(root, "sub/.git/config", "x"))).toBe("git-directory");
    expect(await reasonOf(() => writeContained(root, "sub/.GIT/config", "x"))).toBe("git-directory");
  });

  // R4-F2: an empty, "."-only, or otherwise root-equal `rel` refuses instead
  // of resolving to `root` itself.
  test("refuses an empty rel", async () => {
    expect(await reasonOf(() => writeContained(root, "", "x"))).toBe("lexical-traversal");
  });

  test("refuses a '.' rel", async () => {
    expect(await reasonOf(() => writeContained(root, ".", "x"))).toBe("lexical-traversal");
  });

  // R4-F3: an atomic overwrite preserves the existing file's mode instead of
  // dropping it to the process default (0644).
  test("preserves the existing file's mode across an atomic overwrite", async () => {
    await writeContained(root, "secret.txt", "one", { mode: 0o600 });
    await Bun.file(path.join(root, "secret.txt")).exists(); // sanity: file exists before chmod check
    const before = (await import("node:fs/promises").then((m) => m.stat(path.join(root, "secret.txt")))).mode & 0o777;
    expect(before).toBe(0o600);
    await writeContained(root, "secret.txt", "two");
    const after = (await import("node:fs/promises").then((m) => m.stat(path.join(root, "secret.txt")))).mode & 0o777;
    expect(after).toBe(0o600);
    expect(await readFile(path.join(root, "secret.txt"), "utf8")).toBe("two");
  });

  test("preserves a 0755 mode across an atomic overwrite", async () => {
    await writeContained(root, "script.sh", "one", { mode: 0o755 });
    await writeContained(root, "script.sh", "two");
    const after = (await import("node:fs/promises").then((m) => m.stat(path.join(root, "script.sh")))).mode & 0o777;
    expect(after).toBe(0o755);
  });

  test("refuses writing over a directory", async () => {
    await mkdir(path.join(root, "dir"), { recursive: true });
    expect(await reasonOf(() => writeContained(root, "dir", "x"))).toBe("not-a-regular-file");
  });

  test("refuses a symlink that resolves outside root", async () => {
    const outsideFile = path.join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "TOP SECRET\n", "utf8");
    await symlink(outsideFile, path.join(root, "escape.txt"));
    expect(await reasonOf(() => writeContained(root, "escape.txt", "x"))).toBe("escaping-symlink");
  });

  test("refuses a dangling symlink on the path", async () => {
    await symlink(path.join(outsideDir, "does-not-exist"), path.join(root, "broken.txt"));
    expect(await reasonOf(() => writeContained(root, "broken.txt", "x"))).toBe("dangling-symlink");
  });

  test("refuses a symlink cycle on the path", async () => {
    await symlink(path.join(root, "cycle-b"), path.join(root, "cycle-a"));
    await symlink(path.join(root, "cycle-a"), path.join(root, "cycle-b"));
    expect(await reasonOf(() => writeContained(root, "cycle-a", "x"))).toBe("symlink-cycle");
  });

  test("allows a symlink that resolves back inside root", async () => {
    await writeFile(path.join(root, "real.txt"), "r\n", "utf8");
    await mkdir(path.join(root, "linked-dir"));
    await symlink(path.join(root, "linked-dir"), path.join(root, "alias"));
    await writeContained(root, "alias/inside.txt", "ok\n");
    expect(await readFile(path.join(root, "linked-dir/inside.txt"), "utf8")).toBe("ok\n");
  });
});

describe("appendContained (R700-03)", () => {
  test("creates the file and parent directories, then appends", async () => {
    await appendContained(root, "a/b/log.jsonl", "one\n");
    await appendContained(root, "a/b/log.jsonl", "two\n");
    expect(await readFile(path.join(root, "a/b/log.jsonl"), "utf8")).toBe("one\ntwo\n");
  });

  test("appends to an existing file without truncating it", async () => {
    await writeContained(root, "log.jsonl", "existing\n");
    await appendContained(root, "log.jsonl", "new\n");
    expect(await readFile(path.join(root, "log.jsonl"), "utf8")).toBe("existing\nnew\n");
  });

  test("refuses a symlinked PARENT directory that resolves outside root: nothing lands outside", async () => {
    await symlink(outsideDir, path.join(root, "linked-dir"));
    expect(await reasonOf(() => appendContained(root, "linked-dir/log.jsonl", "x\n"))).toBe("escaping-symlink");
    const outsideEntries = await import("node:fs/promises").then((m) => m.readdir(outsideDir));
    expect(outsideEntries).toEqual([]);
  });

  test("refuses a symlinked FINAL file that resolves outside root: nothing lands outside", async () => {
    const outsideFile = path.join(outsideDir, "secret.jsonl");
    await writeFile(outsideFile, "TOP SECRET\n", "utf8");
    await symlink(outsideFile, path.join(root, "escape.jsonl"));
    expect(await reasonOf(() => appendContained(root, "escape.jsonl", "x\n"))).toBe("escaping-symlink");
    expect(await readFile(outsideFile, "utf8")).toBe("TOP SECRET\n");
  });

  test("refuses a dangling symlink on the path", async () => {
    await symlink(path.join(outsideDir, "does-not-exist"), path.join(root, "broken.jsonl"));
    expect(await reasonOf(() => appendContained(root, "broken.jsonl", "x\n"))).toBe("dangling-symlink");
  });

  test("allows a symlink that resolves back inside root, appending through it", async () => {
    await mkdir(path.join(root, "linked-dir"));
    await symlink(path.join(root, "linked-dir"), path.join(root, "alias"));
    await appendContained(root, "alias/inside.jsonl", "ok\n");
    expect(await readFile(path.join(root, "linked-dir/inside.jsonl"), "utf8")).toBe("ok\n");
  });
});

describe("removeContained", () => {
  test("removes an existing file and returns true", async () => {
    await writeContained(root, "note.txt", "one");
    expect(await removeContained(root, "note.txt")).toBe(true);
    expect(await Bun.file(path.join(root, "note.txt")).exists()).toBe(false);
  });

  test("returns false, not an error, when nothing is there", async () => {
    expect(await removeContained(root, "missing.txt")).toBe(false);
  });

  test("refuses a lexical .. segment", async () => {
    expect(await reasonOf(() => removeContained(root, "../x"))).toBe("lexical-traversal");
  });

  test("refuses an escaping symlink", async () => {
    const outsideFile = path.join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "TOP SECRET\n", "utf8");
    await symlink(outsideFile, path.join(root, "escape.txt"));
    expect(await reasonOf(() => removeContained(root, "escape.txt"))).toBe("escaping-symlink");
  });

  // R4-F2: `removeContained(root, "")` and `(root, ".")` used to delete the
  // whole root directory instead of refusing.
  test("refuses an empty rel instead of deleting the root", async () => {
    await writeContained(root, "keep.txt", "x");
    expect(await reasonOf(() => removeContained(root, ""))).toBe("lexical-traversal");
    expect(await Bun.file(path.join(root, "keep.txt")).exists()).toBe(true);
  });

  test("refuses a '.' rel instead of deleting the root", async () => {
    await writeContained(root, "keep.txt", "x");
    expect(await reasonOf(() => removeContained(root, "."))).toBe("lexical-traversal");
    expect(await Bun.file(path.join(root, "keep.txt")).exists()).toBe(true);
  });

  test("refuses a case-variant .GIT rel instead of deleting .git", async () => {
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".git", "config"), "x", "utf8");
    expect(await reasonOf(() => removeContained(root, ".GIT"))).toBe("git-directory");
    expect(await Bun.file(path.join(root, ".git", "config")).exists()).toBe(true);
  });
});

describe("mkdirContained", () => {
  test("creates a nested directory", async () => {
    await mkdirContained(root, "a/b/c");
    const st = await import("node:fs/promises").then((m) => m.lstat(path.join(root, "a/b/c")));
    expect(st.isDirectory()).toBe(true);
  });

  test("is idempotent", async () => {
    await mkdirContained(root, "a/b");
    await mkdirContained(root, "a/b");
  });

  test("refuses when a file is already there", async () => {
    await writeContained(root, "a", "x");
    expect(await reasonOf(() => mkdirContained(root, "a"))).toBe("not-a-directory");
  });
});

describe("renameContained", () => {
  test("moves a file, creating destination parents", async () => {
    await writeContained(root, "src/a.txt", "content");
    await renameContained(root, "src/a.txt", "dst/b.txt");
    expect(await readFile(path.join(root, "dst/b.txt"), "utf8")).toBe("content");
    expect(await Bun.file(path.join(root, "src/a.txt")).exists()).toBe(false);
  });

  test("refuses when the source does not exist", async () => {
    expect(await reasonOf(() => renameContained(root, "missing.txt", "dst.txt"))).toBe("not-contained");
  });

  test("refuses an escaping destination", async () => {
    await writeContained(root, "a.txt", "x");
    expect(await reasonOf(() => renameContained(root, "a.txt", "../escape.txt"))).toBe("lexical-traversal");
  });
});

describe("rmdirIfEmptyContained", () => {
  test("removes an empty directory", async () => {
    await mkdirContained(root, "empty");
    expect(await rmdirIfEmptyContained(root, "empty")).toBe(true);
  });

  test("leaves a non-empty directory alone", async () => {
    await writeContained(root, "full/a.txt", "x");
    expect(await rmdirIfEmptyContained(root, "full")).toBe(false);
    expect(await Bun.file(path.join(root, "full/a.txt")).exists()).toBe(true);
  });

  test("returns false for a missing directory", async () => {
    expect(await rmdirIfEmptyContained(root, "nope")).toBe(false);
  });
});
