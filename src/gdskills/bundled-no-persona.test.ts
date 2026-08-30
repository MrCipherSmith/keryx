// Flow 206, AC1 — the shipped tree names no person and no machine.
//
// WHAT THIS GUARDS, AND WHY A LIST OF WORDS IS THE RIGHT SHAPE
//
// `src/gdskills/bundled/` is copied verbatim into every installation. Until this
// flow, it carried one specific reviewer: a skill named after them, a rule
// replicating their style, their speech markers, and their team's store
// conventions stated as universal rules. A general tool cannot ship knowledge of
// a particular user, and the removal is only durable if re-adding it fails.
//
// A guard over a fixed list of words has an obvious weakness — it cannot notice
// a NEW persona under a NEW name — and that is accepted deliberately. No test
// can decide whether prose describes a mechanism or a person; that is what AC2's
// reading test is for, and it is a human one. What a test can do is make the
// specific regression this flow removed impossible to reintroduce silently,
// which is the failure mode that actually happened: the names sat in the public
// repository through nineteen releases because nothing looked.
//
// The path check is the part that generalises. A shipped file pointing into
// somebody's home directory is broken for every reader but its author, and that
// IS decidable.

// Flow 207 moved the four predicates below into `bundled-eval.ts` and left the
// justifications with them. Nothing about the rule changed; what changed is that
// the §5.3 sweep over the 65 shipped SKILL.md files now applies the SAME
// predicates. Restating them there would have let the two drift, and the older
// guard would have kept passing on a tree the newer one rejects.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  HARNESS_HOME_ROOTS,
  PERSONAL_MARKER_PATTERNS,
  PERSONA_PATTERNS,
  homePathOffenders,
  personaOffenders,
} from "./bundled-eval";

const BUNDLED = path.join(import.meta.dir, "bundled");

function bundledFiles(dir = BUNDLED): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...bundledFiles(full));
      continue;
    }
    files.push(full);
  }
  return files;
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function relative(file: string): string {
  return path.relative(BUNDLED, file);
}

test("AC1: no file under src/gdskills/bundled names the reviewer this flow removed", () => {
  const offenders: string[] = [];
  for (const file of bundledFiles()) {
    const text = read(file);
    for (const { pattern, why } of PERSONA_PATTERNS) {
      if (pattern.test(text)) offenders.push(`${relative(file)}: ${why}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("AC1: no file under src/gdskills/bundled carries the reviewer's speech markers", () => {
  const offenders: string[] = [];
  for (const file of bundledFiles()) {
    const text = read(file);
    for (const { pattern, why } of PERSONAL_MARKER_PATTERNS) {
      if (pattern.test(text)) offenders.push(`${relative(file)}: ${why}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("AC1: the shared persona predicate is the one applied, line by line", () => {
  // The per-file loops above answer "does this tree carry a persona"; this
  // answers "is the predicate that decides it the same one the §5.3 sweep
  // uses". Deleting the import to inline the patterns again fails here.
  const offenders: string[] = [];
  for (const file of bundledFiles()) {
    for (const offender of personaOffenders(read(file))) {
      offenders.push(`${relative(file)}:${offender.line}: ${offender.why}`);
    }
  }
  expect(offenders).toEqual([]);
});

/**
 * Home directories.
 *
 * The rule and its justification now live with the predicate in
 * `bundled-eval.ts`: harness config roots (`~/.claude`, `${CODEX_HOME:-~/.codex}`)
 * are correct paths a skill has to name, and the violation is a path into a
 * PARTICULAR person's home. The allow-list is asserted here so that shortening
 * it is a visible change to this guard rather than an invisible one.
 */
test("AC1: no file under src/gdskills/bundled points into a particular person's home directory", () => {
  expect(HARNESS_HOME_ROOTS).toContain("~/.claude");
  expect(HARNESS_HOME_ROOTS.length).toBeGreaterThanOrEqual(9);

  const offenders: string[] = [];
  for (const file of bundledFiles()) {
    for (const offender of homePathOffenders(read(file))) {
      offenders.push(`${relative(file)}:${offender.line}: ${offender.why}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("AC1: the guard reads a real tree — the denominator is not zero", () => {
  // Every assertion above passes vacuously over an empty file list, and a
  // renamed directory would empty it.
  const files = bundledFiles();
  expect(files.length).toBeGreaterThan(100);
  expect(files.some((file) => relative(file).startsWith(path.join("skills", "review")))).toBe(true);
  expect(files.some((file) => relative(file).startsWith(path.join("rules", "core")))).toBe(true);
});

/**
 * AC2's mechanism claim, in the one place a test can reach it.
 *
 * Whether prose reads as a mechanism is a human judgement. Whether it says the
 * three things the mechanism actually consists of — learned locally, from
 * pull-request comments, by people the project names — is not, and a rewrite
 * that quietly drops one of them is a rewrite back toward a style guide.
 */
test("AC2: the shipped learned-review skill and rule describe the mechanism, in all five builds", () => {
  const skillDir = path.join(BUNDLED, "skills", "review", "code-learned-review");
  const builds = readdirSync(skillDir).filter((name) => name.startsWith("SKILL") && name.endsWith(".md"));
  expect(builds).toHaveLength(5);

  const texts = [
    ...builds.map((name) => read(path.join(skillDir, name))),
    read(path.join(BUNDLED, "rules", "core", "code-review-learned-profile.mdc")),
  ];
  for (const text of texts) {
    expect(text).toMatch(/review-learning\.config\.json/);
    expect(text).toMatch(/pull-request comments|pull request comments/i);
    expect(text).toMatch(/\.metaproject\/project-skills/);
    // The name it must not carry: a checklist of its own.
    expect(text).toMatch(/no (review )?conventions of its own|carries no conventions/i);
  }
});

test("AC2: the shipped learned-review skill points at the commands that exist", () => {
  // AC10: a claim about a mechanism is wired or it is not made. These three are
  // the commands the prose names, and `review learn` is the one this flow added —
  // asserted here so that renaming it breaks the document that advertises it.
  const skill = read(path.join(BUNDLED, "skills", "review", "code-learned-review", "SKILL.md"));
  expect(skill).toContain("keryx review comments collect");
  expect(skill).toContain("keryx review learn");
  expect(skill).toContain("keryx skills learn apply");
});
