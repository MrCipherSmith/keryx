import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REVIEW_DEGRADATION_CLASSES, REVIEW_EVIDENCE_KINDS } from "../review/types";
import { SKILL_LENGTH_CEILINGS } from "./skill-length-ceilings";

const ROOT = path.resolve(import.meta.dir, "../..");
const PROJECT_COPY = path.join(ROOT, ".metaproject/skills/gdskills/review/review-degradation/SKILL.md");
const BUNDLED_COPY = path.join(ROOT, "src/gdskills/bundled/skills/review/review-degradation/SKILL.md");

const skill = readFileSync(PROJECT_COPY, "utf8");

/** The text above the first `##` heading after the title: what a reader sees without scrolling. */
function firstScreen(text: string): string {
  const body = text.slice(text.indexOf("# Review: Degradation"));
  const next = body.indexOf("\n## ");
  return next === -1 ? body : body.slice(0, next);
}

describe("flow 479 AC1/AC2: the review-degradation skill", () => {
  test("frontmatter names the skill and puts it in the deep tier", () => {
    expect(skill).toMatch(/^---\nname: review-degradation\n/);
    expect(skill).toMatch(/\nmodel_tier: deep\n/);
  });

  test("the two copies are byte-identical", () => {
    expect(readFileSync(BUNDLED_COPY, "utf8")).toBe(skill);
  });

  test("the orchestrator hands the reviewer the --degradation payload before dispatch", () => {
    const orchestrator = readFileSync(path.join(ROOT, ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md"), "utf8");
    expect(orchestrator).toMatch(/review blast-radius [^\n]*--degradation[^\n]*\n?[^\n]*hand its stdout to the reviewer verbatim/);
  });

  test("the first screen says how it differs from review-regression", () => {
    const screen = firstScreen(skill);
    expect(screen).toContain("review-regression");
    expect(screen).toMatch(/dependents of the change only/);
    expect(screen).toMatch(/`major`/);
    expect(screen).toMatch(/never chosen by you/);
    expect(screen).toMatch(/no\w* floor|none:/);
  });

  test("it asks the one question", () => {
    expect(skill).toContain(
      "After this change, is the code worse than on the base branch: in behaviour, in defaults, in speed or in structure, and can that be shown?",
    );
  });

  test("it names exactly the seven classes of the schema", () => {
    expect([...REVIEW_DEGRADATION_CLASSES]).toEqual([
      "behaviour-delta",
      "default-change",
      "diff-vs-description",
      "debt",
      "performance",
      "cross-pr",
      "blind-test",
    ]);
    for (const name of REVIEW_DEGRADATION_CLASSES) expect(skill).toContain(`\`${name}\``);
    // The class table lists no class the schema does not know.
    const table = skill.slice(skill.indexOf("## Classes"), skill.indexOf("## Evidence"));
    const named = [...table.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]);
    expect(named).toEqual([...REVIEW_DEGRADATION_CLASSES]);
  });

  test("it names exactly the five evidence kinds of the schema", () => {
    expect([...REVIEW_EVIDENCE_KINDS]).toEqual(["probe", "consumer-trace", "merge-trace", "red-test", "base-diff"]);
    const table = skill.slice(skill.indexOf("## Evidence"), skill.indexOf("## What you are given"));
    const named = [...table.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]);
    expect(named).toEqual([...REVIEW_EVIDENCE_KINDS]);
  });

  test("it has the four output lanes and the ingest downgrade rule", () => {
    for (const lane of ["**Findings**", "**Questions**", "**Pre-existing**", "**Verified clean**"]) expect(skill).toContain(lane);
    expect(skill).toContain("degradation-no-evidence");
    expect(skill).toMatch(/lowers a `major` or\s+`blocker`/);
    expect(skill).toContain("## Degradation evidence screen");
  });

  test("it names all four severities and sets no minor floor", () => {
    expect(skill).toMatch(/`blocker`, `major`, `minor`, `info`/);
  });

  test("the consumer set is the graph's first; search-found users are added and labelled", () => {
    expect(skill).toContain("keryx gdgraph affected");
    expect(skill).toMatch(/Trace those first/);
    expect(skill).toContain("`search-derived`");
    expect(skill).toMatch(/cap/);
  });

  test("reading is evidence: a traced trigger and outcome is a finding, major when a user gets a wrong result", () => {
    expect(skill).toMatch(/`consumer-trace` and `base-diff` are still evidence/);
    expect(skill).toMatch(/`major` when a user who reaches it\s+gets a wrong, lost or blocked result/);
    expect(skill).toMatch(/I could not run it, so it is a question or a `minor`/);
  });

  test("it is generic: no project-specific rule name, path, PR number or reviewer name", () => {
    for (const forbidden of ["vantage", "presight", "b091", "mobx-stores", ".claude/rules"]) {
      expect(skill.toLowerCase()).not.toContain(forbidden);
    }
    expect(skill).not.toMatch(/#\d{3,}/);
  });

  test("it sits under its length ceiling and is registered in profile full only", () => {
    const ceiling = SKILL_LENGTH_CEILINGS.get("review/review-degradation");
    expect(ceiling).toBeDefined();
    expect(skill.trimEnd().split("\n").length).toBeLessThanOrEqual(ceiling as number);

    const catalog = readFileSync(path.join(ROOT, "src/gdskills/catalog.ts"), "utf8");
    expect(catalog).toMatch(/skill\("review-degradation", "review", \["full"\],/);
  });
});
