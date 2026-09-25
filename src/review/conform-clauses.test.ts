// Flow 308, AC1/AC2/AC10: deterministic clause extraction (no model call) and
// tagging (explicit markers, Jev `choice` fallback, cache merge), over the
// INVENTED fixture document (AC10 — no real reference document's wording).

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  applyClauseTags,
  buildClauseTagQuestions,
  clauseTagFromChoice,
  extractReferenceClauses,
  isWorkflowListStep,
  preClassifyProcessClause,
  type RawReferenceClause,
} from "./conform-clauses";

const FIXTURE = path.join(import.meta.dir, "fixtures", "conform", "invented-doctrine.md");

async function fixtureText(): Promise<string> {
  return readFile(FIXTURE, "utf8");
}

describe("AC1: extractReferenceClauses — deterministic, no model call", () => {
  test("pins the stable ids of the invented fixture document", async () => {
    const clauses = extractReferenceClauses(await fixtureText());
    expect(clauses.map((c) => c.clause_id)).toEqual([
      "before-you-open-a-change-1",
      "before-you-open-a-change-2",
      "change-size-1",
      "change-size-2",
      "review-pass-1",
      "review-pass-2",
      "review-pass-3",
      "code-and-test-hunks-1",
      "code-and-test-hunks-2",
      "sign-off-1",
    ]);
  });

  test("carries clause text with the explicit marker stripped", async () => {
    const clauses = extractReferenceClauses(await fixtureText());
    const changeSize1 = clauses.find((c) => c.clause_id === "change-size-1");
    expect(changeSize1?.text).toBe("A contribution changes no more than 900 lines in total, tests included.");
    expect(changeSize1?.explicit).toEqual({ state_kind: "pr" });
  });

  test("carries the full heading path, not just the nearest heading", async () => {
    const clauses = extractReferenceClauses(await fixtureText());
    const first = clauses.find((c) => c.clause_id === "before-you-open-a-change-1");
    expect(first?.heading_path).toEqual(["Data Pipeline Contribution Policy (fixture)", "Before you open a change"]);
  });

  test("re-extracting the same content reproduces byte-identical ids (idempotent, no model call)", async () => {
    const text = await fixtureText();
    expect(extractReferenceClauses(text)).toEqual(extractReferenceClauses(text));
  });

  test("a not-checkable explicit marker is parsed with its reason", async () => {
    const clauses = extractReferenceClauses(await fixtureText());
    const signOff = clauses.find((c) => c.clause_id === "sign-off-1");
    expect(signOff?.explicit).toEqual({
      not_checkable_reason: "a judgment call the reviewer makes personally, not read back from any artefact",
    });
  });

  test("prose between headings and lists is never turned into a clause", () => {
    const doc = ["# Heading", "", "Some prose that is not a list item.", "", "- A real clause. [state:pr]"].join("\n");
    const clauses = extractReferenceClauses(doc);
    expect(clauses).toHaveLength(1);
    expect(clauses[0]?.text).toBe("A real clause.");
  });

  test("an indented continuation line is folded into the same clause", () => {
    const doc = ["# Heading", "", "- A clause that", "  wraps onto a second line. [state:hunk]"].join("\n");
    const clauses = extractReferenceClauses(doc);
    expect(clauses).toHaveLength(1);
    expect(clauses[0]?.text).toBe("A clause that wraps onto a second line.");
  });
});

