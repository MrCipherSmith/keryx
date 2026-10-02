import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_AUTO_GOAL_ROUNDS } from "../commands/goal-command";

/**
 * The round bounds, in every place that carries one (flow 203, AC8; flow 391).
 *
 * Flow 203 unified three repair-loop bounds at 3: `task-implementer`,
 * `job-orchestrator` and `flow-orchestrator` (which said 6). Flow 391 raises the
 * REVIEW bound in `flow-orchestrator` to 5 by operator decision (message 178020):
 * in a flow, review findings surface across rounds rather than all at once, so
 * a third round can still find new things. The self-fix bounds in
 * `job-orchestrator` and `task-implementer` stay at 3, and `/goal --auto` (a
 * continuation loop, not a repair loop) stays at 8 — which this file also pins,
 * so that "deliberate" stays a claim someone wrote down rather than a number
 * someone forgot.
 */

const REPO_ROOT = process.cwd();

const SKILL_ROOTS = [
  path.join(REPO_ROOT, "src", "gdskills", "bundled", "skills", "orchestration"),
  path.join(REPO_ROOT, ".metaproject", "skills", "gdskills", "orchestration"),
];

function skillFiles(skill: string): string[] {
  const files: string[] = [];
  for (const root of SKILL_ROOTS) {
    const dir = path.join(root, skill);
    for (const name of readdirSync(dir)) {
      if (name.startsWith("SKILL") && name.endsWith(".md")) {
        files.push(path.join(dir, name));
      }
    }
  }
  return files;
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

test("AC2: flow-orchestrator's review/fix bound is five, by operator decision, not six or three", () => {
  const files = skillFiles("flow-orchestrator");
  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    const text = read(file);
    // Five, unlike the two self-fix bounds below which stay at three: review
    // findings surface across rounds in a flow (operator decision, 178020).
    expect(text).toContain("Allow at most **five** review/fix attempts");
    expect(text).toContain("attempts < 5");
    expect(text).toContain("has already reached **five**");
    // The old bounds, in every spelling they appeared in.
    expect(text).not.toContain("at most three");
    expect(text).not.toContain("attempts < 3");
    expect(text).not.toContain("attempts = 3");
    expect(text).not.toContain("has already reached **three**");
    expect(text).not.toContain("The three-attempt bound");
    expect(text).not.toContain("at most six");
    expect(text).not.toContain("attempts < 6");
    expect(text).not.toContain("attempts = 6");
    expect(text).not.toContain("has already reached six");
  }
});

test("AC4: the review guide states the round bound as five", () => {
  const guide = read(path.join(REPO_ROOT, "docs", "docs", "guides", "review-with-a-record.md"));
  expect(guide).toContain("The round bound is five attempts.");
  expect(guide).not.toContain("The round bound is three attempts.");
});

// AC3: these two stay at three. Self-fix loops repair the same artifact against
// the same failing signal, where the evidence says rounds past three regress;
// the review bound above differs because a flow's findings surface across rounds.
test("AC8: job-orchestrator's fix bound is three", () => {
  for (const file of skillFiles("job-orchestrator")) {
    expect(read(file)).toContain("Default max: **3 iterations** (`max_review_iterations`)");
  }
});

test("AC8: task-implementer's self-fix bound is three", () => {
  for (const file of skillFiles("task-implementer")) {
    expect(read(file)).toContain("Maximum 3 self-fix attempts per verification step");
  }
});

test("AC8: the three repair bounds cite the same evidence, in the file that carries each", () => {
  // A number agreeing by coincidence is drift that has not diverged yet. Each
  // file states why it is three where a reader of that file will see it.
  for (const skill of ["flow-orchestrator", "job-orchestrator", "task-implementer"]) {
    for (const file of skillFiles(skill)) {
      const text = read(file);
      expect(text).toContain("arxiv.org/abs/2607.05197");
      expect(text).toContain("arxiv.org/abs/2607.24604");
      expect(text).toContain("max_reflections = 3");
    }
  }
});

test("AC9: every repair loop stops on repetition, not only on count", () => {
  expect(read(path.join(SKILL_ROOTS[0] as string, "flow-orchestrator", "SKILL.md"))).toContain("keryx review loop");
  for (const file of skillFiles("job-orchestrator")) {
    expect(read(file)).toContain("STUCK CHECK");
    expect(read(file)).toContain("even with iterations left");
  }
  for (const file of skillFiles("task-implementer")) {
    expect(read(file)).toContain("Stop earlier on repetition, whatever the count says");
  }
});

/**
 * The fourth bound. Different on purpose, and the purpose is written down in the
 * file that carries the constant — which is what AC8 asks for when a number is
 * not unified.
 */
test("AC8: /goal --auto keeps 8, justified in the file that carries it", () => {
  expect(DEFAULT_AUTO_GOAL_ROUNDS).toBe(8);

  const source = read(path.join(REPO_ROOT, "src", "commands", "goal-command.ts"));
  expect(source).toContain("Why this is 8 and not 3");
  // The distinction the justification turns on, stated rather than implied.
  expect(source).toContain("continuation");
  expect(source).toContain("repair");
});

test("AC14: the bundled skill and its .metaproject mirror are byte-identical", () => {
  for (const skill of ["flow-orchestrator", "job-orchestrator", "task-implementer"]) {
    const bundled = path.join(SKILL_ROOTS[0] as string, skill);
    const mirror = path.join(SKILL_ROOTS[1] as string, skill);
    const names = readdirSync(bundled).filter((name) => name.startsWith("SKILL") && name.endsWith(".md"));
    // SKILL.md at minimum; since flow 257 these three ship no harness builds.
    expect(names).toContain("SKILL.md");
    for (const name of names) {
      expect(read(path.join(mirror, name))).toBe(read(path.join(bundled, name)));
    }
    // The other direction: the mirror carries no SKILL*.md the bundle dropped.
    // A stale SKILL.<runtime>.md left there would be preferred by a runtime
    // export over the current SKILL.md, so "same files" is part of "identical".
    const mirrorNames = readdirSync(mirror).filter((name) => name.startsWith("SKILL") && name.endsWith(".md"));
    expect(mirrorNames.sort()).toEqual([...names].sort());
  }
});
