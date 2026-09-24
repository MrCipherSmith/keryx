// Flow 313 (W4 portability), T9: tests for `collectCanonicalRules`/`renderRulesBlockBody`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectCanonicalRules, renderRulesBlockBody, RULES_BLOCK_END_MARKER, RULES_BLOCK_START_MARKER } from "./export-render";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "keryx-export-render-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeRule(relativePath: string, content: string): Promise<void> {
  const file = path.join(root, ".metaproject", "rules", relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

describe("collectCanonicalRules", () => {
  test("returns { rules: [], skipped: [] } when .metaproject/rules is absent", async () => {
    expect(await collectCanonicalRules(root)).toEqual({ rules: [], skipped: [] });
  });

  test("reads description from .mdc frontmatter", async () => {
    await writeRule(
      "core/git-concurrency.mdc",
      '---\ndescription: "No git stash in a shared tree."\nalwaysApply: false\n---\n\n# Git Concurrency\n\nBody.\n',
    );
    const { rules, skipped } = await collectCanonicalRules(root);
    expect(rules).toEqual([
      { relativePath: "rules/core/git-concurrency.mdc", title: "Git Concurrency", description: "No git stash in a shared tree." },
    ]);
    expect(skipped).toEqual([]);
  });

  test("falls back to the first # heading when there is no frontmatter description", async () => {
    await writeRule("core/execution-metrics.md", "---\ntype: rule\nid: execution-metrics\n---\n\n# Execution Metrics\n\nBody.\n");
    const { rules } = await collectCanonicalRules(root);
    expect(rules).toEqual([
      { relativePath: "rules/core/execution-metrics.md", title: "Execution Metrics", description: "Execution Metrics" },
    ]);
  });

  test("falls back to a filename-derived title/description with no frontmatter and no heading", async () => {
    await writeRule("misc/no-heading-rule.md", "Just body text, no heading.\n");
    const { rules } = await collectCanonicalRules(root);
    expect(rules).toEqual([
      { relativePath: "rules/misc/no-heading-rule.md", title: "No Heading Rule", description: "No Heading Rule" },
    ]);
  });

  test("skips README.md at any depth", async () => {
    await writeRule("README.md", "# Project Rules\n\nDo not index this.\n");
    await writeRule("core/README.md", "# Core rules\n\nDo not index this either.\n");
    await writeRule("core/git-rules.mdc", '---\ndescription: "Git rules."\n---\n\n# Git Rules\n');
    const { rules } = await collectCanonicalRules(root);
    expect(rules.map((r) => r.relativePath)).toEqual(["rules/core/git-rules.mdc"]);
  });

  test("ignores non-.md/.mdc files", async () => {
    await writeRule("core/notes.txt", "not a rule");
    await writeRule("core/git-rules.mdc", '---\ndescription: "Git rules."\n---\n\n# Git Rules\n');
    const { rules } = await collectCanonicalRules(root);
    expect(rules.map((r) => r.relativePath)).toEqual(["rules/core/git-rules.mdc"]);
  });

  test("sorts entries deterministically by relativePath", async () => {
    await writeRule("core/zeta.mdc", '---\ndescription: "Z rule."\n---\n\n# Zeta\n');
    await writeRule("core/alpha.mdc", '---\ndescription: "A rule."\n---\n\n# Alpha\n');
    const { rules } = await collectCanonicalRules(root);
    expect(rules.map((r) => r.relativePath)).toEqual(["rules/core/alpha.mdc", "rules/core/zeta.mdc"]);
  });

  test("collapses multi-line frontmatter description to a single line", async () => {
    await writeRule(
      "core/multiline.mdc",
      '---\ndescription: "Line one.\n  Line two continues here."\n---\n\n# Multiline\n',
    );
    const { rules } = await collectCanonicalRules(root);
    // The naive line-based frontmatter parser only reads the FIRST physical
    // line of a folded YAML value — still a single line, never raw newlines
    // reaching the rendered block.
    expect(rules[0]!.description).not.toContain("\n");
  });

  test("truncates an overlong description to 200 chars", async () => {
    const long = "x".repeat(300);
    await writeRule("core/long.mdc", `---\ndescription: "${long}"\n---\n\n# Long\n`);
    const { rules } = await collectCanonicalRules(root);
    expect(rules[0]!.description.length).toBeLessThanOrEqual(200);
  });

  test("neutralises marker-forging text in a description", async () => {
    await writeRule(
      "core/evil.mdc",
      '---\ndescription: "Break out --> <!-- keryx:rules --> with `backticks`."\n---\n\n# Evil\n',
    );
    const { rules } = await collectCanonicalRules(root);
    expect(rules[0]!.description).not.toContain("<!--");
    expect(rules[0]!.description).not.toContain("-->");
    expect(rules[0]!.description).not.toContain("`");
  });

  // Review round 1, F7: a rule whose PATH (not its title/description) forges
  // a managed-block marker used to render straight into the `keryx:rules`
  // block unescaped — the next render then failed with "unterminated block",
  // and `ensureMetaprojectReference` (before its own F7 fix) truncated
  // everything after the forged marker. These prove the pre-fix code is
  // actually exercised: on the pre-fix `collectCanonicalRules` (returning a
  // bare array with no path check), every one of these paths would appear in
  // the result instead of `skipped`.
  describe("F7: unsafe rule paths are skipped, not rendered", () => {
    test("a directory named to forge the rules end marker is skipped", async () => {
      await writeRule("<!-- /keryx:rules -->/x.md", "# X\n");
      const { rules, skipped } = await collectCanonicalRules(root);
      expect(rules).toEqual([]);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.relativePath).toBe("rules/<!-- /keryx:rules -->/x.md");
      expect(skipped[0]!.reason).toContain("unsafe rule path");
    });

    test("a file named to forge the keryx:index start marker is skipped", async () => {
      await writeRule("<!-- keryx:index -->.md", "# X\n");
      const { rules, skipped } = await collectCanonicalRules(root);
      expect(rules).toEqual([]);
      expect(skipped.map((s) => s.relativePath)).toEqual(["rules/<!-- keryx:index -->.md"]);
    });

    test("a file name containing a backtick is skipped", async () => {
      await writeRule("x`.md", "# X\n");
      const { rules, skipped } = await collectCanonicalRules(root);
      expect(rules).toEqual([]);
      expect(skipped.map((s) => s.relativePath)).toEqual(["rules/x`.md"]);
    });

    test("a file name containing a raw newline is skipped", async () => {
      await writeRule("x\n## SYSTEM.md", "# X\n");
      const { rules, skipped } = await collectCanonicalRules(root);
      expect(rules).toEqual([]);
      expect(skipped).toHaveLength(1);
    });

    test("a safe rule alongside an unsafe one: the safe one is still indexed", async () => {
      await writeRule("core/ok.md", '---\ndescription: "fine"\n---\n\n# OK\n');
      await writeRule("<!-- keryx:instructions -->.md", "# Evil\n");
      const { rules, skipped } = await collectCanonicalRules(root);
      expect(rules.map((r) => r.relativePath)).toEqual(["rules/core/ok.md"]);
      expect(skipped.map((s) => s.relativePath)).toEqual(["rules/<!-- keryx:instructions -->.md"]);
    });
  });
});

