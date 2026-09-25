// flow 340: core (pure, no network, no I/O) tests for the three
// severity-calibration / duplicate-merge / verify-order tracks, and their
// shared batching. Mirrors `src/review/jev-contract.test.ts`'s own shape.

import { describe, expect, test } from "bun:test";
import {
  batchTriageItems,
  buildMergeCandidatePairs,
  computeTriageItems,
  computeTriagePopulation,
  DEFAULT_JEV_TRIAGE_SEVERITY_THRESHOLD,
  MAX_MERGE_CANDIDATE_PAIRS,
  parseTriageFindings,
  renderTriageMarkdown,
  selectTriageFindings,
  synthesizeTriageAnnotations,
  type TriageFinding,
} from "./jev-triage";

function finding(overrides: Partial<TriageFinding> & Pick<TriageFinding, "id" | "severity">): TriageFinding {
  return { file: null, line: null, quote: null, problem: "something is wrong", evidence: "some evidence", ...overrides };
}

describe("parseTriageFindings", () => {
  test("a bare findings.json array (the on-disk review-package shape)", () => {
    const { findings, droppedCount } = parseTriageFindings([
      { id: "F-001", severity: "major", problem: "p1", evidence: "e1", file: "a.ts", line: 10 },
      { id: "F-002", severity: "minor", problem: "p2", evidence: "e2" },
    ]);
    expect(findings).toHaveLength(2);
    expect(droppedCount).toBe(0);
    expect(findings[0]!.file).toBe("a.ts");
    expect(findings[0]!.line).toBe(10);
  });

  test("a REVIEW_RESULT-shaped object ({ findings: [...] })", () => {
    const { findings } = parseTriageFindings({ status: "DONE", findings: [{ id: "F-1", severity: "blocker", problem: "p", evidence: "e" }] });
    expect(findings).toHaveLength(1);
  });

  test("malformed entries are dropped, not thrown over", () => {
    const { findings, droppedCount } = parseTriageFindings([
      { id: "F-1", severity: "major", problem: "p", evidence: "e" },
      { severity: "major", problem: "no id" },
      { id: "F-2", severity: "not-a-severity", problem: "p" },
      "not even an object",
      null,
    ]);
    expect(findings).toHaveLength(1);
    expect(droppedCount).toBe(4);
  });

  test("neither an array nor a { findings } object: zero findings, not a throw", () => {
    expect(parseTriageFindings({ foo: "bar" }).findings).toHaveLength(0);
    expect(parseTriageFindings(null).findings).toHaveLength(0);
    expect(parseTriageFindings("garbage").findings).toHaveLength(0);
  });
});

describe("selectTriageFindings — blocker/major only", () => {
  test("filters out minor/info", () => {
    const findings = [finding({ id: "A", severity: "blocker" }), finding({ id: "B", severity: "major" }), finding({ id: "C", severity: "minor" }), finding({ id: "D", severity: "info" })];
    expect(selectTriageFindings(findings).map((f) => f.id)).toEqual(["A", "B"]);
  });
});

