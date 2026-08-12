// Producer for the metastore TESTING / TIA oracle slice, dogfooded on keryx itself
// (robust, no external clone). This is the thin, I/O-doing half of the pipeline (mirrors
// run-express-oracle.ts): it derives a REAL per-test coverage map for a bounded keryx
// slice, derives the gold impacted-test set via goldTestImpact, runs `keryx test related`
// for the system output, writes both fixtures, then scores them with the PURE scorer in
// src/metrics/oracle-runner.ts and prints the paired-3-5-v2 manifest + validation result.
//
// Ground truth (coverage map): for each slice TEST file it runs
//   bun test <testfile> --coverage --coverage-reporter=lcov --coverage-dir=<tmp>
// parses the lcov `SF:` records, and keeps only covered source files inside the slice
// SOURCE set. The resulting `testId -> coveredFiles[]` map is the coverage-derived gold
// source (metrics-and-validation.md testing row): a test is gold-impacted for a change iff
// it covers a changed file (goldTestImpact, src/metrics/gold.ts). No fabricated coverage.
//
// System output: `keryx test related <target>` (naming + import-graph heuristic). It needs
// the testing context, so this runs `keryx test analyze` first — which writes under
// .metaproject/data/testing/. That is a generated artifact, NOT a deliverable: after
// running this producer, revert it with `git checkout -- .metaproject/data`.
//
// Regenerate with:
//   bun scripts/benchmark/run-testing-oracle.ts
//   git checkout -- .metaproject/data        # drop the analyze side-effect
//
// The pure scorer is fully unit-tested offline (src/metrics/oracle-runner.test.ts), so a
// failure here never blocks the metastore slice — it only means the fixtures were not
// refreshed.

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePairedBenchmark } from "../../src/metrics/benchmark";
import { goldTestImpact, type CoverageMap } from "../../src/metrics/gold";
import { buildTestImpactManifest, type TestImpactScoreInput } from "../../src/metrics/oracle-runner";

// Bounded, self-contained keryx dogfood slice: pure source files + the tests that exercise
// them. Kept small (4 targets) so a live coverage run is fast and the manifest stays within
// the protocol's 3-5 task bound.
const SLICE_SOURCE = [
  "src/metrics/benchmark.ts",
  "src/metrics/gold.ts",
  "src/metrics/ir.ts",
  "src/metrics/oracle-runner.ts",
] as const;
const SLICE_TESTS = [
  "src/metrics/gold.test.ts",
  "src/metrics/ir.test.ts",
  "src/metrics/oracle-runner.test.ts",
  "src/metrics/service.test.ts",
] as const;
// The changed files whose impacted tests we predict (each becomes one scored target).
const TARGET_FILES = SLICE_SOURCE;

const fixtureRoot = new URL("../../fixtures/benchmark/keryx/", import.meta.url);
const coverageMapUrl = new URL("coverage-map.json", fixtureRoot);
const testRelatedUrl = new URL("test-related.json", fixtureRoot);

const repoRoot = new URL("../../", import.meta.url).pathname;

type SpawnResult = { stdout: string; stderr: string; ok: boolean };

function run(cmd: string[], cwd?: string): SpawnResult {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
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

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Parse lcov `SF:` records into the set of covered source files (relative, normalized). */
function coveredFilesFromLcov(lcov: string): Set<string> {
  const covered = new Set<string>();
  for (const rawLine of lcov.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) covered.add(normalizePath(line.slice(3)));
  }
  return covered;
}

/** Build the per-test coverage map, restricted to the slice source set, via bun coverage. */
function buildCoverageMap(): Record<string, string[]> {
  const sliceSource = new Set<string>(SLICE_SOURCE);
  const map: Record<string, string[]> = {};
  for (const testFile of SLICE_TESTS) {
    const covDir = mkdtempSync(join(tmpdir(), "keryx-testing-oracle-"));
    try {
      const res = run(
        ["bun", "test", testFile, "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${covDir}`],
        repoRoot,
      );
      if (!res.ok) throw new Error(`bun coverage for ${testFile} failed: ${res.stderr || res.stdout}`);
      const lcov = readFileSync(join(covDir, "lcov.info"), "utf8");
      const inSlice = [...coveredFilesFromLcov(lcov)].filter((f) => sliceSource.has(f)).sort();
      map[testFile] = inSlice;
    } finally {
      rmSync(covDir, { recursive: true, force: true });
    }
  }
  return map;
}

/** Parse `keryx test related <file>` markdown (`- <path>` bullets) into a test-id set. */
function parseRelated(stdout: string): string[] {
  const ids: string[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) continue;
    const value = line.slice(2).trim();
    if (value === "none") continue;
    ids.push(value);
  }
  return [...new Set(ids)].sort();
}

