import { describe, expect, test } from "bun:test";
import { f1, factPreservation, ndcg, precision, recall, recallAtK } from "./ir";

describe("precision", () => {
  test("perfect: retrieved is a subset of relevant", () => {
    expect(precision(["a", "b"], ["a", "b", "c"])).toBe(1);
  });

  test("zero: no overlap", () => {
    expect(precision(["x", "y"], ["a", "b"])).toBe(0);
  });

  test("partial: hand-computed 2/3", () => {
    // retrieved = {a, b, c}, relevant = {a, b} -> hits = 2, |retrieved| = 3
    expect(precision(["a", "b", "c"], ["a", "b"])).toBeCloseTo(2 / 3, 10);
  });

  test("edge case: empty retrieved set is unmeasured (null), never a fabricated score", () => {
    expect(precision([], ["a", "b"])).toBeNull();
    expect(precision(new Set(), new Set())).toBeNull();
  });

  test("duplicate IDs in retrieved are deduped before dividing", () => {
    // deduped retrieved = {a, b}; relevant = {a}; hits = 1 / 2
    expect(precision(["a", "a", "b"], ["a"])).toBeCloseTo(0.5, 10);
  });

  test("accepts ReadonlySet inputs directly", () => {
    expect(precision(new Set(["a", "b"]), new Set(["a", "b", "c"]))).toBe(1);
  });
});

describe("recall", () => {
  test("perfect: all relevant items retrieved", () => {
    expect(recall(["a", "b", "c"], ["a", "b"])).toBe(1);
  });

  test("zero: no overlap", () => {
    expect(recall(["x", "y"], ["a", "b"])).toBe(0);
  });

  test("partial: hand-computed 1/2", () => {
    expect(recall(["a"], ["a", "b"])).toBeCloseTo(0.5, 10);
  });

  test("edge case: empty relevant set is unmeasured (null), never a fabricated score", () => {
    expect(recall(["a", "b"], [])).toBeNull();
    expect(recall([], [])).toBeNull();
  });

  test("duplicate IDs in relevant are deduped before dividing", () => {
    // deduped relevant = {a, b}; retrieved = {a}; hits = 1 / 2
    expect(recall(["a"], ["a", "a", "b"])).toBeCloseTo(0.5, 10);
  });
});

describe("f1", () => {
  test("perfect precision and recall -> f1 = 1", () => {
    expect(f1(["a", "b"], ["a", "b"])).toBe(1);
  });

  test("zero overlap -> f1 = 0", () => {
    expect(f1(["x"], ["a"])).toBe(0);
  });

  test("partial: hand-computed harmonic mean", () => {
    // retrieved = {a, b, c}, relevant = {a, b, d}
    // precision = 2/3, recall = 2/3 -> f1 = 2*(2/3*2/3)/(2/3+2/3) = 2/3
    expect(f1(["a", "b", "c"], ["a", "b", "d"])).toBeCloseTo(2 / 3, 10);
  });

  test("edge case: both retrieved and relevant empty -> unmeasured (null), never a fabricated 1 (flow 238/T15)", () => {
    expect(f1([], [])).toBeNull();
  });

  test("edge case: empty retrieved, non-empty relevant -> unmeasured precision treated as neutral -> f1 = 0", () => {
    // precision([], ["a"]) is null (unmeasured); recall([], ["a"]) is 0 (real: nothing
    // retrieved so nothing recalled). f1 must still be a plain number (unchanged contract).
    expect(f1([], ["a"])).toBe(0);
  });

  test("edge case: non-empty retrieved, empty relevant -> unmeasured recall treated as neutral -> f1 = 0", () => {
    // precision(["a"], []) is 0 (real: nothing in retrieved is relevant); recall(["a"], [])
    // is null (unmeasured, nothing to miss).
    expect(f1(["a"], [])).toBe(0);
  });
});

