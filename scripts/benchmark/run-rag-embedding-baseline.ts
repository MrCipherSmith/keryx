// M3 RAG-adapter baseline: a minimal, LOCAL, real-embedding semantic search over keryx's own
// `.metaproject/wiki/` corpus, scored against the SAME curated gold queries as the gdwiki
// metastore oracle (fixtures/benchmark/keryx/wiki-gold.json) — never averaged with it, reported
// side by side (docs/requirements/keryx-benchmark-suite/plan.md M3: "RAG/context-tool adapter").
//
// Why this exists: keryx's own `wikiAsk` (src/wiki/ask.ts) is DETERMINISTIC LEXICAL retrieval
// (Jaccard token overlap) by default, with only an OPTIONAL embedding rerank gated behind a
// capability that is dormant in this environment (no `memory-embed-default` entry in this
// repo's `.metaproject/assets.lock.json` — wiring that up for real would need a pinned asset
// URL/sha256 plus an ADR for the optional dependency it requires, out of scope for a benchmark
// script). So a genuine embedding-based RAG baseline is a non-redundant comparison target, not
// a reimplementation of something keryx already does.
//
// Embedding source: `@xenova/transformers` (devDependency only — never a runtime/optionalDep of
// the shipped CLI, never touches `src/memory`'s core capability seam or `assets.lock.json`),
// running `Xenova/all-MiniLM-L6-v2` (ONNX) locally, fully offline after the one-time model
// download (~90MB, cached under `~/.cache/huggingface` by transformers.js). This mirrors the
// user's original ask for a local baseline — rapid-mlx was tried first and confirmed unable to
// serve this model (`ModuleNotFoundError: No module named 'mlx_lm.models.bert'`; rapid-mlx only
// serves causal-LM chat architectures, not BERT-family encoders).
//
// Candidate pool: the wiki corpus only (`.metaproject/wiki/**/*.md`, same universe wiki-gold.json
// documents), via the SAME `collectPages` keryx's own `wikiAsk` calls — NOT `wikiAsk`'s combined
// wiki+memory pool. This keeps the comparison honest: it is not byte-identical to what `keryx
// wiki ask` searches (memory entries are excluded here), but it is the exact corpus the gold
// file defines as ground truth, and that difference is disclosed here rather than hidden.
//
// Groundedness (does the top citation actually support an answer) is INTENTIONALLY OMITTED for
// this baseline. wiki-groundedness.json's hand labels describe wikiAsk's own specific citation
// ORDER for each query (e.g. one case's justification is "the answer LEADS with project-map.md"
// — a fact about wikiAsk's ranking, not a property of the query alone), so reusing those scores
// for a DIFFERENT system's ranking would misattribute another system's judgment. Only the
// objective, ranking-derived metrics (nDCG@k, recall@k) are reported here; `judge` is left unset
// on every run (PairedBenchmarkRunV2.judge is optional).
//
// Regenerate with:
//   bun scripts/benchmark/run-rag-embedding-baseline.ts

import { validatePairedBenchmark, type BenchmarkValue, type PairedBenchmarkManifestV2, type PairedBenchmarkRunV2 } from "../../src/metrics/benchmark";
import { ndcg, recallAtK } from "../../src/metrics/ir";
import { collectPages } from "../../src/wiki/collect";
import type { WikiPage } from "../../src/wiki/types";

type GoldQuery = { target: string; affected: string[]; justification?: string };
type GoldFile = { k?: number; targets?: GoldQuery[] };

const fixtureRoot = new URL("../../fixtures/benchmark/keryx/", import.meta.url);
const goldUrl = new URL("wiki-gold.json", fixtureRoot);
const resultsUrl = new URL("wiki-ask-results-embedding-baseline.json", fixtureRoot);

const repoRoot = new URL("../../", import.meta.url).pathname;

const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_MODEL_LABEL = "embedding-baseline (Xenova/all-MiniLM-L6-v2, local ONNX, mean-pooled + normalized)";

type Candidate = { path: string; title: string; text: string };

