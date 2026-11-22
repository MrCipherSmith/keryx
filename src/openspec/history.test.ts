import { describe, expect, test } from "bun:test";
import { baselineMarkdown, deltaMarkdown } from "./fixture";
import { parseOpenSpecMarkdown } from "./markdown";

describe("OpenSpec Markdown evidence", () => {
  test("preserves exact titles and inclusive source lines for requirements and scenarios", () => {
    const result = parseOpenSpecMarkdown(baselineMarkdown, { delta: false });
    expect(result.requirements.map((item) => item.title)).toEqual(["Exact Name", "exact  name"]);
    expect(result.requirements[0]?.startLine).toBe(3);
    expect(result.requirements[0]?.scenarios[0]?.title).toBe("Successful review");
    expect(result.requirements[0]?.scenarios[0]?.startLine).toBe(6);
    expect(result.requirements[0]?.scenarios[0]?.endLine).toBeGreaterThanOrEqual(8);
  });

  test("reads stock addition, modification, both removals and rename", () => {
    const result = parseOpenSpecMarkdown(deltaMarkdown, { delta: true });
    expect(result.requirements.map(({ title, operation }) => [title, operation])).toEqual([
      ["New behavior", "added"], ["Exact Name", "modified"], ["Old behavior", "removed"],
      ["Legacy behavior", "removed"], ["Previous name", "renamed"],
    ]);
    expect(result.requirements.find((item) => item.title === "Previous name")?.renamedTo).toBe("Current name");
    expect(result.requirements.find((item) => item.title === "Old behavior")?.markdown).toContain("Migration: use New behavior");
  });

  test("ignores heading-shaped text in frontmatter, fences and comments", () => {
    const markdown = ["---", "### Requirement: Frontmatter", "---", "```md", "### Requirement: Fenced", "```", "<!--", "### Requirement: Commented", "-->", "### Requirement: Real", "Body"].join("\n");
    const result = parseOpenSpecMarkdown(markdown, { delta: false });
    expect(result.requirements.map((item) => item.title)).toEqual(["Real"]);
    expect(result.requirements[0]?.startLine).toBe(10);
  });

  test("reports malformed rename without inventing a destination", () => {
    const result = parseOpenSpecMarkdown("## RENAMED Requirements\n- FROM: `### Requirement: Before`\n", { delta: true });
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.requirements.every((item) => item.renamedTo === undefined)).toBe(true);
  });
});
