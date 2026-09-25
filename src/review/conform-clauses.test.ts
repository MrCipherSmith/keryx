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

  test("PR #712's own false positive — 'Review the contract for breaking changes' — is pre-classified process, no Jev question built", () => {
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

    const questions = buildClauseTagQuestions(clauses);
    expect(Object.keys(questions)).toEqual([]); // every step of this fenced numbered workflow is pre-classified — no Jev call at all

    const tagged = applyClauseTags(clauses, new Map());
    const tag = tagged.find((c) => c.text === "Review the contract for breaking changes");
    expect(tag).toMatchObject({ checkable: false, tag_source: "explicit" });
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

  test("a numbered step inside a fenced block is a workflow step regardless of heading wording", () => {
    expect(isWorkflowListStep({ ordered: true, fenced: true, headingPath: ["Core Principle: Contract Before Code"] })).toBe(true);
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

  test("a code-property clause wins over the pre-classifier even inside a fenced numbered workflow list", () => {
    const reason = preClassifyProcessClause("Every handler must never block the event loop.", { ordered: true, fenced: true, headingPath: [] });
    expect(reason).toBeUndefined();
  });

  test("a document-authored explicit marker still wins outright over the pre-classifier", () => {
    const clauses = extractReferenceClauses("# H\n\n- Review the contract for breaking changes. [state:hunk]");
    expect(clauses[0]?.explicit).toEqual({ state_kind: "hunk" });
  });
});
