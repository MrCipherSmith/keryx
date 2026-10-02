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

import { readFile, readdir } from "node:fs/promises";
import { buildAblationManifest, buildRawBaselineManifest, type AblationTaskInput, type RawBaselineTaskInput } from "../../src/metrics/ablation-runner";
import type { AblationVariant } from "../../src/metrics/ablation-runner";
import { aggregateLeg, ac10Verdict, ac11Verdict, renderTokenTable, type LegAggregate, type LegFixture, type Verdict } from "./token-metrics";
import { buildComparativeReport, validateComparativeReport, type ComparativeLegs, type ComparativeReport } from "../../src/metrics/comparative";

const resolvePath = (p: string): string => (p.startsWith("/") ? p : `${process.cwd()}/${p}`);
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

export type TokenEconomySection = {
  readonly legs: readonly LegAggregate[];
  readonly ac10: Verdict;
  readonly ac11: Verdict;
  readonly markdown: string;
};

/**
 * Pure assembly of the AC10/AC11 section from the mutating-ablation leg fixtures (one per
 * harness+model) and an optional keryx baseline fixture (a run on `main` before the flow).
 * `variant` picks which ablation arm is compared (context-on = each harness as it ships).
 * AC11 compares the FIRST keryx leg against the baseline.
 */
export function buildTokenEconomySection(
  fixtures: readonly LegFixture[],
  baseline: LegFixture | undefined,
  variant: AblationVariant = "context-on",
): TokenEconomySection {
  const legs = fixtures.map((f) => aggregateLeg(f, variant));
  const ac10 = ac10Verdict(legs);
  const keryxLeg = legs.find((l) => l.harness === "keryx");
  const baselineLeg = baseline === undefined ? undefined : aggregateLeg(baseline, variant);
  const ac11 = ac11Verdict(keryxLeg, baselineLeg);
  const gapLines = legs.flatMap((l) => l.gaps.map((g) => `- ${l.harness}/${l.model}: ${g}`));
  const markdown = [
    "Mean tokens per task run and success rate, per harness and model",
    "",
    renderTokenTable(legs),
    ...(gapLines.length > 0 ? ["", "Gaps (reported as n/a, never estimated):", ...gapLines] : []),
    "",
    ac10.line,
    ac11.line,
  ].join("\n");
  return { legs, ac10, ac11, markdown };
}

function parseFlag(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function readLegFixture(url: URL): Promise<LegFixture> {
  const raw = JSON.parse(await readFile(url, "utf8")) as { provider?: string; model: string; tasks: LegFixture["tasks"] };
  return { provider: raw.provider ?? "unknown", model: raw.model, tasks: raw.tasks };
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

  // AC10/AC11 token-economy section: every committed mutating-ablation leg fixture, plus
  // an optional `--baseline <file>` (a keryx run on main). Legacy fixtures captured before
  // T13a carry no instrumentation and show up as n/a gaps rather than being skipped.
  const names = (await readdir(FIXTURES_DIR)).filter((n) => /^ablation-mutating-results.*\.json$/.test(n)).sort();
  if (names.length > 0) {
    const fixtures = await Promise.all(names.map((n) => readLegFixture(new URL(n, FIXTURES_DIR))));
    const baselinePath = parseFlag(process.argv, "--baseline");
    const baseline = baselinePath === undefined ? undefined : await readLegFixture(new URL(`file://${resolvePath(baselinePath)}`));
    const section = buildTokenEconomySection(fixtures, baseline);
    console.error(`\n# token economy (AC10/AC11), legs: ${names.join(", ")}\n${section.markdown}`);
  }
  if (code !== 0) process.exit(code);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`build-comparative-report failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
