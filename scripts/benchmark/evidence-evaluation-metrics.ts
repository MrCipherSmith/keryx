// Offline scoring only; observations must be eligibility-checked by the runner.
export interface EvaluationSpan {
  source: string; version: number; sourceHash: string; startByte: number; endByte: number;
}
function validate(span: EvaluationSpan) {
  if (!span.source || !Number.isSafeInteger(span.version) || span.version < 1 ||
      !/^[a-f0-9]{64}$/.test(span.sourceHash) || !Number.isSafeInteger(span.startByte) ||
      !Number.isSafeInteger(span.endByte) || span.startByte < 0 || span.endByte <= span.startByte) {
    throw Error("invalid evaluation span");
  }
}
const sourceKey = (span: EvaluationSpan) => JSON.stringify([span.source, span.version, span.sourceHash]);
const spanKey = (span: EvaluationSpan) => JSON.stringify([sourceKey(span), span.startByte, span.endByte]);
const contains = (item: EvaluationSpan, label: EvaluationSpan) => sourceKey(item) === sourceKey(label) &&
  item.startByte <= label.startByte && item.endByte >= label.endByte;
export function scoreEvidenceRanking(labels: readonly EvaluationSpan[], ranking: readonly EvaluationSpan[] | null) {
  labels.forEach(validate);
  if (new Set(labels.map(spanKey)).size !== labels.length) throw Error("duplicate evaluation label");
  if (ranking === null) return { recallAt10: null, reciprocalRank: null, sourcePrecision: null };
  ranking.forEach(validate);
  const top = ranking.slice(0, 10), relevant = new Set(labels.map(sourceKey)), delivered = new Set(top.map(sourceKey));
  const first = ranking.findIndex(item => labels.some(label => contains(item, label)));
  return {
    recallAt10: labels.length ? labels.filter(label => top.some(item => contains(item, label))).length / labels.length : null,
    reciprocalRank: labels.length ? (first < 0 ? 0 : 1 / (first + 1)) : null,
    sourcePrecision: delivered.size ? [...delivered].filter(key => relevant.has(key)).length / delivered.size : null,
  };
}
export interface PairedObservation { query: string; baseline: number | null; candidate: number | null }
export function pairedBootstrap(observations: readonly PairedObservation[], seed = 415, repetitions = 2000) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isInteger(repetitions) ||
      repetitions < 100 || repetitions > 100000) throw Error("invalid bootstrap config");
  const seen = new Set<string>(), differences: number[] = [];
  for (const row of observations) {
    if (!row.query || seen.has(row.query)) throw Error("invalid paired query");
    seen.add(row.query);
    for (const value of [row.baseline, row.candidate]) {
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
        throw Error("invalid paired metric");
      }
    }
    if (row.baseline !== null && row.candidate !== null) differences.push(row.candidate - row.baseline);
  }
  const n = differences.length;
  const base = { pairs: n, missingPairs: observations.length - n,
    delta: n ? differences.reduce((sum, value) => sum + value, 0) / n : null, seed, repetitions };
  if (n < 2) return { ...base, confidence95: null };
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const samples: number[] = [];
  for (let i = 0; i < repetitions; i++) {
    let total = 0;
    for (let j = 0; j < n; j++) total += differences[Math.floor(random() * n)]!;
    samples.push(total / n);
  }
  samples.sort((a, b) => a - b);
  const percentile = (fraction: number) => {
    const position = (samples.length - 1) * fraction, lo = Math.floor(position), hi = Math.ceil(position);
    return samples[lo]! + (samples[hi]! - samples[lo]!) * (position - lo);
  };
  return { ...base, confidence95: [percentile(0.025), percentile(0.975)] };
}
export function latencyPercentiles(values: readonly number[]) {
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw Error("invalid latency");
  if (!values.length) return { samples: 0, p50Ms: null, p95Ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, p50Ms: sorted[Math.ceil(values.length * 0.5) - 1]!,
    p95Ms: sorted[Math.ceil(values.length * 0.95) - 1]! };
}
