// Flow 417: review-orchestrator runs inline in the main session and never
// half-runs. Each test pins one rule where an agent reads it — the shipped
// bundled skill files, not a copy.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MAX_RATE_HALVINGS, MAX_REVIEWERS_PER_WAVE_FULL } from "../review/caps";
import { REVIEW_ROUND_CAP } from "../flow/review-gate";
import { classifyRoundNeed } from "../review/round-need";
import { SKILL_LENGTH_CEILINGS } from "./skill-length-ceilings";

const SKILLS = path.join(import.meta.dir, "bundled", "skills");
const ENGINE = path.join(SKILLS, "review", "review-orchestrator");
const BLOCKED = "STATUS: BLOCKED nested_dispatch_unavailable — run this skill in the main session";

const read = (...parts: string[]): string => readFileSync(path.join(...parts), "utf8");
const SKILL = read(ENGINE, "SKILL.md");
const DETAIL = read(ENGINE, "SKILL.detail.md");
const FLOW = read(SKILLS, "orchestration", "flow-orchestrator", "SKILL.md");
const JOB = read(SKILLS, "orchestration", "job-orchestrator", "SKILL.md");

const head = (text: string, n = 60): string => text.split("\n").slice(0, n).join("\n");
const lineCount = (text: string): number => text.split("\n").length - 1;

function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const end = lines.findIndex((line, i) => i > start && new RegExp(`^#{1,${level}} `).test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

const orchestratorFiles = (): string[] =>
  readdirSync(SKILLS, { withFileTypes: true })
    .filter((category) => category.isDirectory())
    .flatMap((category) =>
      readdirSync(path.join(SKILLS, category.name), { withFileTypes: true })
        .filter((skill) => skill.isDirectory() && skill.name.endsWith("-orchestrator"))
        .map((skill) => path.join(SKILLS, category.name, skill.name, "SKILL.md")),
    );

describe("AC1: the orchestrator runs the round itself, and says so first", () => {
  test("the first screen states inline, main session, and no whole-round handoff", () => {
    const top = head(SKILL);
    expect(top).toContain("You are the orchestrator.");
    expect(top).toContain("inline");
    expect(top).toContain("main session");
    expect(top).toContain("never hand the whole round to one subagent");
  });

  test("the preflight sits inside the first 60 lines and lists its three checks", () => {
    const top = head(SKILL);
    expect(top).toContain("## Preflight — before Step 0, in this order");
    const preflight = section(SKILL, "## Preflight — before Step 0, in this order");
    expect(preflight).toMatch(/^1\. \*\*Can it spawn\?\*\*/m);
    expect(preflight).toMatch(/^2\. \*\*Is a round needed\?\*\*/m);
    expect(preflight).toMatch(/^3\. \*\*Round ceiling\.\*\*/m);
  });

  test("the preflight comes before the workflow checklist", () => {
    expect(SKILL.indexOf("## Preflight")).toBeLessThan(SKILL.indexOf("## Workflow"));
  });
});

describe("AC2: no spawn tool, no review — one exact line", () => {
  test("the exact BLOCKED line is in the first 60 lines, before the start questions", () => {
    expect(head(SKILL)).toContain(BLOCKED);
    expect(SKILL.indexOf(BLOCKED)).toBeLessThan(SKILL.indexOf("### Start questions (Step 5)"));
  });

  test("the preflight says the whole output is that line, with no tool calls", () => {
    const preflight = section(SKILL, "## Preflight — before Step 0, in this order");
    expect(preflight).toContain("no tool calls");
    expect(preflight).toContain("depth budget");
  });

  test("the older BLOCKED statements are pointers into the preflight", () => {
    const dispatching = section(SKILL, "## Dispatching Reviewers");
    const start = section(SKILL, "### Start questions (Step 5)");
    for (const text of [dispatching, start]) {
      expect(text).toContain("`nested_dispatch_unavailable`");
      expect(text).toContain("Preflight");
    }
  });
});

describe("AC3: no orchestrator tells itself to halt when dispatched", () => {
  test("flow-orchestrator and job-orchestrator carry the same preflight in their first 60 lines", () => {
    for (const text of [FLOW, JOB]) {
      const top = head(text);
      expect(top).toContain("## Preflight");
      expect(top).toContain(BLOCKED);
      expect(top).toContain("main session");
    }
  });

  test("no orchestrating SKILL.md carries a SUBAGENT-STOP block", () => {
    const files = orchestratorFiles();
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      expect({ file: path.relative(SKILLS, file), stop: read(file).includes("SUBAGENT-STOP") }).toEqual({
        file: path.relative(SKILLS, file),
        stop: false,
      });
    }
  });
});

