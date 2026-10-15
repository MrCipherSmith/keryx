// Flow 453 AC5: the orchestrator skill tells the dispatcher to name the chunk wave on spawn_subagent, in both copies.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "..", "..");
const BUNDLED = path.join(REPO, "src", "gdskills", "bundled", "skills", "review", "review-orchestrator", "SKILL.md");
const LOCAL = path.join(REPO, ".metaproject", "skills", "gdskills", "review", "review-orchestrator", "SKILL.md");
const SKILL_CEILING = 1615;

const lineCount = (text: string): number => text.split("\n").length - 1;

describe("AC5: the orchestrator skill tells the dispatcher to pass review_wave", () => {
  for (const [label, file] of [["bundled", BUNDLED], ["project copy", LOCAL]] as const) {
    test(`${label} copy names review_wave with package and pass, the round, and the per-wave count`, () => {
      const text = readFileSync(file, "utf8");
      const line = text.split("\n").find((l) => l.includes("review_wave"));
      expect(line).toBeDefined();
      expect(line).toContain("`spawn_subagent`");
      expect(line).toContain('"package": "${PKG}"');
      expect(line).toContain('"pass": "<chunk id>"');
      expect(line).toContain('"pass": "round"');
      expect(line).toMatch(/each wave counts its own 32 children/);
      expect(line).toMatch(/at most 25 waves/);
      expect(line).toMatch(/ignored and counts against the turn/);
    });

    test(`${label} copy stays within the ${SKILL_CEILING}-line ceiling`, () => {
      expect(lineCount(readFileSync(file, "utf8"))).toBeLessThanOrEqual(SKILL_CEILING);
    });
  }

  test("the two copies are byte-identical", () => {
    expect(readFileSync(LOCAL, "utf8")).toBe(readFileSync(BUNDLED, "utf8"));
  });
});
