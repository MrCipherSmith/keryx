// Flow 308, AC5/AC6: batching (budget-aware, same-kind) and verdict
// computation. Invented content throughout (AC10).

import { describe, expect, test } from "bun:test";
import { applyClauseTags, extractReferenceClauses } from "./conform-clauses";
import {
  activeClausesAt,
  aggregateConformVerdicts,
  batchConformItems,
  boundHunkRegions,
  CONFORM_TOKEN_BUDGET,
  DEFAULT_CONFORM_THRESHOLD,
  DEFAULT_MAX_HUNK_CALLS,
  DEFAULT_MAX_HUNKS,
  evaluatedVerdict,
  notCheckableVerdict,
  notEvaluatedVerdict,
  type ConformHunkLocation,
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
    expect(verdict.reason).toBeUndefined();
  });

  // Flow 326, AC3: a hunk-kind clause skipped by the `--max-hunk-calls`
  // budget carries a reason distinguishing it from "no hunks in the diff".
  test("notEvaluatedVerdict carries a reason when the caller names one (AC3: budget-skipped)", () => {
    const c = clause("A pr-kind rule.");
    const verdict = notEvaluatedVerdict(c, "skipped by --max-hunk-calls (0 of 12 hunks judged)");
    expect(verdict.status).toBe("not-evaluated");
    expect(verdict.reason).toBe("skipped by --max-hunk-calls (0 of 12 hunks judged)");
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

  test("evaluatedVerdict stamps the given hunk location onto the verdict", () => {
    const c = clause("A hunk-kind rule.");
    const loc: ConformHunkLocation = { path: "src/x.ts", startLine: 1, endLine: 3 };
    const verdict = evaluatedVerdict(c, { factLines: [] }, 0.9, DEFAULT_CONFORM_THRESHOLD, loc);
    expect(verdict.location).toEqual(loc);
  });
});

function hunkClause(text: string, clauseId = "h-1"): ReturnType<typeof applyClauseTags>[number] {
  const raw = extractReferenceClauses(`# H\n\n- ${text} [state:hunk]`);
  const tagged = applyClauseTags(raw, new Map())[0]!;
  return { ...tagged, clause_id: clauseId };
}

function hunkVerdict(clauseId: string, probability: number, location: ConformHunkLocation, threshold = DEFAULT_CONFORM_THRESHOLD) {
  return evaluatedVerdict(hunkClause("A hunk rule.", clauseId), { factLines: [] }, probability, threshold, location);
}