describe("AC5: the spawn recipe is spelled out", () => {
  const recipe = section(SKILL, "## How to spawn (Steps 8 and 10)");

  test.each([
    "`Agent` call per reviewer",
    "all calls of a wave in a single message",
    "`subagent_type`",
    "`general-purpose`",
    "pointers, not pasted files",
    "never paraphrase a contract",
    "`STATUS:` line",
    "`REVIEW_RESULT`",
    "`reviewer-finding.schema.json`",
    "`keryx review tier`",
  ])("%s", (phrase) => {
    expect(recipe).toContain(phrase);
  });
});

describe("AC6 / AC9 (skill text): waves split by domain, bounded, and adaptive to rate limits", () => {
  const control = section(SKILL, "## Control");

  test("waves are split by diff domain and capped at the full-round ceiling", () => {
    expect(control).toContain("`core` = logic, security, architecture");
    expect(control).toContain("`domain` = frontend, backend, conventions");
    expect(control).toContain("`support` = style, tests");
    expect(control).toContain(`at most ${MAX_REVIEWERS_PER_WAVE_FULL} reviewers per wave`);
    expect(control).toContain("`MAX_REVIEWERS_PER_WAVE_FULL`");
  });

  test("a rate limit halves the wave, honours retry-after, and ends in BLOCKED rate_limited", () => {
    expect(control).toContain("`STATUS: RATE_LIMITED`");
    expect(control).toContain("halve the wave");
    expect(control).toContain("`retry-after`");
    expect(control).toContain(`at most ${MAX_RATE_HALVINGS === 2 ? "two" : MAX_RATE_HALVINGS} halvings`);
    expect(control).toContain("`MAX_RATE_HALVINGS`");
    expect(control).toContain("`STATUS: BLOCKED rate_limited`");
  });

  test("the quality gate maps every status to an action, RATE_LIMITED included", () => {
    const gate = SKILL.slice(SKILL.indexOf("## Sub-Agent Report Quality Gate"));
    for (const status of ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED", "RATE_LIMITED"]) {
      expect(gate).toContain(`\`${status}\``);
    }
  });
});

describe("AC7: a round that cannot find anything is not run", () => {
  test("the preflight uses the same one-line wording the helper produces", () => {
    const preflight = section(SKILL, "## Preflight — before Step 0, in this order");
    expect(preflight).toContain("`round not needed: <reason>`");
    expect(preflight).toContain("`--all`");
  });

  test("a docs-only fixture ends with no round and no reviewer; a code fixture runs one", () => {
    const docs = classifyRoundNeed({ files: ["README.md", "docs/a.md", "bun.lock"] });
    const code = classifyRoundNeed({ files: ["src/a.ts", "docs/a.md"] });
    expect(docs.needed).toBe(false);
    expect(docs.reason.length).toBeGreaterThan(0);
    expect(code.needed).toBe(true);
  });

  test("--all still forces a round on the docs-only fixture", () => {
    expect(classifyRoundNeed({ files: ["README.md"], all: true }).needed).toBe(true);
  });
});

describe("AC8: read-only by default, --fix hands off, the ceiling is the code constant", () => {
  const control = section(SKILL, "## Control");

  test("the default profile is read-only", () => {
    expect(control).toContain("read-only");
    expect(control).toContain("one round");
    expect(control).toContain("no edits");
  });

  test("--fix hands the findings to flow-orchestrator or task-implementer; the orchestrator never edits", () => {
    expect(control).toContain("`--fix`");
    expect(control).toContain("flow-orchestrator");
    expect(control).toContain("task-implementer");
    expect(control).toContain("never edits code");
    expect(control).toContain("counts toward the ceiling");
  });

  test("the round ceiling in the skill is REVIEW_ROUND_CAP", () => {
    const preflight = section(SKILL, "## Preflight — before Step 0, in this order");
    expect(preflight).toContain(`**Round ceiling.** ${REVIEW_ROUND_CAP} rounds (\`REVIEW_ROUND_CAP\`)`);
    expect(preflight).toContain("`STATUS: BLOCKED round_cap`");
  });
});

