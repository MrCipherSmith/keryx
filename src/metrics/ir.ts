// Pure, deterministic, I/O-free IR (information-retrieval) metric primitives for the
// metastore ladder's oracle metrics (see docs/requirements/keryx-benchmark-suite/
// metrics-and-validation.md and OracleMetrics in ./benchmark.ts: precision, recall, f1,
// ndcg, recallAtK, factPreservation). These functions return plain numbers in [0, 1];
// the caller is responsible for wrapping a result in a `BenchmarkValue` with an explicit
// `reliability` level — this module never fabricates a reliability tag and never touches
// I/O.
//
// Duplicate-ID rule: everywhere an ID set is required (precision/recall/f1/
// factPreservation), duplicate IDs are deduped via `Set` before comparison — an ID
// either was retrieved/relevant/preserved or it wasn't; repetition does not change that.
// Everywhere a *ranked* list is required (recallAtK/ndcg), duplicates are deduped by
// keeping only the first (best-ranked) occurrence of each ID and dropping later repeats,
// so a retrieval system cannot inflate its score by repeating the same hit.

/** Dedupe an ID set-ish input into a plain Set, accepting either shape. */
function toIdSet(ids: readonly string[] | ReadonlySet<string>): ReadonlySet<string> {
  return ids instanceof Set ? ids : new Set(ids);
}

/** Dedupe a ranked list by first occurrence, dropping later repeats of the same ID. */
function dedupeRanked(rankedRetrieved: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of rankedRetrieved) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Precision = |retrieved ∩ relevant| / |retrieved|, over deduped ID sets (order-independent).
 *
 * Edge case: an empty retrieved set has no denominator. Defined as 1 — retrieving
 * nothing relevant-or-not contains no false positive, so precision is vacuously perfect.
 * This mirrors the convention used for `recall` below (empty target set => 1) and avoids
 * silently returning 0 or NaN for a set with no elements to be wrong about.
 */
export function precision(
  retrieved: readonly string[] | ReadonlySet<string>,
  relevant: readonly string[] | ReadonlySet<string>,
): number {
  const retrievedSet = toIdSet(retrieved);
  if (retrievedSet.size === 0) return 1;
  const relevantSet = toIdSet(relevant);
  let hits = 0;
  for (const id of retrievedSet) if (relevantSet.has(id)) hits += 1;
  return hits / retrievedSet.size;
}

/**
 * Recall = |retrieved ∩ relevant| / |relevant|, over deduped ID sets (order-independent).
 *
 * Edge case: an empty relevant set has no denominator. Defined as 1 — there was nothing
 * relevant to miss, so recall against an empty gold set is vacuously perfect. Never
 * returns 0/NaN for this case.
 */
export function recall(
  retrieved: readonly string[] | ReadonlySet<string>,
  relevant: readonly string[] | ReadonlySet<string>,
): number {
  const relevantSet = toIdSet(relevant);
  if (relevantSet.size === 0) return 1;
  const retrievedSet = toIdSet(retrieved);
  let hits = 0;
  for (const id of relevantSet) if (retrievedSet.has(id)) hits += 1;
  return hits / relevantSet.size;
}

/**
 * Harmonic mean of precision and recall.
 *
 * Edge case: when precision + recall === 0 (both zero, e.g. non-empty retrieved and
 * relevant sets that share nothing), the harmonic mean's denominator is zero. Defined
 * as 0 in that case, matching the standard IR convention (no overlap => no F1).
 */
export function f1(
  retrieved: readonly string[] | ReadonlySet<string>,
  relevant: readonly string[] | ReadonlySet<string>,
): number {
  const p = precision(retrieved, relevant);
  const r = recall(retrieved, relevant);
  const denom = p + r;
  if (denom === 0) return 0;
  return (2 * p * r) / denom;
}

/**
 * Recall@k = |top-k(rankedRetrieved) ∩ relevant| / |relevant|.
 *
 * `rankedRetrieved` is deduped by first occurrence (see module comment) before taking
 * the top k.
 *
 * Edge cases:
 * - empty relevant set: 1 (same convention as `recall`, nothing to miss).
 * - k <= 0: 0 — no results are considered, so nothing can be recalled (only reachable
 *   when the relevant set is non-empty, since the empty-relevant case is handled first).
 * - k larger than the (deduped) list length: clamped to the list length, i.e. equivalent
 *   to recall over the whole list.
 */
