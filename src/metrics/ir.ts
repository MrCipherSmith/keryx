// Pure, deterministic, I/O-free IR (information-retrieval) metric primitives for the
// metastore ladder's oracle metrics (see docs/requirements/keryx-benchmark-suite/
// metrics-and-validation.md and OracleMetrics in ./benchmark.ts: precision, recall, f1,
// ndcg, recallAtK, factPreservation). Most of these functions return plain numbers in
// [0, 1]; `precision`/`recall` return `number | null` — `null` on their own empty-
// denominator case, meaning "unmeasured", never a fabricated in-range number (see their
// doc comments) — while f1/ndcg/recallAtK/factPreservation keep their own, separately
// documented vacuous-value conventions and always return a plain number. The caller is
// responsible for wrapping a non-null result in a `BenchmarkValue` with an explicit
// `reliability` level, and for OMITTING (never null-valuing) a manifest field whose
// measurement came back `null` — this module never fabricates a reliability tag and never
// touches I/O.
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
 * Edge case: an empty retrieved set has no denominator — there is nothing to compute a
 * proportion of. Returns `null`, not a number: RESOLVED 2026-09-07, flow 238/T8 (this
 * function previously returned `1`, "vacuously perfect" — see git history / flow 238/T7's
 * decision record for the prior reasoning and why it was wrong). An absence of data is not
 * a confident score, in either direction: `1` here was the same class of bug this
 * benchmark programme keeps finding elsewhere (an absence of data rendered as a confident
 * number), just inverted — a confident PERFECT score instead of a confident zero. Making
 * the return type `number | null` mirrors `UnmeasuredRate` in ./benchmark.ts (`rate: null`,
 * never a fabricated `0`/zero-width CI): arithmetic on an unmeasured precision is now a
 * compile error under this repo's `strict`/`strictNullChecks` tsconfig, not a silently
 * plausible wrong number. Every caller (src/metrics/oracle-runner.ts scoreOracleTarget and
 * its downstream oracleMetrics/oracleMetricsForGold/scoreTestImpactRun/scoreMemorySearchRun)
 * was updated in this same change to OMIT the `precision` field entirely when this returns
 * `null` — never to report it with a null value (OracleMetrics documents "present only when
 * measured"; validatePairedBenchmarkV2's `requireMeasured` guard on `run.oracle.*` actively
 * REJECTS a present field with `value: null`/`reliability: "unknown"`, so omission is the
 * only valid encoding, not a stylistic choice).
 */
export function precision(
  retrieved: readonly string[] | ReadonlySet<string>,
  relevant: readonly string[] | ReadonlySet<string>,
): number | null {
  const retrievedSet = toIdSet(retrieved);
  if (retrievedSet.size === 0) return null;
  const relevantSet = toIdSet(relevant);
  let hits = 0;
  for (const id of retrievedSet) if (relevantSet.has(id)) hits += 1;
  return hits / retrievedSet.size;
}

/**
 * Recall = |retrieved ∩ relevant| / |relevant|, over deduped ID sets (order-independent).
 *
 * Edge case: an empty relevant set has no denominator. Returns `null`, not a number — same
 * fix and same reasoning as `precision` above (RESOLVED 2026-09-07, flow 238/T8): there was
 * nothing relevant to measure recall against, which is an absence of a gold set, not a
 * perfect result. See `precision`'s doc comment for the full rationale (UnmeasuredRate
 * parallel, the `requireMeasured` validator rule that makes omission mandatory, and the
 * updated callers).
 */
export function recall(
  retrieved: readonly string[] | ReadonlySet<string>,
  relevant: readonly string[] | ReadonlySet<string>,
): number | null {
  const relevantSet = toIdSet(relevant);
  if (relevantSet.size === 0) return null;
  const retrievedSet = toIdSet(retrieved);
  let hits = 0;
  for (const id of relevantSet) if (retrievedSet.has(id)) hits += 1;
  return hits / relevantSet.size;
}

/**
 * Harmonic mean of precision and recall.
 *
 * RESOLVED 2026-09-09, flow 238/T15: this function used to fall back `p ?? 1` / `r ?? 1`
 * before combining, so `f1([], [])` — an empty retrieved set AND an empty relevant set,
 * i.e. nothing retrieved and nothing to retrieve — returned `1`, a confidently PERFECT
 * score published from zero measurement. That is the exact class of bug the 2026-09-07
 * precision/recall fix closed one layer down (see their doc comments): an absence of data
 * rendered as a confident number, this time inverted (a fabricated 1 instead of a
 * fabricated 0). `f1` now returns `null` in that one case — precisely when BOTH
 * `precision` and `recall` are themselves `null` (retrieved and relevant both empty) — and
 * every caller must OMIT the field entirely when this is `null`, same "present only when
 * measured" contract as `precision`/`recall` (see ./oracle-runner.ts).
 *
 * Every other case is UNCHANGED from before this fix, including the two single-sided-empty
 * cases: whenever exactly one of `precision`/`recall` is `null` (retrieved is empty XOR
 * relevant is empty, not both), the *other* one is necessarily a real, measured `0` — an
 * empty set can only intersect another set in the empty set — so treating the null side as
 * `0` (not `1`) for the harmonic-mean combination yields the same result either fallback
 * would (2*0*x/(0+x) = 0 regardless of whether the null side is subbed with 0 or 1), while
 * correctly reserving `null` for the one case that actually has no measurement at all.
 *
 * Edge case: when precision + recall === 0 (both real zeros, e.g. non-empty retrieved and
 * relevant sets that share nothing), the harmonic mean's denominator is zero. Defined
 * as 0 in that case, matching the standard IR convention (no overlap => no F1).
 */
