import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const REVIEWERS = [
  "review-logic",
  "review-regression",
  "review-architecture",
  "review-frontend",
  "review-backend",
  "review-performance",
  "review-security-code",
  "review-testing-practices",
] as const;

const repoRoot = path.resolve(import.meta.dir, "../..");
const BUNDLED = path.join(repoRoot, "src/gdskills/bundled/skills/review");
const PROJECT = path.join(repoRoot, ".metaproject/skills/gdskills/review");
const BLOCK = /<!-- keryx:layers-block:start -->\n[\s\S]*?<!-- keryx:layers-block:end -->\n/g;

function skill(root: string, name: string): string {
  return readFileSync(path.join(root, name, "SKILL.md"), "utf8");
}

function blocksOf(text: string): string[] {
  return text.match(BLOCK) ?? [];
}

describe("every code-reading reviewer skill carries the one shared layers block (AC6)", () => {
  const reference = blocksOf(skill(BUNDLED, REVIEWERS[0]))[0] ?? "";

  test("the reference block names the four commands and says when to use each", () => {
    expect(reference).toContain("keryx gdgraph affected <file>");
    expect(reference).toContain("keryx test related <file>");
    expect(reference).toContain('keryx wiki ask "<q>"');
    expect(reference).toContain('keryx memory search "<q>"');
    expect(reference.match(/Use it (before|when)/g)?.length).toBeGreaterThanOrEqual(4);
  });

  for (const name of REVIEWERS) {
    for (const [label, root] of [["bundled", BUNDLED], ["project", PROJECT]] as const) {
      test(`${label} ${name} carries exactly one block, identical to the reference`, () => {
        const blocks = blocksOf(skill(root, name));
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toBe(reference);
      });
    }

    test(`${name}: the bundled and project copies are byte-identical`, () => {
      expect(skill(PROJECT, name)).toBe(skill(BUNDLED, name));
    });
  }
});