describe("AC2: tagging — explicit markers win outright, Jev choice is the fallback", () => {
  test("explicit state_kind markers never generate a Jev question", async () => {
    const clauses = extractReferenceClauses(await fixtureText());
    const questions = buildClauseTagQuestions(clauses);
    expect(Object.keys(questions)).toEqual([]);
  });

  test("a clause with no explicit marker gets exactly one choice question", () => {
    const raw = extractReferenceClauses("# H\n\n- No marker at all here.");
    const questions = buildClauseTagQuestions(raw);
    expect(Object.keys(questions)).toEqual(["h-1"]);
    expect(questions["h-1"]?.type).toBe("choice");
    expect(questions["h-1"]?.criteria).toEqual({ pr: "pr", report: "report", hunk: "hunk", "not-checkable": "not-checkable" });
  });

  test("clauseTagFromChoice maps every criterion to a tag", () => {
    expect(clauseTagFromChoice("pr")).toEqual({ state_kind: "pr", checkable: true });
    expect(clauseTagFromChoice("report")).toEqual({ state_kind: "report", checkable: true });
    expect(clauseTagFromChoice("hunk")).toEqual({ state_kind: "hunk", checkable: true });
    const notCheckable = clauseTagFromChoice("not-checkable");
    expect(notCheckable.state_kind).toBe("pr");
    expect(notCheckable.checkable).toBe(false);
    expect(notCheckable.reason).toBeDefined();
  });

  test("applyClauseTags: explicit beats resolved, resolved beats untagged fallback", () => {
    const raw = extractReferenceClauses(
      ["# H", "", "- Has a marker. [state:report]", "- Has no marker at all."].join("\n"),
    );
    const resolved = new Map([["h-2", { source: "jev" as const, tag: clauseTagFromChoice("hunk") }]]);
    const tagged = applyClauseTags(raw, resolved);
    expect(tagged[0]).toMatchObject({ clause_id: "h-1", state_kind: "report", checkable: true, tag_source: "explicit" });
    expect(tagged[1]).toMatchObject({ clause_id: "h-2", state_kind: "hunk", checkable: true, tag_source: "jev" });
  });

  test("a clause with neither a marker nor a resolved answer fails closed to not-checkable", () => {
    const raw = extractReferenceClauses("# H\n\n- No marker, no answer supplied.");
    const tagged = applyClauseTags(raw, new Map());
    expect(tagged[0]?.checkable).toBe(false);
    expect(tagged[0]?.reason).toBeDefined();
  });

  test("a secret planted in a clause's text never reaches buildClauseTagQuestions' instructions", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const raw = extractReferenceClauses(`# H\n\n- Rotate AWS_ACCESS_KEY_ID=${secret} every 90 days.`);
    const questions = buildClauseTagQuestions(raw);
    const instructions = questions["h-1"]!.instructions;
    expect(instructions).not.toContain(secret);
    expect(instructions).toContain("[REDACTED:");
    expect(instructions).toContain("Rotate AWS_ACCESS_KEY_ID");
  });

  test("the choice question distinguishes a code-hunk property from a human action", () => {
    const raw = extractReferenceClauses("# H\n\n- Every widget needs a docstring.");
    const questions = buildClauseTagQuestions(raw);
    const instructions = questions["h-1"]!.instructions;
    expect(instructions).toContain("a property you can see in a code hunk");
    expect(instructions).toContain("an action someone performs");
  });
});

