import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverRuleSources, stripKeryxManagedBlock } from "./review-jev-rules";
import { reviewerPathGate } from "../gdskills/reviewer-triggers";
import { clauseApplicability } from "../review/jev-rules";
import type { DetectedStack } from "../review/stack";

let root: string;

const CODE_RULE = [
  "# Code style",
  "",
  "- Never declare variables with `var`; use `const` or `let` in TypeScript source files.",
  "- Do not leave `console.log` calls in production source files under `src/`.",
  "",
].join("\n");

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-jev-rules-discovery-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("rule discovery covers where Claude Code projects keep their rules", () => {
  test(".claude/rules/** is discovered without --rules", async () => {
    mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "rules", "code-style.md"), CODE_RULE);
    const { sources } = await discoverRuleSources(root, []);
    expect(sources.map((s) => s.path)).toContain(path.join(".claude", "rules", "code-style.md"));
  });

  test("the root CLAUDE.md is a source, without keryx's managed routing block", async () => {
    writeFileSync(path.join(root, "CLAUDE.md"), `# Project\n\n<!-- keryx:index -->\nRouting: read .metaproject/index.md first.\n<!-- /keryx:index -->\n\n${CODE_RULE}`);
    const { sources } = await discoverRuleSources(root, []);
    const guide = sources.find((s) => s.path === "CLAUDE.md");
    expect(guide).toBeDefined();
    expect(guide!.text).not.toContain("keryx:index");
    expect(guide!.text).not.toContain("Routing: read");
    expect(guide!.text).toContain("console.log");
  });

  test("AGENTS.md is used only when there is no CLAUDE.md", async () => {
    writeFileSync(path.join(root, "AGENTS.md"), CODE_RULE);
    expect((await discoverRuleSources(root, [])).sources.map((s) => s.path)).toContain("AGENTS.md");
    writeFileSync(path.join(root, "CLAUDE.md"), CODE_RULE);
    const paths = (await discoverRuleSources(root, [])).sources.map((s) => s.path);
    expect(paths).toContain("CLAUDE.md");
    expect(paths).not.toContain("AGENTS.md");
  });

  test("a guide that is only keryx's managed block adds nothing", async () => {
    writeFileSync(path.join(root, "CLAUDE.md"), "<!-- keryx:index -->\nRouting only.\n<!-- /keryx:index -->\n");
    const { sources } = await discoverRuleSources(root, []);
    expect(sources.map((s) => s.path)).not.toContain("CLAUDE.md");
  });
});

describe("a convention skill's metadata.paths", () => {
  const STACK: DetectedStack = {
    tags: { nestjs: false, react: false, mobx: false, prisma: false, playwright: false, sql: false, "http-server": false },
    uncertain: false,
    reason: "test",
    matched: [],
  };

  // G-004: `review jev-rules` had its own reader that took only a scalar, so a
  // block list read as "not restricted" there while the inventory gated on it.
  test.each([
    ["scalar", "\n", ['  paths: "src/core/**, src/ui/**"']],
    ["flow list", "\n", ["  paths: [src/core/**, 'src/ui/**']"]],
    ["block list", "\n", ["  paths:", "    - src/core/**   # the core tree", "    -", "    - src/ui/**"]],
    ["block list, BOM and CRLF", "\r\n", ["  paths:", "    - src/core/**", "    - src/ui/**"]],
  ])("%s: the same globs as the inventory, and they gate clause applicability", async (shape, eol, paths) => {
    const bom = shape.includes("BOM") ? "\uFEFF" : "";
    // `applies_to: code` — the path holds "skill", which the process heuristic would otherwise drop.
    const text = bom + ["---", "name: house-conventions", "applies_to: code", "metadata:", ...paths, "---", "", CODE_RULE].join(eol);
    const dir = path.join(root, ".metaproject", "project-skills", "house-conventions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), text);
    const { sources } = await discoverRuleSources(root, []);
    const source = sources.find((s) => s.path.endsWith(path.join("house-conventions", "SKILL.md")));
    expect(source?.declaredPaths).toEqual(["src/core/**", "src/ui/**"]);
    expect(source?.declaredPaths).toEqual(reviewerPathGate(text).paths);
    expect(clauseApplicability(source!, "docs/tools/readme.ts", STACK).applicable).toBe(false);
    expect(clauseApplicability(source!, "src/ui/button.ts", STACK).applicable).toBe(true);
  });
});

describe("stripKeryxManagedBlock", () => {
  test("removes every managed block and keeps the rest", () => {
    expect(stripKeryxManagedBlock("a\n<!-- keryx:index -->\nx\n<!-- /keryx:index -->\nb")).toBe("a\nb");
  });
});
