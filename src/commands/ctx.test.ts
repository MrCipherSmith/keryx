import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  buildRgCommand,
  isWorkingTreeDiff,
  rgListMode,
  summarizeCommandOutput,
  summarizeCompact,
  summarizeDiff,
  summarizeRg,
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

// ---------------------------------------------------------------------------
// Flow 235 / T7 — the three measured defects in the compaction layer.
//
// Defect 1. A truncated summary printed the FULL count in its header and showed
// a short body with nothing marking the gap. Measured: `keryx ctx rg "function"
// src/commands/ctx.ts` printed `Matches: 50` above four matches; `keryx ctx rg
// "export" src/ctx` printed `Matches: 60` above 28. A reader takes the header
// as a fact about what they are looking at.

test("summarizeRg marks the gap between the count it reports and the matches it shows", () => {
  // One file, 50 hits — the exact shape measured. Only four are rendered.
  const raw = Array.from({ length: 50 }, (_, i) => `src/a.ts:${i + 1}:1:hit ${i + 1}`).join("\n");
  const out = summarizeRg("rg -- x src/a.ts", result(raw), CONFIG);

  expect(out).toContain("Matches: `50`");
  // The header must no longer stand alone as a claim about the body.
  expect(out).toMatch(/Matches: `50`.*shown/);
  // And the body must say what it dropped, in matches, where it dropped them.
  expect(out).toContain("omitted 46");
});

test("summarizeRg marks files dropped from Top Files and Matches", () => {
  // 20 files × 2 hits: maxGroupItems is 12, so eight files vanished unremarked
  // from both sections while `Files: 20` sat in the header.
  const raw = Array.from({ length: 20 }, (_, f) =>
    [`src/f${f}.ts:1:1:hit a`, `src/f${f}.ts:2:1:hit b`].join("\n"),
  ).join("\n");
  const out = summarizeRg("rg -- x src", result(raw), CONFIG);

  expect(out).toContain("Files: `20`");
  expect(out).toContain("omitted 8");
});

test("summarizeRg says nothing about omissions when it shows everything", () => {
  // The opposite defect a sibling lane fixed: a tiny result must not grow a
  // truncation apparatus it does not need.
  const out = summarizeRg("rg -- x src/a.ts", result("src/a.ts:1:1:only hit"), CONFIG);
  expect(out).toContain("Matches: `1`");
  expect(out).not.toContain("omitted");
  expect(out).not.toContain("shown");
});

// Defect 2. A `FAIL` line in the middle of a long log vanished under compaction
// while the footer reported 98% saved. Measured on a 5,000-line log with one
// `FAIL src/thing/broken.test.ts` at line 2,500: zero occurrences of `FAIL` in
// the summary. `failed|failure` does not match the bare token `FAIL`, and the
// whole programme this tool served exists to stop exactly this.

function logWithVerdict(verdict: string, at: number, total = 5_000): string {
  return Array.from({ length: total }, (_, i) =>
    i + 1 === at ? verdict : `pass line ${i + 1} ok some padding text for a realistic log line`,
  ).join("\n");
}

test("summarizeCommandOutput keeps a failure verdict buried in the middle of a long log", () => {
  const out = summarizeCommandOutput(
    "bun test",
    result(logWithVerdict("FAIL src/thing/broken.test.ts > it keeps the receipt", 2_500)),
    CONFIG,
  );
  expect(out).toContain("FAIL src/thing/broken.test.ts");
});

test("summarizeCommandOutput keeps the verdict vocabulary this repository already uses", () => {
  // Not a special case for one word: these are the failure markers the
  // repository's own summarisers key on — `(fail)` in src/health/sources/tests.ts
  // and `✗` in src/lib/ui.ts — plus the tokens the tools it runs actually emit.
  for (const verdict of [
    "(fail) keeps the receipt",
    "✗ 3 checks did not pass",
    "npm ERR! code ELIFECYCLE",
    "src/a.ts(4,1): error TS2345: Argument of type X",
    "AssertionError: expected 1 to be 2",
    "Segmentation fault",
    "2 fail, 8 pass",
  ]) {
    const out = summarizeCommandOutput("run", result(logWithVerdict(verdict, 2_500)), CONFIG);
    expect(out).toContain(verdict);
  }
});

