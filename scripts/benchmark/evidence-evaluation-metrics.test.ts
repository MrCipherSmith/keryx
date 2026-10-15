import { expect, test } from "bun:test";
import { latencyPercentiles, pairedBootstrap, scoreEvidenceRanking } from "./evidence-evaluation-metrics";
const label = { source: "s", version: 1, sourceHash: "a".repeat(64), startByte: 4, endByte: 20 };
test("matches complete spans with exact source version and hash", () => {
  expect(scoreEvidenceRanking([label], [{ ...label, startByte: 0, endByte: 30 }])).toEqual({
    recallAt10: 1, reciprocalRank: 1, sourcePrecision: 1 });
  for (const patch of [{ version: 2 }, { sourceHash: "b".repeat(64) }, { startByte: 5 }, { endByte: 19 }]) {
    expect(scoreEvidenceRanking([label], [{ ...label, ...patch }]).recallAt10).toBe(0);
  }
});
test("duplicates do not inflate recall or source precision", () => {
  expect(scoreEvidenceRanking([label], [{ ...label, source: "other" }, label, label])).toEqual({
    recallAt10: 1, reciprocalRank: 0.5, sourcePrecision: 0.5 });
  expect(() => scoreEvidenceRanking([label, label], [])).toThrow();
});
test("Recall@10 and full-ranking MRR have explicit cutoffs", () => {
  const misses = Array.from({ length: 10 }, () => ({ ...label, source: "other" }));
  expect(scoreEvidenceRanking([label], [...misses, label])).toEqual({
    recallAt10: 0, reciprocalRank: 1 / 11, sourcePrecision: 0 });
});
test("missing observations and unanswerable denominator remain null", () => {
  const missing = { recallAt10: null, reciprocalRank: null, sourcePrecision: null };
  expect(scoreEvidenceRanking([label], null)).toEqual(missing);
  expect(scoreEvidenceRanking([], [])).toEqual(missing);
  expect(scoreEvidenceRanking([label], []).recallAt10).toBe(0);
  expect(() => scoreEvidenceRanking([{ ...label, startByte: -1 }], [])).toThrow();
});
test("bootstrap is deterministic, paired, and reports missing pairs", () => {
  const rows = [{ query: "a", baseline: 0.2, candidate: 0.7 },
    { query: "b", baseline: 0.4, candidate: 0.9 }, { query: "c", baseline: null, candidate: 0.3 }];
  const result = pairedBootstrap(rows);
  expect(result).toEqual(pairedBootstrap(rows));
  expect(result.pairs).toBe(2); expect(result.missingPairs).toBe(1);
  expect(result.delta).toBeCloseTo(0.5);
  expect(result.confidence95![0]).toBeCloseTo(0.5); expect(result.confidence95![1]).toBeCloseTo(0.5);
  expect(pairedBootstrap(rows.slice(0, 1)).confidence95).toBeNull();
  expect(pairedBootstrap([]).delta).toBeNull();
});
test("bootstrap rejects duplicate queries and malformed values", () => {
  const row = { query: "a", baseline: 0, candidate: 1 };
  expect(() => pairedBootstrap([row, row])).toThrow();
  expect(() => pairedBootstrap([{ ...row, candidate: NaN }])).toThrow();
  expect(() => pairedBootstrap([{ ...row, baseline: -1 }])).toThrow();
  expect(() => pairedBootstrap([row], 0, 0)).toThrow();
});
test("latency uses nearest rank without mutating samples", () => {
  const samples = [30, 10, 20];
  expect(latencyPercentiles(samples)).toEqual({ samples: 3, p50Ms: 20, p95Ms: 30 });
  expect(samples).toEqual([30, 10, 20]);
  expect(latencyPercentiles([])).toEqual({ samples: 0, p50Ms: null, p95Ms: null });
  expect(() => latencyPercentiles([Infinity])).toThrow();
});
