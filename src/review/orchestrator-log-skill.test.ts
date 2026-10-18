// Flow 454 AC8: both review-orchestrator skill files, in both copies, say keryx writes the orchestrator log and the agent
// must not edit it, and no longer tell the agent to append its own tool calls.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "..", "..");
const DIRS = [
  ["bundled", path.join(REPO, "src", "gdskills", "bundled", "skills", "review", "review-orchestrator")],
  ["project copy", path.join(REPO, ".metaproject", "skills", "gdskills", "review", "review-orchestrator")],
] as const;
const SKILL_CEILING = 1615;

const lineCount = (text: string): number => text.split("\n").length - 1;
const read = (dir: string, name: string): string => readFileSync(path.join(dir, name), "utf8");

describe("AC8: the skill says keryx writes the orchestrator log", () => {
  for (const [label, dir] of DIRS) {
    test(`${label} SKILL.md says keryx writes the log and the agent leaves it alone`, () => {
      const line = read(dir, "SKILL.md").split("\n").find((l) => l.includes("One memory read."));
      expect(line).toBeDefined();
      expect(line).toContain("keryx writes `<package>/tool-calls/orchestrator.jsonl` itself");
      expect(line).toMatch(/never create, edit or append to it/);
    });

    test(`${label} SKILL.detail.md says what keryx records, who is named, and that the agent must not edit the file`, () => {
      const detail = read(dir, "SKILL.detail.md");
      const paragraph = detail.split("\n").find((l) => l.startsWith("**One memory read, and the log.**"));
      expect(paragraph).toBeDefined();
      expect(paragraph).toContain("keryx writes the orchestrator log");
      expect(paragraph).toContain("`keryx review start` and `keryx review attach`");
      expect(paragraph).toMatch(/You do not write that file and must not edit it/);
      expect(paragraph).toContain("`unattributed`");
      expect(paragraph).toContain("never blocks");
    });

    test(`${label} copy no longer tells the agent to append its tool calls`, () => {
      for (const name of ["SKILL.md", "SKILL.detail.md"]) {
        const text = read(dir, name);
        expect(text).not.toMatch(/Append each of your tool calls/);
        expect(text).not.toMatch(/append one JSON line per tool call of yours/);
      }
    });

    test(`${label} SKILL.md stays within the ${SKILL_CEILING}-line ceiling`, () => {
      expect(lineCount(read(dir, "SKILL.md"))).toBeLessThanOrEqual(SKILL_CEILING);
    });
  }

  for (const name of ["SKILL.md", "SKILL.detail.md"]) {
    test(`the two copies of ${name} are byte-identical`, () => {
      expect(read(DIRS[1][1], name)).toBe(read(DIRS[0][1], name));
    });
  }
});
