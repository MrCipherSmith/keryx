import { expect, test } from "bun:test";
import {
  buildPathScope,
  buildReviewScope,
  classifyPath,
  DEFAULT_CONTEXT_LINES,
  renderReviewScopeMarkdown,
  type ReviewScope,
} from "./scope";

function fileHeader(path: string): string[] {
  return [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`];
}

function hunk(header: string, ...lines: string[]): string[] {
  return [header, ...lines];
}

function droppedFor(scope: ReviewScope, path: string) {
  return scope.drops.filter((drop) => drop.path === path);
}

// ---------------------------------------------------------------------------
// AC4 — the acceptance test named in the criterion.
// ---------------------------------------------------------------------------

/**
 * The diff the acceptance criterion names: a lockfile, a whitespace-only hunk,
 * and one real change. Only the real change may survive, and both drops must be
 * recorded with a reason.
 */
const AC4_DIFF = [
  ...fileHeader("bun.lock"),
  ...hunk('@@ -12,3 +12,3 @@ "lockfileVersion": 1', '   "left-pad": "1.3.0",', '-  "ms": "2.1.2",', '+  "ms": "2.1.3",'),
  ...fileHeader("src/format.ts"),
  ...hunk(
    "@@ -40,6 +40,6 @@ export function format(value: string): string {",
    "   const trimmed = value.trim();",
    "-  return trimmed.padEnd(8);",
    "+       return trimmed.padEnd(8);",
    "   // unchanged",
    "   return trimmed;",
    " }",
  ),
  ...fileHeader("src/rate.ts"),
  ...hunk(
    "@@ -10,5 +10,5 @@ export function rate(hits: number, total: number): number {",
    "   if (total === 0) {",
    "     return 0;",
    "   }",
    "-  return hits / total;",
    "+  return total === 0 ? 0 : hits / total;",
    " }",
  ),
  "",
].join("\n");

test("AC4: a lockfile, a whitespace-only hunk and a real change — only the real change survives", () => {
  const scope = buildReviewScope(AC4_DIFF);

  expect(scope.files).toEqual(["src/rate.ts"]);
  expect(scope.regions).toHaveLength(1);
  expect(scope.regions[0]!.path).toBe("src/rate.ts");
  expect(scope.regions[0]!.text).toContain("+  return total === 0 ? 0 : hits / total;");

  // Nothing from the two dropped files reaches a reviewer.
  const dispatched = scope.regions.map((region) => region.text).join("\n");
  expect(dispatched).not.toContain('"ms": "2.1.3"');
  expect(dispatched).not.toContain("       return trimmed.padEnd(8);");
});

test("AC5: both drops are recorded, each with its own reason and a human detail", () => {
  const scope = buildReviewScope(AC4_DIFF);

  expect(scope.drops).toHaveLength(2);

  const lockfile = droppedFor(scope, "bun.lock");
  expect(lockfile).toHaveLength(1);
  expect(lockfile[0]!.reason).toBe("lockfile");
  expect(lockfile[0]!.granularity).toBe("file");
  expect(lockfile[0]!.detail).toContain("bun.lock");
  // The size of the drop is recorded, not just the fact of it.
  expect(lockfile[0]!.changedLines).toBe(2);

  const whitespace = droppedFor(scope, "src/format.ts");
  expect(whitespace).toHaveLength(1);
  expect(whitespace[0]!.reason).toBe("whitespace-only");
  expect(whitespace[0]!.granularity).toBe("block");
  expect(whitespace[0]!.detail.length).toBeGreaterThan(0);
  expect(whitespace[0]!.startLine).toBe(41);
  expect(whitespace[0]!.changedLines).toBe(2);

  // Every reason string is non-empty: a drop without a reason is the silent
  // truncation AC5 exists to prevent.
  for (const drop of scope.drops) {
    expect(drop.detail.trim().length).toBeGreaterThan(0);
  }
});

test("AC5: the counts add up, so a review record's arithmetic can be checked", () => {
  const scope = buildReviewScope(AC4_DIFF);

  expect(scope.counts.filesSeen).toBe(3);
  expect(scope.counts.filesRetained).toBe(1);
  expect(scope.counts.filesDropped).toBe(2);
  expect(scope.counts.filesSeen).toBe(scope.counts.filesRetained + scope.counts.filesDropped);
  expect(scope.counts.blocksSeen).toBe(scope.counts.blocksRetained + scope.counts.blocksDropped);
  expect(scope.counts.droppedByReason.lockfile).toBe(1);
  expect(scope.counts.droppedByReason["whitespace-only"]).toBe(1);
  expect(scope.counts.droppedByReason["comment-only"]).toBe(0);
});

test("AC5: the rendered record carries the retained scope AND the drop list", () => {
  const markdown = renderReviewScopeMarkdown(buildReviewScope(AC4_DIFF));

  expect(markdown).toContain("### Retained");
  expect(markdown).toContain("src/rate.ts");
  expect(markdown).toContain("### Dropped by the pre-filter");
  expect(markdown).toContain("bun.lock");
  expect(markdown).toContain("lockfile");
  expect(markdown).toContain("whitespace-only");
  expect(markdown).toContain("files_dropped: 2");
});

test("AC3: the pre-filter is deterministic — the same input yields byte-identical output", () => {
  const first = JSON.stringify(buildReviewScope(AC4_DIFF));
  const second = JSON.stringify(buildReviewScope(AC4_DIFF));
  expect(first).toBe(second);
});

// ---------------------------------------------------------------------------
// AC3 — path exclusions
// ---------------------------------------------------------------------------

test("classifyPath drops generated, lockfile, snapshot, vendored and minified paths", () => {
  expect(classifyPath("pnpm-lock.yaml")?.reason).toBe("lockfile");
  expect(classifyPath("go.sum")?.reason).toBe("lockfile");
  expect(classifyPath("node_modules/left-pad/index.js")?.reason).toBe("vendored");
  expect(classifyPath("vendor/github.com/x/y.go")?.reason).toBe("vendored");
  expect(classifyPath("dist/app.js")?.reason).toBe("generated");
  expect(classifyPath("src/__generated__/schema.ts")?.reason).toBe("generated");
  expect(classifyPath("src/api/service.pb.go")?.reason).toBe("generated");
  expect(classifyPath("src/app.js.map")?.reason).toBe("generated");
  expect(classifyPath("src/__snapshots__/App.test.ts.snap")?.reason).toBe("snapshot");
  expect(classifyPath("src/App.test.ts.snap")?.reason).toBe("snapshot");
  expect(classifyPath("public/js/vendor.min.js")?.reason).toBe("minified");
});

test("classifyPath keeps the paths this module deliberately does NOT treat as generated", () => {
  // Dependency decisions — exactly what a reviewer wants next to lockfile churn.
  expect(classifyPath("package.json")).toBeNull();
  expect(classifyPath("go.mod")).toBeNull();
  expect(classifyPath("Cargo.toml")).toBeNull();
  // `build/` is as often hand-written build tooling as it is output.
  expect(classifyPath("build/release.ts")).toBeNull();
  // Declaration files are frequently hand-written.
  expect(classifyPath("src/types/global.d.ts")).toBeNull();
  // A file named after a directory on the list is not that directory.
  expect(classifyPath("src/gdgraph/build.ts")).toBeNull();
  expect(classifyPath("src/lib/dist-utils.ts")).toBeNull();
});

test("classifyPath keeps a source directory that happens to be named after build output", () => {
  expect(classifyPath("src/target/resolve.ts")).toBeNull();
  expect(classifyPath("app/components/out/Button.tsx")).toBeNull();
  expect(classifyPath("packages/core/src/out/index.ts")).toBeNull();
  expect(classifyPath("lib/generated/reader.ts")).toBeNull();
  expect(classifyPath("test/coverage/report.test.ts")).toBeNull();
});

test("classifyPath still drops build output where no source root precedes it", () => {
  expect(classifyPath("dist/app.js")?.reason).toBe("generated");
  expect(classifyPath("out/index.html")?.reason).toBe("generated");
  expect(classifyPath("target/debug/keryx")?.reason).toBe("generated");
  expect(classifyPath("coverage/lcov.info")?.reason).toBe("generated");
  // The common monorepo shape still works: the workspace container is not a
  // source root, so `packages/*/dist` is still build output.
  expect(classifyPath("packages/core/dist/index.js")?.reason).toBe("generated");
  expect(classifyPath("apps/web/.next/server/page.js")?.reason).toBe("generated");
  // Unambiguous names keep matching at any depth — nothing names a source
  // directory `__generated__` or `__pycache__`.
  expect(classifyPath("src/__generated__/schema.ts")?.reason).toBe("generated");
  expect(classifyPath("src/api/__pycache__/client.pyc")?.reason).toBe("generated");
});

test("additionalGeneratedDirectories extends the list without a code change", () => {
  expect(classifyPath("gen/api/client.ts")).toBeNull();
  expect(classifyPath("gen/api/client.ts", { ...requiredConfig(), additionalGeneratedDirectories: ["gen"] })?.reason).toBe(
    "generated",
  );
  // A project-configured name is an explicit statement about this repository,
  // so it keeps matching at any depth, source root above it or not.
  expect(classifyPath("src/gen/client.ts", { ...requiredConfig(), additionalGeneratedDirectories: ["gen"] })?.reason).toBe(
    "generated",
  );
});

function requiredConfig() {
  return {
    contextLines: DEFAULT_CONTEXT_LINES,
    detectWhitespaceOnly: true,
    detectCommentOnly: true,
    additionalGeneratedDirectories: [] as readonly string[],
  };
}

test("a binary file is dropped with a reason rather than vanishing", () => {
  const diff = [
    ...fileHeader("assets/logo.png"),
    "Binary files a/assets/logo.png and b/assets/logo.png differ",
    "",
  ].join("\n");
  const scope = buildReviewScope(diff);
  expect(scope.files).toEqual([]);
  expect(scope.drops).toHaveLength(1);
  expect(scope.drops[0]!.reason).toBe("binary");
});

// ---------------------------------------------------------------------------
// AC3 — whitespace-only
// ---------------------------------------------------------------------------

test("whitespace-only: a blank-line insertion is dropped", () => {
  const diff = [
    ...fileHeader("src/a.ts"),
    ...hunk("@@ -1,2 +1,3 @@", " const a = 1;", "+", " const b = 2;"),
    "",
  ].join("\n");
  const scope = buildReviewScope(diff);
  expect(scope.regions).toHaveLength(0);
  expect(scope.drops[0]!.reason).toBe("whitespace-only");
});

test("whitespace-only: a line join is NOT whitespace-only (ASI is semantic)", () => {
  const diff = [
    ...fileHeader("src/a.ts"),
    ...hunk("@@ -1,3 +1,2 @@", "-const a =", "-  compute();", "+const a = compute();", " export { a };"),
    "",
  ].join("\n");
  const scope = buildReviewScope(diff);
  expect(scope.drops).toHaveLength(0);
  expect(scope.regions).toHaveLength(1);
});

test("whitespace-only: re-indenting Python is a real change, re-indenting TypeScript is not", () => {
  const python = [
    ...fileHeader("src/a.py"),
    ...hunk("@@ -1,3 +1,3 @@", " def f():", "-    return 1", "+  return 1", " ", ""),
  ].join("\n");
  expect(buildReviewScope(python).drops).toHaveLength(0);

  const typescript = [
    ...fileHeader("src/a.ts"),
    ...hunk("@@ -1,3 +1,3 @@", " function f() {", "-    return 1;", "+  return 1;", " }", ""),
  ].join("\n");
  expect(buildReviewScope(typescript).drops[0]!.reason).toBe("whitespace-only");
});

// ---------------------------------------------------------------------------
// Whitespace-only — false drops inside string literals (regression guards)
// ---------------------------------------------------------------------------

test("whitespace-only: removing a space from inside a string literal is a real change", () => {
  const diff = [
    ...fileHeader("src/a.ts"),
    ...hunk(
      "@@ -1,3 +1,3 @@",
      " export function render(parts: string[]): string {",
      '-  return parts.join(" ");',
      '+  return parts.join("");',
      " }",
    ),
    "",
  ].join("\n");
  const scope = buildReviewScope(diff);

  expect(scope.drops).toHaveLength(0);
  expect(scope.regions).toHaveLength(1);
  expect(scope.regions[0]!.text).toContain('+  return parts.join("");');
});

test("whitespace-only: a spacing edit inside a SQL string literal is a real change", () => {
  const diff = [
    ...fileHeader("src/db.ts"),
    ...hunk(
      "@@ -1,3 +1,3 @@",
      " function query(): string {",
      '-  return "SELECT a FROM t WHERE x = 1";',
      '+  return "SELECT a  FROM t WHERE x = 1";',
      " }",
    ),
    "",
  ].join("\n");
  expect(buildReviewScope(diff).drops).toHaveLength(0);
});

test("whitespace-only: a hunk carrying an unterminated quote is never whitespace-only", () => {
  // The re-indent sits inside a multi-line template literal, where leading
  // whitespace is content. The opening backtick is on a context line, so the
  // guard has to be per hunk, not per changed line.
  const diff = [
    ...fileHeader("src/db.ts"),
    ...hunk("@@ -1,4 +1,4 @@", " const query = `", "-    SELECT a", "+  SELECT a", " `;"),
    "",
  ].join("\n");
  expect(buildReviewScope(diff).drops).toHaveLength(0);
});

test("whitespace-only: a plain re-indent with a balanced string literal is still dropped", () => {
  const diff = [
    ...fileHeader("src/a.ts"),
    ...hunk("@@ -1,3 +1,3 @@", " function f() {", '-    return "x";', '+  return "x";', " }"),
    "",
  ].join("\n");
  expect(buildReviewScope(diff).drops[0]!.reason).toBe("whitespace-only");
});

// ---------------------------------------------------------------------------
// AC3 — comment-only
// ---------------------------------------------------------------------------

test("comment-only: a reworded line comment is dropped", () => {
  const diff = [
    ...fileHeader("src/a.ts"),
    ...hunk("@@ -1,3 +1,3 @@", " const a = 1;", "-// adds one", "+// Adds one to the total.", " const b = a + 1;"),
    "",
  ].join("\n");
  const scope = buildReviewScope(diff);
  expect(scope.regions).toHaveLength(0);
  expect(scope.drops[0]!.reason).toBe("comment-only");
  expect(scope.drops[0]!.detail).toContain(".ts");
});

test("comment-only: a JSDoc block edit is dropped", () => {
  const diff = [
    ...fileHeader("src/a.ts"),
    ...hunk("@@ -1,5 +1,5 @@", " /**", "-  * old text", "+  * new text", "  */", " export const a = 1;"),
    "",
  ].join("\n");
  expect(buildReviewScope(diff).drops[0]!.reason).toBe("comment-only");
});

