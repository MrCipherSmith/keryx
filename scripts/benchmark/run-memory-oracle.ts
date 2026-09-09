// Producer for the metastore MEMORY oracle slice (recall@k), dogfooded on keryx's own
// `.metaproject/memory/` corpus (robust, no external clone; mirrors run-testing-oracle.ts).
// This is the thin, I/O-doing half of the pipeline: it reads the curated gold queries from
// fixtures/benchmark/keryx/memory-gold.json (hand-labeled offline — this script does NOT
// invent or choose gold), runs `keryx memory search <query> --json --limit 10` for the
// SYSTEM ranked path list, writes the captured system-output fixture, then scores both
// with the PURE scorer in src/metrics/oracle-runner.ts and prints the paired-3-5-v2
// manifest + validation result.
//
// Ground truth (gold): fixtures/benchmark/keryx/memory-gold.json, curated by hand — a query
// is included only when the relevant memory entry is an OBVIOUS match (a close paraphrase
// of the entry's own title/summary), one line of justification per query, so it is
// auditable. This script never edits that file.
//
// System output: `keryx memory search <query> --json --limit 10`, ranked `results[].path`
// best-first. No `keryx memory index`/`analyze` side effect is needed — search scans
// canonical Markdown directly (see .metaproject/memory/index.md) — but if a future change
// makes search consult generated data under `.metaproject/data/`, revert it the same way
// run-testing-oracle.ts does: `git checkout -- .metaproject/data`.
//
// Regenerate with:
//   bun scripts/benchmark/run-memory-oracle.ts
//
// The pure scorer is fully unit-tested offline (src/metrics/oracle-runner.test.ts), so a
// failure here never blocks the metastore slice — it only means the fixture was not
// refreshed. If `keryx memory search` is unavailable in the current environment, this
// producer fails loudly rather than fabricating a ranked list; report it as
// `memory_result: pending` and keep the deterministic scorer + this regen command.

import { validatePairedBenchmark, type PairedBenchmarkManifestV2 } from "../../src/metrics/benchmark";
import { buildMemorySearchManifest, type MemoryScoreInput } from "../../src/metrics/oracle-runner";

type GoldQuery = { target: string; affected: string[]; justification?: string };
type GoldFile = { k?: number; targets?: GoldQuery[] };

const fixtureRoot = new URL("../../fixtures/benchmark/keryx/", import.meta.url);
const goldUrl = new URL("memory-gold.json", fixtureRoot);
const resultsUrl = new URL("memory-search-results.json", fixtureRoot);

const repoRoot = new URL("../../", import.meta.url).pathname;

type SpawnResult = { stdout: string; stderr: string; ok: boolean };

function run(cmd: string[], cwd?: string): SpawnResult {
  const result = Bun.spawnSync(cmd, { ...(cwd !== undefined ? { cwd } : {}), stdout: "pipe", stderr: "pipe" });
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    ok: result.exitCode === 0,
  };
}

function keryxCli(): string[] {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--keryx");
  if (flag >= 0 && args[flag + 1]) return [args[flag + 1] as string];
  return ["keryx"];
}

/** Parse `keryx memory search --json` stdout into the ranked `results[].path` list. */
function parseSearchResults(stdout: string): string[] {
  const parsed = JSON.parse(stdout) as { results?: Array<{ path?: string }> };
  const paths: string[] = [];
  for (const item of parsed.results ?? []) {
    if (typeof item.path === "string") paths.push(item.path);
  }
  return paths;
}

/** Injectable side effects for {@link finalizeMemoryOracleRun} — real I/O in `main`, spies in tests. */
export type MemoryOracleEmissionIO = {
  readonly writeResultsFixture: (contents: string) => Promise<void>;
  readonly printManifest: (contents: string) => void;
  readonly logLine: (line: string) => void;
};

/**
 * Decide what to emit for the memory-oracle run, GATED on validation (same defect shape
 * fixed across every scripts/benchmark/run-*-oracle.ts producer: previously the captured
 * system-output fixture was written to disk and the derived manifest printed to stdout
 * FIRST, and only afterward validated — an invalid manifest's fixture reached disk before
 * the process exited non-zero, indistinguishable there from a good one).
 *
 * Choice recorded (same as run-ablation.ts's finalizeAblationRun): on an invalid run, a
 * previously-written GOOD fixture file is left ON DISK, UNTOUCHED — not overwritten with
 * the invalid run's fixture, not deleted either.
 */
