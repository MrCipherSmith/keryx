// Flow 331, AC3/AC4 — the report generator. AC4's honest-reporting rules are
// encoded here, not left to whoever reads the JSON later:
//
//   1. n and a 95% CI are printed next to EVERY percentage — `formatRate`
//      is the only place this benchmark renders a rate, and it never emits
//      a bare percentage.
//   2. A component/arm with n < `ANECDOTAL_THRESHOLD_N` is labelled
//      `anecdotal` inline, not just in a footnote.
//   3. Run-to-run variance (repeated with-jev runs on a subset) is printed
//      as its own section when present, never folded silently into a
//      single-run number.
import { isMeasuredRate, type RateWithCI } from "../../src/metrics/benchmark";
import type { ComponentMetrics, VarianceReport } from "./metrics";
import type { Dataset } from "./types";

export interface ReportMeta {
  readonly generatedAt: string;
  readonly mode: "offline" | "live";
  readonly datasetCounts: Dataset["counts"];
  readonly totalUsage: { readonly jevCalls: number; readonly cost: number; readonly wallClockMs: number };
  readonly notes: readonly string[];
}

export interface BenchmarkReport {
  readonly meta: ReportMeta;
  readonly components: readonly ComponentMetrics[];
  readonly variance: readonly VarianceReport[];
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** AC4 rule 1: never a bare percentage. */
export function formatRate(rate: RateWithCI | null, n?: number): string {
  if (rate === null) return `not measured (n=${n ?? 0})`;
  if (!isMeasuredRate(rate)) return `not measured (n=0)`;
  return `${pct(rate.rate)} (n=${rate.n}, 95% CI [${pct(rate.ci95.lower)}, ${pct(rate.ci95.upper)}])`;
}

function componentLine(m: ComponentMetrics): string {
  if (!m.available) return `| ${m.component} | ${m.arm} | not available | ${m.reason} |`;
  const anecdotal = m.anecdotal ? " **anecdotal**" : "";
  const parts = [
    `accuracy: ${formatRate(m.accuracy, m.n)}`,
    `precision: ${formatRate(m.precision)}`,
    `noise: ${formatRate(m.noise)}`,
    `addedTP: ${m.addedTruePositives === null ? "not hand-labelled" : String(m.addedTruePositives)}`,
    `calls: ${m.usage.jevCalls}`,
    `cost: $${m.usage.cost.toFixed(6)}`,
    `wall: ${m.usage.wallClockMs}ms`,
  ];
  return `| ${m.component} | ${m.arm} (n=${m.n})${anecdotal} | ${parts.join("; ")} |`;
}

export function buildReport(components: readonly ComponentMetrics[], variance: readonly VarianceReport[], meta: ReportMeta): BenchmarkReport {
  return { meta, components, variance };
}

export function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push("# Jev review benchmark — flow 331");
  lines.push("");
  lines.push(`Generated: ${report.meta.generatedAt} · mode: **${report.meta.mode}**`);
  lines.push("");
  lines.push("## Honesty rules (AC4)");
  lines.push("");
  lines.push("- Every percentage below is printed with its n and 95% Wilson confidence interval — never a bare number.");
  lines.push(`- A component/arm with n < 10 is marked **anecdotal**: read it as a data point, not a finding.`);
  lines.push("- Run-to-run variance (§Variance) reflects repeated with-jev runs on a subset, when this run measured any.");
  lines.push("");
  lines.push("## Dataset");
  lines.push("");
  lines.push(`- Review packages: ${report.meta.datasetCounts.packages}`);
  lines.push(`- Findings: ${report.meta.datasetCounts.findings}`);
  lines.push(
    `- Labels: true-positive=${report.meta.datasetCounts.byLabel["true-positive"]}, false-positive=${report.meta.datasetCounts.byLabel["false-positive"]}, unlabeled=${report.meta.datasetCounts.byLabel.unlabeled}`,
  );
  lines.push("");
  lines.push("## Components");
  lines.push("");
  lines.push("| component | arm | metrics |");
  lines.push("|---|---|---|");
  for (const m of report.components) lines.push(componentLine(m));
  lines.push("");
  if (report.variance.length > 0) {
    lines.push("## Variance across repeated with-jev runs (AC4)");
    lines.push("");
    lines.push("| component | repeats | values | mean | stddev | bootstrap 95% CI |");
    lines.push("|---|---|---|---|---|---|");
    for (const v of report.variance) {
      const ci = v.bootstrapCi95 ? `[${pct(v.bootstrapCi95.lower)}, ${pct(v.bootstrapCi95.upper)}]` : "n/a";
      lines.push(`| ${v.component} | ${v.repeats} | ${v.values.map(pct).join(", ")} | ${pct(v.mean)} | ${pct(v.stddev)} | ${ci} |`);
    }
    lines.push("");
  }
  lines.push("## Totals this run");
  lines.push("");
  lines.push(`- Jev calls: ${report.meta.totalUsage.jevCalls}`);
  lines.push(`- Cost: $${report.meta.totalUsage.cost.toFixed(6)}`);
  lines.push(`- Wall-clock: ${report.meta.totalUsage.wallClockMs}ms`);
  lines.push("");
  if (report.meta.notes.length > 0) {
    lines.push("## Notes");
    lines.push("");
    for (const note of report.meta.notes) lines.push(`- ${note}`);
    lines.push("");
  }
  return lines.join("\n");
}
