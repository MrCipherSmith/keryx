// Producer for the AC3/AC-22 freshness-cost-at-scale benchmark (flow 236, phase 4,
// T10). "The budget is agreed before optimisation" (AC-22's last clause) is the
// point of this file: it measures TODAY's real, unmodified
// `evaluatePageFreshness` (src/wiki/freshness/page-freshness.ts) against a
// calibration profile that was written from the requirement text BEFORE this
// script ran, not fitted to what it finds. See
// docs/requirements/keryx-agent-first-core/examples/wiki-freshness-calibration.v1.json
// for the budget and its derivation.
//
// SCOPE, STATED PLAINLY: this benchmarks `evaluatePageFreshness` directly, not the
// full `buildFreshnessReport` pipeline (src/wiki/freshness/report.ts). That
// function is where every git subprocess the AC3 inventory measured actually
// happens (`cat-file` / `log` / `diff` — report.ts adds no git calls of its own),
// so it is the right unit for a COST benchmark. `report.ts`'s categorisation
// (stale-reference vs stale-prose, orphan detection, propagation) is a downstream
// concern of AC1/AC7/AC-08, governed by its own criteria and fixtures elsewhere —
// pulling in a full GraphData/module/propagation harness here would not add
// anything to a cost-and-oracle-agreement measurement, only weight.
//
// This script deliberately runs pages SEQUENTIALLY, one `evaluatePageFreshness`
// call at a time — exactly matching `report.ts`'s own `for (const page of pages)`
// loop — rather than parallelising to make its own run faster. Parallelising here
// would measure a DIFFERENT, faster, not-yet-built implementation and misreport it
// as "today's cost". The calibration profile's `concurrencyBound` is a target for
// that not-yet-built implementation, not something this script exercises.
//
// Usage:
//   bun scripts/benchmark/run-wiki-freshness-scale.ts [--sizes 50,500,2000]

import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { gitCmd } from "../../src/sync/provenance";
import { evaluatePageFreshness, type GitRunner, type PageFreshness } from "../../src/wiki/freshness/page-freshness";
import {
  generateFreshnessScaleCorpus,
  type FreshnessFixtureCorpus,
  type FreshnessFixtureManifest,
  type FreshnessFixturePage,
  type OracleVerdict,
} from "./wiki-freshness-scale-fixture";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const MANIFEST_PATH = path.join(REPO_ROOT, "fixtures/wiki-freshness-scale/manifest.json");
const CALIBRATION_PATH = path.join(
  REPO_ROOT,
  "docs/requirements/keryx-agent-first-core/examples/wiki-freshness-calibration.v1.json",
);
const RESULTS_PATH = path.join(REPO_ROOT, "fixtures/wiki-freshness-scale/results.json");

export interface CalibrationProfile {
  profileVersion: string;
  scales: number[];
  gitSubprocessBudget: {
    worstCaseCeiling: { perPage: number; note: string };
  };
  latencyBudgetMs: {
    perScale: Record<string, { cold: number; repeated: number }>;
    hardCeiling: { scale: number; ms: number; anchoredOn: string };
  };
}

export function verdictKind(f: PageFreshness): OracleVerdict["kind"] {
  if (f.basis === "undecidable") return f.gitFailure ? "git-failure" : "undecidable";
  return f.changed ? "changed" : "unchanged";
}

export interface Mismatch {
  page: string;
  category: string;
  expected: OracleVerdict["kind"];
  actual: OracleVerdict["kind"];
}

export interface PassResult {
  mode: "healthy" | "broken-git";
  wallClockMs: number;
  gitOperations: number;
  gitOperationsSumMs: number;
  agreementCount: number;
  total: number;
  mismatches: Mismatch[];
}

function makeCountingGitRunner(mode: "healthy" | "broken-git"): { runner: GitRunner; count: () => number; sumMs: () => number } {
  let count = 0;
  let sumMs = 0;
  const runner: GitRunner = async (cwd, args) => {
    count += 1;
    if (mode === "broken-git") {
      // Simulates "git could not be run at all" (gitCmdResult's spawn-error case)
      // — no real subprocess, matching how the flow-236-T7 fix's own probe
      // established `gitAvailable`. This is NOT a real-git non-zero-exit case;
      // it is the wholly-unavailable case.
      return null;
    }
    const t0 = performance.now();
    const result = await gitCmd(cwd, args);
    sumMs += performance.now() - t0;
    return result;
  };
  return { runner, count: () => count, sumMs: () => sumMs };
}

