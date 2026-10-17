// Flow 461 (AC1-AC3): code-writing and testing skills read project rules first, bundled rules second,
// and a project skill only supplements them. Pins the bundled skills and their .metaproject copies.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const flat = (text: string): string => text.replace(/\s+/g, " ");
const SKILLS = [
  ["orchestration", "task-implementer"],
  ["quality", "tests-creator"],
] as const;

const bundled = (cat: string, name: string): string =>
  readFileSync(path.join(import.meta.dir, "bundled", "skills", cat, name, "SKILL.md"), "utf8");
const installed = (cat: string, name: string): string =>
  readFileSync(
    path.join(import.meta.dir, "..", "..", ".metaproject", "skills", "gdskills", cat, name, "SKILL.md"),
    "utf8",
  );

describe("task-implementer: project first", () => {
  const text = flat(bundled("orchestration", "task-implementer"));

  test.each([
    "read `.metaproject/rules/project/<rule>.mdc` when it exists, otherwise `.metaproject/rules/core/<rule>.mdc`",
    "A project rule with the same name replaces the bundled one",
    "a project's own rules live only in `rules/project/`",
  ])("rule resolution says: %s", (phrase) => {
    expect(text).toContain(phrase);
  });

  test.each([
    "a project skill never replaces a phase, the TDD order or the output contract",
    "Where it and a bundled rule disagree, the project skill wins; say so in `notes`",
  ])("a fresh project skill supplements and never replaces: %s", (phrase) => {
    expect(text).toContain(phrase);
  });
});

describe("tests-creator: project first", () => {
  const text = flat(bundled("quality", "tests-creator"));

  test.each([
    "`.metaproject/rules/project/<rule>.mdc` first, then `.metaproject/rules/core/<rule>.mdc`",
    "A project rule with the same name replaces the bundled one",
    "A project skill only supplements these steps; it never replaces this skill",
    "project_context_applied:",
  ])("the skill says: %s", (phrase) => {
    expect(text).toContain(phrase);
  });
});

describe("installed copies", () => {
  test.each(SKILLS)("%s/%s installed copy is byte-identical to the bundled skill", (cat, name) => {
    expect(installed(cat, name)).toBe(bundled(cat, name));
  });
});
