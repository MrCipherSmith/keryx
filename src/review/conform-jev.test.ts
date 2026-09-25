// Flow 308, AC5/AC6: batching (budget-aware, same-kind) and verdict
// computation. Invented content throughout (AC10).

import { describe, expect, test } from "bun:test";
import { applyClauseTags, extractReferenceClauses } from "./conform-clauses";
import {
  batchConformItems,
  CONFORM_TOKEN_BUDGET,
  DEFAULT_CONFORM_THRESHOLD,
  evaluatedVerdict,
  notCheckableVerdict,
  notEvaluatedVerdict,
} from "./conform-jev";

function clause(text: string): ReturnType<typeof applyClauseTags>[number] {
  const raw = extractReferenceClauses(`# H\n\n- ${text} [state:pr]`);
  return applyClauseTags(raw, new Map())[0]!;
}

/** Multiple clauses from ONE document, so their ids are distinct (`h-1`, `h-2`, ...). */
function clausesFrom(texts: readonly string[]): ReturnType<typeof applyClauseTags> {
  const doc = ["# H", "", ...texts.map((t) => `- ${t} [state:pr]`)].join("\n");
  return applyClauseTags(extractReferenceClauses(doc), new Map());
}

describe("AC5: batchConformItems — same-kind clauses share state, split under budget", () => {
  test("a handful of small clauses fit in one batch", () => {
    const [first, second] = clausesFrom(["First rule.", "Second rule."]);
    const items = [
      { clause: first!, facts: { factLines: ["fact one"] } },
      { clause: second!, facts: { factLines: ["fact two"] } },
    ];
    const batches = batchConformItems(items, "shared redacted state");
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]!.questions)).toEqual([items[0]!.clause.clause_id, items[1]!.clause.clause_id]);
    expect(batches[0]!.state).toContain("shared redacted state");
  });

  test("an oversized set of clauses splits into multiple batches, never truncating a clause", () => {
    const bigFact = "x".repeat(40_000);
    const clauses = clausesFrom(Array.from({ length: 10 }, (_, i) => `Rule number ${i}.`));
    const items = clauses.map((c) => ({ clause: c, facts: { factLines: [bigFact] } }));
    const batches = batchConformItems(items, "shared state");
    expect(batches.length).toBeGreaterThan(1);
    const allClauseIds = batches.flatMap((b) => Object.keys(b.questions));
    expect(new Set(allClauseIds).size).toBe(items.length);
    for (const batch of batches) {
      // Every batch stays within the documented budget (best-effort estimate).
      expect(batch.state.length + Object.values(batch.questions).reduce((n, q) => n + q.instructions.length, 0)).toBeLessThan(
        CONFORM_TOKEN_BUDGET * 4,
      );
    }
  });

  test("an empty item list returns no batches", () => {
    expect(batchConformItems([], "state")).toEqual([]);
  });
});

describe("secret redaction: clause text is scrubbed before it reaches a Jev question", () => {
  test("an AWS access key planted in a clause's text never reaches batchConformItems' question body", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const c = clause(`Rotate the credential AWS_ACCESS_KEY_ID=${secret} every 90 days.`);
    const [batch] = batchConformItems([{ clause: c, facts: { factLines: [] } }], "shared redacted state");
    const instructions = batch!.questions[c.clause_id]!.instructions;
    expect(instructions).not.toContain(secret);
    expect(instructions).toContain("[REDACTED:");
    // The rest of the clause's wording is still sent — redaction strips only
    // the secret span, not the clause itself (clause text IS the feature).
    expect(instructions).toContain("Rotate the credential");
  });
});

describe("AC6: verdict computation", () => {
  test("notCheckableVerdict carries the reason and no probability", () => {
    const raw = extractReferenceClauses("# H\n\n- Verified manually. [not-checkable: no artefact records this]");
    const tagged = applyClauseTags(raw, new Map())[0]!;
    const verdict = notCheckableVerdict(tagged);
    expect(verdict.status).toBe("not-checkable");
    expect(verdict.reason).toBe("no artefact records this");
    expect(verdict.probability).toBeUndefined();
  });

  test("notEvaluatedVerdict is used when the clause's kind has no state supplied this run", () => {
    const c = clause("A pr-kind rule.");
    const verdict = notEvaluatedVerdict(c);
    expect(verdict.status).toBe("not-evaluated");
  });

  test("evaluatedVerdict: at/above the threshold is satisfied, below is likely-violated", () => {
    const c = clause("A pr-kind rule.");
    const satisfied = evaluatedVerdict(c, { factLines: ["a fact"] }, 0.9);
    expect(satisfied.status).toBe("satisfied");
    const violated = evaluatedVerdict(c, { factLines: ["a fact"] }, 0.1);
    expect(violated.status).toBe("likely-violated");
    const boundary = evaluatedVerdict(c, { factLines: [] }, DEFAULT_CONFORM_THRESHOLD);
    expect(boundary.status).toBe("satisfied");
  });

  test("evaluatedVerdict carries a decisive fact through when present", () => {
    const c = clause("A pr-kind rule.");
    const verdict = evaluatedVerdict(c, { factLines: ["fact"], decisive: { satisfied: false, reason: "over budget" } }, 0.7);
    expect(verdict.decisive).toEqual({ satisfied: false, reason: "over budget" });
  });
});
