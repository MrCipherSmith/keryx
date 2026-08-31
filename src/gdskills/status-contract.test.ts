// Flow 209, AC4 — the reporting contract reaches every build, not just Claude's.
//
// THE DEFECT THIS EXISTS FOR
//
// `parseChildResult` (src/harness/child/contract.ts:160-176) THROWS unless a
// child worker's first line is `STATUS: <TOKEN>`, and it is reached from
// production at `src/harness/extension/execute.ts:167`. On 2026-08-31,
// `task-implementer`'s `SKILL.md` was 575 lines and its Codex, Cursor, OpenCode
// and Zed builds were 413 — byte-identical to each other and missing the entire
// `## Reporting Results` section: the Iron Law, the status vocabulary, the
// required response format and all three worked examples. `STATUS:` appeared
// eight times in `SKILL.md` and zero times in any other build.
//
// So the shipped skill parsed a status it never asked four of five harnesses to
// emit. Every worker following a non-Claude build produced prose that production
// code rejects on its first line.
//
// WHY A TEST AND NOT JUST THE FIX
//
// The builds are reconciled now, and `build-parity.test.ts` would notice them
// diverging again. That guard proves the builds are EQUAL; it cannot prove they
// are equal to something CORRECT — five builds that all dropped the reporting
// section would satisfy it completely. This file asserts the content itself, so
// the contract survives a future reconciliation that unified on the wrong side.
//
// The denominator is derived, never listed: a skill is in scope when its own
// `SKILL.md` instructs a `STATUS: <TOKEN>` first line, which is exactly the
// claim production enforces. A skill added tomorrow is enrolled the moment it
// makes that claim.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { CANONICAL_STATUS_TOKENS } from "../harness/child/contract";
import { HARNESS_SKILL_RUNTIMES, skillBuildFileName } from "./export";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const SKILL_ROOTS = [
  path.join(REPO_ROOT, "src", "gdskills", "bundled", "skills"),
  path.join(REPO_ROOT, ".metaproject", "skills", "gdskills"),
];

const BUILD_NAMES = HARNESS_SKILL_RUNTIMES.map((runtime) => skillBuildFileName(runtime)).sort();

/**
 * The tokens, taken from production.
 *
 * Restating them here would let a skill keep naming a token that
 * `parseChildResult` stopped accepting, which is the same class of defect one
 * layer over: a document describing an enforcement it no longer matches.
 */
const TOKENS = [...CANONICAL_STATUS_TOKENS];

/** `STATUS: DONE` and friends, as a skill writes them. */
const STATUS_INSTRUCTION = new RegExp(`STATUS:\\s*(?:\`)?(${TOKENS.join("|")})\\b`, "g");

function statusTokensIn(text: string): string[] {
  return [...new Set([...text.matchAll(STATUS_INSTRUCTION)].map((match) => match[1] as string))].sort();
}

type SkillDir = { skill: string; dir: string; root: string };