async function main(): Promise<void> {
  const cli = keryxCli();

  // Ground truth: real per-test coverage map for the slice.
  const coverageMap = buildCoverageMap();

  // System output: `keryx test related` needs the testing context, so analyze first. This
  // writes .metaproject/data/testing/ (a generated artifact — revert after).
  const analyze = run([...cli, "test", "analyze"], repoRoot);
  if (!analyze.ok) throw new Error(`keryx test analyze failed: ${analyze.stderr || analyze.stdout}`);
  const system = new Map<string, string[]>();
  for (const target of TARGET_FILES) {
    const related = run([...cli, "test", "related", target], repoRoot);
    if (!related.ok) throw new Error(`keryx test related ${target} failed: ${related.stderr}`);
    system.set(target, parseRelated(related.stdout));
  }

  // Persist both fixtures (same shapes the CLI's loaders read).
  const coverageFixture = {
    note:
      "REAL per-test coverage map for a bounded keryx dogfood slice. Produced by " +
      "`bun test <testfile> --coverage --coverage-reporter=lcov` per slice test file, keeping " +
      "covered SF records inside the slice source set. Gold source for goldTestImpact.",
    repo: "keryx (dogfood, this repository)",
    slice: { source: [...SLICE_SOURCE], tests: [...SLICE_TESTS] },
    generated_by: "bun scripts/benchmark/run-testing-oracle.ts",
    coverageMap,
  };
  await Bun.write(coverageMapUrl, `${JSON.stringify(coverageFixture, null, 2)}\n`);

  const relatedFixture = {
    note:
      "SYSTEM test-impact set: `keryx test related <target>` (naming + import-graph heuristic) " +
      "per changed file, after `keryx test analyze`. Scored against the coverage-derived gold.",
    repo: "keryx (dogfood, this repository)",
    generated_by: "keryx test analyze && keryx test related <target>",
    targets: TARGET_FILES.map((target) => ({ target, affected: system.get(target) ?? [] })),
  };
  await Bun.write(testRelatedUrl, `${JSON.stringify(relatedFixture, null, 2)}\n`);

  // Score: system test-impact set vs coverage-derived gold impacted-test set per target.
  const coverage: CoverageMap = coverageMap;
  const inputs: TestImpactScoreInput[] = TARGET_FILES.map((changedFile) => ({
    changedFile,
    system: system.get(changedFile) ?? [],
    gold: goldTestImpact(coverage, [changedFile]),
  }));

  const manifest = buildTestImpactManifest(inputs, { ladder: "metastore" });
  console.log("# layer: testing (test-impact analysis)");
  console.log(JSON.stringify(manifest, null, 2));
  console.error("# oracle IR result — layer=testing (test-impact analysis)");
  for (const runRecord of manifest.runs) {
    const o = runRecord.oracle;
    console.error(
      `${runRecord.task_id}: precision=${o?.precision?.value} recall=${o?.recall?.value} f1=${o?.f1?.value}`,
    );
  }
  const result = validatePairedBenchmark(manifest);
  console.error(`# layer=testing manifest valid: ${result.valid ? "yes" : "no"}`);
  for (const err of result.errors) console.error(`- ${err}`);
  console.error("wrote fixtures/benchmark/keryx/{coverage-map,test-related}.json");
  console.error("NOTE: revert the analyze side-effect with `git checkout -- .metaproject/data`");
  if (!result.valid) process.exit(1);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-testing-oracle failed (offline/bun/keryx unavailable is expected in CI): ${(error as Error).message}`);
    console.error("The pure scorer remains fully unit-tested offline: bun test src/metrics/oracle-runner.test.ts");
    process.exit(1);
  });
}
