import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  buildRgCommand,
  isWorkingTreeDiff,
  rgListMode,
  summarizeDiff,
  summarizeRgFileList,
} from "./ctx";

const CONFIG = {
  maxOutputLines: 120,
  maxImportantLines: 60,
  maxGroupItems: 12,
  compactHeadLines: 120,
  compactTailLines: 80,
  outlineMaxEntries: 160,
};

function result(raw: string) {
  return { stdout: raw, stderr: "", raw, exitCode: 0 };
}

test("rgListMode detects file-listing and count flags", () => {
  expect(rgListMode(["foo", "--files-with-matches"])).toBe("files");
  expect(rgListMode(["foo", "-l"])).toBe("files");
  expect(rgListMode(["foo", "--files"])).toBe("files");
  expect(rgListMode(["foo", "--count"])).toBe("count");
  expect(rgListMode(["foo", "-c"])).toBe("count");
  expect(rgListMode(["foo", "src/"])).toBeNull(); // normal match search
});

// Review 2026-07-26, B-03: rg omits the filename for a single explicit file
// path, so `keryx ctx rg "x" src/foo.ts` reported `(unknown)` and `0:0`.
test("buildRgCommand always passes --with-filename", () => {
  // `buildRgCommand` returns a result rather than an argv, because flow 126
  // made it refuse caller-supplied flags that ripgrep would parse as its own
  // — `--pre=…` reached arbitrary command execution through the one operation
  // agents are told to prefer over raw grep. The `--with-filename` fix rides
  // inside that shape; both properties are asserted together here so neither
  // can be dropped while the other still passes.
  const search = buildRgCommand(["foo", "src/a.ts"], null);
  expect(search.ok).toBe(true);
  if (!search.ok) return;
  expect(search.command).toEqual([
    "rg",
    "--with-filename",
    "--line-number",
    "--column",
    "--no-heading",
    "--",
    "foo",
    "src/a.ts",
  ]);

  const listing = buildRgCommand(["foo", "-l"], "files");
  expect(listing.ok).toBe(true);
  if (!listing.ok) return;
  expect(listing.command).toEqual(["rg", "--with-filename", "--no-heading", "-l", "--", "foo"]);
});

test("rg emits file:line:col for a single explicit file path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-ctx-rg-"));
  try {
    const file = path.join(dir, "single.ts");
    await writeFile(file, "const a = 1;\nconst needle = 2;\n");

    const built = buildRgCommand(["needle", file], null);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const proc = Bun.spawn(built.command, { stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const line = stdout.trim().split("\n")[0] ?? "";

    // `<file>:<line>:<column>:<text>` — the shape parseRgMatches requires.
    expect(line.startsWith(`${file}:2:7:`)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("summarizeRgFileList lists real paths, not (unknown) 0:0 garbage", () => {
  const raw = "src/a.ts\nsrc/b.ts\nsrc/c.ts";
  const out = summarizeRgFileList("rg --no-heading foo -l", result(raw), CONFIG, "files");
  expect(out).toContain("Files: `3`");
  expect(out).toContain("- src/a.ts");
  expect(out).toContain("- src/c.ts");
  // the old bug's tells must be gone
  expect(out).not.toContain("(unknown)");
  expect(out).not.toContain("0:0");
});

test("summarizeRgFileList handles --count output (path:count)", () => {
  const out = summarizeRgFileList("rg --count foo", result("src/a.ts:3\nsrc/b.ts:1"), CONFIG, "count");
  expect(out).toContain("path:count");
  expect(out).toContain("- src/a.ts:3");
});

test("isWorkingTreeDiff only claims flag-only invocations", () => {
  expect(isWorkingTreeDiff([])).toBe(true);
  expect(isWorkingTreeDiff(["--stat"])).toBe(true);
  // an explicit revision, a pathspec, or --staged must reach git verbatim:
  // appending a base after them changes how git parses the arguments.
  expect(isWorkingTreeDiff(["HEAD~1"])).toBe(false);
  expect(isWorkingTreeDiff(["main...HEAD"])).toBe(false);
  expect(isWorkingTreeDiff(["--", "src/"])).toBe(false);
  expect(isWorkingTreeDiff(["--staged"])).toBe(false);
  expect(isWorkingTreeDiff(["--cached"])).toBe(false);
});

test("summarizeDiff reports untracked files, and omits the section when not applicable", () => {
  const withUntracked = summarizeDiff("git diff HEAD", result(""), CONFIG, ["new-a.ts", "new-b.ts"]);
  expect(withUntracked).toContain("Untracked files: `2`");
  expect(withUntracked).toContain("## Untracked");
  expect(withUntracked).toContain("- new-a.ts");

  // explicit invocations (revision/pathspec/--staged) pass null — a working-tree
  // untracked listing would be noise there.
  const explicit = summarizeDiff("git diff main...HEAD", result(""), CONFIG, null);
  expect(explicit).not.toContain("## Untracked");
  expect(explicit).not.toContain("Untracked files:");
});

const CLI = path.join(import.meta.dir, "..", "cli.ts");

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr}`);
  }
}

// Regression: `keryx ctx diff` must describe the working tree it is invoked
// from — including a linked `git worktree`, the isolation model used for
// concurrent flows — and must not miss staged or untracked work. Bare
// `git diff` showed neither, so a mid-flow worktree holding hundreds of
// changed lines reported "Changed files: 0" and read as clean.
test("ctx diff reports staged and untracked changes from inside a git worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-ctx-diff-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "wt");

  try {
    await git(root, ["init", "--quiet", "-b", "main", repo]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "test"]);
    await writeFile(path.join(repo, "tracked.ts"), "export const value = 1;\n", "utf8");
    await git(repo, ["add", "tracked.ts"]);
    await git(repo, ["commit", "--quiet", "-m", "initial"]);

    await git(repo, ["worktree", "add", "--quiet", "-b", "probe", worktree]);

    // The exact shape flow workers produce: a staged edit plus a brand-new file.
    await writeFile(path.join(worktree, "tracked.ts"), "export const value = 2;\n", "utf8");
    await git(worktree, ["add", "tracked.ts"]);
    await writeFile(path.join(worktree, "brand-new.ts"), "export const added = true;\n", "utf8");

    const proc = Bun.spawn(["bun", CLI, "ctx", "diff"], {
      cwd: worktree,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Changed files: `1`");
    expect(stdout).toContain("- tracked.ts:");
    expect(stdout).toContain("Untracked files: `1`");
    expect(stdout).toContain("- brand-new.ts");
    // the bug's tell: the worktree silently reported as clean
    expect(stdout).not.toContain("Changed files: `0`");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