export function recallAtK(
  rankedRetrieved: readonly string[],
  relevant: readonly string[] | ReadonlySet<string>,
  k: number,
): number {
  const relevantSet = toIdSet(relevant);
  if (relevantSet.size === 0) return 1;
  if (k <= 0) return 0;
  const deduped = dedupeRanked(rankedRetrieved);
  const topK = deduped.slice(0, Math.min(k, deduped.length));
  let hits = 0;
  for (const id of relevantSet) if (topK.includes(id)) hits += 1;
  return hits / relevantSet.size;
}

/**
 * Binary-relevance nDCG@k: DCG@k normalized by the ideal DCG@k (IDCG@k).
 *
 * Definitions (fixed, documented so results are reproducible):
 * - Relevance is binary: rel(id) = 1 if id ∈ relevant, else 0.
 * - Discount uses log base 2: DCG@k = Σ_{i=1..k} rel(id_i) / log2(i + 1), i-th rank
 *   (1-indexed) taken from the deduped `rankedRetrieved` list (see module comment on
 *   duplicate handling — a repeated ID keeps only its first, best-ranked position).
 * - IDCG@k is the DCG of the ideal ranking: all min(|relevant|, k) relevant items placed
 *   first, i.e. IDCG@k = Σ_{i=1..min(|relevant|,k)} 1 / log2(i + 1).
 * - nDCG@k = DCG@k / IDCG@k.
 * - Ties (multiple items with the same binary relevance) are not distinguished — binary
 *   relevance has no intra-class ordering to break, so whatever order `rankedRetrieved`
 *   provides is used as-is; this function does not re-sort or randomize among ties.
 *
 * Hand-computed example (see ir.test.ts for the executable version):
 *   relevant = {A, B}, rankedRetrieved = [C, A, B], k = 3
 *   DCG@3   = rel(C)/log2(2) + rel(A)/log2(3) + rel(B)/log2(4)
 *           = 0 + 1/log2(3) + 1/log2(4) = 0 + 0.630930 + 0.5 = 1.130930
 *   IDCG@3  = 1/log2(2) + 1/log2(3) = 1 + 0.630930 = 1.630930  (min(2,3)=2 relevant items)
 *   nDCG@3  = 1.130930 / 1.630930 ≈ 0.693426
 *
 * Edge cases:
 * - empty relevant set: IDCG@k is 0 by definition (no relevant items to place). Defined
 *   as 1 — nothing was relevant, so nothing could have been missed or misordered. This
 *   matches the "empty relevant => vacuously perfect" convention used by recall/recall@k.
 * - empty rankedRetrieved (or k <= 0): DCG@k is 0; when relevant is non-empty this
 *   yields 0/IDCG@k = 0.
 * - k omitted: defaults to the full (deduped) length of `rankedRetrieved`.
 * - k larger than the deduped list length: clamped to the list length.
 */
export function ndcg(
  rankedRetrieved: readonly string[],
  relevant: readonly string[] | ReadonlySet<string>,
  k?: number,
): number {
  const relevantSet = toIdSet(relevant);
  const deduped = dedupeRanked(rankedRetrieved);
  const effectiveK = k === undefined ? deduped.length : Math.max(0, k);

  const idealCount = Math.min(relevantSet.size, effectiveK);
  let idcg = 0;
  for (let i = 1; i <= idealCount; i += 1) idcg += 1 / Math.log2(i + 1);
  if (idcg === 0) return 1;

  const topK = deduped.slice(0, Math.min(effectiveK, deduped.length));
  let dcg = 0;
  for (const [index, id] of topK.entries()) {
    if (!relevantSet.has(id)) continue;
    const rank = index + 1; // 1-indexed
    dcg += 1 / Math.log2(rank + 1);
  }
  return dcg / idcg;
}

/**
 * Fact-preservation rate: the fraction of a raw output's facts that survive in a
 * compacted form, over deduped ID sets (order-independent). Facts are identified by
 * caller-assigned IDs (e.g. stable hashes or indices of extracted claims) — this
 * function does no extraction, only set comparison.
 *
 * Edge case: an empty raw-facts set has no denominator. Defined as 1 — there were no
 * facts to preserve, so none were lost. Matches the "empty target => vacuously perfect"
 * convention used throughout this module.
 */
export function factPreservation(
  rawFacts: readonly string[] | ReadonlySet<string>,
  compactFacts: readonly string[] | ReadonlySet<string>,
): number {
  const rawSet = toIdSet(rawFacts);
  if (rawSet.size === 0) return 1;
  const compactSet = toIdSet(compactFacts);
  let preserved = 0;
  for (const id of rawSet) if (compactSet.has(id)) preserved += 1;
  return preserved / rawSet.size;
}
