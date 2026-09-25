#!/usr/bin/env bun
// Flow 331, AC2/AC4/AC5/AC6 — the benchmark runner.
//
//   bun bench/jev-review/run.ts                       offline, all components
//   bun bench/jev-review/run.ts --live                live Jev calls where a component supports them
//   bun bench/jev-review/run.ts --live --max-cost 0.05 tighter cap than the $0.10 default
//   bun bench/jev-review/run.ts --repeat 3             repeat each available with-jev arm N times (variance, AC4)
//   bun bench/jev-review/run.ts --out <dir>            write results-<date>.json/.md into <dir> (default: this directory)
//
// `env -u OPENROUTER_API_KEY` before `--live` is how AC6 asks this to be
// run: with no key in the immediate shell, so the saved key in
// `~/.local/share/keryx/auth.json` (`envWithSavedApiKeys`, the same
// fallback `jev-client.ts` already implements) is what actually
// authenticates — proving the saved-credential path works, not just the
// env-var one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { registerAdapters } from "./adapters/registry";
import { buildDataset } from "./build-dataset";
import { assertEstimateWithinCap, CostCapExceededError, CostCapTracker, defaultCostCap } from "./cost-cap";
import { computeMetrics, varianceReport, type ComponentMetrics, type VarianceReport } from "./metrics";
import { buildReport, renderMarkdown } from "./report";
import type { AdapterRunContext, Arm, ComponentResult, Dataset } from "./types";

const HERE = import.meta.dir;
const ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_DATASET_PATH = path.join(HERE, "dataset.json");

interface Args {
  readonly live: boolean;
  readonly maxCostUsd: number;
  readonly repeat: number;
  readonly outDir: string;
  readonly datasetPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  const optionValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    live: argv.includes("--live"),
    maxCostUsd: Number(optionValue("--max-cost") ?? defaultCostCap().maxCostUsd),
    repeat: Number(optionValue("--repeat") ?? 1),
    outDir: path.resolve(optionValue("--out") ?? HERE),
    datasetPath: path.resolve(optionValue("--dataset") ?? DEFAULT_DATASET_PATH),
  };
}

function loadDataset(datasetPath: string): Dataset {
  if (existsSync(datasetPath)) return JSON.parse(readFileSync(datasetPath, "utf8")) as Dataset;
  return buildDataset(ROOT);
}

async function runComponent(
  adapter: ReturnType<typeof registerAdapters>[number],
  arm: Arm,
  ctx: AdapterRunContext,
  cap: { maxCostUsd: number; maxCalls: number },
): Promise<ComponentResult> {
  if (!adapter.available) {
    return { component: adapter.id, arm, available: false, reason: adapter.unavailableReason ?? "not available" };
  }
  if (!ctx.live) return adapter.run(arm, ctx);

  // Pre-flight (AC5/AC6): the offline replay IS the cost estimate — same
  // tokens either way, offline just replays a recorded answer.
  const offlineEstimate = await adapter.run(arm, { ...ctx, live: false });
  if (offlineEstimate.available) {
    assertEstimateWithinCap(offlineEstimate.usage, cap);
  }
  return adapter.run(arm, ctx);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const dataset = loadDataset(args.datasetPath);
  const adapters = registerAdapters();
  const bunPath = process.execPath;
  const cliPath = path.join(ROOT, "src", "cli.ts");
  const cap = { maxCostUsd: args.maxCostUsd, maxCalls: defaultCostCap().maxCalls };
  const tracker = new CostCapTracker(cap);

  const ctxBase: AdapterRunContext = { root: ROOT, dataset, live: args.live, bunPath, cliPath };

  const metrics: ComponentMetrics[] = [];
  const variance: VarianceReport[] = [];
  const runNotes: string[] = [];
  let aborted: CostCapExceededError | null = null;

  outer: for (const adapter of adapters) {
    for (const arm of ["without-jev", "with-jev"] as const) {
      let result: ComponentResult;
      try {
        result = await runComponent(adapter, arm, ctxBase, cap);
      } catch (error) {
        if (error instanceof CostCapExceededError) {
          aborted = error;
          break outer;
        }
        throw error;
      }
      // Only LIVE spend counts against the cap — an offline run replays
      // fixtures and costs nothing real, whatever number the replayed JSON
      // happens to carry (it is the recorded cost of the ORIGINAL live call
      // that produced the fixture, not a new charge).
      if (args.live && result.available) {
        try {
          tracker.record(result.usage);
        } catch (error) {
          if (error instanceof CostCapExceededError) {
            aborted = error;
            break outer;
          }
          throw error;
        }
      }
      metrics.push(computeMetrics(result));

      // AC4: repeat the with-jev arm >= 2 times when asked, to measure
      // run-to-run variance. Only meaningful live (offline replay is
      // deterministic by construction — repeating it would report a fake
      // zero variance) and only for accuracy-bearing (closed-world)
      // components, since precision/noise-only components have no single
      // scalar to compare across repeats.
      if (args.live && args.repeat > 1 && arm === "with-jev" && result.available) {
        const values: number[] = [];
        const first = computeMetrics(result);
        if (first.available && first.accuracy !== null) values.push(first.accuracy.rate ?? 0);
        for (let i = 1; i < args.repeat && first.available && first.accuracy !== null; i += 1) {
          let repeatResult: ComponentResult;
          try {
            repeatResult = await runComponent(adapter, arm, ctxBase, cap);
            if (repeatResult.available) tracker.record(repeatResult.usage);
          } catch (error) {
            if (error instanceof CostCapExceededError) {
              aborted = error;
              break;
            }
            throw error;
          }
          const repeatMetrics = computeMetrics(repeatResult);
          if (repeatMetrics.available && repeatMetrics.accuracy !== null) values.push(repeatMetrics.accuracy.rate ?? 0);
        }
        if (values.length > 1) variance.push(varianceReport(adapter.id, values));
        if (aborted) break outer;
      }
    }
  }

  if (aborted) {
    console.error(aborted.message);
    console.error("Refusing to write results for this run — cap was exceeded mid-run.");
    process.exit(1);
  }

  if (args.live) {
    runNotes.push(
      "Live run: ci-triage's with-jev arm called the real gh + Jev/OpenRouter endpoint; review-conform has no --live path (see its adapter's file header) and always replays committed fixtures.",
    );
  } else {
    runNotes.push("Offline run: every component replayed committed fixtures — hermetic, no network.");
  }

  const report = buildReport(metrics, variance, {
    generatedAt: new Date().toISOString(),
    mode: args.live ? "live" : "offline",
    datasetCounts: dataset.counts,
    totalUsage: {
      jevCalls: tracker.totals.calls,
      cost: tracker.totals.costUsd,
      wallClockMs: metrics.reduce((s, m) => s + (m.available ? m.usage.wallClockMs : 0), 0),
    },
    notes: runNotes,
  });

  mkdirSync(args.outDir, { recursive: true });
  const date = report.meta.generatedAt.slice(0, 10);
  const jsonPath = path.join(args.outDir, `results-${date}.json`);
  const mdPath = path.join(args.outDir, `results-${date}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  writeFileSync(mdPath, renderMarkdown(report), "utf8");

  console.log(`bench/jev-review: wrote ${path.relative(ROOT, jsonPath)} and ${path.relative(ROOT, mdPath)}`);
  console.log(`  mode: ${report.meta.mode}`);
  console.log(`  jevCalls: ${tracker.totals.calls}  cost: $${tracker.totals.costUsd.toFixed(6)}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