describe("Flow 326, AC2: aggregateConformVerdicts — one row per clause, not one row per hunk × clause", () => {
  test("a not-checkable clause passes through unchanged", () => {
    const raw = extractReferenceClauses("# H\n\n- Manual step. [not-checkable: no artefact]");
    const tagged = applyClauseTags(raw, new Map())[0]!;
    const [agg] = aggregateConformVerdicts([notCheckableVerdict(tagged)]);
    expect(agg!.status).toBe("not-checkable");
    expect(agg!.reason).toBe("no artefact");
    expect(agg!.hunksJudged).toBe(0);
  });

  test("empty set: a clause whose kind has no state supplied this run reads not-evaluated, never per-hunk fields", () => {
    const c = clause("A pr-kind rule.");
    const [agg] = aggregateConformVerdicts([notEvaluatedVerdict(c)]);
    expect(agg!.status).toBe("not-evaluated");
    expect(agg!.hunksJudged).toBe(0);
    expect(agg!.worst).toBeUndefined();
  });

  test("a pr/report-kind clause (single verdict, no location) passes through with its own probability", () => {
    const c = clause("A pr-kind rule.");
    const verdict = evaluatedVerdict(c, { factLines: ["fact"] }, 0.83);
    const [agg] = aggregateConformVerdicts([verdict]);
    expect(agg!.probability).toBe(0.83);
    expect(agg!.hunksJudged).toBe(0);
    expect(agg!.worst).toBeUndefined();
  });

  test("a hunk-kind clause: satisfied only when EVERY judged hunk is at/above threshold", () => {
    const verdicts = [
      hunkVerdict("h-1", 0.9, { path: "a.ts", startLine: 1, endLine: 2 }),
      hunkVerdict("h-1", 0.6, { path: "b.ts", startLine: 3, endLine: 4 }),
    ];
    const [agg] = aggregateConformVerdicts(verdicts);
    expect(agg!.status).toBe("satisfied");
    expect(agg!.hunksJudged).toBe(2);
    expect(agg!.hunksBelowThreshold).toBe(0);
  });

  test("a hunk-kind clause: likely-violated when ANY retained hunk falls below threshold, worst hunk is the lowest probability", () => {
    const verdicts = [
      hunkVerdict("h-1", 0.9, { path: "a.ts", startLine: 1, endLine: 2 }),
      hunkVerdict("h-1", 0.1, { path: "b.ts", startLine: 3, endLine: 4 }),
      hunkVerdict("h-1", 0.3, { path: "c.ts", startLine: 5, endLine: 6 }),
    ];
    const [agg] = aggregateConformVerdicts(verdicts);
    expect(agg!.status).toBe("likely-violated");
    expect(agg!.hunksJudged).toBe(3);
    expect(agg!.hunksBelowThreshold).toBe(2);
    expect(agg!.worst?.location).toEqual({ path: "b.ts", startLine: 3, endLine: 4 });
    expect(agg!.worst?.probability).toBe(0.1);
    // "c.ts" (0.3) is the only further violation, below threshold and not the worst.
    expect(agg!.furtherViolations).toEqual([{ location: { path: "c.ts", startLine: 5, endLine: 6 }, probability: 0.3 }]);
  });

  test("ties: a probability exactly at threshold reads satisfied (matches evaluatedVerdict's own >= comparison)", () => {
    const verdicts = [hunkVerdict("h-1", DEFAULT_CONFORM_THRESHOLD, { path: "a.ts", startLine: 1, endLine: 2 })];
    const [agg] = aggregateConformVerdicts(verdicts);
    expect(agg!.status).toBe("satisfied");
    expect(agg!.hunksBelowThreshold).toBe(0);
  });

  test("furtherViolations is capped at maxHunks, most severe (lowest probability) first, excluding the worst", () => {
    const verdicts = [
      hunkVerdict("h-1", 0.05, { path: "worst.ts", startLine: 1, endLine: 2 }),
      hunkVerdict("h-1", 0.1, { path: "a.ts", startLine: 1, endLine: 2 }),
      hunkVerdict("h-1", 0.2, { path: "b.ts", startLine: 1, endLine: 2 }),
      hunkVerdict("h-1", 0.3, { path: "c.ts", startLine: 1, endLine: 2 }),
      hunkVerdict("h-1", 0.4, { path: "d.ts", startLine: 1, endLine: 2 }),
    ];
    const [agg] = aggregateConformVerdicts(verdicts, 2);
    expect(agg!.worst?.location.path).toBe("worst.ts");
    expect(agg!.furtherViolations.map((v) => v.location.path)).toEqual(["a.ts", "b.ts"]);
  });

  test("multiple clauses keep their own groups, in first-encountered order", () => {
    const verdicts = [
      hunkVerdict("h-1", 0.9, { path: "a.ts", startLine: 1, endLine: 2 }),
      hunkVerdict("h-2", 0.1, { path: "b.ts", startLine: 1, endLine: 2 }),
      hunkVerdict("h-1", 0.8, { path: "c.ts", startLine: 1, endLine: 2 }),
    ];
    const aggregates = aggregateConformVerdicts(verdicts);
    expect(aggregates.map((a) => a.clause_id)).toEqual(["h-1", "h-2"]);
    expect(aggregates[0]!.hunksJudged).toBe(2);
    expect(aggregates[1]!.hunksJudged).toBe(1);
  });

  test("the default max-hunks constant is 3", () => {
    expect(DEFAULT_MAX_HUNKS).toBe(3);
  });
});

