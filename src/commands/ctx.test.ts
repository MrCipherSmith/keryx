import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// Flow 235 / T9, AC3 ("JSON валиден"). The step above stopped a truncated
// document from *claiming* to be whole; it did not give the reader a JSON
// document. A fragment labelled "does not parse" is honest and useless — the
// consumer of `ctx read` on a JSON file is an agent that wants to parse it.
// The elided form is now a bounded STRUCTURAL SUMMARY with its own type, which
// parses, states that it is incomplete, and carries the address of the rest.
test("summarizeCompact renders an elided JSON document as a summary that still parses", () => {
  const document = JSON.stringify(
    {
      exitCode: 7,
      failedTests: 3,
      files: Array.from({ length: 400 }, (_, i) => `src/file-${i}.ts`),
    },
    null,
    2,
  ).split("\n");
  const out = summarizeCompact("module-map.json", document, CONFIG);

  expect(out.toLowerCase()).toContain("excerpt");
  const body = fencedBody(out);
  const parsed = JSON.parse(body) as Record<string, unknown>;

  // Its own type, and it says out loud that it is not the document.
  const envelope = parsed.keryxSummary as Record<string, unknown>;
  expect(envelope.type).toBe("json-structure");
  expect(envelope.complete).toBe(false);
  expect(typeof envelope.recover).toBe("string");

  // Critical structural fields survive the summary rather than surviving by
  // the accident of sitting near the head of the file.
  const doc = parsed.document as Record<string, unknown>;
  expect(doc.exitCode).toBe(7);
  expect(doc.failedTests).toBe(3);
  // And the loss is stated where it happened.
  expect(JSON.stringify(doc.files)).toContain("omitted");
});

test("summarizeCompact leaves a JSON document that fits entirely alone, and it parses", () => {
  const document = JSON.stringify({ a: 1, b: [1, 2, 3] }, null, 2).split("\n");
  const out = summarizeCompact("small.json", document, CONFIG);
  expect(out).not.toContain("excerpt");
  const parsed = JSON.parse(fencedBody(out)) as Record<string, unknown>;
  // The whole document, verbatim — not wrapped in a summary envelope it does
  // not need. "Короткий ввод не раздувается" applies to shape as well as size.
  expect(parsed).toEqual({ a: 1, b: [1, 2, 3] });
});

/** The first fenced block's body, whatever the fence's language tag. */
function fencedBody(out: string): string {
  const open = out.indexOf("```");
  const bodyStart = out.indexOf("\n", open) + 1;
  const close = out.indexOf("\n```", bodyStart);
  return out.slice(bodyStart, close === -1 ? undefined : close);
}

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

// ---------------------------------------------------------------------------
// Flow 235 / T9 — AC3 (ctx preservation) and AC4 (loss manifest) at the real
// surface. Every test below drives `bun src/cli.ts ctx …`, not a summariser,
// because the standing failure in this programme is a capability implemented
// where no live path calls it.

