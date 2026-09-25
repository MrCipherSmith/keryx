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
});