describe("Precision fix (flow 337): deterministic process/not-checkable pre-classifier", () => {
  const codeContext = { ordered: false, fenced: false, headingPath: [] as string[] };

  test("PR #712's own false positive — 'Review the contract for breaking changes' — is pre-classified process, tagged via its own verb (not swept for being fenced)", () => {
    const doc = [
      "# API Contracts",
      "",
      "## Core Principle: Contract Before Code",
      "",
      "```",
      "1. Design the endpoint in OpenAPI/schema first",
      "2. Review the contract for breaking changes",
      "3. Generate or update types/validators from the spec",
      "4. Implement the handler",
      "5. Write contract tests that validate the spec is honoured",
      "```",
    ].join("\n");
    const clauses = extractReferenceClauses(doc);
    const reviewClause = clauses.find((c) => c.text === "Review the contract for breaking changes");
    expect(reviewClause?.explicit).toMatchObject({ not_checkable_reason: expect.stringContaining("Pre-classified process") });
    const designClause = clauses.find((c) => c.text === "Design the endpoint in OpenAPI/schema first");
    expect(designClause?.explicit).toMatchObject({ not_checkable_reason: expect.stringContaining("Pre-classified process") });

    // Flow 337, item 2: steps 3-5 have no process-verb lead of their own, and
    // the nearest heading ("Core Principle: Contract Before Code") never says
    // "workflow" — being fenced no longer sweeps them along with steps 1/2,
    // so they stay Jev candidates instead of being silently pre-classified.
    const questions = buildClauseTagQuestions(clauses);
    const stillCandidates = clauses.filter((c) => c.explicit === undefined).map((c) => c.clause_id).sort();
    expect(stillCandidates).toHaveLength(3);
    expect(Object.keys(questions).sort()).toEqual(stillCandidates);

    const tagged = applyClauseTags(clauses, new Map());
    const tag = tagged.find((c) => c.text === "Review the contract for breaking changes");
    expect(tag).toMatchObject({ checkable: false, tag_source: "pre-classified" });
  });

  test.each([
    ["review the contract for breaking changes", "review"],
    ["Discuss the migration plan with the team before merging", "discuss"],
    ["Ask the platform team before adding a new dependency", "ask"],
    ["Document the rationale for this exception in the PR description", "document"],
    ["Communicate the deprecation to downstream consumers", "communicate"],
    ["Get approval from a domain owner before changing this schema", "get approval"],
    ["Plan the rollout across at least two release trains", "plan"],
    ["Decide whether this warrants a major version bump", "decide"],
    ["Design the endpoint in OpenAPI/schema first", "design"],
  ] as const)("process verb lead: %s -> pre-classified (verb: %s)", (text) => {
    expect(preClassifyProcessClause(text, codeContext)).toBeDefined();
  });

  test.each([
    ["Every exported function must document its return type.", "must + function, verb not at clause start"],
    ["A handler must never swallow an exception without logging it.", "must never + handler"],
    ["An import must always resolve through the package's own public entrypoint.", "must always + import"],
    ["Every new class must implement the base validate() method.", "must + class"],
    ["A query must never concatenate raw user input into SQL.", "must never + query"],
    ["Every exported type must be documented with a JSDoc comment.", "must + type, and the word 'documented' mid-sentence"],
  ] as const)("code-property clause stays a Jev candidate: %s (%s)", (text) => {
    expect(preClassifyProcessClause(text, codeContext)).toBeUndefined();
  });

  test("flow 337, item 2: a numbered step inside a fenced block is NOT a workflow step on its own — being fenced no longer qualifies it", () => {
    expect(isWorkflowListStep({ ordered: true, fenced: true, headingPath: ["Core Principle: Contract Before Code"] })).toBe(false);
  });

  test("an ordered list under a heading literally naming 'workflow' is a workflow step even unfenced", () => {
    expect(isWorkflowListStep({ ordered: true, fenced: false, headingPath: ["Release Workflow"] })).toBe(true);
  });

  test("a bulleted (non-ordered) list item is never a workflow step, fenced or not", () => {
    expect(isWorkflowListStep({ ordered: false, fenced: true, headingPath: [] })).toBe(false);
  });

  test("an ordered, unfenced list under an unrelated heading is not a workflow step", () => {
    expect(isWorkflowListStep({ ordered: true, fenced: false, headingPath: ["Rules"] })).toBe(false);
  });

  test("flow 337, item 1: an ordered list under a NON-workflow nearest heading is not a workflow step, even when an ANCESTOR heading says 'workflow'", () => {
    expect(isWorkflowListStep({ ordered: true, fenced: false, headingPath: ["Rule Management Workflow", "Mandatory Behavior"] })).toBe(false);
  });

  test("flow 337, item 1: the nearest heading itself naming 'workflow' still counts, regardless of what its ancestors say", () => {
    expect(isWorkflowListStep({ ordered: true, fenced: false, headingPath: ["Rules", "Release Workflow"] })).toBe(true);
  });

  test("a code-property clause wins over the pre-classifier even inside a fenced numbered workflow list", () => {
    const reason = preClassifyProcessClause("Every handler must never block the event loop.", { ordered: true, fenced: true, headingPath: [] });
    expect(reason).toBeUndefined();
  });

  test("a document-authored explicit marker still wins outright over the pre-classifier", () => {
    const clauses = extractReferenceClauses("# H\n\n- Review the contract for breaking changes. [state:hunk]");
    expect(clauses[0]?.explicit).toEqual({ state_kind: "hunk" });
  });
});