export async function runPass(corpus: FreshnessFixtureCorpus, mode: "healthy" | "broken-git"): Promise<PassResult> {
  const probe = makeCountingGitRunner(mode);
  const gitAvailable = mode === "healthy" ? (await probe.runner(corpus.root, ["rev-parse", "HEAD"])) !== null : false;

  const mismatches: Mismatch[] = [];
  let agreementCount = 0;
  const t0 = performance.now();
  for (const p of corpus.pages) {
    const freshness = await evaluatePageFreshness({
      cwd: corpus.root,
      page: { path: p.page, verifiedAt: p.verifiedAt, verifiedScope: p.verifiedScope },
      describePaths: [p.describePath],
      graph: corpus.graph,
      git: probe.runner,
      gitAvailable,
    });
    const expected = mode === "broken-git" ? p.oracleUnderGitFailure : p.oracle;
    const actual = verdictKind(freshness);
    if (actual === expected.kind) {
      agreementCount += 1;
    } else {
      mismatches.push({ page: p.page, category: p.category, expected: expected.kind, actual });
    }
  }
  const wallClockMs = performance.now() - t0;

  return {
    mode,
    wallClockMs,
    gitOperations: probe.count(),
    gitOperationsSumMs: probe.sumMs(),
    agreementCount,
    total: corpus.pages.length,
    mismatches,
  };
}

export interface ScaleResult {
  size: number;
  categoryCounts: Record<string, number>;
  cold: PassResult;
  repeated: PassResult;
  brokenGit: PassResult;
  budget: {
    coldTargetMs: number;
    repeatedTargetMs: number;
    coldWithinBudget: boolean;
    repeatedWithinBudget: boolean;
    hardCeilingMs?: number;
    withinHardCeiling?: boolean;
    measuredSpawnsPerPage: number;
    worstCaseCeilingPerPage: number;
    withinWorstCaseCeiling: boolean;
  };
}

function summarizeCategories(pages: FreshnessFixturePage[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pages) out[p.category] = (out[p.category] ?? 0) + 1;
  return out;
}

export async function runScale(
  size: number,
  seed: number,
  manifest: FreshnessFixtureManifest,
  calibration: CalibrationProfile,
): Promise<ScaleResult> {
  const corpus = generateFreshnessScaleCorpus(size, seed, manifest);
  try {
    const cold = await runPass(corpus, "healthy");
    const repeated = await runPass(corpus, "healthy");
    const brokenGit = await runPass(corpus, "broken-git");

    const perScale = calibration.latencyBudgetMs.perScale[String(size)];
    const coldTargetMs = perScale?.cold ?? Number.POSITIVE_INFINITY;
    const repeatedTargetMs = perScale?.repeated ?? Number.POSITIVE_INFINITY;
    const isHardCeilingScale = calibration.latencyBudgetMs.hardCeiling.scale === size;
    const measuredSpawnsPerPage = cold.gitOperations / size;

    return {
      size,
      categoryCounts: summarizeCategories(corpus.pages),
      cold,
      repeated,
      brokenGit,
      budget: {
        coldTargetMs,
        repeatedTargetMs,
        coldWithinBudget: cold.wallClockMs <= coldTargetMs,
        repeatedWithinBudget: repeated.wallClockMs <= repeatedTargetMs,
        ...(isHardCeilingScale
          ? {
              hardCeilingMs: calibration.latencyBudgetMs.hardCeiling.ms,
              withinHardCeiling: cold.wallClockMs <= calibration.latencyBudgetMs.hardCeiling.ms,
            }
          : {}),
        measuredSpawnsPerPage,
        worstCaseCeilingPerPage: calibration.gitSubprocessBudget.worstCaseCeiling.perPage,
        withinWorstCaseCeiling: measuredSpawnsPerPage <= calibration.gitSubprocessBudget.worstCaseCeiling.perPage + 0.05,
      },
    };
  } finally {
    corpus.cleanup();
  }
}

