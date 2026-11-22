import { describe, expect, test } from "bun:test";
import { baselineMarkdown, createOpenSpecFixture, deltaMarkdown, populateOpenSpecFixture } from "./fixture";
import { parseOpenSpecMarkdown } from "./markdown";
import { readOpenSpec } from "./service";

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

describe("OpenSpec service history", () => {
  test("resolves only exact unique current titles and retains archived evidence", async () => {
    const fixture = createOpenSpecFixture();
    try {
      populateOpenSpecFixture(fixture);
      fixture.write("openspec/specs/review/spec.md", baselineMarkdown + "### Requirement: Exact Name\nDuplicate\n### Requirement: Previous name\nBefore rename");
      fixture.write("openspec/changes/update-review/specs/new-capability/spec.md", "## ADDED Requirements\n### Requirement: First\nNew capability");
      const snapshot = await readOpenSpec(fixture.root);
      const current = snapshot.list({ kind: "spec" }).items[0];
      if (!current) throw new Error("expected a current spec");
      const history = snapshot.history({ id: current.id }).items;
      expect(history.map((item) => item.entry.archiveDate)).toEqual(["2025-03-01"]);
      expect(history[0]?.source.path).toBe("openspec/changes/archive/2025-03-01-old/specs/review/spec.md");
      expect(history[0]?.requirements.find((item) => item.operation === "removed")?.source.startLine).toBe(10);

      const changePath = "openspec/changes/update-review";
      const detail = snapshot.detail({ path: changePath, artifactPath: changePath + "/specs/review/spec.md" });
      const summary = snapshot.detail({ path: changePath });
      expect(summary.artifact?.source.path).toBe(changePath + "/proposal.md");
      expect(summary.deltas.map(({ specPath }) => specPath)).toEqual(["openspec/specs/new-capability/spec.md", "openspec/specs/review/spec.md"]);
      expect(summary.deltas[1]?.requirements.find(({ operation }) => operation === "modified")?.source.path).toBe(changePath + "/specs/review/spec.md");
      const requirements = detail.artifact?.requirements;
      expect(requirements?.find((item) => item.operation === "modified")?.baseline?.state).toBe("unresolved");
      expect(requirements?.find((item) => item.operation === "renamed")?.baseline?.state).toBe("matched");
      const newCapability = snapshot.detail({ path: changePath, artifactPath: changePath + "/specs/new-capability/spec.md" });
      expect(newCapability.artifact?.requirements[0]?.baseline?.state).toBe("absent");
      expect(snapshot.detail({ path: "openspec/changes/no-delta" }).relatedSpecs).toEqual([]);
      expect(snapshot.relationships.deltas.map((item) => item.specPath)).toEqual(["openspec/specs/review/spec.md", "openspec/specs/review/spec.md"]);

      const retiredPath = "openspec/changes/archive/undated";
      const retired = snapshot.detail({ path: retiredPath, artifactPath: retiredPath + "/specs/retired/spec.md" });
      expect(retired.artifact?.requirements[0]?.operation).toBe("removed");
      expect(retired.relatedSpecs).toEqual([]);
      expect(snapshot.detail({ path: retiredPath }).deltas[0]?.specPath).toBe("openspec/specs/retired/spec.md");
    } finally {
      fixture.cleanup();
    }
  });
});
