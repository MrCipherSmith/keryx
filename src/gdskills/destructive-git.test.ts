// No shipped skill may instruct an UNSCOPED destructive git command.
//
// Flow 210 found `task-implementer` telling every implementer that on failure it
// "MUST run `git reset --hard` to clean the worktree". That instruction shipped in
// all five builds. It is not a style problem:
//
//   `job-orchestrator` §2.5 dispatches implementers in PARALLEL WAVES that share a
//   single worktree. One implementer failing its third attempt would destroy a
//   wave-mate's uncommitted work — work it does not own, cannot restore, and whose
//   loss it cannot even observe, because the other agent's failure surfaces
//   somewhere else entirely.
//
// The audit that found it classified it "named, not fixed". It is fixed now, and
// this guard is what stops it coming back — the same reasoning that put a guard
// behind the dangling-agent class after its third recurrence rather than fixing
// the third instance by hand.
//
// Scoped forms stay legal. `git checkout -- <path>` and `git clean` limited to a
// named path are how an agent tidies up after itself; the rule is about blast
// radius, not about the word "git".

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { bundledSkillDocuments, defaultBundledRoot } from "./bundled-eval";

/**
 * Commands whose blast radius is the whole worktree.
 *
 * Each pattern deliberately requires the UNSCOPED form. `git checkout -- src/a.ts`
 * is safe and common; `git checkout -- .` is not. A rule that failed on both would
 * be excepted on its first honest use and then deleted.
 */
const DESTRUCTIVE = [
  {
    pattern: /git\s+reset\s+--hard(?!\s+\S)/,
    why: "`git reset --hard` with no pathspec discards every uncommitted change in the worktree, including another agent's",
  },
  {
    pattern: /git\s+clean\s+-[a-z]*[fd][a-z]*(?!\s+--?\s*\S*\/)/,
    why: "`git clean -fd` with no path deletes untracked files anywhere in the tree",
  },
  {
    pattern: /git\s+checkout\s+--\s+\.(?:\s|$)/,
    why: "`git checkout -- .` reverts every tracked file, not only the ones this agent touched",
  },
  {
    pattern: /git\s+restore\s+(?:--\w+\s+)*\.(?:\s|$)/,
    why: "`git restore .` reverts every tracked file in the tree",
  },
];

/**
 * A line that forbids the command is not a line that instructs it.
 *
 * The fix for the original finding says "Never run `git reset --hard`", and a
 * guard that fires on its own correction is a guard somebody deletes. So a match
 * is excused when the same line denies, forbids or warns against it.
 */
const DENIAL = /\b(never|do not|don't|must not|avoid|forbidden|refuses?|instead of|rather than|no unscoped)\b/i;

function offenders(): string[] {
  const root = defaultBundledRoot();
  const found: string[] = [];
  for (const file of bundledSkillDocuments(root)) {
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, index) => {
      for (const { pattern, why } of DESTRUCTIVE) {
        if (pattern.test(line) && !DENIAL.test(line)) {
          found.push(`${path.relative(root, file)}:${index + 1}: ${why}`);
        }
      }
    });
  }
  return found;
}

test("no shipped skill instructs an unscoped destructive git command", () => {
  expect(offenders()).toEqual([]);
});

test("the sweep reads something — an empty denominator would pass vacuously", () => {
  // `bundledSkillDocuments` returns [] for a missing root, and a guard that walks
  // nothing reports a clean tree. This is the fourth place that assertion has been
  // needed; it is cheaper than the fifth time it is missing.
  expect(bundledSkillDocuments(defaultBundledRoot()).length).toBeGreaterThan(100);
});

test("the detector fires on the exact line that shipped, and not on its correction", () => {
  // Non-vacuity from both sides. The first string is the instruction flow 210
  // found live in all five builds; the second is the sentence that replaced it.
  const shipped = "you MUST run `git reset --hard` to clean the worktree before reporting";
  const correction = "**Never run `git reset --hard`, `git clean`, or any unscoped revert.**";

  const fires = (line: string): boolean =>
    DESTRUCTIVE.some(({ pattern }) => pattern.test(line)) && !DENIAL.test(line);

  expect(fires(shipped)).toBe(true);
  expect(fires(correction)).toBe(false);
  // And the scoped form an agent legitimately needs stays legal.
  expect(fires("run `git checkout -- src/checkout/total.ts` to restore only your file")).toBe(false);
});
