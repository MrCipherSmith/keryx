import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lintSkill, lintStackRule, STACK_EXTENSIONS } from "./authoring-lint";

function findingRules(findings: { rule: string }[]): string[] {
  return findings.map((f) => f.rule);
}

describe("lintSkill", () => {
  const goodSkill = `---
name: python-testing
description: Use when a Python project's test suite needs writing or fixing.
metadata:
  category: implement
  version: "1.0.0"
  origin: authored
---

Body text.
`;

  test("a well-formed skill produces no findings", () => {
    const findings = lintSkill(goodSkill, { path: "/tmp/pack/skills/python-testing/SKILL.md", strict: true });
    expect(findings).toEqual([]);
  });

  test("flags a name over the length ceiling", () => {
    const longName = "a".repeat(65);
    const content = goodSkill.replace("name: python-testing", `name: ${longName}`);
    const findings = lintSkill(content, { path: `/tmp/pack/skills/${longName}/SKILL.md` });
    expect(findingRules(findings)).toContain("name-length");
  });

  test("flags a name that is not lowercase-hyphen", () => {
    const content = goodSkill.replace("name: python-testing", "name: Python_Testing");
    const findings = lintSkill(content, { path: "/tmp/pack/skills/Python_Testing/SKILL.md" });
    expect(findingRules(findings)).toContain("name-format");
  });

  test("flags a reserved vendor/harness word in the name", () => {
    const content = goodSkill.replace("name: python-testing", "name: claude-helper");
    const findings = lintSkill(content, { path: "/tmp/pack/skills/claude-helper/SKILL.md" });
    expect(findingRules(findings)).toContain("name-reserved-word");
  });

  test("flags a name that does not match its directory", () => {
    const findings = lintSkill(goodSkill, { path: "/tmp/pack/skills/other-dir/SKILL.md" });
    expect(findingRules(findings)).toContain("name-matches-directory");
  });

  test("flags a description over 1024 chars", () => {
    const content = goodSkill.replace(
      "description: Use when a Python project's test suite needs writing or fixing.",
      `description: Use when ${"x".repeat(1030)}`,
    );
    const findings = lintSkill(content, { path: "/tmp/pack/skills/python-testing/SKILL.md" });
    expect(findingRules(findings)).toContain("description-length");
  });

  test("flags a description with no 'Use when' clause", () => {
    const content = goodSkill.replace(
      "description: Use when a Python project's test suite needs writing or fixing.",
      "description: Writes tests for Python projects.",
    );
    const findings = lintSkill(content, { path: "/tmp/pack/skills/python-testing/SKILL.md" });
    expect(findingRules(findings)).toContain("description-use-when");
  });

  test("flags a body over 500 lines", () => {
    const content = `${goodSkill}${"line\n".repeat(510)}`;
    const findings = lintSkill(content, { path: "/tmp/pack/skills/python-testing/SKILL.md" });
    expect(findingRules(findings)).toContain("body-length");
  });

  test("metadata.origin missing is an error in strict mode, a warning otherwise", () => {
    const content = goodSkill.replace("  origin: authored\n", "");
    const lenient = lintSkill(content, { path: "/tmp/pack/skills/python-testing/SKILL.md", strict: false });
    const strict = lintSkill(content, { path: "/tmp/pack/skills/python-testing/SKILL.md", strict: true });
    expect(lenient.find((f) => f.rule === "metadata-origin")?.severity).toBe("warning");
    expect(strict.find((f) => f.rule === "metadata-origin")?.severity).toBe("error");
  });

  test("flags metadata.origin outside the closed set", () => {
    const content = goodSkill.replace("origin: authored", "origin: scraped");
    const findings = lintSkill(content, { path: "/tmp/pack/skills/python-testing/SKILL.md", strict: true });
    expect(findingRules(findings)).toContain("metadata-origin");
  });

  test("flags a references/*.md file that links to another local .md reference", () => {
    const root = mkdtempSync(path.join(tmpdir(), "authoring-lint-"));
    try {
      const skillDir = path.join(root, "python-testing");
      const referencesDir = path.join(skillDir, "references");
      mkdirSync(referencesDir, { recursive: true });
      writeFileSync(path.join(referencesDir, "a.md"), "See [more](references/b.md) for detail.", "utf8");
      writeFileSync(path.join(referencesDir, "b.md"), "Leaf reference, no further links.", "utf8");
      const findings = lintSkill(goodSkill, { path: path.join(skillDir, "SKILL.md") });
      expect(findingRules(findings)).toContain("references-one-level");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not flag a references/*.md file with no further links", () => {
    const root = mkdtempSync(path.join(tmpdir(), "authoring-lint-"));
    try {
      const skillDir = path.join(root, "python-testing");
      const referencesDir = path.join(skillDir, "references");
      mkdirSync(referencesDir, { recursive: true });
      writeFileSync(path.join(referencesDir, "a.md"), "Leaf reference, no further links.", "utf8");
      const findings = lintSkill(goodSkill, { path: path.join(skillDir, "SKILL.md") });
      expect(findingRules(findings)).not.toContain("references-one-level");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("lintStackRule", () => {
  const good = `---
extends: common
paths: ["**/*.py"]
metadata:
  origin: authored
---

Rule body.
`;

  test("a well-formed stack rule produces no findings", () => {
    const findings = lintStackRule(good, { path: "/tmp/pack/rules/coding-style.mdc", allowedExtensions: STACK_EXTENSIONS.python! });
    expect(findings).toEqual([]);
  });

  test("flags a missing extends: common", () => {
    const content = good.replace("extends: common", "extends: other");
    const findings = lintStackRule(content, { path: "/tmp/pack/rules/coding-style.mdc", allowedExtensions: STACK_EXTENSIONS.python! });
    expect(findings.map((f) => f.rule)).toContain("stack-rule-extends");
  });

  test("flags an empty paths list", () => {
    const content = good.replace('paths: ["**/*.py"]', "");
    const findings = lintStackRule(content, { path: "/tmp/pack/rules/coding-style.mdc", allowedExtensions: STACK_EXTENSIONS.python! });
    expect(findings.map((f) => f.rule)).toContain("stack-rule-paths");
  });

  test("flags a paths glob outside the stack's allowed extensions", () => {
    const content = good.replace('paths: ["**/*.py"]', 'paths: ["**/*.rb"]');
    const findings = lintStackRule(content, { path: "/tmp/pack/rules/coding-style.mdc", allowedExtensions: STACK_EXTENSIONS.python! });
    expect(findings.map((f) => f.rule)).toContain("stack-rule-paths-scope");
  });

  test("accepts a block-list paths shape", () => {
    const content = good.replace('paths: ["**/*.py"]', "paths:\n  - \"**/*.py\"\n  - \"**/*.pyi\"");
    const findings = lintStackRule(content, { path: "/tmp/pack/rules/coding-style.mdc", allowedExtensions: STACK_EXTENSIONS.python! });
    expect(findings).toEqual([]);
  });

  test("STACK_EXTENSIONS covers the five named stacks", () => {
    expect(STACK_EXTENSIONS.python).toEqual(["py", "pyi"]);
    expect(STACK_EXTENSIONS["ts-js-node"]).toEqual(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
    expect(STACK_EXTENSIONS.react).toEqual(["tsx", "jsx"]);
    expect(STACK_EXTENSIONS.go).toEqual(["go"]);
    expect(STACK_EXTENSIONS.rust).toEqual(["rs"]);
  });
});
