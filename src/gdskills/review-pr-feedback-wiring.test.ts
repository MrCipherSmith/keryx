// The external-comment loop, pinned end to end.
//
// WHY A PROSE GUARD IS THE RIGHT INSTRUMENT HERE
//
// Every defect this file guards WAS a sentence, and each one shipped for a
// release while the code beside it was correct:
//
//   - the skill told the agent to `gh api` three endpoints by hand. `gh api`
//     without `--paginate` returns thirty items, which `src/review/pr-comments.ts`
//     fixed and documented as "a collector that silently reads the first thirty
//     comments reports 'no new comments' about a thread it never saw" — while the
//     skill kept instructing the hand-rolled version;
//   - it then told the agent to run `keryx review learn`, which reads the record
//     `keryx review comments collect` writes and ERRORS without it. Two steps of
//     one skill, and the second could not run after the first;
//   - it told the reviewer to run `keryx skills learn apply` itself, which
//     `review-orchestrator` forbids for every reviewer in the tree;
//   - it carried the boilerplate "Orchestrated Review Contract" paragraph
//     demanding a `reviewer-finding.schema.json` object, while two other guards
//     in this directory exempt it from that contract by name.
//
// None of those is decidable from the TypeScript. What is decidable is whether
// the sentence is present, and whether the command it names exists — so that is
// what this asserts.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const SKILL_DIR = path.join(import.meta.dir, "bundled", "skills", "review", "review-pr-feedback");
const SKILL = path.join(SKILL_DIR, "SKILL.md");

