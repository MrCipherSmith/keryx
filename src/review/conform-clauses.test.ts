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
} from "./conform-clauses";

const FIXTURE = path.join(import.meta.dir, "fixtures", "conform", "invented-doctrine.md");

async function fixtureText(): Promise<string> {
  return readFile(FIXTURE, "utf8");
}

describe("AC1: extractReferenceClauses — deterministic, no model call", () => {
  test("pins the stable ids of the invented fixture document", async () => {
    const clauses = extractReferenceClauses(await fixtureText());
    expect(clauses.map((c) => c.clause_id)).toEqual([
      "scope-1",
      "scope-2",
      "scope-3",
      "review-rounds-1",
      "review-rounds-2",
      "reviewer-contract-1",
      "reviewer-contract-2",
      "reviewer-contract-3",
      "code-and-test-hunks-1",
      "code-and-test-hunks-2",
      "exit-criterion-1",
    ]);
  });

  test("carries clause text with the explicit marker stripped", async () => {
    const clauses = extractReferenceClauses(await fixtureText());
    const scope2 = clauses.find((c) => c.clause_id === "scope-2");
    expect(scope2?.text).toBe("Hand-written code in one PR stays under a 600 lines budget.");
    expect(scope2?.explicit).toEqual({ state_kind: "pr" });
  });

  test("carries the full heading path, not just the nearest heading", async () => {
    const clauses = extractReferenceClauses(await fixtureText());
    const scope1 = clauses.find((c) => c.clause_id === "scope-1");
    expect(scope1?.heading_path).toEqual(["Invented Review Doctrine (fixture)", "Scope"]);
  });

  test("re-extracting the same content reproduces byte-identical ids (idempotent, no model call)", async () => {
    const text = await fixtureText();
    expect(extractReferenceClauses(text)).toEqual(extractReferenceClauses(text));
  });

  test("a not-checkable explicit marker is parsed with its reason", async () => {
    const clauses = extractReferenceClauses(await fixtureText());
    const roundsExit = clauses.find((c) => c.clause_id === "exit-criterion-1");
    expect(roundsExit?.explicit).toEqual({
      not_checkable_reason: "an obligation on the review process itself, not something a single artefact records",
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
});