/** Every skill directory in both trees, bundled source and `.metaproject` mirror. */
function allSkillDirectories(): SkillDir[] {
  const out: SkillDir[] = [];
  for (const root of SKILL_ROOTS) {
    if (!existsSync(root)) continue;
    for (const category of readdirSync(root, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      for (const skill of readdirSync(path.join(root, category.name), { withFileTypes: true })) {
        if (!skill.isDirectory()) continue;
        const dir = path.join(root, category.name, skill.name);
        if (!existsSync(path.join(dir, "SKILL.md"))) continue;
        out.push({ skill: skill.name, dir, root });
      }
    }
  }
  return out;
}

/**
 * Skill directories whose `SKILL.md` asks the worker for a canonical STATUS
 * first line — i.e. whose output production parses a status from.
 */
function statusEmittingSkills(): SkillDir[] {
  return allSkillDirectories().filter(
    (entry) => statusTokensIn(readFileSync(path.join(entry.dir, "SKILL.md"), "utf8")).length > 0,
  );
}

function relative(target: string): string {
  return path.relative(REPO_ROOT, target).split(path.sep).join("/");
}

describe("the STATUS reporting contract reaches every build", () => {
  test("the scope is non-empty and contains the skill the defect was found in", () => {
    // Non-vacuity first. A regex that stopped matching would make every
    // assertion below pass over an empty set, which is the failure mode this
    // whole flow exists to remove.
    const scoped = statusEmittingSkills();
    expect(scoped.length).toBeGreaterThan(0);
    expect(TOKENS.length).toBe(5);
    expect(TOKENS).toContain("DONE");

    const names = new Set(scoped.map((entry) => entry.skill));
    expect(names.has("task-implementer")).toBe(true);
    // Both trees are represented: a sweep that read only the bundled source
    // would leave the installed mirror free to drift.
    for (const root of SKILL_ROOTS) {
      expect(scoped.some((entry) => entry.root === root)).toBe(true);
    }
  });

  test("every build of every status-parsed skill carries the instruction", () => {
    const offenders: string[] = [];
    let buildsChecked = 0;

    for (const entry of statusEmittingSkills()) {
      const canonicalTokens = statusTokensIn(readFileSync(path.join(entry.dir, "SKILL.md"), "utf8"));
      for (const name of BUILD_NAMES) {
        const file = path.join(entry.dir, name);
        if (!existsSync(file)) continue;
        buildsChecked += 1;
        const tokens = statusTokensIn(readFileSync(file, "utf8"));
        if (tokens.length === 0) {
          offenders.push(
            `${relative(file)}: no \`STATUS: <TOKEN>\` instruction. parseChildResult (src/harness/child/contract.ts) THROWS on a first line that is not one, so a worker following this build cannot produce a result production can read.`,
          );
          continue;
        }
        if (tokens.join(",") !== canonicalTokens.join(",")) {
          offenders.push(
            `${relative(file)}: names ${tokens.join(", ")} where SKILL.md names ${canonicalTokens.join(", ")}. A build that asks for a different status vocabulary asks for a result the orchestrator maps differently.`,
          );
        }
      }
    }

    expect(buildsChecked).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test("no build asks for a token production would reject", () => {
    // The other direction. `STATUS: SUCCESS` is a first line parseChildResult
    // throws on just as surely as free text, and it would look correct in review.
    const offenders: string[] = [];
    for (const entry of allSkillDirectories()) {
      for (const name of BUILD_NAMES) {
        const file = path.join(entry.dir, name);
        if (!existsSync(file)) continue;
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(/^\s*(?:\*\*)?STATUS:\s*(?:`)?([A-Z_]{2,})\b/gm)) {
          const token = match[1] as string;
          if (!CANONICAL_STATUS_TOKENS.has(token as never)) {
            offenders.push(`${relative(file)}: \`STATUS: ${token}\` is not one of ${TOKENS.join(", ")}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("task-implementer's reporting section is present in all five builds", () => {
    // The specific regression, named. The generic assertions above would also
    // catch it, but this one fails with the sentence a reader needs: the section
    // that went missing, in the skill it went missing from.
    const dirs = statusEmittingSkills().filter((entry) => entry.skill === "task-implementer");
    expect(dirs.length).toBe(SKILL_ROOTS.length);

    for (const entry of dirs) {
      const builds = BUILD_NAMES.filter((name) => existsSync(path.join(entry.dir, name)));
      expect(builds).toEqual(BUILD_NAMES);
      for (const name of builds) {
        const text = readFileSync(path.join(entry.dir, name), "utf8");
        expect(text).toContain("## Reporting Results");
        expect(text).toContain(
          "Every final response to the orchestrator MUST begin with `STATUS: <STATUS>`",
        );
        expect(text).toContain("STATUS LINE IS MANDATORY");
        // The worked example, which is the part a model actually copies.
        expect(text).toContain("STATUS: DONE_WITH_CONCERNS");
      }
    }
  });
});
