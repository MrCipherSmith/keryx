import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { SKILL_LENGTH_CEILINGS } from "./skill-length-ceilings";

const ROOT = process.cwd();
const BUNDLED = path.join(ROOT, "src", "gdskills", "bundled", "skills", "review", "review-orchestrator", "SKILL.md");
const INSTALLED = path.join(ROOT, ".metaproject", "skills", "gdskills", "review", "review-orchestrator", "SKILL.md");

const lineCount = (text: string): number => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

test("review-orchestrator stays at or under its length ceiling after the review gates were added", () => {
  const ceiling = SKILL_LENGTH_CEILINGS.get("review/review-orchestrator");
  expect(ceiling).toBeDefined();
  expect(lineCount(readFileSync(BUNDLED, "utf8"))).toBeLessThanOrEqual(ceiling as number);
});

test("the gates are named in the skill in at most four lines, each pointing at its command", () => {
  const gateLines = readFileSync(BUNDLED, "utf8")
    .split("\n")
    .filter((line) => /Evidence level:|citation not found|reviewed SHA|`narrowed`/.test(line));
  expect(gateLines.length).toBeGreaterThan(0);
  expect(gateLines.length).toBeLessThanOrEqual(4);
  const text = gateLines.join("\n");
  for (const gate of ["reviewed SHA", "Evidence level:", "citation not found", "at the reviewed SHA", "narrowed"]) {
    expect(text).toContain(gate);
  }
});

test("the packaged and the installed copy are the same file", () => {
  expect(readFileSync(INSTALLED, "utf8")).toBe(readFileSync(BUNDLED, "utf8"));
});