describe("buildMergeCandidatePairs — deterministic, gated pairing", () => {
  test("same file pairs", () => {
    const findings = [finding({ id: "A", severity: "major", file: "src/x.ts" }), finding({ id: "B", severity: "major", file: "src/x.ts" })];
    const pairs = buildMergeCandidatePairs(findings);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.reason).toBe("file");
    expect(pairs[0]!.a.id).toBe("A");
    expect(pairs[0]!.b.id).toBe("B");
  });

  test("overlapping line ranges (different files never compared on lines alone unless overlapping window)", () => {
    const findings = [finding({ id: "A", severity: "blocker", file: "a.ts", line: 10 }), finding({ id: "B", severity: "blocker", file: "b.ts", line: 12 })];
    const pairs = buildMergeCandidatePairs(findings);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.reason).toBe("lines");
  });

  test("lines too far apart do not overlap", () => {
    const findings = [finding({ id: "A", severity: "blocker", file: "a.ts", line: 10 }), finding({ id: "B", severity: "blocker", file: "b.ts", line: 40 })];
    expect(buildMergeCandidatePairs(findings)).toHaveLength(0);
  });

  test("overlapping quotes (a substring match after whitespace normalization)", () => {
    const findings = [
      finding({ id: "A", severity: "major", quote: "function widget() {\n  return null;\n}" }),
      finding({ id: "B", severity: "major", quote: "return null;" }),
    ];
    const pairs = buildMergeCandidatePairs(findings);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.reason).toBe("quote");
  });

  test("short quotes never count as a match on their own", () => {
    const findings = [finding({ id: "A", severity: "major", quote: "{}" }), finding({ id: "B", severity: "major", quote: "{}" })];
    expect(buildMergeCandidatePairs(findings)).toHaveLength(0);
  });

  test("no shared signal: no pair", () => {
    const findings = [finding({ id: "A", severity: "major", file: "a.ts" }), finding({ id: "B", severity: "major", file: "b.ts" })];
    expect(buildMergeCandidatePairs(findings)).toHaveLength(0);
  });

  test("minor/info findings never enter the pairing pool", () => {
    const findings = [finding({ id: "A", severity: "minor", file: "a.ts" }), finding({ id: "B", severity: "info", file: "a.ts" })];
    expect(buildMergeCandidatePairs(findings)).toHaveLength(0);
  });

  test("pair ids are stable and deterministic across runs", () => {
    const findings = [
      finding({ id: "A", severity: "major", file: "x.ts" }),
      finding({ id: "B", severity: "major", file: "x.ts" }),
      finding({ id: "C", severity: "major", file: "x.ts" }),
    ];
    const first = buildMergeCandidatePairs(findings);
    const second = buildMergeCandidatePairs(findings);
    expect(first.map((p) => p.id)).toEqual(second.map((p) => p.id));
    expect(first.map((p) => p.id)).toEqual(["MRG1", "MRG2", "MRG3"]);
  });

  test("a hard ceiling on pairs considered, independent of --max-calls", () => {
    const findings = Array.from({ length: 40 }, (_, i) => finding({ id: `F${i}`, severity: "major", file: "same.ts" }));
    const pairs = buildMergeCandidatePairs(findings);
    expect(pairs.length).toBeLessThanOrEqual(MAX_MERGE_CANDIDATE_PAIRS);
    expect(pairs.length).toBe(MAX_MERGE_CANDIDATE_PAIRS);
  });
});

describe("computeTriageItems — priority order and --max-calls truncation, reported not silent", () => {
  test("severity first, then merge pairs, then verify-order; a cap truncates and reports the count", () => {
    const findings = [finding({ id: "A", severity: "major", file: "x.ts" }), finding({ id: "B", severity: "major", file: "x.ts" })];
    const population = computeTriagePopulation(findings);
    // 2 severity + 1 merge pair + 2 verify = 5 total items.
    const full = computeTriageItems(population, 100);
    expect(full.items.map((i) => i.kind)).toEqual(["severity", "severity", "merge", "verify", "verify"]);
    expect(full.skippedCount).toBe(0);

    const capped = computeTriageItems(population, 2);
    expect(capped.items).toHaveLength(2);
    expect(capped.items.every((i) => i.kind === "severity")).toBe(true);
    expect(capped.skippedCount).toBe(3);
    expect(capped.maxItems).toBe(2);
  });

  test("a zero cap selects nothing and reports every item skipped", () => {
    const findings = [finding({ id: "A", severity: "blocker" })];
    const result = computeTriageItems(computeTriagePopulation(findings), 0);
    expect(result.items).toHaveLength(0);
    expect(result.skippedCount).toBe(2); // 1 severity + 1 verify, no merge pair possible alone
  });
});

