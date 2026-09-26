import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { SKILL_LENGTH_CEILINGS } from "./skill-length-ceilings";

/**
 * Flow 344: `review-orchestrator`'s SKILL.md and SKILL.detail.md ship in TWO
 * places on purpose (`.metaproject/skills/gdskills/review/review-orchestrator/`
 * — the installed/project-local copy — and
 * `src/gdskills/bundled/skills/review/review-orchestrator/` — the shipped
 * source), and they must stay byte-identical. `bundled-eval.test.ts`'s
 * `anatomy:length`/ceiling checks only ever read the bundled copy
 * (`document:build-parity`'s own reasoning: "canonical SKILL.md only"), so a
 * hand-edit to the `.metaproject` copy alone — exactly what a Jev-integration
 * pass like this one makes — could drift silently forever with every other
 * guard in this repository staying green. This file is the guard for that one
 * pair, not a general bundled-vs-installed parity check (no such generic
 * check exists yet across every skill; see `round-bound.test.ts`'s narrower,
 * content-only precedent for `orchestration/*`).
 */

const REPO_ROOT = process.cwd();
const METAPROJECT_ROOT = path.join(REPO_ROOT, ".metaproject", "skills", "gdskills", "review", "review-orchestrator");
const BUNDLED_ROOT = path.join(REPO_ROOT, "src", "gdskills", "bundled", "skills", "review", "review-orchestrator");

function read(root: string, file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

describe("review-orchestrator: the two SKILL copies stay byte-identical", () => {
  test("SKILL.md", () => {
    expect(read(METAPROJECT_ROOT, "SKILL.md")).toBe(read(BUNDLED_ROOT, "SKILL.md"));
  });

  test("SKILL.detail.md", () => {
    expect(read(METAPROJECT_ROOT, "SKILL.detail.md")).toBe(read(BUNDLED_ROOT, "SKILL.detail.md"));
  });

  test("SKILL.md's line count matches its recorded ceiling (never raised, per the ratchet in skill-length-ceilings.ts)", () => {
    const text = read(BUNDLED_ROOT, "SKILL.md");
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    const ceiling = SKILL_LENGTH_CEILINGS.get("review/review-orchestrator");
    expect(ceiling).toBeDefined();
    expect(lines).toBe(ceiling as number);
  });
});