test("comment-only: a suppression directive is a behaviour change and is kept", () => {
  const diff = [
    ...fileHeader("src/a.ts"),
    ...hunk("@@ -1,3 +1,3 @@", " const a: number = 1;", "-// a note", "+// @ts-expect-error narrowing is wrong here", " use(a);"),
    "",
  ].join("\n");
  const scope = buildReviewScope(diff);
  expect(scope.drops).toHaveLength(0);
  expect(scope.regions).toHaveLength(1);
});

test("comment-only: a hunk containing a template literal is not classified (the marker could be inside a string)", () => {
  const diff = [
    ...fileHeader("src/a.ts"),
    ...hunk("@@ -1,4 +1,4 @@", " const sample = `", "-// one", "+// two", " `;"),
    "",
  ].join("\n");
  expect(buildReviewScope(diff).drops).toHaveLength(0);
});

test("comment-only: an unknown extension is never classified as comment-only", () => {
  const diff = [
    ...fileHeader("config.weird"),
    ...hunk("@@ -1,3 +1,3 @@", " value = 1", "-// note", "+// other note", " other = 2"),
    "",
  ].join("\n");
  expect(buildReviewScope(diff).drops).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Comment-only — false drops that hide live code (regression guards)
//
// Every case below was a real drop before the fix: `files_retained: 0`, reason
// `comment-only`, and an empty scoped diff handed to the reviewers. The module's
// invariant is that a false retain beats a false drop; these are the false
// drops.
// ---------------------------------------------------------------------------

test("comment-only: an added `/*` that comments out live code is NOT comment-only", () => {
  const diff = [
    ...fileHeader("src/auth.ts"),
    ...hunk(
      "@@ -10,4 +10,5 @@ export function check(user: User): void {",
      "   const role = user.role;",
      "+  /*",
      "   if (!user.isAdmin) {",
      '     throw new Error("denied");',
      "   }",
    ),
    "",
  ].join("\n");
  const scope = buildReviewScope(diff);

  expect(scope.drops).toHaveLength(0);
  expect(scope.files).toEqual(["src/auth.ts"]);
  expect(scope.regions).toHaveLength(1);
  expect(scope.regions[0]!.text).toContain("+  /*");
});

test("comment-only: a deleted `*/` that swallows live code is NOT comment-only", () => {
  const diff = [
    ...fileHeader("src/auth.ts"),
    ...hunk(
      "@@ -20,5 +20,4 @@",
      "   /* legacy check",
      "    * removed in v2",
      "-   */",
      "   grantAccess(user);",
    ),
    "",
  ].join("\n");
  const scope = buildReviewScope(diff);

  expect(scope.drops).toHaveLength(0);
  expect(scope.regions).toHaveLength(1);
  expect(scope.regions[0]!.text).toContain("-   */");
});

test("comment-only: a `*/` inside a string literal does not turn live code into a comment", () => {
  const diff = [
    ...fileHeader("src/a.ts"),
    ...hunk("@@ -1,3 +1,3 @@", "-const limit = 1;", "+const limit = 2;", '   const marker = "*/";'),
    "",
  ].join("\n");
  const scope = buildReviewScope(diff);

  expect(scope.drops).toHaveLength(0);
  expect(scope.regions).toHaveLength(1);
  expect(scope.regions[0]!.text).toContain("+const limit = 2;");
});

test("comment-only: a plain comment reword next to a block delimiter it did not touch is still dropped", () => {
  // The guard is on *changed* lines: an untouched `/**` … `*/` around the edit
  // must not disable the check, or JSDoc edits would never be dropped again.
  const diff = [
    ...fileHeader("src/a.ts"),
    ...hunk("@@ -1,5 +1,5 @@", " /**", "-  * old text", "+  * new text", "  */", " export const a = 1;"),
    "",
  ].join("\n");
  expect(buildReviewScope(diff).drops[0]!.reason).toBe("comment-only");
});

test("comment-only detection can be switched off", () => {
  const diff = [
    ...fileHeader("src/a.ts"),
    ...hunk("@@ -1,3 +1,3 @@", " const a = 1;", "-// adds one", "+// Adds one.", " const b = a + 1;"),
    "",
  ].join("\n");
  expect(buildReviewScope(diff, { detectCommentOnly: false }).drops).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// AC3 — bounded context window
// ---------------------------------------------------------------------------

test("the window is the changed lines plus contextLines on each side, not the whole file", () => {
  const context = Array.from({ length: 30 }, (_, index) => ` line ${index + 1}`);
  const diff = [
    ...fileHeader("src/big.ts"),
    "@@ -1,61 +1,61 @@",
    ...context,
    "-old value",
    "+new value",
    ...Array.from({ length: 30 }, (_, index) => ` line ${index + 32}`),
    "",
  ].join("\n");

  const scope = buildReviewScope(diff, { contextLines: 5 });
  expect(scope.regions).toHaveLength(1);
  const region = scope.regions[0]!;
  // 5 before + 1 removed (anchored to 31) + 1 added + 5 after.
  expect(region.startLine).toBe(26);
  expect(region.endLine).toBe(36);
  expect(region.text.split("\n")).toHaveLength(12);
  expect(region.contextTruncated).toBe(false);
  expect(region.text).toContain("+new value");
  expect(region.text).not.toContain("line 1\n");
});

test("contextLines defaults to 20 and is configurable", () => {
  expect(DEFAULT_CONTEXT_LINES).toBe(20);
  expect(buildReviewScope(AC4_DIFF).contextLines).toBe(20);
  expect(buildReviewScope(AC4_DIFF, { contextLines: 3 }).contextLines).toBe(3);
  expect(buildReviewScope(AC4_DIFF, { contextLines: -4 }).contextLines).toBe(0);
});

test("a window wider than the diff carries is reported as truncated, not silently narrowed", () => {
  const diff = [
    ...fileHeader("src/a.ts"),
    ...hunk("@@ -50,3 +50,3 @@", " before", "-old", "+new", " after"),
    "",
  ].join("\n");
  const region = buildReviewScope(diff, { contextLines: 20 }).regions[0]!;
  expect(region.contextTruncated).toBe(true);
});

test("two distant changes in one file produce two windows, not one span", () => {
  const diff = [
    ...fileHeader("src/a.ts"),
    ...hunk("@@ -10,3 +10,3 @@", " a", "-b", "+B", " c"),
    ...hunk("@@ -200,3 +200,3 @@", " x", "-y", "+Y", " z"),
    "",
  ].join("\n");
  const scope = buildReviewScope(diff, { contextLines: 2 });
  expect(scope.regions).toHaveLength(2);
  expect(scope.regions[0]!.startLine).toBeLessThan(scope.regions[1]!.startLine);
});

test("a hunk holding both a whitespace-only block and a real block keeps only the real one", () => {
  const diff = [
    ...fileHeader("src/a.ts"),
    "@@ -1,10 +1,10 @@",
    " const a = 1;",
    "-  const b = 2;",
    "+const b = 2;",
    " const c = 3;",
    " const d = 4;",
    "-const e = 5;",
    "+const e = 55;",
    " const f = 6;",
    "",
  ].join("\n");
  const scope = buildReviewScope(diff, { contextLines: 1 });
  expect(scope.counts.blocksSeen).toBe(2);
  expect(scope.counts.blocksRetained).toBe(1);
  expect(scope.counts.blocksDropped).toBe(1);
  expect(scope.drops[0]!.reason).toBe("whitespace-only");
  const kept = scope.regions.map((region) => region.text).join("\n");
  expect(kept).toContain("+const e = 55;");
  expect(kept).not.toContain("+const b = 2;");
});

// ---------------------------------------------------------------------------
// Path mode and degenerate input
// ---------------------------------------------------------------------------

test("path mode applies the same exclusions to a file list", () => {
  const scope = buildPathScope(["src/a.ts", "yarn.lock", "node_modules/x/index.js", "src/b.ts"]);
  expect(scope.mode).toBe("path");
  expect(scope.files).toEqual(["src/a.ts", "src/b.ts"]);
  expect(scope.regions).toEqual([]);
  expect(scope.drops.map((drop) => drop.reason)).toEqual(["lockfile", "vendored"]);
});

test("input that is not a diff yields an empty scope rather than an unbounded one", () => {
  const scope = buildReviewScope("this is not a diff\nnor is this\n");
  expect(scope.files).toEqual([]);
  expect(scope.regions).toEqual([]);
  expect(scope.counts.filesSeen).toBe(0);
});

test("a deleted file is still reviewed — removing code is a change", () => {
  const diff = [
    `diff --git a/src/gone.ts b/src/gone.ts`,
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-export const gone = 1;",
    "-export const alsoGone = 2;",
    "",
  ].join("\n");
  const scope = buildReviewScope(diff);
  expect(scope.files).toEqual(["src/gone.ts"]);
  expect(scope.regions[0]!.text).toContain("-export const gone = 1;");
});
