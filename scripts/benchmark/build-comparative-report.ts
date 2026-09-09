// Synthesis step for the M2 comparative ladder (docs/requirements/keryx-benchmark-suite/
// plan.md, "M2 — Comparative: one third-party agent harness"; specification.md §1.3, AC-6).
// Reads the THREE already-live, already-validated per-leg fixtures — never runs an agent or
// a provider itself:
//   - fixtures/benchmark/keryx/ablation-results.json       (keryx-on/keryx-off, deepseek-v4-flash, run-ablation.ts)
//   - fixtures/benchmark/keryx/ablation-results-raw.json    (raw floor, deepseek-v4-flash, run-ablation-raw.ts)
//   - fixtures/benchmark/keryx/ablation-results-codex.json  (harness, codex CLI, run-ablation-codex.ts)
// and re-derives each leg's PairedBenchmarkManifestV2 from its raw per-seed fixture, then
// combines them via src/metrics/comparative.ts's buildComparativeReport. The codex leg's
// fairness status is recorded as `not-met` — model not held constant (codex resolves its own
// default under the active ChatGPT account, gpt-5.6-sol, vs deepseek-v4-flash for the keryx
// and raw legs) — a documented deviation from spec §1.3, not papered over. Per AC-6, every
// harness cell is therefore marked non-publishable.
//
// Regenerate with (no live credentials needed — this step is pure synthesis over fixtures):
//   bun scripts/benchmark/build-comparative-report.ts

import { readFile } from "node:fs/promises";
import { buildAblationManifest, buildRawBaselineManifest, type AblationTaskInput, type RawBaselineTaskInput } from "../../src/metrics/ablation-runner";
import { buildComparativeReport, validateComparativeReport, type ComparativeLegs, type ComparativeReport } from "../../src/metrics/comparative";

const FIXTURES_DIR = new URL("../../fixtures/benchmark/keryx/", import.meta.url);

/** Injectable side effects for {@link finalizeComparativeReport} — real I/O in `main`, spies in tests. */
export type ComparativeEmissionIO = {
  readonly writeReport: (contents: string) => Promise<void>;
  readonly printReport: (contents: string) => void;
  readonly logLine: (line: string) => void;
};

/**
 * Decide what to emit for the comparative-report build, GATED on validation (defect fix:
 * previously the report was written to disk and printed to stdout FIRST, and only
 * afterward checked for validity — an invalid report reached both the file and the
 * terminal before the process exited non-zero, indistinguishable there from a good one).
 * Now the report JSON is written and printed ONLY when `validation.valid` is true; the
 * validity line, every validation error, and the per-cell diagnostics always go to
 * `logLine` (stderr in `main`) so a reader can see *why* a run was rejected.
 *
 * Choice recorded (task asked for one): on an invalid run, a previously-written GOOD
 * report file is left ON DISK, UNTOUCHED — not overwritten with the invalid report, and
 * not deleted either. Overwriting it would destroy the last known-good artifact for no
 * benefit (the new run is invalid, so it has nothing better to offer); deleting it would
 * make a transient validation failure (e.g. a leg's fixture temporarily out of date)
 * silently erase a fine artifact. A caller that truly wants a clean slate can remove the
 * file itself before regenerating.
 *
 * Returns the process exit code the caller should use (0 valid, 1 invalid).
 */
export async function finalizeComparativeReport(
  report: ComparativeReport,
  validation: { readonly valid: boolean; readonly errors: readonly string[] },
  io: ComparativeEmissionIO,
): Promise<number> {
  if (validation.valid) {
    const json = JSON.stringify(report, null, 2);
    await io.writeReport(`${json}\n`);
    io.printReport(json);
  }

  io.logLine(`\n# ladder=comparative report valid (AC-6): ${validation.valid ? "yes" : "no"}`);
  for (const err of validation.errors) io.logLine(`- ${err}`);
  io.logLine("\n# cells, publishable status:");
  for (const cell of report.cells) {
    io.logLine(
      `${cell.taskId} / ${cell.cell} (${cell.target}, ${cell.model}): rate=${cell.successRate.rate} ` +
        `n=${cell.successRate.n} publishable=${cell.publishable}`,
    );
  }

  if (validation.valid) {
    io.logLine("wrote fixtures/benchmark/keryx/comparative-report.json");
    return 0;
  }
  io.logLine(
    "invalid report — nothing written to disk and nothing printed to stdout; " +
      "fixtures/benchmark/keryx/comparative-report.json left unchanged " +
      "(a previously-written valid report, if any, is preserved as-is)",
  );
  return 1;
}

async function readFixture<T>(name: string): Promise<{ model: string; tasks: T[] }> {
  const raw = await readFile(new URL(name, FIXTURES_DIR), "utf8");
  return JSON.parse(raw) as { model: string; tasks: T[] };
}

async function main(): Promise<void> {
  const keryxFixture = await readFixture<AblationTaskInput>("ablation-results.json");
  const rawFixture = await readFixture<RawBaselineTaskInput>("ablation-results-raw.json");
  const codexFixture = await readFixture<AblationTaskInput>("ablation-results-codex.json");

  const keryx = buildAblationManifest(keryxFixture.tasks, { ladder: "harness", model: keryxFixture.model });
  const raw = buildRawBaselineManifest(rawFixture.tasks, { ladder: "comparative", model: rawFixture.model });
  const harness = buildAblationManifest(codexFixture.tasks, { ladder: "harness", model: codexFixture.model });

  const legs: ComparativeLegs = {
    keryx,
    raw,
    harness,
    harnessTargetName: "codex",
    harnessStatus: {
      adapter: "native-reviewed",
      fairness: "not-met",
      fairnessNote:
        `model not held constant: codex resolves its own default (${codexFixture.model}) under the ` +
        `active ChatGPT account, with no known way to pin it to keryx's own roster ` +
        `(${keryxFixture.model}) — a documented spec §1.3 deviation, see plan.md M2 ` +
        "harness-selection investigation",
    },
  };

  const report = buildComparativeReport(legs);
  const validation = validateComparativeReport(report);

  const reportUrl = new URL("comparative-report.json", FIXTURES_DIR);
  const code = await finalizeComparativeReport(report, validation, {
    writeReport: async (contents) => {
      await Bun.write(reportUrl, contents);
    },
    printReport: (contents) => console.log(contents),
    logLine: (line) => console.error(line),
  });
  if (code !== 0) process.exit(code);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`build-comparative-report failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
