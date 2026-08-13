// Producer for the metastore GDWIKI oracle slice (nDCG + recall@k + hand-labeled
// groundedness), dogfooded on keryx's own `.metaproject/wiki/` corpus (robust, no external
// clone; mirrors run-memory-oracle.ts). This is the thin, I/O-doing half of the pipeline: it
// reads the curated gold queries from fixtures/benchmark/keryx/wiki-gold.json (hand-labeled
// offline — this script does NOT invent or choose gold), obtains the SYSTEM ranked passage
// list per query via the SAME grounded retrieval `keryx wiki ask <q>` runs, writes the
// captured system-output fixture, then scores both with the PURE scorer in
// src/metrics/oracle-runner.ts and prints the paired-3-5-v2 manifest + validation result.
//
// Ground truth (gold): fixtures/benchmark/keryx/wiki-gold.json, curated by hand — a query is
// included only when the relevant wiki page is an OBVIOUS match (a close paraphrase of the
// page's own `## Summary`), one line of justification per query, so it is auditable. The
// per-query GROUNDEDNESS is a separate hand-labeled 3-judge panel in
// fixtures/benchmark/keryx/wiki-groundedness.json (a live-LLM judge is a documented
// follow-up). This script never edits either file.
//
// System output: the ranked citation `path`s `keryx wiki ask <q>` cites, best match first. We
// obtain them by invoking the working-tree `wikiAsk` retrieval directly (src/wiki/ask.ts — the
// exact function the `keryx wiki ask` CLI calls, src/commands/wiki.ts `runAsk`) rather than
// spawning the installed `keryx` binary, which this repo's own memory records as a stale build
// that "does not exercise the code under review" (.metaproject/memory/constraints/
// stale-installed-keryx-binary.md). Importing the working-tree function makes the capture
// reproducible AND faithful to the code under test. `keryx wiki ask` has no `--json` flag; its
// Markdown answer's `## Sources` section lists the identical ranked `path`s, so a CLI-parsing
// variant would yield the same list.
//
// Regenerate with:
//   bun scripts/benchmark/run-gdwiki-oracle.ts
//
// The pure scorer is fully unit-tested offline (src/metrics/oracle-runner.test.ts), so a
// failure here never blocks the metastore slice — it only means the fixture was not
// refreshed. If `wikiAsk` becomes unavailable in the current environment, this producer fails
// loudly rather than fabricating a ranked list; report it as `wiki_result: pending` and keep
// the deterministic scorer + this regen command.

import { validatePairedBenchmark, type JudgeScore } from "../../src/metrics/benchmark";
import { buildWikiAskManifest, type WikiScoreInput } from "../../src/metrics/oracle-runner";
import { wikiAsk } from "../../src/wiki/ask";

type GoldQuery = { target: string; affected: string[]; justification?: string };
type GoldFile = { k?: number; targets?: GoldQuery[] };
type GroundQuery = { target: string; scores: [JudgeScore, JudgeScore, JudgeScore]; justification?: string };
type GroundFile = { targets?: GroundQuery[] };

const fixtureRoot = new URL("../../fixtures/benchmark/keryx/", import.meta.url);
const goldUrl = new URL("wiki-gold.json", fixtureRoot);
const groundUrl = new URL("wiki-groundedness.json", fixtureRoot);
const resultsUrl = new URL("wiki-ask-results.json", fixtureRoot);

const repoRoot = new URL("../../", import.meta.url).pathname;

/** Run the working-tree grounded retrieval for one query → the ranked citation `path` list. */
async function rankedPassages(query: string, k: number): Promise<string[]> {
  // Fetch a few more than k so nDCG/recall@k see the real tail, not a pre-truncated list.
  const result = await wikiAsk({ cwd: repoRoot, question: query, k: Math.max(k, 8) });
  return result.citations.map((citation) => citation.path);
}