describe("Flow 326, AC3: boundHunkRegions — caps hunk × clause questions per run", () => {
  const CLAUSE_IDS_4 = ["c0", "c1", "c2", "c3"];

  test("under budget: every region is kept, nothing skipped", () => {
    const result = boundHunkRegions(["r1", "r2", "r3"], CLAUSE_IDS_4, 40);
    expect(result.regions).toEqual(["r1", "r2", "r3"]);
    expect(result.skippedRegions).toBe(0);
    expect(result.totalRegions).toBe(3);
    for (const id of CLAUSE_IDS_4) expect(result.judgedPerClause.get(id)).toBe(3);
  });

  test("over budget: a deterministic prefix is kept, the rest counted as skipped", () => {
    const regions = Array.from({ length: 10 }, (_, i) => `r${i}`);
    // 4 clauses * 10 regions = 40 questions; budget 12 -> floor(12/4) = 3 regions kept, EVERY clause equally.
    const result = boundHunkRegions(regions, CLAUSE_IDS_4, 12);
    expect(result.regions).toEqual(["r0", "r1", "r2"]);
    expect(result.skippedRegions).toBe(7);
    expect(result.totalRegions).toBe(10);
    for (const id of CLAUSE_IDS_4) expect(result.judgedPerClause.get(id)).toBe(3);
  });

  test("no hunk-kind clauses at all: nothing to bound, every region kept", () => {
    const regions = ["r1", "r2"];
    const result = boundHunkRegions(regions, [], 40);
    expect(result.regions).toEqual(regions);
    expect(result.skippedRegions).toBe(0);
    expect(result.judgedPerClause.size).toBe(0);
  });

  test("no regions: nothing to bound", () => {
    const result = boundHunkRegions([], ["c0", "c1", "c2", "c3", "c4"], 40);
    expect(result.regions).toEqual([]);
    expect(result.skippedRegions).toBe(0);
    expect(result.totalRegions).toBe(0);
  });

  test("the default max-hunk-calls constant is 40", () => {
    expect(DEFAULT_MAX_HUNK_CALLS).toBe(40);
  });

  // Flow 326: budget smaller than the clause count — floor(maxHunkCalls /
  // clauseCount) alone would round every clause down to 0 and silently drop
  // every hunk-kind clause. The per-clause floor instead spends the budget on
  // the first `maxHunkCalls` clauses (1 hunk each), 0 for the rest.
  describe("per-clause floor: budget smaller than the clause count", () => {
    const regions = Array.from({ length: 12 }, (_, i) => `r${i}`);
    const clauseIds = ["hunks-1", "hunks-2"];

    test("--max-hunk-calls 0: every clause gets 0, nothing is asked", () => {
      const result = boundHunkRegions(regions, clauseIds, 0);
      expect(result.regions).toEqual([]);
      expect(result.judgedPerClause.get("hunks-1")).toBe(0);
      expect(result.judgedPerClause.get("hunks-2")).toBe(0);
      expect(result.skippedRegions).toBe(12);
    });

    test("--max-hunk-calls 1: the FIRST clause gets 1 judged hunk, the rest get 0 — not floor(1/2)=0 for everyone", () => {
      const result = boundHunkRegions(regions, clauseIds, 1);
      expect(result.regions).toEqual(["r0"]);
      expect(result.judgedPerClause.get("hunks-1")).toBe(1);
      expect(result.judgedPerClause.get("hunks-2")).toBe(0);
    });

    test("--max-hunk-calls 3 with 4 clauses: the first 3 clauses get 1 hunk each, the 4th gets 0", () => {
      const result = boundHunkRegions(regions, [...clauseIds, "hunks-3", "hunks-4"], 3);
      expect(result.judgedPerClause.get("hunks-1")).toBe(1);
      expect(result.judgedPerClause.get("hunks-2")).toBe(1);
      expect(result.judgedPerClause.get("hunks-3")).toBe(1);
      expect(result.judgedPerClause.get("hunks-4")).toBe(0);
    });
  });

  describe("activeClausesAt", () => {
    test("returns only the clauses whose quota reaches this index", () => {
      const judgedPerClause = new Map([
        ["a", 3],
        ["b", 1],
        ["c", 0],
      ]);
      const ids = ["a", "b", "c"];
      expect(activeClausesAt(judgedPerClause, 0, ids)).toEqual(["a", "b"]);
      expect(activeClausesAt(judgedPerClause, 1, ids)).toEqual(["a"]);
      expect(activeClausesAt(judgedPerClause, 2, ids)).toEqual(["a"]);
      expect(activeClausesAt(judgedPerClause, 3, ids)).toEqual([]);
    });
  });
});
