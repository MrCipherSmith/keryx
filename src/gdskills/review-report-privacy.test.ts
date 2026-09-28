import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const roots = [
  new URL("./bundled/skills/review/review-orchestrator/", import.meta.url),
  new URL("../../.metaproject/skills/gdskills/review/review-orchestrator/", import.meta.url),
];

test("published review guidance never identifies the human via GitHub login", () => {
  for (const root of roots) {
    const template = readFileSync(new URL("templates/review-report.md", root), "utf8");
    const skill = readFileSync(new URL("SKILL.md", root), "utf8");
    for (const text of [template, skill]) {
      expect(text).not.toContain("**Run by:**");
      expect(text).not.toContain("@<gh-login>");
      for (const label of ["**Workflow:**", "**Models:**", "**Tools:**", "**Skills:**", "**Subagents:**"]) {
        expect(text).toContain(label);
      }
    }
    expect(template).toContain("never infer an operator identity from `gh auth`");
    expect(skill).toContain("Never identify the operator from `gh auth status`");
  }
});