describe("Flow 337 regression: the reviewer's exact counter-examples (12/62 false drops over .metaproject/rules)", () => {
  function notPreClassified(clauses: readonly RawReferenceClause[], text: string): void {
    const clause = clauses.find((c) => c.text === text);
    expect(clause).toBeDefined();
    expect(clause?.explicit).toBeUndefined();
  }

  test("'Keep all rule files in English.' — under a 'Workflow'-titled H1, but nested under a non-workflow nearest heading — is not swept", () => {
    // Mirrors this repo's own rule-management-workflow.mdc: H1 "Rule
    // Management Workflow" (says "workflow"), item 2 sits three headings
    // below under "## Mandatory Behavior" (does not).
    const doc = [
      "# Rule Management Workflow",
      "",
      "## Mandatory Behavior",
      "1. Update or create rule files only under the rules directory.",
      "2. Keep all rule files in English.",
      "3. Keep frontmatter valid YAML.",
    ].join("\n");
    notPreClassified(extractReferenceClauses(doc), "Keep all rule files in English.");
  });

  test("'Ensure `agents/openai.yaml` exists where required…' — same ancestor-vs-nearest-heading shape — is not swept", () => {
    // Mirrors skills-storage-workflow.mdc: H1 "Skills Storage Workflow",
    // item 6 sits under "## Mandatory Behavior".
    const doc = [
      "# Skills Storage Workflow",
      "",
      "## Mandatory Behavior",
      "1. Always create/update SKILL.md as the canonical source.",
      "6. Ensure `agents/openai.yaml` exists where required by the target agent UI.",
    ].join("\n");
    notPreClassified(extractReferenceClauses(doc), "Ensure `agents/openai.yaml` exists where required by the target agent UI.");
  });

  test("the mobx member-ordering fenced list (1. private fields … 5. private methods) is not swept just for being fenced", () => {
    // Mirrors mobx-store-template.mdc: fenced, ordered, under "## Member
    // Ordering" — no "workflow" anywhere, and no step opens with a
    // process-verb lead.
    const doc = [
      "# Store Conventions",
      "",
      "## Member Ordering",
      "```",
      "1. private fields",
      "2. public fields",
      "3. constructor",
      "4. public methods",
      "5. private methods",
      "```",
    ].join("\n");
    const clauses = extractReferenceClauses(doc);
    for (const text of ["private fields", "public fields", "constructor", "public methods", "private methods"]) {
      notPreClassified(clauses, text);
    }
  });

  test("'Plan files MUST be Markdown (`.md`).' — the must/never/always + widened code-noun rescue covers it", () => {
    const doc = ["# Implementation Plans", "", "## Output Contract", "- Plan files MUST be Markdown (`.md`).", "- Code or command examples MUST be fenced code blocks."].join(
      "\n",
    );
    notPreClassified(extractReferenceClauses(doc), "Plan files MUST be Markdown (`.md`).");
  });

  test("'document index;' — a lead term directly followed by a bare noun, not an imperative object — is not swept", () => {
    // Mirrors requirements-package-standard.mdc's README Contract list —
    // the clause loses its "README.md must state:" prefix at extraction
    // (that line is prose, not a list item), leaving the bare noun phrase.
    const doc = ["# Requirements Package Standard", "", "## README Contract", "- package purpose;", "- document index;", "- scope and non-goals;"].join("\n");
    notPreClassified(extractReferenceClauses(doc), "document index;");
  });

  test("the three true-process clauses the reviewer confirmed stay pre-classified (dropped), unaffected by the precision fix", () => {
    const doc = [
      "# API Contracts",
      "",
      "## Core Principle: Contract Before Code",
      "- Review the contract for breaking changes.",
      "- Ask whether to apply changes.",
      "- Design the endpoint in OpenAPI/schema first.",
    ].join("\n");
    const clauses = extractReferenceClauses(doc);
    for (const text of ["Review the contract for breaking changes.", "Ask whether to apply changes.", "Design the endpoint in OpenAPI/schema first."]) {
      const clause = clauses.find((c) => c.text === text);
      expect(clause?.explicit).toMatchObject({ not_checkable_reason: expect.stringContaining("Pre-classified process") });
    }
    const tagged = applyClauseTags(clauses, new Map());
    for (const text of ["Review the contract for breaking changes.", "Ask whether to apply changes.", "Design the endpoint in OpenAPI/schema first."]) {
      const tag = tagged.find((c) => c.text === text);
      expect(tag).toMatchObject({ checkable: false, tag_source: "pre-classified" });
    }
  });
});