export async function finalizeMemoryOracleRun(
  resultsFixture: unknown,
  manifest: PairedBenchmarkManifestV2,
  validation: { readonly valid: boolean; readonly errors: readonly string[] },
  io: MemoryOracleEmissionIO,
): Promise<number> {
  if (validation.valid) {
    await io.writeResultsFixture(`${JSON.stringify(resultsFixture, null, 2)}\n`);
    io.printManifest(JSON.stringify(manifest, null, 2));
  }

  io.logLine(`# layer=memory manifest valid: ${validation.valid ? "yes" : "no"}`);
  for (const err of validation.errors) io.logLine(`- ${err}`);

  if (validation.valid) {
    io.logLine("wrote fixtures/benchmark/keryx/memory-search-results.json");
    io.logLine("gold is hand-curated and NOT regenerated by this script: fixtures/benchmark/keryx/memory-gold.json");
    return 0;
  }
  io.logLine(
    "invalid manifest — nothing written to disk and nothing printed to stdout; " +
      "fixtures/benchmark/keryx/memory-search-results.json left unchanged " +
      "(a previously-written valid fixture, if any, is preserved as-is)",
  );
  return 1;
}

async function main(): Promise<void> {
  const cli = keryxCli();

  const gold = JSON.parse(await Bun.file(goldUrl).text()) as GoldFile;
  const queries = gold.targets ?? [];
  const k = typeof gold.k === "number" && gold.k > 0 ? gold.k : 3;
  if (queries.length < 3 || queries.length > 5) {
    throw new Error(`memory-gold.json must curate 3-5 queries, found ${queries.length}`);
  }

  // System output: run the live search per curated gold query. No fabrication — a failed
  // search throws and the whole producer fails loudly (see module comment).
  const systemByQuery = new Map<string, string[]>();
  for (const { target: query } of queries) {
    const search = run([...cli, "memory", "search", query, "--json", "--limit", "10"], repoRoot);
    if (!search.ok) throw new Error(`keryx memory search "${query}" failed: ${search.stderr || search.stdout}`);
    systemByQuery.set(query, parseSearchResults(search.stdout));
  }

  // Build the captured system-output fixture (same shape the CLI's loadAffectedSets reads) —
  // held in memory, not yet written; {@link finalizeMemoryOracleRun} decides whether it
  // reaches disk, based on the manifest's own validation below.
  const resultsFixture = {
    note:
      "SYSTEM output: `keryx memory search \"<query>\" --json --limit 10` ranked `results[].path` " +
      "per gold query in memory-gold.json, captured live against this repo's own " +
      ".metaproject/memory/ corpus (no fabricated ranking). Shape matches the AffectedSetFile " +
      "the CLI already loads: `target` is the query, `affected` is the ranked path list, best " +
      "match first.",
    repo: "keryx (dogfood, this repository)",
    generated_by:
      'bun scripts/benchmark/run-memory-oracle.ts (keryx memory search "<query>" --json --limit 10 per gold query)',
    captured: new Date().toISOString().slice(0, 10),
    targets: queries.map(({ target: query }) => ({ target: query, affected: systemByQuery.get(query) ?? [] })),
  };

  // Score: system ranked list vs curated gold set per query.
  const inputs: MemoryScoreInput[] = queries.map(({ target: query, affected: goldIds }) => ({
    query,
    system: systemByQuery.get(query) ?? [],
    gold: goldIds,
    k,
  }));

  const manifest = buildMemorySearchManifest(inputs, { ladder: "metastore" });
  console.error("# oracle IR result — layer=memory (memory recall@k)");
  for (const runRecord of manifest.runs) {
    const o = runRecord.oracle;
    console.error(
      `${runRecord.task_id}: precision=${o?.precision?.value} recall=${o?.recall?.value} recallAtK=${o?.recallAtK?.value} (k=${k})`,
    );
  }
  const result = validatePairedBenchmark(manifest);
  const code = await finalizeMemoryOracleRun(resultsFixture, manifest, result, {
    writeResultsFixture: async (contents) => {
      await Bun.write(resultsUrl, contents);
    },
    printManifest: (contents) => {
      console.log("# layer: memory (memory recall@k)");
      console.log(contents);
    },
    logLine: (line) => console.error(line),
  });
  if (code !== 0) process.exit(code);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-memory-oracle failed (offline/bun/keryx unavailable is expected in CI): ${(error as Error).message}`);
    console.error("The pure scorer remains fully unit-tested offline: bun test src/metrics/oracle-runner.test.ts");
    process.exit(1);
  });
}
