// Flow 209, AC7 — a shipped skill may not dispatch an agent or a skill that
// this tree does not have.
//
// # Why a guard and not a third manual fix
//
// This class has now been removed three times and come back three times:
//
//   1. `code-boss-review` as job-orchestrator's default reviewer — removed.
//   2. `code-review` as the default `review_mode` — removed, then REINTRODUCED
//      in the §1.1 plan JSON (`agent: "code-review"`, SKILL.md:302) and in
//      `src/job/plans.ts:22`, in the same file that says at :950 and :1894 that
//      the reference is gone.
//   3. `wave-executor` — denied in job-orchestrator, still described as real in
//      `task-implementer/orchestrator-prompt.md`.
//
// Each was fixed by hand and nothing checked afterwards, which is why each came
// back. `keryx skills verify --bundled`'s `xref:skill` check exists and did not
// catch any of them: every one of its patterns requires the word `skill` (or
// `Skill(...)`) adjacent to the name, so a DISPATCH POSITION — `agent: "x"`,
// `subagent_type: "x"`, `Agent("x")`, `Task("x")` — was invisible to it. That
// gap is exactly where the reintroduction landed. This guard closes it.
//
// # What it checks, and what it deliberately does not
//
// Only unambiguous *dispatch positions* are matched. A name in one of those is
// an instruction to run something; there is no reading of `agent: "code-review"`
// under which the referent may be absent.
//
// Prose is NOT matched, and that is a decision rather than an oversight. The
// same tree carries sentences whose whole purpose is to deny a reference —
// `There is no \`wave-executor\` agent` (job-orchestrator SKILL.md:733) — and a
// pattern wide enough to catch a prose mention flags those denials as defects.
// A guard that fails on the correction is a guard that gets deleted, and the
// three recurrences above show what happens next. The hole is stated here rather
// than papered over: **a skill that only DESCRIBES a non-existent agent in prose
// still passes this guard.** `wave-executor` in
// `task-implementer/orchestrator-prompt.md` is such a case and is open.
//
// The check runs over BOTH trees and over every `*.md` in them — the harness
// builds too, not one file per skill, because a divergence that reintroduces a
// dangling reference in `SKILL.codex.md` alone is the same defect on four fifths
// of the shipped harnesses.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { BUNDLED_GDSKILLS } from "./catalog";
import { KNOWN_EXTERNAL_SKILL_REFERENCES } from "./bundled-eval";
import { defaultPlan } from "../job/plans";
import type { JobIntent } from "../job/types";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");

/** The two trees a skill edit must land in. Both ship; both are checked. */
const SKILL_TREES = [
  path.join(REPO_ROOT, "src", "gdskills", "bundled", "skills"),
  path.join(REPO_ROOT, ".metaproject", "skills", "gdskills"),
];

/**
 * The shipped rules, which are read by the same agents and carried
 * `subagent_type: "general"` — a type no dispatcher accepts — in two files.
 *
 * A rule is not a skill, so it is scanned for dispatch positions and is
 * deliberately absent from {@link knownAgentNames}: a rule cannot be dispatched
 * and must never be a valid referent.
 */
const RULE_TREES = [
  path.join(REPO_ROOT, "src", "gdskills", "bundled", "rules"),
  path.join(REPO_ROOT, ".metaproject", "rules"),
];

const SCANNED_TREES = [...SKILL_TREES, ...RULE_TREES];

/**
 * Names that resolve to something REAL that is not a bundled skill.
 *
 * Every entry says where the referent lives. An allowance is not an exemption
 * from the check; it is a statement that the thing exists somewhere this sweep
 * cannot see. A name added here without a referent is the defect wearing the
 * guard's own clothes.
 */
const NON_SKILL_AGENT_LABELS: ReadonlyMap<string, string> = new Map([
  ["orchestrator", "the running skill itself — the step is not delegated"],
  ["reviewers", "the set of `review-*` skills, dispatched individually"],
  ...KNOWN_EXTERNAL_SKILL_REFERENCES,
]);

/**
 * Dispatch positions. Each names something to RUN, so a name in one of them is
 * either in the catalogue or broken.
 *
 * Capture group 1 is always the referenced name.
 */
