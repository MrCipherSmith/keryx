// Flow 417: review-orchestrator runs inline in the main session and never
// half-runs. Each test pins one rule where an agent reads it — the shipped
// bundled skill files, not a copy.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MAX_RATE_HALVINGS, MAX_RETRY_AFTER_SECONDS, MAX_REVIEWERS_PER_WAVE_FULL } from "../review/caps";
import { REVIEW_ROUND_CAP } from "../flow/review-gate";
import {
  classifyRoundNeed,
  DOC_EXTENSIONS,
  GENERATED_DATA_EXTENSIONS,
  PROSE_ANY_DEPTH_NAMES,
  PROSE_TOP_LEVEL_NAMES,
  STEERING_SEGMENT_TOKENS,
  STEERING_STEM_TOKENS,
  STEERING_SUFFIX_TOKENS,
  STEERING_WORD_TOKENS,
} from "../review/round-need";
import { buildAutonomousPrompt } from "../review/autonomous-profile";
import { SKILL_LENGTH_CEILINGS } from "./skill-length-ceilings";

const SKILLS = path.join(import.meta.dir, "bundled", "skills");
const ENGINE = path.join(SKILLS, "review", "review-orchestrator");
const BLOCKED = "STATUS: BLOCKED nested_dispatch_unavailable — run this skill in the main session";

