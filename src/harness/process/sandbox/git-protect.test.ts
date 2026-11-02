import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitProtectAnchors, resolveGitProtectedPaths, type GitProtectFs } from "./git-protect";

/** A fake filesystem: `dirs` and `files` (path -> content) exist, nothing else. */
function fake(dirs: string[], files: Record<string, string> = {}): GitProtectFs {
  return {
    kind: (p) => (dirs.includes(p) ? "dir" : p in files ? "file" : "missing"),
    readText: (p) => files[p],
    real: (p) => p,
  };
}

describe("resolveGitProtectedPaths", () => {
  test("a checkout: hooks and config (and config.worktree) are protected, objects/refs are not", () => {
    const fs = fake(["/r/.git", "/r/.git/hooks", "/r/.git/objects"], { "/r/.git/config": "", "/r/.git/HEAD": "" });
    expect(resolveGitProtectedPaths(["/r"], fs)).toEqual(["/r/.git/config", "/r/.git/hooks"]);
  });

  test("no repository: nothing to protect, so a contained `git init` is not broken", () => {
    expect(resolveGitProtectedPaths(["/r"], fake([]))).toEqual([]);
  });

  test("a gitdir FILE is protected itself, and so is the gitdir it names when that lives inside a writable root", () => {
    const fs = fake(["/r/meta/wt", "/r/meta/wt/hooks", "/r/meta"], {
      "/r/.git": "gitdir: /r/meta/wt\n",
      "/r/meta/wt/config": "",
      "/r/meta/wt/commondir": "..\n",
      "/r/meta/config": "",
    });
    const out = resolveGitProtectedPaths(["/r"], fs);
    expect(out).toContain("/r/.git");
    expect(out).toContain("/r/meta/wt/hooks");
    expect(out).toContain("/r/meta/wt/config");
    expect(out).toContain("/r/meta/config"); // commondir
  });

  test("a gitdir FILE pointing outside every writable root: only the file is protected (the target is already read-only)", () => {
    const fs = fake(["/main/.git/worktrees/x"], { "/r/.git": "gitdir: /main/.git/worktrees/x\n" });
    expect(resolveGitProtectedPaths(["/r"], fs)).toEqual(["/r/.git"]);
  });

  test("a relative gitdir resolves against the root", () => {
    const fs = fake(["/r/g", "/r/g/hooks"], { "/r/.git": "gitdir: g\n" });
    expect(resolveGitProtectedPaths(["/r"], fs)).toContain("/r/g/hooks");
  });

  test("real filesystem: a repo on disk", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-gp-")));
    try {
      mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
      writeFileSync(path.join(root, ".git", "config"), "");
      expect(resolveGitProtectedPaths([root])).toEqual([path.join(root, ".git", "config"), path.join(root, ".git", "hooks")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("gitProtectAnchors", () => {
  test("the git dir holding protected entries, but not a .git gitdir file", () => {
    expect(gitProtectAnchors(["/r/.git/config", "/r/.git/hooks", "/r/.git"])).toEqual(["/r/.git"]);
  });
});