async function main(): Promise<void> {
  const gold = JSON.parse(await Bun.file(goldUrl).text()) as GoldFile;
  const ground = JSON.parse(await Bun.file(groundUrl).text()) as GroundFile;
  const queries = gold.targets ?? [];
  const k = typeof gold.k === "number" && gold.k > 0 ? gold.k : 5;
  if (queries.length < 3 || queries.length > 5) {
    throw new Error(`wiki-gold.json must curate 3-5 queries, found ${queries.length}`);
  }

  const groundByQuery = new Map<string, GroundQuery>();
  for (const entry of ground.targets ?? []) groundByQuery.set(entry.target, entry);

  // System output: run the live retrieval per curated gold query. No fabrication — a failed
  // retrieval throws and the whole producer fails loudly (see module comment).
  const systemByQuery = new Map<string, string[]>();
  for (const { target: query } of queries) {
    systemByQuery.set(query, await rankedPassages(query, k));
  }

  // Persist the captured system-output fixture (same shape the CLI's loadAffectedSets reads).
  const resultsFixture = {
    note:
      "SYSTEM output: the ranked citation `path`s `keryx wiki ask \"<query>\"` cites (best match " +
      "first) per gold query in wiki-gold.json, captured against this repo's own .metaproject/wiki/ " +
      "corpus by invoking the working-tree wikiAsk retrieval directly (src/wiki/ask.ts, the exact " +
      "function the CLI's `keryx wiki ask` runs) — not by spawning the stale installed binary. No " +
      "fabricated ranking. Shape matches the AffectedSetFile the CLI already loads: `target` is the " +
      "query, `affected` is the ranked passage id list, best match first.",
    repo: "keryx (dogfood, this repository)",
    corpus: ".metaproject/wiki/**/*.md",
    generated_by:
      "bun scripts/benchmark/run-gdwiki-oracle.ts (wikiAsk({ question, k: max(k,8) }) per gold query, ranked citations[].path)",
    captured: new Date().toISOString().slice(0, 10),
    targets: queries.map(({ target: query }) => ({ target: query, affected: systemByQuery.get(query) ?? [] })),
  };
  await Bun.write(resultsUrl, `${JSON.stringify(resultsFixture, null, 2)}\n`);

  // Score: system ranked list vs curated gold set + hand-labeled groundedness per query.
  const inputs: WikiScoreInput[] = queries.map(({ target: query, affected: goldIds }) => {
    const g = groundByQuery.get(query);
    if (!g) throw new Error(`wiki-groundedness.json is missing a groundedness panel for query: ${query}`);
    return {
      query,
      system: systemByQuery.get(query) ?? [],
      gold: goldIds,
      k,
      groundedness: { scores: g.scores, ...(g.justification ? { rationale: g.justification } : {}) },
    };
  });

  const manifest = buildWikiAskManifest(inputs, { ladder: "metastore" });
  console.log("# layer: gdwiki (gdwiki nDCG/recall@k)");
  console.log(JSON.stringify(manifest, null, 2));
  console.error("# oracle IR result — layer=gdwiki (gdwiki nDCG/recall@k + groundedness)");
  for (const runRecord of manifest.runs) {
    const o = runRecord.oracle;
    const j = runRecord.judge;
    console.error(
      `${runRecord.task_id}: nDCG@${k}=${o?.ndcg?.value} recall@${k}=${o?.recallAtK?.value} ` +
        `groundedness strict=${j?.strict} lenient=${j?.lenient} scores=[${j?.scores.join(",")}]`,
    );
  }
  const result = validatePairedBenchmark(manifest);
  console.error(`# layer=gdwiki manifest valid: ${result.valid ? "yes" : "no"}`);
  for (const err of result.errors) console.error(`- ${err}`);
  console.error("wrote fixtures/benchmark/keryx/wiki-ask-results.json");
  console.error("gold + groundedness are hand-curated and NOT regenerated by this script:");
  console.error("  fixtures/benchmark/keryx/wiki-gold.json, fixtures/benchmark/keryx/wiki-groundedness.json");
  if (!result.valid) process.exit(1);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-gdwiki-oracle failed (offline/bun/wikiAsk unavailable is expected in CI): ${(error as Error).message}`);
    console.error("The pure scorer remains fully unit-tested offline: bun test src/metrics/oracle-runner.test.ts");
    process.exit(1);
  });
}