function parseSizes(argv: string[]): number[] | null {
  const idx = argv.indexOf("--sizes");
  if (idx < 0 || !argv[idx + 1]) return null;
  return (argv[idx + 1] as string)
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export interface RunOutcome {
  scales: ScaleResult[];
  allAgree: boolean;
  totalMismatches: number;
}

export function summarizeOutcome(scales: ScaleResult[]): RunOutcome {
  let totalMismatches = 0;
  for (const s of scales) {
    totalMismatches += s.cold.mismatches.length + s.repeated.mismatches.length + s.brokenGit.mismatches.length;
  }
  return { scales, allAgree: totalMismatches === 0, totalMismatches };
}

function printReport(profileVersion: string, outcome: RunOutcome): void {
  console.log(`# wiki-freshness-scale — evaluatePageFreshness cost & oracle agreement (calibration v${profileVersion})`);
  for (const s of outcome.scales) {
    console.log(`\n## ${s.size} pages (categories: ${JSON.stringify(s.categoryCounts)})`);
    for (const pass of [s.cold, s.repeated, s.brokenGit]) {
      const label = pass.mode === "broken-git" ? "git-broken" : pass === s.cold ? "cold" : "repeated";
      console.log(
        `  ${label.padEnd(11)} ${pass.gitOperations.toString().padStart(6)} git ops in ${pass.wallClockMs.toFixed(0).padStart(7)} ms` +
          ` (git-time ${pass.gitOperationsSumMs.toFixed(0)} ms) — agree ${pass.agreementCount}/${pass.total}` +
          (pass.mismatches.length > 0 ? ` — MISMATCHES: ${JSON.stringify(pass.mismatches.slice(0, 5))}` : ""),
      );
    }
    const b = s.budget;
    console.log(
      `  budget: cold ${s.cold.wallClockMs.toFixed(0)}ms vs target ${b.coldTargetMs}ms (${b.coldWithinBudget ? "WITHIN" : "OVER"}); ` +
        `repeated ${s.repeated.wallClockMs.toFixed(0)}ms vs target ${b.repeatedTargetMs}ms (${b.repeatedWithinBudget ? "WITHIN" : "OVER"}); ` +
        `spawns/page ${b.measuredSpawnsPerPage.toFixed(2)} vs worst-case ceiling ${b.worstCaseCeilingPerPage} (${b.withinWorstCaseCeiling ? "WITHIN" : "OVER"})` +
        (b.hardCeilingMs !== undefined
          ? `; hard ceiling ${b.hardCeilingMs}ms (${b.withinHardCeiling ? "WITHIN" : "OVER"})`
          : ""),
    );
  }
  console.log(`\n# oracle agreement: ${outcome.allAgree ? "ALL PAGES AGREE" : `${outcome.totalMismatches} MISMATCHES`}`);
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as FreshnessFixtureManifest;
  const calibration = JSON.parse(readFileSync(CALIBRATION_PATH, "utf8")) as CalibrationProfile;
  const sizes = parseSizes(process.argv.slice(2)) ?? calibration.scales;

  const scaleResults: ScaleResult[] = [];
  for (const size of sizes) {
    console.error(`# running scale ${size}…`);
    // Scales are measured sequentially by design (see header note) — not a lint
    // accident.
    scaleResults.push(await runScale(size, manifest.seed, manifest, calibration));
  }
  const outcome = summarizeOutcome(scaleResults);
  printReport(calibration.profileVersion, outcome);

  mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  await Bun.write(
    RESULTS_PATH,
    `${JSON.stringify(
      {
        note:
          "Measured this run: evaluatePageFreshness cost & per-page oracle agreement at 50/500/2000 pages, cold/repeated/git-broken, against the versioned calibration profile. Regenerate with `bun scripts/benchmark/run-wiki-freshness-scale.ts`.",
        generatedAt: new Date().toISOString(),
        calibrationProfileVersion: calibration.profileVersion,
        manifestSeed: manifest.seed,
        scales: scaleResults,
        allAgree: outcome.allAgree,
        totalMismatches: outcome.totalMismatches,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote fixtures/wiki-freshness-scale/results.json`);

  if (!outcome.allAgree) process.exit(1);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-wiki-freshness-scale failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}
