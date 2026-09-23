// `fs/write_text_file` against a check-then-write race (flow 292 T13, item 3).
//
// The path is confined before the approval wait; the agent owns the worktree
// and can swap an ancestor for an outward symlink before keryx writes. The
// write re-checks the parent's real path after `mkdir`, and opens the target
// with O_NOFOLLOW. `beforeWrite` is the seam that performs the swap at exactly
// the moment a hostile agent would.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { confineAcpPath, writeTextFileInWorktree } from "./acp-fs";

let base = "";
let worktree = "";
let outside = "";

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-fs-")));
  worktree = path.join(base, "wt");
  outside = path.join(base, "outside");
  mkdirSync(path.join(worktree, "sub"), { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("writeTextFileInWorktree", () => {
  test("a plain confined write lands in the worktree", async () => {
    const target = confineAcpPath(worktree, "fs/write_text_file", path.join(worktree, "sub", "a.txt"));
    await writeTextFileInWorktree(worktree, target, "hello", "sub/a.txt");
    expect(readFileSync(path.join(worktree, "sub", "a.txt"), "utf8")).toBe("hello");
  });

  test("an ancestor swapped for an outward symlink between check and write is refused", async () => {
    const target = confineAcpPath(worktree, "fs/write_text_file", path.join(worktree, "sub", "deep", "a.txt"));
    const write = writeTextFileInWorktree(worktree, target, "escaped", "sub/deep/a.txt", {
      beforeWrite: () => {
        rmSync(path.join(worktree, "sub"), { recursive: true, force: true });
        symlinkSync(outside, path.join(worktree, "sub"));
      },
    });
    await expect(write).rejects.toThrow("outside the disposable worktree at write time");
    expect(existsSync(path.join(outside, "deep", "a.txt"))).toBe(false);
  });

  test("a symlink planted AT the target between check and write is not followed (O_NOFOLLOW)", async () => {
    const target = confineAcpPath(worktree, "fs/write_text_file", path.join(worktree, "sub", "a.txt"));
    const write = writeTextFileInWorktree(worktree, target, "escaped", "sub/a.txt", {
      beforeWrite: () => {
        symlinkSync(path.join(outside, "victim.txt"), path.join(worktree, "sub", "a.txt"));
      },
    });
    await expect(write).rejects.toThrow("is a symbolic link");
    expect(existsSync(path.join(outside, "victim.txt"))).toBe(false);
  });
});
