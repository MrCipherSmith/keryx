// Offline orchestration: no model, network or runtime is loaded here.
import { prepareEvidenceEvaluation } from "./prepare-evidence-evaluation";
import { latencyPercentiles, pairedBootstrap, scoreEvidenceRanking } from "./evidence-evaluation-metrics";
import type { EvaluationSpan } from "./evidence-evaluation-metrics";
const arms = ["A", "B", "C", "D", "E"] as const;
export type EvaluationArm = typeof arms[number];
export interface EvaluationAdapter {
  revision: string;
  scenarios: readonly string[];
  run(input: { datasetHash: string; queryId: string; queryHash: string; repetition: number; signal: AbortSignal }): Promise<
    { status: "ok"; ranking: EvaluationSpan[] } | { status: "unsupported" | "failed" }
  >;
}
type Score = ReturnType<typeof scoreEvidenceRanking>;
interface Observation {
  arm: EvaluationArm; queryId: string; split: string; scenario: string; repetition: number;
  status: "ok" | "missing-adapter" | "unsupported" | "failed" | "invalid-observation" | "timed-out" | "cancelled";
  elapsedMs: number | null; score: Score;
}
const emptyScore = (): Score => ({ recallAt10: null, reciprocalRank: null, sourcePrecision: null });
const simple = new Set(["answerable", "unanswerable", "conflicting", "paraphrased", "instruction-shaped"]);
export async function runEvidenceEvaluation(raw: string, adapters: Partial<Record<EvaluationArm, EvaluationAdapter>>, timeoutMs = 30000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw Error("invalid deadline");
  const prepared = prepareEvidenceEvaluation(raw);
  const data = JSON.parse(raw) as { sources: Array<{
    id: string; version: number; project: string; split: string; state: string; text: string;
  }> };
  const metadata = new Map(data.sources.map(source => [source.id, source]));
  const sources = new Map(prepared.sources.map(source => [source.id, source]));
  for (const key of Object.keys(adapters)) {
    if (!arms.includes(key as EvaluationArm)) throw Error("unknown evaluation arm");
    const adapter = adapters[key as EvaluationArm];
    if (!adapter || typeof adapter.revision !== "string" || !adapter.revision.trim() ||
        !Array.isArray(adapter.scenarios) || adapter.scenarios.some(value => typeof value !== "string") ||
        typeof adapter.run !== "function") throw Error("invalid evaluation adapter");
  }
  const observations: Observation[] = [];
  let cancelled = false;
  for (const arm of arms) {
    const adapter = adapters[arm];
    for (const query of prepared.queries) {
      for (let repetition = 0; repetition < 3; repetition++) {
        const row: Observation = { arm, queryId: query.id, split: String(query.split), scenario: query.kind,
          repetition, status: "missing-adapter", elapsedMs: null, score: emptyScore() };
        observations.push(row);
        if (!adapter) continue;
        if (cancelled) { row.status = "cancelled"; continue; }
        // Never approximate visibility or mutation scenarios as static retrieval.
        if (!simple.has(query.kind) || !adapter.scenarios.includes(query.kind)) {
          row.status = "unsupported"; continue;
        }
        const start = performance.now();
        let result: Awaited<ReturnType<EvaluationAdapter["run"]>>;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let expired = false;
        try {
          const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              expired = true; controller.abort(); reject(Error("deadline"));
            }, timeoutMs);
          });
          result = await Promise.race([deadline, Promise.resolve().then(() => adapter.run({
            datasetHash: prepared.datasetHash, queryId: query.id,
            queryHash: query.queryHash, repetition, signal: controller.signal,
          }))]);
        } catch {
          // In-process cancellation is cooperative: do not start more work after expiry.
          row.status = expired ? "timed-out" : "failed";
          if (expired) cancelled = true;
          continue;
        } finally { clearTimeout(timer); }
        const elapsed = performance.now() - start;
        try {
          if (result.status === "unsupported" || result.status === "failed") {
            row.status = result.status; continue;
          }
          if (result.status !== "ok" || !Array.isArray(result.ranking)) throw Error("invalid result");
          for (const item of result.ranking) {
            const source = sources.get(item.source), info = metadata.get(item.source);
            if (!source || !info || source.version !== item.version || source.sourceHash !== item.sourceHash ||
                info.state !== "active" || info.project !== query.project || info.split !== query.split ||
                item.endByte > Buffer.byteLength(info.text) || query.forbiddenSources.includes(item.source)) {
              throw Error("ineligible observation");
            }
          }
          const labels: EvaluationSpan[] = query.relevant.map(label => ({ ...label, version: Number(label.version) }));
          row.score = scoreEvidenceRanking(labels, result.ranking);
          row.status = "ok"; row.elapsedMs = elapsed;
        } catch { row.status = "invalid-observation" | "timed-out" | "cancelled"; }
      }
    }
  }
  // Timing repetitions are not independent queries. Average only complete triples.
  function queryMetric(arm: EvaluationArm, id: string, metric: keyof Score): number | null {
    const rows = observations.filter(row => row.arm === arm && row.queryId === id);
    if (rows.length !== 3 || rows.some(row => row.status !== "ok" || row.score[metric] === null)) return null;
    return rows.reduce((sum, row) => sum + row.score[metric]!, 0) / 3;
  }
  const comparisons = ["dev", "held-out"].flatMap(split =>
    (["C", "D", "E"] as const).flatMap(candidate =>
      (["recallAt10", "reciprocalRank", "sourcePrecision"] as const).map(metric => ({
        split, baseline: "B", candidate, metric,
        ...pairedBootstrap(prepared.queries.filter(query => query.split === split).map(query => ({
          query: query.id, baseline: queryMetric("B", query.id, metric), candidate: queryMetric(candidate, query.id, metric),
        }))),
      })),
    ));
  return {
    version: 1, status: "offline-orchestration-only", datasetHash: prepared.datasetHash,
    repetitions: 3, observations, comparisons,
    arms: arms.map(arm => ({ arm, revision: adapters[arm]?.revision ?? null,
      latency: latencyPercentiles(observations.filter(row => row.arm === arm && row.status === "ok")
        .map(row => row.elapsedMs!)),
    })),
    rolloutDecision: null,
    limitations: ["Synthetic exploratory corpus, not frozen quality evidence",
      "Caller-supplied adapters: execution provenance is not certified",
      "Visibility and lifecycle need proof-producing runtime drivers and remain unsupported",
      "No grounded-answer judgments, embedding accounting, duplicate-token or recovery metrics",
      "A has narrower coverage and is not used as paired baseline"],
  };
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw Error("expected dataset path");
    // No adapters means missing observations, never fabricated measurements.
    console.log(JSON.stringify(await runEvidenceEvaluation(await Bun.file(args[0]!).text(), {}), null, 2));
  } catch {
    console.error("Evidence evaluation refused: invalid dataset or invocation");
    process.exitCode = 1;
  }
}