test("summarizeCommandOutput does not treat a clean verdict as a failure", () => {
  // The predicate has to stay useful: promoting "0 failed" would push real
  // failures out of a bounded budget.
  const out = summarizeCommandOutput(
    "bun test",
    result(logWithVerdict("0 failed, 812 passed", 2_500)),
    CONFIG,
  );
  expect(out).not.toContain("## Errors / Warnings");
});

// Defect 3. Compacted structured output still looked like a whole document and
// no longer parsed. Measured: `keryx ctx read
// .metaproject/data/gdgraph/artifacts/module-map.json` produced a body starting
// `{` and ending `}` that JSON.parse rejected at the elision marker.

test("summarizeCompact labels an elided JSON document as an excerpt that does not parse", () => {
  const document = JSON.stringify(
    { files: Array.from({ length: 400 }, (_, i) => `src/file-${i}.ts`) },
    null,
    2,
  ).split("\n");
  const out = summarizeCompact("module-map.json", document, CONFIG);

  expect(out).toContain("omitted");
  // The tell of the defect: a body that opens `{` and closes `}` with nothing
  // saying it is a fragment.
  expect(out.toLowerCase()).toContain("excerpt");
  expect(out.toLowerCase()).toContain("json");
  expect(out).toContain("does not parse");
});

test("summarizeCompact leaves a JSON document that fits entirely alone, and it parses", () => {
  const document = JSON.stringify({ a: 1, b: [1, 2, 3] }, null, 2).split("\n");
  const out = summarizeCompact("small.json", document, CONFIG);
  expect(out).not.toContain("excerpt");
  const body = out.split("```text\n")[1]?.split("\n```")[0] ?? "";
  expect(() => JSON.parse(body) as unknown).not.toThrow();
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

// Defect (flow 238 / phase 6 / T5, #1): output size discipline fails on small
// inputs. `keryx ctx read` on a four-byte file returned 311 bytes and a
// single-hit `keryx ctx rg` returned ~490-520 — a wrapper costing tens of
// times the payload, defeating the whole point of a context-compacting tool.
// The fix drops the raw/summary artifact-pointer trailer for `read`/`rg` only
// when nothing was actually truncated (the printed body already shows
// everything, so a "here's where to go re-read it" pointer adds pure
// overhead). A large/truncated result must keep the pointer unchanged — that
// is asserted separately below.
async function initTinyProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-ctx-tiny-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    `${JSON.stringify({ modules: { gdctx: { enabled: true } } }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

test("ctx read on a tiny file is not wrapped in a trailer many times its size", async () => {
  const root = await initTinyProject();
  try {
    const file = path.join(root, "tiny.txt");
    await writeFile(file, "abc\n", "utf8");

    const proc = Bun.spawn(["bun", CLI, "ctx", "read", file], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("abc");
    // The bug's tell: a pointer trailer for content that is already shown in
    // full, printed unconditionally regardless of size.
    expect(stdout).not.toContain("raw: ");
    expect(stdout).not.toContain("summary: ");
    // Not a byte-exact pin (paths vary by environment) — a proportionality
    // guard: the whole point of the tool is defeated once the wrapper costs
    // tens of times the four-byte payload.
    expect(Buffer.byteLength(stdout)).toBeLessThan(250);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("ctx rg on a single-hit search is not wrapped in a trailer many times its size", async () => {
  const root = await initTinyProject();
  try {
    const file = path.join(root, "needle.txt");
    await writeFile(file, "uniqueneedle12345\n", "utf8");

    const proc = Bun.spawn(["bun", CLI, "ctx", "rg", "uniqueneedle12345", file], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("uniqueneedle12345");
    expect(stdout).toContain("Matches: `1`");
    expect(stdout).not.toContain("raw: ");
    expect(stdout).not.toContain("summary: ");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("ctx read on a large file still compacts and keeps the raw/summary pointer expandable", async () => {
  const root = await initTinyProject();
  try {
    const file = path.join(root, "big.txt");
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    await writeFile(file, lines.join("\n"), "utf8");

    const proc = Bun.spawn(["bun", CLI, "ctx", "read", file], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    expect(exitCode).toBe(0);
    // Compaction (head/tail truncation) must still fire, and the pointer to
    // the full raw copy must still be printed — the small-input fix must not
    // regress the large-input path this tool exists for.
    expect(stdout).toContain("omitted");
    expect(stdout).toContain("compacted:");
    expect(stdout).toContain("raw: ");
    expect(stdout).toContain("summary: ");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
