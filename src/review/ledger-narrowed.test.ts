import { expect, test } from "bun:test";
import { type LedgerInputs, buildLedger } from "./ledger";
import { researchErrors } from "./research";

const finding = { id: "L-01", severity: "major", problem: "the guard is missing", impact: "i", suggested_fix: "f", evidence: "e", confidence: 0.5, reviewer: "review-logic" };
const ID = "review-logic:L-01";

function inputs(dispositions: LedgerInputs["dispositions"]): LedgerInputs {
  return {
    mode: "all",
    selected: ["review-logic"],
    manifest: undefined,
    payloadSlices: {},
    ruleFiles: { "review-logic": ".metaproject/skills/gdskills/review/review-logic/SKILL.md" },
    raws: [{ name: "raw/review-logic.txt", hash: "h1", mtimeMs: 1, empty: false, result: { reviewer: "review-logic", status: "DONE", summary: "s", findings: [finding], needs_context: [] } }],
    retry: { schemaVersion: 1, reviewers: {} },
    canonical: [],
    dispositions,
    manifestPath: "slices/manifest.json",
  };
}

const narrowed = { id: ID, status: "narrowed", evidence: "probe.log shows the empty case is guarded at a.ts:12", reason: "the reported case is guarded; the null case is not" };

test("a narrowed disposition with a 'what remains' text closes the obligation and keeps it", () => {
  const { ledger } = buildLedger(inputs([{ ...narrowed, remains: "a.ts:30 still dereferences a null name" }]));
  expect(ledger.obligations[0]).toMatchObject({ status: "narrowed", evidence: narrowed.evidence, remains: "a.ts:30 still dereferences a null name" });
  expect(ledger.rawReconciled).toBe(true);
  expect(researchErrors(ledger, [])).not.toContain(`${ID}: unresolved research (narrowed)`);
});

test("narrowed without a 'what remains' text is not closed", () => {
  for (const remains of [undefined, "", "   "]) {
    const { ledger, gaps } = buildLedger(inputs([{ ...narrowed, ...(remains === undefined ? {} : { remains }) }]));
    expect(ledger.obligations[0]).toMatchObject({ status: "unresolved" });
    expect(ledger.rawReconciled).toBe(false);
    expect(gaps.length).toBeGreaterThan(0);
  }
});

test("the completion gate refuses a narrowed obligation that lost its 'what remains' text", () => {
  const ready = { version: 1, scopeReviewed: true, rawReconciled: true };
  const obligation = { id: ID, source: "raw/review-logic.txt", question: "q", status: "narrowed", evidence: "e", reason: "r" };
  expect(researchErrors({ ...ready, obligations: [obligation] }, []).join(" ")).toContain("what remains");
  expect(researchErrors({ ...ready, obligations: [{ ...obligation, remains: "a.ts:30 still dereferences null" }] }, [])).toEqual([]);
});

test("narrowed still needs evidence and reason like every other closure", () => {
  const ready = { version: 1, scopeReviewed: true, rawReconciled: true };
  const obligation = { id: ID, source: "raw/review-logic.txt", question: "q", status: "narrowed", remains: "x", evidence: " ", reason: "r" };
  expect(researchErrors({ ...ready, obligations: [obligation] }, []).join(" ")).toContain("evidence and reason");
});