async function runCtx(
  root: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI, "ctx", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

// AC3, JSON clause. Measured before the fix on a 1,084,141-byte document:
// `ctx read --mode compact` emitted a 6,043-byte body that opened `{`, closed
// `}` and failed `JSON.parse` at the elision marker.
test("ctx read hands back JSON that parses, at both size ends", async () => {
  const root = await initTinyProject();
  try {
    const small = path.join(root, "small.json");
    await writeFile(small, `${JSON.stringify({ ok: true, items: [1, 2] }, null, 2)}\n`, "utf8");
    const smallRun = await runCtx(root, ["read", small]);
    expect(smallRun.exitCode).toBe(0);
    expect(JSON.parse(fencedBody(smallRun.stdout))).toEqual({ ok: true, items: [1, 2] });

    const big = path.join(root, "big.json");
    await writeFile(
      big,
      JSON.stringify(
        {
          exitCode: 7,
          failedTests: 3,
          errors: [{ message: "boom" }],
          records: Array.from({ length: 4_000 }, (_, i) => ({ id: i, detail: "x".repeat(40) })),
        },
        null,
        2,
      ),
      "utf8",
    );
    const bigRun = await runCtx(root, ["read", big]);
    expect(bigRun.exitCode).toBe(0);
    const parsed = JSON.parse(fencedBody(bigRun.stdout)) as Record<string, unknown>;
    const envelope = parsed.keryxSummary as Record<string, unknown>;
    expect(envelope.complete).toBe(false);
    expect(String(envelope.recover)).toContain("keryx ctx show");
    const doc = parsed.document as Record<string, unknown>;
    expect(doc.exitCode).toBe(7);
    expect(doc.failedTests).toBe(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

// The same clause for JSON Lines, driven through the CLI rather than the
// helper — a repair nothing calls would be worth nothing.
test("ctx read on an elided JSONL file leaves every row parseable", async () => {
  const root = await initTinyProject();
  try {
    const file = path.join(root, "events.jsonl");
    const rows = Array.from({ length: 2_000 }, (_, i) => JSON.stringify({ i, kind: "event" }));
    await writeFile(file, rows.join("\n"), "utf8");

    const run = await runCtx(root, ["read", file]);
    expect(run.exitCode).toBe(0);
    const body = fencedBody(run.stdout);
    expect(body).toContain("keryxOmitted");
    for (const row of body.split("\n").filter((line) => line.trim().length > 0)) {
      expect(() => JSON.parse(row) as unknown).not.toThrow();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

// AC3, base clause. `--base` was accepted and silently discarded: exit 0, an
// ordinary view, and nothing saying the argument had no effect.
test("ctx read with a base it cannot honour returns the full view and says why", async () => {
  const root = await initTinyProject();
  try {
    const file = path.join(root, "small.json");
    await writeFile(file, `${JSON.stringify({ ok: true }, null, 2)}\n`, "utf8");
    const run = await runCtx(root, ["read", file, "--base", "no-such-snapshot"]);

    expect(run.exitCode).toBe(0);
    // The full view is still returned…
    expect(JSON.parse(fencedBody(run.stdout))).toEqual({ ok: true });
    // …with a stated reason, not silence.
    expect(run.stdout).toContain("Base ignored");
    expect(run.stdout.toLowerCase()).toContain("no delta");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

// AC4, recovery by address. The pointer already existed; feeding it back was
// measured to fail — `ctx show .metaproject/data/gdctx/raw/<id>.log` joined the
// address onto the root a second time and reported "Artifact not found".
test("an omitted range is recoverable from the printed address without searching", async () => {
  const root = await initTinyProject();
  try {
    const file = path.join(root, "big.txt");
    const lines = Array.from({ length: 1_000 }, (_, i) => `line ${i}`);
    await writeFile(file, lines.join("\n"), "utf8");

    const read = await runCtx(root, ["read", file]);
    expect(read.exitCode).toBe(0);

    // The manifest names the omitted range and the exact command to recover it.
    const entry = /- lines (\d+)-(\d+)\b/.exec(read.stdout);
    expect(entry).not.toBeNull();
    const address = /^raw: (\S+)$/m.exec(read.stdout)?.[1] ?? "";
    expect(address).not.toBe("");

    const [, startText, endText] = entry as RegExpExecArray;
    const recovered = await runCtx(root, [
      "show",
      address,
      "--raw",
      "--lines",
      `${startText}-${endText}`,
    ]);
    expect(recovered.exitCode).toBe(0);
    // Exactly the omitted range, addressed — no second search over the source.
    expect(recovered.stdout).toContain(lines[Number(startText) - 1] as string);
    expect(recovered.stdout).toContain(lines[Number(endText) - 1] as string);
    expect(recovered.stdout).not.toContain(`${lines[0] as string}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

// AC4, manifest truncation. Rescuing verdict lines out of the elided middle
// splits it into many ranges, so the manifest itself has to be bounded — and
// when it is cut, that has to show.
test("a loss manifest that is itself shortened says so", async () => {
  const root = await initTinyProject();
  try {
    const file = path.join(root, "suite.log");
    const lines = Array.from({ length: 4_000 }, (_, i) =>
      i % 40 === 0 && i > 200 && i < 3_800 ? `not ok ${i} - failure ${i}` : `ok ${i} - passing case`,
    );
    await writeFile(file, lines.join("\n"), "utf8");

    const run = await runCtx(root, ["read", file]);
    expect(run.exitCode).toBe(0);
    // Measured on this checkout while writing the test: `ctx read --mode
    // compact` sliced head+tail with its own code and never called
    // `compactLines`, so the verdict rescue that `ctx run` got was absent here.
    // An agent told to read the test log still lost every failure in it.
    expect(run.stdout).toContain("not ok ");
    expect(run.stdout).toContain("## Omitted");
    expect(run.stdout).toContain("manifest truncated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

// AC4, closed object. Measured before the fix: `EACCES: permission denied,
// open '/etc/master.passwd'` versus `ENOENT: no such file or directory, open
// '<abs path>'` — the first positively confirms the object exists, and both
// echo a path the caller never supplied.
test("a denied read and a missing read are indistinguishable and leak no path", async () => {
  const root = await initTinyProject();
  try {
    const denied = path.join(root, "closed.txt");
    await writeFile(denied, "secret\n", "utf8");
    await chmod(denied, 0o000);

    const deniedRun = await runCtx(root, ["read", "closed.txt"]);
    const missingRun = await runCtx(root, ["read", "absent.txt"]);

    expect(deniedRun.exitCode).toBe(missingRun.exitCode);
    expect(deniedRun.exitCode).not.toBe(0);
    // Same shape, differing only in the caller's own argument.
    expect(deniedRun.stderr.replace("closed.txt", "<p>")).toBe(
      missingRun.stderr.replace("absent.txt", "<p>"),
    );
    for (const out of [deniedRun.stderr, missingRun.stderr]) {
      expect(out).not.toContain("EACCES");
      expect(out).not.toContain("ENOENT");
      // Not the resolved absolute path: the caller gave a relative one.
      expect(out).not.toContain(root);
    }
  } finally {
    await chmod(path.join(root, "closed.txt"), 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Flow 238 / T13 — completeness at the point of use. Three reviews refused to
// use `keryx ctx rg` for a defect enumeration and fell back to raw search:
// eliding matches is fine for finding something and useless for proving a
// list of sites is complete. `Scope:`/`Completeness:` close that gap.

test("summarizeRg carries Scope and Completeness lines on every run, capped or not", () => {
  const raw = Array.from({ length: 50 }, (_, i) => `src/a.ts:${i + 1}:1:hit ${i + 1}`).join("\n");

  const partial = summarizeRg("rg -- x src/a.ts", result(raw), CONFIG);
  expect(partial).toContain("Scope: `ripgrep defaults`");
  expect(partial).toContain("Completeness: `partial`");

  // The realistic failure named by this task: a caller tests a two-hit query,
  // sees no marker, and trusts the same tool on a fifty-hit one. Both runs
  // must carry the same two lines, even the small one that elides nothing.
  const complete = summarizeRg("rg -- x src/a.ts", result("src/a.ts:1:1:only hit"), CONFIG);
  expect(complete).toContain("Scope: `ripgrep defaults`");
  expect(complete).toContain("Completeness: `complete`");
});

test("summarizeRg reports the header count as unreliable when -m capped ripgrep itself", () => {
  // Measured: `keryx ctx rg -m 1 "omitted" src/ctx/lines.ts` printed
  // `Matches: 1` for a file holding 19, with no marker anywhere — the header
  // count is not always a true total, and this is the one case where it is
  // not: `-m` makes ripgrep stop counting, not just keryx stop rendering.
  const out = summarizeRg("rg -m 1 -- x src/a.ts", result("src/a.ts:1:1:hit"), CONFIG, {
    scope: { hidden: false, ignored: false, capped: true },
  });
  expect(out).toContain("Matches: `1` (capped by -m/--max-count — not a total)");
  expect(out).toContain("Completeness: `unknown`");
  expect(out).not.toContain("Completeness: `complete`");
});

test("summarizeRg --all renders every match and every file, not the default caps", () => {
  // 20 files x 3 hits: more than maxGroupItems (12) files and more than
  // RG_EXAMPLES_PER_FILE (4) hits per file — both defaults would cut this.
  const raw = Array.from({ length: 20 }, (_, f) =>
    Array.from({ length: 3 }, (_, h) => `src/f${f}.ts:${h + 1}:1:hit ${h + 1}`).join("\n"),
  ).join("\n");
  const out = summarizeRg("rg -- x src", result(raw), CONFIG, { all: true });

  expect(out).toContain("Matches: `60`");
  expect(out).toContain("Completeness: `complete`");
  expect(out).not.toContain("omitted");
  // Every file's third hit is present, not just the capped four.
  for (let f = 0; f < 20; f += 1) {
    expect(out).toContain(`- src/f${f}.ts`);
    expect(out).toContain(`3:1 hit 3`);
  }
});

test("summarizeRgFileList also carries Scope and Completeness, and --all lifts its cap", () => {
  const many = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`).join("\n");
  const capped = summarizeRgFileList("rg --files-with-matches foo", result(many), CONFIG, "files");
  expect(capped).toContain("Scope: `ripgrep defaults`");
  expect(capped).toContain("Completeness: `partial`");

  const all = summarizeRgFileList("rg --files-with-matches foo", result(many), CONFIG, "files", {
    all: true,
  });
  expect(all).toContain("Completeness: `complete`");
  expect(all).toContain("- src/f199.ts");
});

// End-to-end: `.metaproject/` is unreachable by default not through a keryx
// exclusion or `.gitignore`, but through ripgrep's own hidden-path skip — and
// a caller must be told which, not shown an empty result indistinguishable
// from "nothing there".
test("ctx rg: a nil result under .metaproject/ reads as excluded, not as absent", async () => {
  const root = await initTinyProject();
  try {
    await writeFile(path.join(root, ".metaproject", "secret-needle-9f3a.md"), "found me\n", "utf8");
    // A visible sibling file, so the directory is not ENTIRELY hidden content
    // — otherwise ripgrep refuses to search at all ("No files were searched")
    // rather than reporting a clean zero, which would test a different rg
    // behaviour than the one this case exists to cover.
    await writeFile(path.join(root, "visible.txt"), "nothing to find here\n", "utf8");

    const bare = await runCtx(root, ["rg", "found me"]);
    expect(bare.exitCode).not.toBe(0); // ripgrep's own no-match exit code
    expect(bare.stdout).toContain("Matches: `0`");
    // The scope line is what turns that zero from a false-clean into an
    // honest "not searched here" — present even on a run that found nothing.
    expect(bare.stdout).toContain(".metaproject/");
    expect(bare.stdout).toContain('"not looked at", not "not present"');

    const hidden = await runCtx(root, ["rg", "--hidden", "found me"]);
    expect(hidden.exitCode).toBe(0);
    expect(hidden.stdout).toContain("secret-needle-9f3a.md");
    expect(hidden.stdout).toContain("Completeness: `complete`");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("ctx rg --all renders a full result at the real CLI, not just in the summariser", async () => {
  const root = await initTinyProject();
  try {
    const many = Array.from({ length: 30 }, (_, i) => `line ${i}: unique-token-c7d1`).join("\n");
    await writeFile(path.join(root, "many.txt"), `${many}\n`, "utf8");

    const capped = await runCtx(root, ["rg", "unique-token-c7d1", "many.txt"]);
    expect(capped.stdout).toContain("Completeness: `partial`");
    expect(capped.stdout).not.toContain("line 29:");

    const all = await runCtx(root, ["rg", "unique-token-c7d1", "many.txt", "--all"]);
    expect(all.stdout).toContain("Completeness: `complete`");
    expect(all.stdout).toContain("line 29:");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