describe("AC10: every prompt names what happens unattended", () => {
  test.each([
    ["the full context prompt", "## Review Context Pack", /Unattended: take A/],
    ["the missing producer", "## Review Context Pack", /Unattended, nobody is asked: record\s+`state: unavailable`/],
    ["the missing mutation table", "## Dispatching Reviewers", /Unattended: record\s+`Not run: mutation pass`/],
    ["the start questions", "### Start questions (Step 5)", /Unattended rounds ask nothing/],
    ["publication", "## PR Review Report Publication", /Unattended: do not publish/],
    ["the comment reply", "## Workflow", /unattended: do not publish/],
    ["the round ceiling", "## Preflight — before Step 0, in this order", /unattended, `STATUS: BLOCKED round_cap`/],
  ])("%s", (_name, heading, pattern) => {
    expect(section(SKILL, heading)).toMatch(pattern);
  });

  test("every section that asks the operator names an unattended default", () => {
    const blocks = SKILL.split(/\n(?=#{2,3} )/);
    const asking = blocks.filter((block) => /\bask (the user|the operator|once)\b|pick a letter/i.test(block));
    expect(asking.length).toBeGreaterThan(0);
    const silent = asking.filter((block) => !/nattended/.test(block));
    expect(silent.map((block) => block.split("\n")[0])).toEqual([]);
  });
});

describe("AC11: the skill is internally consistent", () => {
  test("every schema file the skill names resolves in its directory or in the shared contracts", () => {
    const named = new Set([...SKILL.matchAll(/[a-z][a-z-]*\.schema\.json/g)].map((m) => m[0]));
    expect(named.size).toBeGreaterThan(0);
    for (const file of named) {
      const found = existsSync(path.join(ENGINE, file)) || existsSync(path.join(import.meta.dir, "contracts", file));
      expect({ file, found }).toEqual({ file, found: true });
    }
  });

  test("one step numbering: the workflow checklist is the only Step 0/1 definition", () => {
    expect(SKILL).not.toMatch(/^### Step 0: Is this a fix round\?/m);
    expect(SKILL).not.toMatch(/^### Step 1: Determine Review Mode/m);
    expect(SKILL).toMatch(/^### Fix round check \(Step 1a\)/m);
    expect(SKILL).toMatch(/^### Step 2: Determine Review Mode/m);
  });

  test("recipes read the project through keryx, not bare find or grep", () => {
    expect(SKILL).not.toMatch(/^\s*(\$ )?(find|grep) /m);
  });

  test("the model rule is stated once, as the Step 6 computation", () => {
    const strategy = section(SKILL, "## Model Strategy");
    expect(strategy).toContain("Step 6");
    expect(strategy.split("\n").length).toBeLessThanOrEqual(16);
    expect(SKILL).not.toContain("Do NOT assign the tier");
    expect(SKILL).not.toContain("Do not assign a model class");
  });

  test("no shouted emphasis in the instructions", () => {
    const outsideTables = SKILL.split("\n").filter((line) => !line.startsWith("|") && !line.startsWith("```"));
    const shouted = outsideTables.filter((line) => /\b(NEVER|MUST NOT|MANDATORY|CRITICAL|ALWAYS)\b/.test(line));
    expect(shouted).toEqual([]);
  });

  test("the plan bridge is its own item, outside the model step", () => {
    expect(SKILL).toMatch(/^### Step 6a — the plan bridge/m);
  });

  test("Step 10 is conditional on blockers, majors, --verify or a high-risk PR", () => {
    const step10 = SKILL.split("\n").find((line) => line.startsWith("- [ ] Step 10:")) ?? "";
    expect(step10).toContain("when blockers/majors exist, `--verify` is set, or the PR is high-risk");
  });

  test("the skill only shrinks: its line count equals its ceiling, which is no higher than before", () => {
    const ceiling = SKILL_LENGTH_CEILINGS.get("review/review-orchestrator") ?? Number.POSITIVE_INFINITY;
    expect(lineCount(SKILL)).toBe(ceiling);
    expect(ceiling).toBeLessThanOrEqual(1712);
    expect(DETAIL.length).toBeGreaterThan(0);
  });

  test.each([
    ["orchestration/flow-orchestrator", FLOW, 694],
    ["orchestration/job-orchestrator", JOB, 2243],
  ])("%s did not grow", (key, text, before) => {
    const ceiling = SKILL_LENGTH_CEILINGS.get(key) ?? Number.POSITIVE_INFINITY;
    expect(lineCount(text)).toBe(ceiling);
    expect(ceiling).toBeLessThanOrEqual(before);
  });

  test("autodoc-orchestrator did not grow", () => {
    const text = read(SKILLS, "planning", "autodoc-orchestrator", "SKILL.md");
    const ceiling = SKILL_LENGTH_CEILINGS.get("planning/autodoc-orchestrator") ?? Number.POSITIVE_INFINITY;
    expect(lineCount(text)).toBe(ceiling);
    expect(ceiling).toBeLessThanOrEqual(343);
  });
});