export function f1(
  retrieved: readonly string[] | ReadonlySet<string>,
  relevant: readonly string[] | ReadonlySet<string>,
): number | null {
  const p = precision(retrieved, relevant);
  const r = recall(retrieved, relevant);
  if (p === null && r === null) return null; // nothing retrieved AND nothing relevant: no measurement, never a fabricated 1
  const pp = p ?? 0;
  const rr = r ?? 0;
  const denom = pp + rr;
  if (denom === 0) return 0;
  return (2 * pp * rr) / denom;
}

/**
 * Recall@k = |top-k(rankedRetrieved) ∩ relevant| / |relevant|.
 *
 * `rankedRetrieved` is deduped by first occurrence (see module comment) before taking
 * the top k.
 *
 * RESOLVED 2026-09-09, flow 238/T15: an empty relevant set used to return `1`
 * ("vacuously perfect, nothing to miss") — same fabricated-perfect-score bug as `f1`
 * above and `recall`'s own pre-2026-09-07 convention. There is no denominator (nothing
 * was relevant to look for), so this is now `null`, matching `recall`'s own empty-
 * denominator convention exactly. Every caller must OMIT the field entirely when this
 * is `null` (see ./oracle-runner.ts).
 *
 * Edge cases:
 * - empty relevant set: `null` (no denominator — see above).
 * - k <= 0: 0 — no results are considered, so nothing can be recalled (only reachable
 *   when the relevant set is non-empty, since the empty-relevant case is handled first).
 * - k larger than the (deduped) list length: clamped to the list length, i.e. equivalent
 *   to recall over the whole list.
 */
export function recallAtK(
  rankedRetrieved: readonly string[],
  relevant: readonly string[] | ReadonlySet<string>,
  k: number,
): number | null {
  const relevantSet = toIdSet(relevant);
  if (relevantSet.size === 0) return null;
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
 * RESOLVED 2026-09-09, flow 238/T15: IDCG@k === 0 used to return `1` ("nothing was
 * relevant, so nothing could have been missed or misordered") — same fabricated-perfect-
 * score bug as `f1`/`recallAtK` above. IDCG@k is 0 exactly when `min(|relevant|,
 * effectiveK) === 0`, i.e. either the relevant set is empty OR the evaluated window is
 * zero-width (`k` resolves to 0) — both are "nothing was there to measure", not "a
 * perfect outcome was measured". This now returns `null`, the same empty-denominator
 * convention as `precision`/`recall`/`f1`/`recallAtK`. Every caller must OMIT the field
 * entirely when this is `null` (see ./oracle-runner.ts).
 *
 * Edge cases:
 * - empty relevant set, or a zero-width window (`k` resolves to 0): `null` (no
 *   denominator — see above).
 * - empty rankedRetrieved (with a non-empty relevant set and effectiveK > 0): DCG@k is 0,
 *   yielding 0/IDCG@k = 0 — a real, measured zero, not an absence of measurement.
 * - k omitted: defaults to the full (deduped) length of `rankedRetrieved`.
 * - k larger than the deduped list length: clamped to the list length.
 */
export function ndcg(
  rankedRetrieved: readonly string[],
  relevant: readonly string[] | ReadonlySet<string>,
  k?: number,
): number | null {
  const relevantSet = toIdSet(relevant);
  const deduped = dedupeRanked(rankedRetrieved);
  const effectiveK = k === undefined ? deduped.length : Math.max(0, k);

  const idealCount = Math.min(relevantSet.size, effectiveK);
  let idcg = 0;
  for (let i = 1; i <= idealCount; i += 1) idcg += 1 / Math.log2(i + 1);
  if (idcg === 0) return null;

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
 * RESOLVED 2026-09-09, flow 238/T15: an empty raw-facts set used to return `1` ("there
 * were no facts to preserve, so none were lost") — same fabricated-perfect-score bug as
 * `f1`/`recallAtK`/`ndcg` above. There is no denominator (nothing was there to compact),
 * so this is now `null`, the same empty-denominator convention used throughout this
 * module. The caller (./oracle-runner.ts scoreGdctxRun) already guarded the companion
 * `rates.factPreservation` Wilson-CI rate on `rawSet.size > 0`, but previously still
 * emitted `oracle.factPreservation` unconditionally with this function's old fabricated
 * `1` — that field is now OMITTED entirely when this returns `null`.
 *
 * Edge case: an empty raw-facts set has no denominator. `null` — see above.
 */
export function factPreservation(
  rawFacts: readonly string[] | ReadonlySet<string>,
  compactFacts: readonly string[] | ReadonlySet<string>,
): number | null {
  const rawSet = toIdSet(rawFacts);
  if (rawSet.size === 0) return null;
  const compactSet = toIdSet(compactFacts);
  let preserved = 0;
  for (const id of rawSet) if (compactSet.has(id)) preserved += 1;
  return preserved / rawSet.size;
}