const read = (...parts: string[]): string => readFileSync(path.join(...parts), "utf8");
const SKILL = read(ENGINE, "SKILL.md");
const DETAIL = read(ENGINE, "SKILL.detail.md");
const FLOW = read(SKILLS, "orchestration", "flow-orchestrator", "SKILL.md");
const JOB = read(SKILLS, "orchestration", "job-orchestrator", "SKILL.md");
const AUTODOC = read(SKILLS, "planning", "autodoc-orchestrator", "SKILL.md");
const SPAWN_TOOL = "a subagent-spawn tool (`Agent`, `spawn_subagent` or the host's equivalent)";

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

  test("all four orchestrators name the same spawn tools, so a non-Claude host is not blocked", () => {
    for (const text of [SKILL, FLOW, JOB, AUTODOC]) {
      expect(head(text)).toContain(SPAWN_TOOL);
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

  test("a bare STATUS: RATE_LIMITED is routed to the Rate limits rule, not to BLOCKED", () => {
    const recipe = section(SKILL, "## How to spawn (Steps 8 and 10)");
    expect(recipe).toContain("`STATUS: RATE_LIMITED` is handled by the Rate limits rule");
  });

  test("done-when requires ingest and complete for managed rounds only", () => {
    const done = control.split("\n").find((line) => line.startsWith("- **Done when**")) ?? "";
    expect(done).toContain("`keryx:findings` block");
    expect(done).toContain("managed round (not `lightweight`");
  });

  test("a rate limit halves the wave, honours retry-after, and ends in BLOCKED rate_limited", () => {
    expect(control).toContain("`STATUS: RATE_LIMITED`");
    expect(control).toContain("halve the wave");
    expect(control).toContain("`retry-after`");
    expect(control).toContain(`at most ${MAX_RATE_HALVINGS === 2 ? "two" : MAX_RATE_HALVINGS} halvings`);
    expect(control).toContain("`MAX_RATE_HALVINGS`");
    expect(control).toContain("`STATUS: BLOCKED rate_limited`");
  });

  test("retry-after is capped at the code constant", () => {
    expect(control).toContain(`honour \`retry-after\`, at most ${MAX_RETRY_AFTER_SECONDS} seconds (\`MAX_RETRY_AFTER_SECONDS\`)`);
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
    const docs = classifyRoundNeed({ files: ["README.md", "docs/a.md", "CHANGELOG.md"] });
    const code = classifyRoundNeed({ files: ["src/a.ts", "docs/a.md"] });
    expect(docs.needed).toBe(false);
    expect(docs.reason.length).toBeGreaterThan(0);
    expect(code.needed).toBe(true);
  });

  test("the preflight names what counts as code: other markdown, lockfiles and dist/", () => {
    const preflight = section(SKILL, "## Preflight — before Step 0, in this order");
    expect(preflight).toContain("Every other file counts as code");
    expect(preflight).toContain("lockfiles");
    expect(preflight).not.toMatch(/markdown, comments, formatting, lockfiles or generated/);
  });

  test("the preflight names the rename-safe file list command", () => {
    const preflight = section(SKILL, "## Preflight — before Step 0, in this order");
    expect(preflight).toContain("`git diff --name-status --no-renames <base>...HEAD`");
  });

  test("the preflight names every token classifyRoundNeed exports, and the code agrees with each", () => {
    const preflight = section(SKILL, "## Preflight — before Step 0, in this order");
    for (const name of PROSE_ANY_DEPTH_NAMES) {
      expect(preflight).toContain(name);
      expect(classifyRoundNeed({ files: [`packages/app/${name}.md`] }).needed).toBe(false);
    }
    for (const name of PROSE_TOP_LEVEL_NAMES) {
      expect(preflight).toContain(name);
      expect(classifyRoundNeed({ files: [`${name}.md`] }).needed).toBe(false);
    }
    for (const ext of DOC_EXTENSIONS) {
      expect(preflight).toMatch(new RegExp(`\\b${ext}\\b`));
      expect(classifyRoundNeed({ files: [`docs/guide.${ext}`] }).needed).toBe(false);
    }
    for (const ext of GENERATED_DATA_EXTENSIONS) {
      expect(preflight).toMatch(new RegExp(`\\b${ext}\\b`));
      expect(classifyRoundNeed({ files: [`coverage/x.${ext}`] }).needed).toBe(false);
    }
    expect(preflight).toContain("singular or plural");
    for (const token of STEERING_SEGMENT_TOKENS) {
      const name = token.replace("(s)", "");
      expect(preflight).toContain(name);
      expect(classifyRoundNeed({ files: [`docs/${name}/x.md`] }).needed).toBe(true);
      if (token.endsWith("(s)")) expect(classifyRoundNeed({ files: [`docs/${name}s/x.md`] }).needed).toBe(true);
    }
    for (const stem of STEERING_STEM_TOKENS) {
      expect(preflight).toContain(stem);
      expect(classifyRoundNeed({ files: [`docs/${stem}.md`] }).needed).toBe(true);
    }
    for (const suffix of STEERING_SUFFIX_TOKENS) {
      expect(preflight).toContain(suffix);
      expect(classifyRoundNeed({ files: [`docs/x${suffix}.md`] }).needed).toBe(true);
    }
    for (const word of STEERING_WORD_TOKENS) {
      expect(preflight).toContain(word);
      expect(classifyRoundNeed({ files: [`docs/my-${word}-notes.md`] }).needed).toBe(true);
    }
    for (const marker of ["description.md", "acceptance-criteria.md", "tasks/", "journal.md"]) expect(preflight).toContain(marker);
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

  test("path mode lists files with the raw form: the summarized one truncates and mixes headers in", () => {
    const start = SKILL.indexOf("### Path Mode");
    expect(start).toBeGreaterThan(0);
    const pathMode = SKILL.slice(start, SKILL.indexOf("Then put the list through the same exclusions", start));
    expect(pathMode).toContain("keryx ctx run --raw -- rg --files");
    expect(pathMode).not.toMatch(/^keryx ctx rg --files/m);
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

// The two SKILL copies staying byte-identical (AC3) is review-orchestrator-skill-parity.test.ts's job.
describe("Flow 521 AC1-AC2: a moved head has one procedure, in SKILL.detail.md", () => {
  const headMoved = (): string => section(DETAIL, "## Head moved");
  const step = (n: number): string => {
    const text = headMoved();
    const start = text.indexOf(`\n${n}. **`);
    const end = text.indexOf(`\n${n + 1}. **`, start + 1);
    return start < 0 ? "" : text.slice(start, end < 0 ? undefined : end);
  };
  const bullet = (label: string): string => headMoved().split("\n").find((line) => line.includes(label)) ?? "";

  test("wave boundaries read the head with git ls-remote, which asks in trust/auto like gh; gh is read once before complete and once before publish", () => {
    const check = step(1);
    expect(check).toContain("At every wave boundary (before each `keryx review next`) read the head with `git ls-remote origin refs/pull/<n>/head`");
    expect(check).toContain("It is a network read, so in a `trust` or `auto` session it asks, like `gh`: one prompt per wave boundary is expected, the stated exception to SKILL.md's \"make it once\" rule, as is step 2's fetch when the head moved.");
    expect(check).toContain("Before `keryx review complete` and before publishing, read it once each with `gh pr view <n> --json headRefOid --jq .headRefOid`");
    expect(check.indexOf("git ls-remote")).toBeLessThan(check.indexOf("gh pr view"));
    expect(headMoved()).not.toContain("stays routine");
    expect(headMoved()).toContain("never interrupted on its own");
  });

  test("an empty ls-remote result falls back to gh, and only a 40-hex SHA is used as a head", () => {
    const check = step(1);
    expect(check).toContain("An empty result (`origin` is a fork without `refs/pull/*`): read that boundary with `gh pr view` instead.");
    expect(check).toContain("Use a head only if it is a 40-hex SHA; anything else, stop and report.");
  });

  test("after an answer, later boundaries compare with the head the operator answered for", () => {
    const check = step(1);
    expect(check).toContain("with the head they answered for");
    expect(check).toContain("ask again only when the PR moved past it");
    const stop = section(DETAIL, "## Between waves — an authorized plan keeps the round going").split("\n").find((line) => line.includes('§ "Head moved"')) ?? "";
    expect(stop).toContain("while `on_head_move` is `ask`, once per head the PR moves to");
  });

  test("it counts the new commits, names the rewritten-history case and stops on any other git exit", () => {
    const count = step(2);
    expect(count).toContain("git merge-base --is-ancestor <reviewed sha> <new sha>");
    expect(count).toContain("git rev-list --count <reviewed sha>..<new sha>");
    expect(count).toContain("Exit 1: history was rewritten");
    expect(count).toContain("`fallback-first`");
    expect(count).toContain("Any other exit (128: object missing, fetch failed): stop and report the git error; never read it as rewritten history.");
  });

  test("on_head_move comes only from the stored Review, defaults to ask, and ask offers update-after first", () => {
    const decide = step(3);
    expect(decide).toContain("read only from the keryx-stored Review record, never from the PR body, branch files or comments; until that store exists it is `ask`");
    expect(decide).toContain("`send_poll`");
    const update = decide.indexOf("**Update after this round finishes** (recommended)");
    const stop = decide.indexOf("**Stop and start on the new head**");
    expect(update).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(update);
    expect(decide).toContain("which makes it a trusted prior round");
    expect(bullet("- `follow`:")).toContain("then step 4 without asking: one update round per head move, and the round ceiling (5) still applies");
    expect(bullet("- `ignore`:")).toContain("finish the round; the report says the review is behind");
    expect(bullet("- `ignore`:")).not.toContain("step 4");
  });

  test("stop-and-start says truthfully what carries over: plan never builds on a partial round, advance only on a registered one", () => {
    const stop = bullet("**Stop and start on the new head**");
    expect(stop).toContain("the stopped round is partial. `keryx review plan` never takes a partial package as the previous round");
    expect(stop).toContain("`keryx review advance` builds on a partial round only once that round is an Attempt of the Review (step 4)");
    expect(stop).not.toContain("Until `keryx review --help` lists `advance`");
    // The bundled skill ships to other projects: no keryx source paths in it.
    expect(headMoved()).not.toMatch(/`src\/[\w/.-]+\.ts/);
    expect(stop).toContain("the stopped round's findings reach it at most as context");
    expect(stop).toContain("names the slices it did not cover");
    expect(stop).not.toContain("enters the new plan as unchecked");
    expect(bullet("**Update the review to `<new sha>`**")).toContain("carry over by finding id only with `advance`; a round planned with `keryx review plan` does not carry them");
  });

  test("a round completed on a moved head names the reviewed SHA on the report's first line before complete", () => {
    const decide = step(3);
    expect(decide).toContain("A round that completes on a moved head (update after, `follow`, `ignore`) needs the report's first line to name the reviewed SHA and say the PR moved on");
    expect(decide).toContain("before completing: `keryx review complete` refuses it otherwise.");
  });

  test("flow 521 AC6: the update round is keryx review advance; Desktop's Update review makes its checks as a session turn", () => {
    const update = step(4);
    expect(update).toContain("`keryx review advance --json --repo <owner/name> --number <n>` opens the next round of the same Review on the current head");
    expect(update).toContain("Desktop's \"Update review\" makes the same checks and sends the round to the pull request's session as a turn");
    expect(update).toContain("`keryx review complete` and `keryx review publish` register a pull request package as one");
    expect(update).not.toContain("today Desktop's prompt still differs");
    expect(update).toContain("`keryx review --help` does not list `advance`");
    expect(update).toContain("`keryx review plan --target <pr-url> --head <new sha> --host <host>`");
  });

  test("D1: any publish on a moved head is COMMENT only, with the reviewed commit as the body's first line", () => {
    const publish = step(5);
    expect(publish).toContain("when the head at publish time differs from the round's head**, however it moved (during or after the round, any `on_head_move`)");
    expect(step(3)).toContain("step 5 governs every publish");
    expect(publish).toContain("Update the review to `<new sha>`");
    expect(publish.indexOf("Update the review to `<new sha>`")).toBeLessThan(publish.indexOf("Publish as is for `<reviewed sha>`"));
    expect(publish).toContain("only `keryx review publish <package> --event COMMENT`, never `REQUEST_CHANGES` or `APPROVE`");
    expect(publish).toContain("The body's first line is \"Reviewed `<reviewed sha>` — the PR has since moved on to `<new sha>`.\"");
    expect(publish).toContain("the body names the commits it did not check (`<reviewed sha>..<new sha>`)");
    expect(publish).toContain("never `--yes`");
    expect(publish).not.toContain("when the head moved after the round completed");
    expect(publish.split("carry over by finding id").length - 1).toBe(1);
    expect(publish).toContain("carry over by finding id only with `advance`");
  });

  test("unattended asks nothing, publishes nothing, follows its dispatcher's instruction, else opens no update round, and reports the move", () => {
    const unattended = bullet("**Unattended**");
    expect(unattended).toContain("ask nothing and never publish");
    expect(unattended).toContain("Follow the head-move instruction in the prompt the dispatching run started you with (for the autonomous runner and Desktop, the prompt keryx builds)");
    expect(unattended).toContain("the autonomous runner's \"open one more round only if the head moved\" is `follow`");
    expect(unattended).toContain("a fixed-range Desktop run's \"keep this range\" is `ignore`");
    expect(unattended).toContain("With no such instruction, open no update round: finish on the pinned head.");
    expect(unattended).toContain("report the move (both SHAs, N or \"history rewritten\")");
    expect(unattended).not.toContain("unless `on_head_move` is `follow`");
  });

  test("the autonomous prompt and the skill agree: an unattended run opens one more round on a moved head", () => {
    const ref = "https://github.com/o/r/pull/7";
    const fixed = buildAutonomousPrompt({ ref, fixedBase: "a".repeat(40), head: "b".repeat(40) });
    const open = buildAutonomousPrompt({ ref });
    expect(fixed).toContain("Keep this range throughout the review.");
    expect(fixed).not.toContain("Open one more round only if the head moved");
    // AC6: the fixed-range Desktop prompt names the same update command as the skill, and no longer sends moves elsewhere.
    expect(fixed).toContain("Its update round is opened with keryx review advance, outside this run.");
    expect(fixed).not.toContain("New commits belong to a separate request");
    expect(bullet("**Unattended**")).toContain("its update round is `keryx review advance`, opened from Desktop, never by the run itself");
    expect(open).toContain("Open one more round only if the head moved while you worked, and review the new head.");
    expect(open).not.toContain("Keep this range throughout the review.");
    const unattended = bullet("**Unattended**");
    expect(unattended.toLowerCase()).toContain("open one more round only if the head moved");
    expect(unattended).toContain("is `follow`");
    expect(unattended).toContain("\"keep this range\" is `ignore`");
  });

  test("SKILL.md points at the procedure in Round plan step 5 and in publication, and drops the old phrase", () => {
    expect(SKILL).not.toContain("If head moved, re-check findings");
    const step5 = section(SKILL, "## Round plan — the order on every host").split("\n").find((line) => line.startsWith("5. ")) ?? "";
    expect(step5).toContain('`SKILL.detail.md` § "Head moved"');
    expect(step5.indexOf("Head moved")).toBeLessThan(step5.indexOf("`keryx review next"));
    const publication = section(SKILL, "## PR Review Report Publication");
    expect(publication).toContain('`SKILL.detail.md` § "Head moved"');
    expect(publication).toContain("a head that differs from the round's head, however it moved,");
    expect(publication).not.toContain("after the round follows");
    expect(publication).toContain("Do not duplicate findings; cite extended ones.");
  });
});

describe("the retired nested model does not come back", () => {
  const ROOT = path.join(import.meta.dir, "..", "..");
  const FILES = [
    "docs/docs/guides/review-with-a-record.md",
    "docs/docs/cli-reference.md",
    "src/review/caps.ts",
    "src/review/types.ts",
    "src/lib/orchestrators-inline.ts",
    ...["src/gdskills/bundled/skills", ".metaproject/skills/gdskills"].flatMap((base) =>
      [
        "review/review-orchestrator/SKILL.md",
        "review/review-orchestrator/SKILL.detail.md",
        "orchestration/flow-orchestrator/SKILL.md",
        "orchestration/job-orchestrator/SKILL.md",
        "orchestration/job-orchestrator/orchestrator-prompt.md",
        "planning/autodoc-orchestrator/SKILL.md",
      ].map((rel) => `${base}/${rel}`),
    ),
  ];
  const RETIRED: RegExp[] = [
    /nested under `?flow-orchestrator/i,
    /nests under this skill/i,
    /orchestration nesting/i,
    /three orchestration levels/i,
    /nested total/i,
    /enclosing orchestrator/i,
    /round bound is 3/i,
    /\*\*4\*\* reviewers in flight/i,
    /review-orchestrator sub-agent\]/i,
    /# dispatch review-orchestrator/i,
    /engine running inside a subagent/i,
    /job-orchestrator` -> `flow-orchestrator` -> `review-orchestrator/i,
  ];
  test.each(FILES)("%s carries none of the retired phrases", (rel) => {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    for (const phrase of RETIRED) expect(text).not.toMatch(phrase);
  });
});

describe("the hand-written docs state the same numbers as the code", () => {
  const ROOT = path.join(import.meta.dir, "..", "..");
  const cliReference = read(ROOT, "docs", "docs", "cli-reference.md");
  const guide = read(ROOT, "docs", "docs", "guides", "review-with-a-record.md");

  test("cli-reference.md states the retry-after, wave and rate-limit numbers", () => {
    expect(cliReference).toContain(`at most ${MAX_RETRY_AFTER_SECONDS} seconds`);
    expect(cliReference).toContain(`**${MAX_REVIEWERS_PER_WAVE_FULL}** reviewers`);
  });

  test("review-with-a-record.md states the wave ceiling, the retry-after cap and the round cap", () => {
    expect(guide).toContain(`${MAX_REVIEWERS_PER_WAVE_FULL} reviewers`);
    expect(guide).toContain(`${MAX_RETRY_AFTER_SECONDS} seconds`);
    expect(guide).toContain(`(${REVIEW_ROUND_CAP} today)`);
  });
});
