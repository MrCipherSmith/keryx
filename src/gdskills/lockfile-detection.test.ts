import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

/**
 * F-240-02 (flow 240 T6): no shipped skill may detect a Bun project by
 * `bun.lockb` alone.
 *
 * Bun 1.2 replaced the binary `bun.lockb` with the text `bun.lock`. Three
 * shipped skills still branched on the old name only, and this repository —
 * which has `bun.lock`, no `bun.lockb`, no `package-lock.json` and no
 * `yarn.lock` — matched none of their arms:
 *
 *   security-audit  "Auto-detect: `bun.lockb` -> `bun audit` | ..."   (no else)
 *   code-verifier   "if   [ -f bun.lockb ];  then PM=bun; ..."       (-> PM=unknown)
 *   job-orchestrator "if [ -f <worktree_path>/bun.lockb ]; then ..."  (-> npm)
 *
 * `security-audit` was the expensive one: with no arm matching and no else
 * branch, its next instruction was "group by severity" over whatever the next
 * command returned, and `npm audit --json` without a lockfile returns
 * `{"error":{"code":"ENOLOCK",...}}` — zero for every severity. A security skill
 * reporting "no vulnerabilities" because it could not run.
 *
 * The rule is LINE-scoped: wherever a shipped skill names `bun.lockb` it must
 * name `bun.lock` on the same line. A file-scoped version was written first and
 * rejected — reverting only the detection table, while leaving a paragraph
 * further down that happens to mention `bun.lock`, kept it green. Line scope
 * costs nothing (prose about the rename names both anyway, since the whole point
 * of the sentence is the pair) and it bites on exactly the edit that matters:
 * the one that leaves a check reaching only the name Bun no longer writes.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const SKILL_ROOTS = [
  path.join(REPO_ROOT, "src", "gdskills", "bundled", "skills"),
  path.join(REPO_ROOT, ".metaproject", "skills", "gdskills"),
];

/** `bun.lock` NOT followed by another word character, so `bun.lockb` never counts. */
const CURRENT_BUN_LOCKFILE = /bun\.lock(?![\w])/;
const LEGACY_BUN_LOCKFILE = /bun\.lockb/;

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function shippedSkillFiles(): string[] {
  return SKILL_ROOTS.filter((root) => existsSync(root)).flatMap((root) => markdownFiles(root));
}

function relative(target: string): string {
  return path.relative(REPO_ROOT, target).split(path.sep).join("/");
}

test("the lockfile sweep has a real denominator", () => {
  // A guard that walks an empty tree passes forever. Both roots exist and the
  // sweep sees the whole shipped skill corpus, not a handful of files.
  for (const root of SKILL_ROOTS) expect(existsSync(root)).toBe(true);
  expect(shippedSkillFiles().length).toBeGreaterThan(100);

  // And the predicate bites: `bun.lockb` must not satisfy the current-name test.
  expect(CURRENT_BUN_LOCKFILE.test("if [ -f bun.lockb ]; then")).toBe(false);
  expect(CURRENT_BUN_LOCKFILE.test("if [ -f bun.lock ]; then")).toBe(true);
  expect(CURRENT_BUN_LOCKFILE.test("`bun.lock` **or** `bun.lockb`")).toBe(true);
});

test("no shipped skill names bun.lockb on a line that does not also name bun.lock", () => {
  const offenders: string[] = [];
  for (const file of shippedSkillFiles()) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (LEGACY_BUN_LOCKFILE.test(line) && !CURRENT_BUN_LOCKFILE.test(line)) {
        offenders.push(`${relative(file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  expect(offenders).toEqual([]);
});

test("the shipped security-audit skill detects bun and states a not-run outcome", () => {
  const files = SKILL_ROOTS.map((root) => path.join(root, "quality", "security-audit"))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => readdirSync(dir).filter((name) => name.startsWith("SKILL")).map((name) => path.join(dir, name)));

  // Both roots ship this skill, in three builds each.
  expect(files.length).toBeGreaterThanOrEqual(6);

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // Detection reaches a current Bun project...
    expect(text).toMatch(CURRENT_BUN_LOCKFILE);
    // ...and an unrecognised project is a stated outcome, not a fall-through.
    expect(text).toContain("NOT RUN");
    // The specific trap that made the old skill dangerous is named, so nobody
    // "simplifies" the not-run branch back out without meeting the argument.
    expect(text).toContain("ENOLOCK");
    // And the standing rule, in the skill's own Rules section.
    expect(text).toContain("A check that did not run is not a check that passed.");
  }
});
