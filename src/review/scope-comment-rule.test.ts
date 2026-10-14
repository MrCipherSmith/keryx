import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commentRuleScopeConfig, detectRepositoryCommentRule, findCommentRuleLine } from "./comment-rule";
import { buildReviewScope, renderReviewScopeMarkdown } from "./scope";

const FILE = "src/admin/AdminQueryLogPage.tsx";

/** A two-line `//` comment added between statements: the shape the pre-filter calls comment-only. */
const COMMENT_DIFF = [
  `diff --git a/${FILE} b/${FILE}`,
  "index 1111111..2222222 100644",
  `--- a/${FILE}`,
  `+++ b/${FILE}`,
  "@@ -10,4 +10,6 @@ export function AdminQueryLogPage() {",
  "   const rows = useRows();",
  "+  // The table is virtualised, so the row count is only an estimate here.",
  "+  // Keep it in step with the page size used by the loader.",
  "   const total = rows.length;",
  "   return render(total);",
  " }",
  "",
].join("\n");

describe("retainCommentBlocks", () => {
  test("off (the default): the comment-only block is dropped and the scope carries nothing new", () => {
    const scope = buildReviewScope(COMMENT_DIFF);
    expect(scope.drops.map((drop) => drop.reason)).toEqual(["comment-only"]);
    expect(scope.regions).toEqual([]);
    expect("kept" in scope).toBe(false);
    expect("keptByReason" in scope.counts).toBe(false);
    expect(renderReviewScopeMarkdown(scope)).not.toContain("kept:comment-rule");
    expect(buildReviewScope(COMMENT_DIFF, { retainCommentBlocks: false })).toEqual(scope);
  });

  test("on: the block is retained and recorded as kept:comment-rule", () => {
    const scope = buildReviewScope(COMMENT_DIFF, { retainCommentBlocks: true });
    expect(scope.drops).toEqual([]);
    expect(scope.files).toEqual([FILE]);
    expect(scope.regions).toHaveLength(1);
    expect(scope.regions[0]?.text).toContain("+  // The table is virtualised");
    expect(scope.kept).toEqual([
      {
        path: FILE,
        reason: "kept:comment-rule",
        detail: expect.stringContaining("kept:comment-rule"),
        startLine: 11,
        endLine: 12,
        changedLines: 2,
      },
    ]);
    expect(scope.counts.keptByReason).toEqual({ "kept:comment-rule": 1 });
    expect(scope.counts.blocksDropped).toBe(0);
    expect(scope.counts.blocksRetained).toBe(1);
    expect(scope.counts.droppedByReason["comment-only"]).toBe(0);
    expect(renderReviewScopeMarkdown(scope)).toContain("kept:comment-rule");
  });

  test("a pattern keeps only a block whose added comment lines match it", () => {
    expect(buildReviewScope(COMMENT_DIFF, { retainCommentBlocks: "virtuali[sz]ed" }).regions).toHaveLength(1);
    const miss = buildReviewScope(COMMENT_DIFF, { retainCommentBlocks: "no such words" });
    expect(miss.regions).toEqual([]);
    expect(miss.drops.map((drop) => drop.reason)).toEqual(["comment-only"]);
    // an unparsable pattern keeps the block: the safe direction
    expect(buildReviewScope(COMMENT_DIFF, { retainCommentBlocks: "(" }).regions).toHaveLength(1);
  });

  test("a block that only removes comments is still dropped", () => {
    const removal = COMMENT_DIFF.replace("@@ -10,4 +10,6 @@", "@@ -10,6 +10,4 @@")
      .replace(/^\+  \/\/ The table.*$/m, "-  // The table is virtualised, so the row count is only an estimate here.")
      .replace(/^\+  \/\/ Keep it.*$/m, "-  // Keep it in step with the page size used by the loader.");
    const scope = buildReviewScope(removal, { retainCommentBlocks: true });
    expect(scope.drops.map((drop) => drop.reason)).toEqual(["comment-only"]);
    expect("kept" in scope).toBe(false);
  });

  test("a hunk that also changes code is unaffected by the setting", () => {
    const mixed = COMMENT_DIFF.replace("   const total = rows.length;", "-  const total = rows.length;\n+  const total = rows.length + 1;");
    expect(buildReviewScope(mixed, { retainCommentBlocks: true })).toEqual(buildReviewScope(mixed));
  });
});

describe("findCommentRuleLine", () => {
  test("recognises a limit or a gate on comments", () => {
    for (const text of [
      "Comments: at most one line per function.",
      "- Comment gate: no multi-line comments in src/.",
      "Keep each comment to a single line.",
      "Limit comments to two lines; explain why, not what.",
      "A comment longer than 1 line is a defect.",
      "Do not exceed the comment max length of 80.",
    ]) {
      expect(findCommentRuleLine(text)).not.toBeNull();
    }
  });

  test("ignores text that mentions comments without limiting them", () => {
    for (const text of [
      "Add a comment explaining why the workaround exists.",
      "Reply to every review comment before merging.",
      "The line limit for functions is 40.",
      "Keep the changelog up to date.",
    ]) {
      expect(findCommentRuleLine(text)).toBeNull();
    }
  });

  test("reports the 1-based line of the first rule", () => {
    expect(findCommentRuleLine("# Style\n\nUse tabs.\nComments are limited to one line.\n")).toEqual({
      line: 4,
      text: "Comments are limited to one line.",
    });
  });
});

describe("detectRepositoryCommentRule", () => {
  const roots: string[] = [];
  async function repo(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "keryx-comment-rule-"));
    roots.push(root);
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), content);
    }
    return root;
  }
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("finds the rule in CLAUDE.md, AGENTS.md and .metaproject/rules/**", async () => {
    const claude = await repo({ "CLAUDE.md": "# Rules\nComments may be one line at most.\n" });
    expect(await detectRepositoryCommentRule(claude)).toEqual({ source: "CLAUDE.md", line: 2, text: "Comments may be one line at most." });
    const agents = await repo({ "AGENTS.md": "No multi-line comments.\n" });
    expect((await detectRepositoryCommentRule(agents))?.source).toBe("AGENTS.md");
    const rules = await repo({ ".metaproject/rules/core/style.mdc": "Comment gate: one line per comment.\n" });
    expect((await detectRepositoryCommentRule(rules))?.source).toBe(path.join(".metaproject", "rules", "core", "style.mdc"));
  });

  test("a repository without the rule yields no config, so scope output is unchanged", async () => {
    const plain = await repo({ "CLAUDE.md": "Write tests.\nAdd a comment where the reason is not obvious.\n" });
    expect(await detectRepositoryCommentRule(plain)).toBeNull();
    expect(await commentRuleScopeConfig(plain)).toEqual({});
    expect(await commentRuleScopeConfig(await repo({}))).toEqual({});
  });

  test("a repository with the rule turns retainCommentBlocks on", async () => {
    const ruled = await repo({ "CLAUDE.md": "Comments: one line, why not what. This is a gate.\n" });
    const config = await commentRuleScopeConfig(ruled);
    expect(config).toEqual({ retainCommentBlocks: true });
    expect(buildReviewScope(COMMENT_DIFF, config).regions).toHaveLength(1);
  });
});