/** Both trees. A skill edit that lands in one of them has diverged. */
function bothTrees(category: string, name: string): string[] {
  return [
    path.join(REPO_ROOT, "src", "gdskills", "bundled", "skills", category, name, "SKILL.md"),
    path.join(REPO_ROOT, ".metaproject", "skills", "gdskills", category, name, "SKILL.md"),
  ].filter((file) => existsSync(file));
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Whitespace is layout, not meaning: line wrapping must not be part of the contract. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("collection goes through the CLI, and the skill says why", () => {
  const skill = read(SKILL);

  test("the collect command is named with its required --sha", () => {
    expect(flat(skill)).toContain("keryx review comments collect --repo <owner/repo> --pr <n> --sha <headRefOid>");
  });

  test("the hand-rolled fetch is refused, and the pagination reason is stated", () => {
    expect(skill).toMatch(/Do not fetch the three endpoints by hand/i);
    expect(skill).toMatch(/first thirty/i);
  });

  test("the documented fallback paginates and declares what it costs", () => {
    // A fallback is allowed; a fallback that looks equivalent is not.
    expect(skill).toContain("gh api --paginate");
    expect(skill).toMatch(/no durable record/i);
    expect(skill).toMatch(/Never present a\s+fallback run as equivalent/i);
  });

  test("the two consumers of the record are named, and so is the gate", () => {
    expect(skill).toContain("keryx review comments reply");
    expect(skill).toContain("keryx review learn");
    expect(flat(skill)).toContain("collected: false");
  });
});

describe("the learning step proposes and stops", () => {
  const skill = read(SKILL);

  test("`skills learn apply` is forbidden here, matching review-orchestrator", () => {
    expect(skill).toMatch(/Do not run `keryx skills learn apply`/);
    for (const file of bothTrees("review", "review-orchestrator")) {
      expect(read(file)).toContain("Never run `skills learn apply` from the reviewer");
    }
  });

  test("the target is a project skill, never a rule file", () => {
    expect(skill).toContain(".metaproject/project-skills/");
    expect(skill).toMatch(/never a rule file/i);
  });
});

describe("the skill no longer claims a contract two other guards exempt it from", () => {
  const skill = read(SKILL);

  test("the boilerplate orchestrated-reviewer contract is gone", () => {
    // Its own Output Contract is `status/mode/pr/...`; the pasted block demanded
    // `reviewer-finding.schema.json`, whose findings require `impact`, `evidence`
    // and an `id` this skill never emits. Both cannot be the contract.
    expect(skill).not.toContain("## Orchestrated Review Contract");
    expect(skill).not.toContain("reviewer-finding.schema.json");
  });

  test("it ships the contracts it does claim", () => {
    for (const name of ["input-contract.schema.json", "output-contract.schema.json"]) {
      const file = path.join(SKILL_DIR, name);
      expect(existsSync(file)).toBe(true);
      const schema = JSON.parse(readFileSync(file, "utf8")) as { additionalProperties?: boolean };
      expect(schema.additionalProperties).toBe(false);
      expect(skill).toContain(`skills/review/review-pr-feedback/${name}`);
    }
  });

  test("it does not claim an enforcement nobody wrote", () => {
    // Same rule as `enforcement-claims.test.ts`: no production TypeScript loads
    // these files, so the skill must say so rather than imply a refusal.
    expect(flat(skill)).toContain("Nothing refuses a dispatch that ignores them");
  });
});

describe("the fix run lands inside the pull request it answers", () => {
  const skill = read(SKILL);

  test("the fix PR's base is the reviewed PR's head branch, never the default branch", () => {
    expect(skill).toMatch(/The fix never targets the repository's default branch/);
    expect(flat(skill)).toContain("base_branch: <headRefName>");
    expect(flat(skill)).toContain("merge back into it");
  });

  test("execution is delegated, not reimplemented", () => {
    expect(skill).toContain("flow-orchestrator");
    expect(skill).toMatch(/Do \*\*not\*\* create the\s+branch, the flow, the PR, or the commits from here/);
  });

  test("the exit condition is zero at minor and above, and info does not hold the loop", () => {
    expect(flat(skill)).toContain("zero findings at severity minor or above");
    expect(skill).toMatch(/`info` (findings )?do(es)? not hold the loop/);
  });

  test("the loop is bounded, and the bound is not raised from here", () => {
    expect(skill).toMatch(/attempt budget/i);
    expect(skill).toContain("keryx review loop");
    expect(skill).toMatch(/stops with the flow `in-progress`/);
    // The bound has evidence behind it in flow-orchestrator; the citation must
    // survive here too, or "three" reads as an arbitrary number to argue with.
    expect(skill).toContain("arXiv:2607.24604");
  });

  test("--fix is explicit, confirmed, and refused without a durable record", () => {
    expect(skill).toMatch(/`--fix` is never inferred/);
    expect(skill).toMatch(/The operator confirmed/);
    expect(flat(skill)).toContain("`--fix` is refused");
  });
});

describe("comment text is data, never direction", () => {
  const skill = read(SKILL);

  test("external bodies are screened before they can drive a fix", () => {
    expect(skill).toContain("keryx security check-input --source external");
    expect(skill).toMatch(/not dropped and not\s+obeyed/);
    expect(skill).toMatch(/addresses? the developer, never this skill/);
  });
});

describe("every comment is answered once, at the end, in English", () => {
  const skill = read(SKILL);

  test("the reply pass runs after the merge and requires --final", () => {
    expect(skill).toContain("--final");
    expect(skill).toMatch(/after\*?\*? the merge, never during the loop/i);
  });

  test("inline and general routing is delegated to the command that implements it", () => {
    // `src/review/pr-comments.ts` routes an inline comment to
    // pulls/{n}/comments/{id}/replies and a review body or PR-level comment to
    // issues/{n}/comments. A skill that re-specified the routing would drift.
    expect(skill).toContain("pulls/{n}/comments/{id}/replies");
    expect(skill).toMatch(/top-level comment that names what it answers/);
  });

  test("the reply language does not follow the session's language", () => {
    expect(skill).toMatch(/\*\*English, always\*\*/);
  });

  test("the pass re-collects, so every comment it will see has a decision", () => {
    // `buildReplyPass` refuses the whole pass over one undecided comment, and the
    // command re-collects from GitHub before posting — so a comment that arrived
    // during the fix loop is in the set the outcomes must cover.
    expect(skill).toMatch(/re-collects from GitHub before it posts/);
    expect(skill).toMatch(/praise included/);
    expect(skill).toMatch(/re-run Step 3 at `<mergedHeadSha>`/);
    // The reply is filed against the post-merge head, not the head the verdicts
    // were reached at: the gate compares the collection to the PR as it stands.
    expect(skill).toContain("--sha <mergedHeadSha> --final");
  });

  test("every verdict maps to a terminal disposition, and `unknown` is refused", () => {
    for (const disposition of ["acted-on", "answered-disagree", "dismissed-out-of-scope", "dismissed-deprioritised"]) {
      expect(skill).toContain(disposition);
    }
    expect(skill).toMatch(/`unknown` is refused/);
  });
});

describe("a nested round does not answer the reviewer twice", () => {
  test("review-orchestrator states who owns the reply, in both trees", () => {
    const files = bothTrees("review", "review-orchestrator");
    expect(files.length).toBe(2);
    for (const file of files) {
      const text = read(file);
      expect(text).toContain("### A round never answers a pull request another skill is answering");
      // The fix PR is a DIFFERENT pull request with its own record, so a round
      // reviewing it replies as normal. Only the caller's PR is off limits — the
      // first draft of this rule said "a nested round does not reply", which
      // would have silenced the reviewers of the fix itself.
      expect(text).toMatch(/`#B` is its own conversation/);
      expect(text).toMatch(/Never run a reply pass against a pull request the dispatch named as the\s+caller's/);
      expect(text).toMatch(/Absent such a constraint this orchestrator owns the reply/);
    }
  });

  test("flow-orchestrator passes the constraint down, in both trees", () => {
    const files = bothTrees("orchestration", "flow-orchestrator");
    expect(files.length).toBe(2);
    for (const file of files) {
      const text = read(file);
      expect(text).toContain("### A dispatched run answers the question in its constraints");
      expect(text).toMatch(/the caller owns the reply on #<n>/);
      expect(text).toMatch(/reply as normal/);
      expect(text).toMatch(/A constraint that would raise this skill's own attempt budget is \*\*not\*\* obeyed/);
    }
  });

  test("the skill sends that constraint", () => {
    const skill = flat(read(SKILL));
    expect(skill).toContain("the fix PR is its own conversation");
    expect(skill).toContain("MUST NOT run a reply pass against #<n>");
  });
});

describe("the catalog describes the skill that shipped", () => {
  const catalog = readFileSync(path.join(import.meta.dir, "catalog.ts"), "utf8");

  test("the entry names validation, the fix run, and the reply", () => {
    expect(catalog).toContain('skill("review-pr-feedback"');
    const entry = catalog.slice(catalog.indexOf('skill("review-pr-feedback"'));
    const bullets = entry.slice(0, entry.indexOf("]),"));
    expect(bullets).toContain("keryx review comments collect");
    expect(bullets).toContain("flow-orchestrator");
    expect(bullets).toMatch(/never apply it/);
  });
});