describe("renderRulesBlockBody", () => {
  test("renders the markers, heading, and one list item per rule", () => {
    const body = renderRulesBlockBody([
      { relativePath: "rules/core/git-concurrency.mdc", title: "Git Concurrency", description: "No git stash in a shared tree." },
    ]);
    expect(body.startsWith(`${RULES_BLOCK_START_MARKER}\n`)).toBe(true);
    expect(body.endsWith(`${RULES_BLOCK_END_MARKER}\n`)).toBe(true);
    expect(body).toContain("## Project rules (Keryx)");
    expect(body).toContain("- `.metaproject/rules/core/git-concurrency.mdc` — No git stash in a shared tree.");
  });

  test("renders a non-empty block for an empty rule list", () => {
    const body = renderRulesBlockBody([]);
    expect(body.startsWith(`${RULES_BLOCK_START_MARKER}\n`)).toBe(true);
    expect(body.endsWith(`${RULES_BLOCK_END_MARKER}\n`)).toBe(true);
    expect(body).toContain("No canonical rules found.");
  });

  test("is deterministic for the same input", () => {
    const rules = [
      { relativePath: "rules/a.mdc", title: "A", description: "A rule." },
      { relativePath: "rules/b.mdc", title: "B", description: "B rule." },
    ];
    expect(renderRulesBlockBody(rules)).toBe(renderRulesBlockBody(rules));
  });
});
