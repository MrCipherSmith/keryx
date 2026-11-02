import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveGitProtection, type GitProtectFs } from "./git-protect";

/** A fake filesystem: `dirs` and `files` (path -> content) exist, nothing else. */
function fake(dirs: string[], files: Record<string, string> = {}): GitProtectFs {
  return {
    kind: (p) => (dirs.includes(p) ? "dir" : p in files ? "file" : "missing"),
    readText: (p) => files[p],
    real: (p) => p,
    list: (p) => [...dirs, ...Object.keys(files)].filter((c) => path.dirname(c) === p).map((c) => path.basename(c)),
  };
}

const paths = (roots: string[], fs: GitProtectFs): string[] => resolveGitProtection(roots, fs).controls.map((c) => c.path);

describe("resolveGitProtection", () => {
  test("a checkout: hooks, config, config.worktree and commondir are protected, objects/refs/index are not", () => {
    const fs = fake(["/r/.git", "/r/.git/hooks", "/r/.git/objects"], { "/r/.git/config": "", "/r/.git/HEAD": "" });
    expect(paths(["/r"], fs)).toEqual(["/r/.git/commondir", "/r/.git/config", "/r/.git/config.worktree", "/r/.git/hooks"]);
    expect(resolveGitProtection(["/r"], fs).anchors).toEqual(["/r/.git"]);
  });

  // review-security-code-w2:F-001 (a) / review-logic-w3:F-002 (1): a path that does
  // not exist yet is as dangerous as one that does — git reads it once it appears.
  test("missing control paths are still protected, marked missing", () => {
    const fs = fake(["/r/.git"], { "/r/.git/config": "" });
    const out = resolveGitProtection(["/r"], fs).controls;
    const kind = (p: string) => out.find((c) => c.path === p)?.kind;
    expect(kind("/r/.git/hooks")).toBe("missing");
    expect(kind("/r/.git/commondir")).toBe("missing");
    expect(kind("/r/.git/config")).toBe("file");
  });

  test("no repository: nothing to protect, so a contained `git init` is not broken", () => {
    expect(resolveGitProtection(["/r"], fake([]))).toEqual({ controls: [], anchors: [] });
  });

  test("a gitdir FILE is protected itself, and so is the gitdir it names when that lives inside a writable root", () => {
    const fs = fake(["/r/meta/wt", "/r/meta"], {
      "/r/.git": "gitdir: /r/meta/wt\n",
      "/r/meta/wt/commondir": "..\n",
      "/r/meta/config": "",
    });
    const out = paths(["/r"], fs);
    expect(out).toContain("/r/.git");
    expect(out).toContain("/r/meta/wt/commondir");
    expect(out).toContain("/r/meta/wt/config.worktree");
    expect(out).not.toContain("/r/meta/wt/hooks"); // a linked gitdir takes hooks from the common dir
    expect(out).toContain("/r/meta/config"); // the common dir, via commondir
    expect(out).toContain("/r/meta/hooks");
    // Every directory between the root and each git dir is pinned: renaming /r/meta
    // away would otherwise let a fresh /r/meta/wt take its place.
    expect(resolveGitProtection(["/r"], fs).anchors).toEqual(["/r/meta", "/r/meta/wt"]);
  });

  test("a submodule's gitdir (no commondir) is a full repository: hooks and config too", () => {
    const fs = fake(["/r/.git", "/r/.git/modules", "/r/.git/modules/s"], { "/s/.git": "gitdir: ../r/.git/modules/s\n" });
    const out = paths(["/s", "/r"], fs);
    expect(out).toContain("/r/.git/modules/s/hooks");
    expect(out).toContain("/r/.git/modules/s/config");
  });

  test("a gitdir FILE pointing outside every writable root: only the file is protected (the target is already read-only)", () => {
    const fs = fake(["/main/.git/worktrees/x"], { "/r/.git": "gitdir: /main/.git/worktrees/x\n" });
    expect(resolveGitProtection(["/r"], fs)).toEqual({
      controls: [{ path: "/r/.git", real: "/r/.git", entry: ".git", kind: "file" }],
      anchors: [],
    });
  });

  test("a relative gitdir resolves against the root", () => {
    const fs = fake(["/r/g"], { "/r/.git": "gitdir: g\n" });
    expect(paths(["/r"], fs)).toContain("/r/g/hooks");
  });

  test("a checkout's linked worktrees: their commondir and config.worktree are protected, and the worktrees dir is pinned", () => {
    const fs = fake(["/r/.git", "/r/.git/worktrees", "/r/.git/worktrees/a"], {
      "/r/.git/config": "",
      "/r/.git/worktrees/a/commondir": "../..\n",
      "/r/.git/worktrees/a/gitdir": "/elsewhere/a/.git\n",
    });
    const g = resolveGitProtection(["/r"], fs);
    expect(g.controls.map((c) => c.path)).toContain("/r/.git/worktrees/a/commondir");
    expect(g.controls.map((c) => c.path)).toContain("/r/.git/worktrees/a/config.worktree");
    expect(g.anchors).toEqual(["/r/.git", "/r/.git/worktrees", "/r/.git/worktrees/a"]);
  });

  test("nested writable roots: anchors run up to the OUTERMOST root", () => {
    const fs = fake(["/r/a/b/.git"], {});
    expect(resolveGitProtection(["/r/a/b", "/r"], fs).anchors).toEqual(["/r/a", "/r/a/b", "/r/a/b/.git"]);
  });

  test("real filesystem: a repo on disk, a symlinked hooks dir is protected under both names", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-gp-")));
    try {
      mkdirSync(path.join(root, ".git"), { recursive: true });
      mkdirSync(path.join(root, "githooks"));
      symlinkSync("../githooks", path.join(root, ".git", "hooks"));
      writeFileSync(path.join(root, ".git", "config"), "");
      const g = resolveGitProtection([root]);
      const hooks = g.controls.find((c) => c.entry === "hooks");
      expect(hooks).toEqual({ path: path.join(root, ".git", "hooks"), real: path.join(root, "githooks"), entry: "hooks", kind: "dir" });
      expect(g.controls.find((c) => c.entry === "commondir")?.kind).toBe("missing");
      expect(g.anchors).toEqual([path.join(root, ".git")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