const DISPATCH_PATTERNS: readonly RegExp[] = [
  /"?\bagent"?\s*[:=]\s*["']([a-z][a-z0-9-]*)["']/g,
  /"?\bsubagent_type"?\s*[:=]\s*["']([a-z][a-z0-9-]*)["']/g,
  /\bAgent\(\s*["']([a-z][a-z0-9-]*)["']\s*\)/g,
  // Quoted only. `Task(subagent)` and `Task(sub-agent)` appear in the ASCII
  // pipeline diagrams several orchestrator prompts draw, where the token is a
  // placeholder for "whatever this wave dispatches" rather than a name. Matching
  // the unquoted form reported four of those as dangling references, and a guard
  // whose first run is mostly false positives is a guard nobody keeps.
  /\bTask\(\s*["']([a-z][a-z0-9-]*)["']\s*[),]/g,
  /\bSkill\(\s*["']([a-z][a-z0-9-]*)["']\s*\)/g,
];

/**
 * Every agent-readable document under `root`, absolute, sorted. `[]` when `root`
 * is absent.
 *
 * `.mdc` as well as `.md`: `rules/core/gproject-contracts.mdc` carries a
 * dispatch block and an extension-based walk that skipped it would have reported
 * a clean tree over a file naming an agent type nothing accepts.
 */
function agentDocuments(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".md") || entry.name.endsWith(".mdc")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * The names this tree can actually run: the catalogue, plus every skill
 * directory that ships.
 *
 * The union rather than the catalogue alone, because a directory present but
 * uncatalogued is a different defect (`catalog:registered` in
 * `bundled-eval.ts`) and reporting it here too would give one problem two
 * voices.
 */
function knownAgentNames(): Set<string> {
  const names = new Set(BUNDLED_GDSKILLS.map((skill) => skill.name));
  for (const tree of SKILL_TREES) {
    if (!existsSync(tree)) continue;
    for (const category of readdirSync(tree, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      for (const skill of readdirSync(path.join(tree, category.name), { withFileTypes: true })) {
        if (skill.isDirectory()) names.add(skill.name);
      }
    }
  }
  return names;
}

type DanglingReference = {
  file: string;
  line: number;
  name: string;
  text: string;
};

function danglingDispatchReferences(): DanglingReference[] {
  const known = knownAgentNames();
  const found: DanglingReference[] = [];
  for (const tree of SCANNED_TREES) {
    for (const file of agentDocuments(tree)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          for (const pattern of DISPATCH_PATTERNS) {
            for (const match of line.matchAll(pattern)) {
              const name = match[1] as string;
              if (known.has(name)) continue;
              if (NON_SKILL_AGENT_LABELS.has(name)) continue;
              found.push({
                file: path.relative(REPO_ROOT, file),
                line: index + 1,
                name,
                text: line.trim(),
              });
            }
          }
        });
    }
  }
  return found;
}

describe("a shipped skill never dispatches an agent this tree does not have", () => {
  // The denominator, asserted rather than assumed. A walk that found nothing
  // reports the same `0 dangling references` as a clean tree, and "the sweep ran
  // over an empty directory" is the failure mode this whole programme is about.
  test("the sweep reads both trees, every harness build, and the rules", () => {
    const files = SCANNED_TREES.flatMap((tree) => agentDocuments(tree));
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.endsWith("SKILL.codex.md"))).toBe(true);
    expect(files.some((file) => file.includes(`${path.sep}.metaproject${path.sep}`))).toBe(true);
    expect(files.some((file) => file.endsWith(".mdc"))).toBe(true);
    expect(files.some((file) => file.includes(`${path.sep}rules${path.sep}`))).toBe(true);
  });

  test("no shipped skill document names an unknown agent in a dispatch position", () => {
    const dangling = danglingDispatchReferences();
    expect(
      dangling.map((entry) => `${entry.file}:${entry.line} names \`${entry.name}\` — ${entry.text}`),
    ).toEqual([]);
  });

  // The guard proving it can fail. Without this the test above passes equally
  // well when the patterns match nothing at all, which is how `xref:skill`
  // shipped a clean report over a tree carrying `agent: "code-review"`.
  test("the patterns fire on the exact forms that were reintroduced", () => {
    const known = knownAgentNames();
    const reintroduced = [
      '  8.  { id: "review", type: "review", agent: "code-review", depends: ["verify"] }',
      'Dispatch SINGLE Agent("wave-executor") with all tasks in this wave.',
      'Use subagent_type: "code-boss-review" for the strict pass.',
      'Task("task-implementer-v2")',
      'subagent_type: "general",',
    ];
    const caught = reintroduced.filter((line) =>
      DISPATCH_PATTERNS.some((pattern) =>
        [...line.matchAll(pattern)].some((match) => !known.has(match[1] as string)),
      ),
    );
    expect(caught).toEqual(reintroduced);
  });

  test("a catalogued name in the same forms is not reported", () => {
    const known = knownAgentNames();
    const legitimate = [
      '  5.  { id: "implement", type: "implement", agent: "task-implementer", depends: [] }',
      'Agent("review-orchestrator")',
      'subagent_type: "review-logic"',
    ];
    for (const line of legitimate) {
      for (const pattern of DISPATCH_PATTERNS) {
        for (const match of line.matchAll(pattern)) {
          expect(known.has(match[1] as string)).toBe(true);
        }
      }
    }
  });
});

/**
 * The same rule over the plan `keryx job init` writes.
 *
 * `src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md` §1.1
 * says the listed plan is what the command writes "step for step", so the two
 * carried the identical dangling reference: the skill said `agent:
 * "code-review"` and `src/job/plans.ts` wrote it into every implement job on
 * disk. Fixing only the Markdown would have left the record wrong and the
 * document right, which is worse than both being wrong.
 */
describe("every job-plan agent label resolves", () => {
  const INTENTS: readonly JobIntent[] = ["implement", "analyze", "review", "custom"];

  test("no default plan names an agent outside the catalogue", () => {
    const known = knownAgentNames();
    const unknown: string[] = [];
    for (const intent of INTENTS) {
      for (const step of defaultPlan(intent)) {
        if (known.has(step.agent)) continue;
        if (NON_SKILL_AGENT_LABELS.has(step.agent)) continue;
        unknown.push(`${intent}/${step.id}: ${step.agent}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  test("the implement plan's review step names the skill that runs it", () => {
    const review = defaultPlan("implement").find((step) => step.id === "review");
    expect(review?.agent).toBe("review-orchestrator");
  });
});