async function wikiCandidates(cwd: string): Promise<Candidate[]> {
  const pages = await collectPages(cwd);
  return pages.map((page: WikiPage) => ({
    path: `wiki/${page.relativePath}`,
    title: page.title,
    text: `${page.title} ${page.summary}`.trim(),
  }));
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function measured(value: number, source: string): BenchmarkValue {
  return { value, reliability: "exact", source };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function main(): Promise<void> {
  const gold = JSON.parse(await Bun.file(goldUrl).text()) as GoldFile;
  const queries = gold.targets ?? [];
  const k = typeof gold.k === "number" && gold.k > 0 ? gold.k : 5;
  if (queries.length < 3 || queries.length > 5) {
    throw new Error(`wiki-gold.json must curate 3-5 queries, found ${queries.length}`);
  }

  // Real, live embedding inference — no fabrication. A missing/unresolvable optional
  // dependency fails the whole producer loudly (see module comment + the `main().catch`
  // handler below), the same discipline every other producer script in this directory follows.
  const { pipeline } = await import("@xenova/transformers");
  const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL);
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    const dim = out.dims[out.dims.length - 1] as number;
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 1) {
      vectors.push(out.data.slice(i * dim, (i + 1) * dim) as Float32Array);
    }
    return vectors;
  };

  const candidates = await wikiCandidates(repoRoot);
  const candidateVectors = await embed(candidates.map((c) => c.text));

  const systemByQuery = new Map<string, string[]>();
  for (const { target: query } of queries) {
    const [queryVector] = await embed([query]);
    if (!queryVector) throw new Error(`embedding failed for query: ${query}`);
    const ranked = candidates
      .map((candidate, i) => ({ candidate, sim: cosine(queryVector, candidateVectors[i] as Float32Array) }))
      .sort((a, b) => b.sim - a.sim || a.candidate.path.localeCompare(b.candidate.path));
    systemByQuery.set(
      query,
      ranked.slice(0, Math.max(k, 8)).map((r) => r.candidate.path),
    );
  }

  const resultsFixture = {
    note:
      "SYSTEM output: the ranked wiki page `path`s a LOCAL, LIVE Xenova/all-MiniLM-L6-v2 " +
      "embedding search returns (cosine similarity, best match first) per gold query in " +
      "wiki-gold.json, over the SAME .metaproject/wiki/ corpus keryx's own wikiCandidates() " +
      "builds (title + summary text per page). No fabricated ranking; not wikiAsk's own " +
      "lexical retrieval — this is the independent RAG-adapter comparison leg (M3). Groundedness " +
      "is intentionally not scored here (see module header comment); only nDCG/recall@k are " +
      "reported, never averaged with the gdwiki lexical oracle's numbers.",
    repo: "keryx (dogfood, this repository)",
    corpus: ".metaproject/wiki/**/*.md",
    model: EMBEDDING_MODEL_LABEL,
    generated_by: "bun scripts/benchmark/run-rag-embedding-baseline.ts",
    captured: new Date().toISOString().slice(0, 10),
    targets: queries.map(({ target: query }) => ({ target: query, affected: systemByQuery.get(query) ?? [] })),
  };
  await Bun.write(resultsUrl, `${JSON.stringify(resultsFixture, null, 2)}\n`);

  const source =
    `local embedding search (${EMBEDDING_MODEL_LABEL}) over .metaproject/wiki/**/*.md ` +
    `vs curated Q→passage gold (fixtures/benchmark/keryx/wiki-gold.json)`;

  const runs: PairedBenchmarkRunV2[] = queries.map(({ target: query, affected: goldIds }) => {
    const system = systemByQuery.get(query) ?? [];
    const nd = round(ndcg(system, goldIds, k));
    const atK = round(recallAtK(system, goldIds, k));
    const taskId = `metastore:rag-embedding-baseline:${query}`;
    return {
      task_id: taskId,
      variant: "baseline",
      run_id: `${taskId}#1`,
      ladder: "metastore",
      model: EMBEDDING_MODEL_LABEL,
      cacheState: "unknown",
      leakageAssertion: "not-applicable",
      caseKind: "deterministic",
      tokenCap: null,
      seeds: [1],
      quality: "measured",
      oracle: {
        ndcg: measured(nd, `${source} [layer=gdwiki-comparative: nDCG@${k}]`),
        recallAtK: measured(atK, `${source} [layer=gdwiki-comparative: recall@${k}]`),
      },
      human_interventions: null,
    };
  });

  const manifest: PairedBenchmarkManifestV2 = {
    protocol: "paired-3-5-v2",
    ladder: "metastore",
    task_ids: [...new Set(runs.map((run) => run.task_id))].sort(),
    runs,
    speedClaim: { claimed: false },
  };

  console.log("# layer: rag-embedding-baseline (local Xenova/all-MiniLM-L6-v2 vs gdwiki-lexical gold)");
  console.log(JSON.stringify(manifest, null, 2));
  console.error("# RAG-adapter baseline result — layer=rag-embedding-baseline");
  for (const run of manifest.runs) {
    const o = run.oracle;
    console.error(`${run.task_id}: nDCG@${k}=${o?.ndcg?.value} recall@${k}=${o?.recallAtK?.value}`);
  }
  const result = validatePairedBenchmark(manifest);
  console.error(`# layer=rag-embedding-baseline manifest valid: ${result.valid ? "yes" : "no"}`);
  for (const err of result.errors) console.error(`- ${err}`);
  console.error("wrote fixtures/benchmark/keryx/wiki-ask-results-embedding-baseline.json");
  console.error(
    "compare side by side (never averaged) with fixtures/benchmark/keryx/wiki-ask-results.json " +
      "(gdwiki lexical oracle, same gold, same k)",
  );
  if (!result.valid) process.exit(1);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `run-rag-embedding-baseline failed (offline/@xenova/transformers unavailable is expected ` +
        `in CI without the model cached): ${(error as Error).message}`,
    );
    process.exit(1);
  });
}