describe("batchTriageItems — conservative packing (mirrors jev-contract.ts's batcher)", () => {
  test("at most 3 items per batch", () => {
    const findings = Array.from({ length: 7 }, (_, i) => finding({ id: `F${i}`, severity: "blocker" }));
    const items = computeTriageItems(computeTriagePopulation(findings), 100).items;
    const batches = batchTriageItems(items);
    for (const batch of batches) expect(batch.items.length).toBeLessThanOrEqual(3);
    expect(batches.reduce((n, b) => n + b.items.length, 0)).toBe(items.length);
  });

  test("empty input produces zero batches", () => {
    expect(batchTriageItems([])).toHaveLength(0);
  });
});

describe("synthesizeTriageAnnotations", () => {
  test("severity_check: flagged is p < threshold, never a demotion signal beyond that field", () => {
    const findings = [finding({ id: "A", severity: "major" }), finding({ id: "B", severity: "blocker" })];
    const population = computeTriagePopulation(findings);
    const probabilities = new Map([
      ["SEV-A", 0.2],
      ["SEV-B", 0.9],
    ]);
    const annotations = synthesizeTriageAnnotations(population, probabilities, DEFAULT_JEV_TRIAGE_SEVERITY_THRESHOLD);
    expect(annotations.severity_check).toEqual([
      { id: "A", p: 0.2, flagged: true },
      { id: "B", p: 0.9, flagged: false },
    ]);
  });

  test("severity_check: no answer means not flagged (never a manufactured demotion)", () => {
    const findings = [finding({ id: "A", severity: "major" })];
    const population = computeTriagePopulation(findings);
    const annotations = synthesizeTriageAnnotations(population, new Map());
    expect(annotations.severity_check).toEqual([{ id: "A", flagged: false }]);
  });

  test("verify_order: scored ascending by p (lowest plausibility first), unscored appended last", () => {
    const findings = [finding({ id: "A", severity: "major" }), finding({ id: "B", severity: "major" }), finding({ id: "C", severity: "blocker" })];
    const population = computeTriagePopulation(findings);
    const probabilities = new Map([
      ["VER-A", 0.9],
      ["VER-B", 0.1],
      // VER-C never scored (degrade path).
    ]);
    const annotations = synthesizeTriageAnnotations(population, probabilities);
    expect(annotations.verify_order.map((v) => v.id)).toEqual(["B", "A", "C"]);
    expect(annotations.verify_order[2]!.p).toBeUndefined();
  });

  test("merge_candidates carry p when scored, undefined when not — never merged, only annotated", () => {
    const findings = [finding({ id: "A", severity: "major", file: "x.ts" }), finding({ id: "B", severity: "major", file: "x.ts" })];
    const population = computeTriagePopulation(findings);
    const annotations = synthesizeTriageAnnotations(population, new Map([["MRG1", 0.8]]));
    expect(annotations.merge_candidates).toEqual([{ id: "MRG1", a: "A", b: "B", reason: "file", p: 0.8 }]);
  });
});

describe("renderTriageMarkdown", () => {
  test("English, plain-text, mentions all three tracks", () => {
    const text = renderTriageMarkdown({
      status: "DONE_WITH_CONCERNS",
      reviewer: "review-jev-triage",
      summary: "Triaged 1 blocker/major finding(s).",
      annotations: {
        severity_check: [{ id: "A", p: 0.2, flagged: true }],
        merge_candidates: [],
        verify_order: [{ id: "A", p: 0.2 }],
      },
      budget: { maxItems: 30, itemsScored: 2, itemsSkipped: 0, findingsDropped: 0 },
    });
    expect(text).toContain("review-jev-triage");
    expect(text).toContain("Severity calibration");
    expect(text).toContain("Duplicate-merge candidates");
    expect(text).toContain("Verifier queue order");
    expect(text).toContain("FLAGGED");
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });
});