describe("recallAtK", () => {
  const ranked = ["c", "a", "d", "b"]; // relevant items at rank 2 (a) and rank 4 (b)

  test("hand-computed boundary: k covers exactly one relevant hit", () => {
    // top-2 = [c, a]; relevant = {a, b}; hits = 1 -> 1/2
    expect(recallAtK(ranked, ["a", "b"], 2)).toBeCloseTo(0.5, 10);
  });

  test("k larger than list length is clamped to the full list", () => {
    expect(recallAtK(ranked, ["a", "b"], 100)).toBe(1);
  });

  test("k = 0 retrieves nothing -> 0 (relevant set non-empty)", () => {
    expect(recallAtK(ranked, ["a", "b"], 0)).toBe(0);
  });

  test("negative k behaves like k = 0 -> 0", () => {
    expect(recallAtK(ranked, ["a", "b"], -5)).toBe(0);
  });

  test("edge case: empty relevant set is unmeasured (null) regardless of k, never a fabricated 1 (flow 238/T15)", () => {
    expect(recallAtK(ranked, [], 0)).toBeNull();
    expect(recallAtK(ranked, [], 2)).toBeNull();
  });

  test("duplicate IDs keep only the first (best-ranked) occurrence", () => {
    // deduped ranking = [a, b]; top-1 = [a]; relevant = {a} -> 1
    expect(recallAtK(["a", "a", "b"], ["a"], 1)).toBe(1);
  });
});

describe("ndcg", () => {
  test("hand-computed: relevant = {A, B}, ranking = [C, A, B], k = 3", () => {
    // DCG@3  = rel(C)/log2(2) + rel(A)/log2(3) + rel(B)/log2(4)
    //        = 0 + 1/log2(3) + 1/log2(4) = 0.6309297535714575 + 0.5 = 1.1309297535714575
    // IDCG@3 = 1/log2(2) + 1/log2(3) (min(|relevant|=2, k=3) = 2 ideal slots)
    //        = 1 + 0.6309297535714575 = 1.6309297535714575
    // nDCG@3 = 1.1309297535714575 / 1.6309297535714575 = 0.6934264036172046
    const value = ndcg(["C", "A", "B"], ["A", "B"], 3);
    expect(value).toBeCloseTo(0.6934264036172046, 10);
  });

  test("perfect ranking: all relevant items first -> nDCG = 1", () => {
    expect(ndcg(["A", "B", "C"], ["A", "B"], 3)).toBeCloseTo(1, 10);
  });

  test("zero: no relevant item retrieved", () => {
    expect(ndcg(["X", "Y"], ["A", "B"], 2)).toBe(0);
  });

  test("edge case: empty relevant set is unmeasured (null), never a fabricated 1 (flow 238/T15)", () => {
    expect(ndcg(["A", "B"], [], 2)).toBeNull();
  });

  test("edge case: zero-width window (k resolves to 0) with non-empty relevant is also unmeasured (null)", () => {
    expect(ndcg(["A", "B"], ["A"], 0)).toBeNull();
  });

  test("edge case: empty ranking with non-empty relevant -> 0", () => {
    expect(ndcg([], ["A"], 2)).toBe(0);
  });

  test("k omitted defaults to the full ranked list length", () => {
    // ranking = [B, A], relevant = {A, B} -> both hits, effectiveK = 2 (list length)
    // DCG = 1/log2(2) + 1/log2(3), IDCG = same two ideal terms -> nDCG = 1
    expect(ndcg(["B", "A"], ["A", "B"])).toBeCloseTo(1, 10);
  });

  test("k larger than list length is clamped to the list length", () => {
    expect(ndcg(["A", "B"], ["A", "B"], 100)).toBeCloseTo(1, 10);
  });

  test("duplicate IDs keep only the first (best-ranked) occurrence", () => {
    // deduped ranking = [A, B]; relevant = {A} -> DCG = 1/log2(2) = 1, IDCG (min(1,2)=1) = 1 -> nDCG = 1
    expect(ndcg(["A", "A", "B"], ["A"], 2)).toBeCloseTo(1, 10);
  });
});

describe("factPreservation", () => {
  test("perfect: all raw facts preserved", () => {
    expect(factPreservation(["f1", "f2"], ["f1", "f2", "f3"])).toBe(1);
  });

  test("zero: none preserved", () => {
    expect(factPreservation(["f1", "f2"], ["f3", "f4"])).toBe(0);
  });

  test("partial: hand-computed 1/3", () => {
    expect(factPreservation(["f1", "f2", "f3"], ["f1"])).toBeCloseTo(1 / 3, 10);
  });

  test("edge case: empty raw-facts set is unmeasured (null), never a fabricated 1 (flow 238/T15)", () => {
    expect(factPreservation([], ["f1"])).toBeNull();
    expect(factPreservation([], [])).toBeNull();
  });

  test("duplicate IDs in rawFacts are deduped before dividing", () => {
    // deduped raw = {f1, f2}; compact = {f1}; preserved = 1 / 2
    expect(factPreservation(["f1", "f1", "f2"], ["f1"])).toBeCloseTo(0.5, 10);
  });
});
