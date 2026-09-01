import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

// Regression: the diff summariser understood ONE output shape — a full patch,
// found by its `diff --git` headers. Asked for any other shape it found no
// files and reported `Changed files: 0` over a real diff, while the raw log it
// wrote beside the summary carried every one of them. A false-clean report is
// the worst failure mode for a context tool: nothing in the output signals the
// disagreement, so an agent reads "no changes" and stops.
const STAT_OUTPUT = [
  " .../gdskills/review/review-clean-code/SKILL.md     |  34 +++-",
  " src/gdskills/catalog.ts                            |   6 +",
  " 2 files changed, 39 insertions(+), 1 deletion(-)",
].join("\n");

test("summarizeDiff counts files from --stat, not zero", () => {
  const out = summarizeDiff("git diff --stat HEAD", result(STAT_OUTPUT), CONFIG, null);
  expect(out).toContain("Changed files: `2`");
  expect(out).not.toContain("Changed files: `0`");
  expect(out).toContain("Output shape: `stat`");
  expect(out).toContain("src/gdskills/catalog.ts");
  expect(out).not.toContain("- none");
});

test("summarizeDiff warns that --stat abbreviated the paths it matches risk on", () => {
  const out = summarizeDiff("git diff --stat HEAD", result(STAT_OUTPUT), CONFIG, null);
  // `src/commands/` and friends cannot match a path git elided to `.../tail`,
  // so a bare "- none" here would be the same false-clean one section down.
  expect(out).toContain("paths are abbreviated");
});

test("summarizeDiff reads exact counts from --numstat, and binary files carry none", () => {
  const out = summarizeDiff(
    "git diff --numstat HEAD",
    result(["34\t1\tsrc/a.ts", "-\t-\tassets/logo.png"].join("\n")),
    CONFIG,
    null,
  );
  expect(out).toContain("Changed files: `2`");
  expect(out).toContain("- src/a.ts: +34 -1");
  // a binary file reported as `+0 -0` would claim it was touched without changing
  expect(out).toContain("- assets/logo.png");
  expect(out).not.toContain("assets/logo.png: +0 -0");
});

test("summarizeDiff still counts a real patch, and --name-only/--name-status too", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1,2 @@",
    "+added",
    "-removed",
  ].join("\n");
  expect(summarizeDiff("git diff HEAD", result(patch), CONFIG, null)).toContain("Changed files: `1`");
  // the patch shape is the default and stays unannotated
  expect(summarizeDiff("git diff HEAD", result(patch), CONFIG, null)).not.toContain("Output shape:");

  expect(summarizeDiff("git diff --name-only HEAD", result("src/a.ts\nsrc/b.ts"), CONFIG, null)).toContain(
    "Changed files: `2`",
  );
  expect(
    summarizeDiff("git diff --name-status HEAD", result("M\tsrc/a.ts\nA\tsrc/b.ts"), CONFIG, null),
  ).toContain("Changed files: `2`");
});

test("summarizeDiff reports --shortstat's count even though it lists no rows", () => {
  const out = summarizeDiff(
    "git diff --shortstat HEAD",
    result(" 14 files changed, 831 insertions(+), 12 deletions(-)"),
    CONFIG,
    null,
  );
  expect(out).toContain("Changed files: `14`");
  expect(out).toContain("no per-file rows");
  // The Risk Hints section must not claim a clean result for a file list it
  // never had. This assertion is the gap that let the defect ship: the test
  // above pinned the count and the row message, and nothing in the suite
  // asserted on Risk Hints at all, so "- none" over 14 unexamined files read as
  // correct.
  expect(out).not.toContain("- none");
  expect(out).toContain("nothing was checked");
});

test("Risk Hints says `- none` only when a file list was actually examined", () => {
  // Three states, two of which "- none" was covering for:
  //
  //   a truly empty diff  -> none, honestly
  //   a count with no rows -> unknown; files changed, none inspected
  //   a list with no risky files -> none, honestly
  const empty = summarizeDiff("git diff HEAD", result(""), CONFIG, null);
  expect(empty).toContain("- none");

  const countedButUnlisted = summarizeDiff(
    "git diff --shortstat HEAD",
    result(" 2 files changed, 3 insertions(+), 1 deletion(-)"),
    CONFIG,
    null,
  );
  expect(countedButUnlisted).toContain("2 file(s) changed");
  expect(countedButUnlisted).toContain("Re-run with");

  // A real list whose files are simply not risky still reports none — the fix
  // must not turn every diff into "unknown", which would make the section
  // useless and get it ignored.
  const listedAndSafe = summarizeDiff(
    "git diff --name-only HEAD",
    result("docs/readme.md\ndocs/guide.md"),
    CONFIG,
    null,
  );
  expect(listedAndSafe).toContain("Changed files: `2`");
  expect(listedAndSafe).toContain("- none");
});

test("summarizeDiff says unknown, never zero, for a shape it cannot enumerate", () => {
  const out = summarizeDiff("git diff --some-future-flag", result("a b c\nd e f"), CONFIG, null);
  expect(out).toContain("Changed files: `unknown`");
  expect(out).not.toContain("Changed files: `0`");
  expect(out).toContain("not enumerable");
});

test("summarizeDiff still reports a genuinely clean tree as zero", () => {
  // The fix must not turn "clean" into "unknown": empty output IS enumerable.
  const out = summarizeDiff("git diff HEAD", result(""), CONFIG, []);
  expect(out).toContain("Changed files: `0`");
  expect(out).toContain("- none");
});

const CLI = path.join(import.meta.dir, "..", "cli.ts");

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr}`);
  }
}

// Regression: gdctx artifacts belong to the PROJECT, not to whatever directory
// the command was started in. Rooted at `process.cwd()`, `keryx ctx rg` run
// from a docs or fixture folder wrote a brand-new `.metaproject/data/gdctx/`
// right there — this repository collected six such directories — and
// `keryx ctx show latest` from the root then could not find what had just been
// written.
test("ctx run from a subdirectory writes artifacts to the project root, not beside the caller", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-ctx-root-"));
  const sub = path.join(root, "docs", "requirements");

  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      `${JSON.stringify({ modules: { gdctx: { enabled: true } } }, null, 2)}\n`,
      "utf8",
    );
    await mkdir(sub, { recursive: true });

    const proc = Bun.spawn(["bun", CLI, "ctx", "run", "--", "echo", "hello"], {
      cwd: sub,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    expect(exitCode).toBe(0);
    // the bug's tell
    expect(existsSync(path.join(sub, ".metaproject"))).toBe(false);
    expect(existsSync(path.join(root, "docs", ".metaproject"))).toBe(false);

    expect(existsSync(path.join(root, ".metaproject", "data", "gdctx", "artifacts", "latest.md"))).toBe(
      true,
    );
    // Reported paths stay project-root-relative rather than becoming a `../../`
    // walk out of the caller's directory.
    expect(stdout).toContain(".metaproject/data/gdctx/");
    expect(stdout).not.toContain("../");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

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
