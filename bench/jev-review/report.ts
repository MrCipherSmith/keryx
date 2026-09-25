// Flow 331, AC3/AC4 — the report generator. AC4's honest-reporting rules are
// encoded here, not left to whoever reads the JSON later:
//
//   1. n and a 95% CI are printed next to EVERY percentage — `formatRate`
//      is the only place this benchmark renders a rate, and it never emits
//      a bare percentage.
//   2. Anecdotal labelling is RATE-level, not component-level: each rate
//      (accuracy/precision/noise) carries its own n — the denominator it was
//      actually computed over, e.g. the flagged subset for precision, which
//      can be much smaller than the component's overall n — and is labelled
//      `anecdotal` inline the moment THAT n is below `ANECDOTAL_THRESHOLD_N`,
//      not just in a footnote and not gated on the component's n. A
//      large-n component can still report an anecdotal precision.
//   3. Run-to-run variance (repeated with-jev runs on a subset) is printed
//      as its own section when present, never folded silently into a
//      single-run number; with fewer than 5 repeats the interval is labelled
//      as a plain range over the repeats actually run, not a confidence
//      interval — see `renderMarkdown`'s variance section.
import { isMeasuredRate, type RateWithCI } from "../../src/metrics/benchmark";
import { ANECDOTAL_THRESHOLD_N } from "./metrics";
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

/**
 * A percentile bootstrap over fewer than this many repeats has too little
 * data to behave like a real interval — with 2 repeats it collapses to the
 * plain min/max of the two values, which LOOKS like a confidence interval
 * but describes nothing statistical. Below this threshold the report labels
 * the interval honestly as a range over the repeats actually run, computed
 * directly as min/max rather than borrowing the bootstrap's number.
 */
const REPEATS_FOR_BOOTSTRAP = 5;

function varianceIntervalLabel(v: VarianceReport): string {
  if (v.repeats < REPEATS_FOR_BOOTSTRAP) {
    if (v.values.length === 0) return "n/a";
    const lower = Math.min(...v.values);
    const upper = Math.max(...v.values);
    return `range over ${v.repeats} repeat${v.repeats === 1 ? "" : "s"}: [${pct(lower)}, ${pct(upper)}]`;
  }
  return v.bootstrapCi95 ? `bootstrap 95% CI [${pct(v.bootstrapCi95.lower)}, ${pct(v.bootstrapCi95.upper)}]` : "n/a";
}

/**
 * AC4 rule 1: never a bare percentage. AC4 rule 2 (rate-level): the rate's
 * OWN `n` — not the component's overall `n` — decides whether IT is
 * anecdotal, because that `n` is the denominator this specific rate was
 * actually computed over (e.g. precision's flagged subset, which can be far
 * smaller than the component's total case count).
 */
export function formatRate(rate: RateWithCI | null, n?: number): string {
  if (rate === null) return `not measured (n=${n ?? 0})`;
  if (!isMeasuredRate(rate)) return `not measured (n=0)`;
  const anecdotal = rate.n < ANECDOTAL_THRESHOLD_N ? " **anecdotal**" : "";
  return `${pct(rate.rate)} (n=${rate.n}, 95% CI [${pct(rate.ci95.lower)}, ${pct(rate.ci95.upper)}])${anecdotal}`;
}

function componentLine(m: ComponentMetrics): string {
  if (!m.available) return `| ${m.component} | ${m.arm} | not available | ${m.reason} |`;
  // Component-level context only — the overall case count, not a claim that
  // every rate below shares this n. Each rate's own anecdotal marking (from
  // `formatRate`) is the one that actually governs that rate's reliability.
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
  lines.push(
    `- Anecdotal labelling is per-rate: a rate is marked **anecdotal** the moment ITS OWN n (the denominator it was actually computed over — e.g. precision's flagged subset, which can be smaller than the component's overall n) is below ${ANECDOTAL_THRESHOLD_N}. Read it as a data point, not a finding.`,
  );
  lines.push(
    `- Run-to-run variance (§Variance) reflects repeated with-jev runs on a subset, when this run measured any. With fewer than ${REPEATS_FOR_BOOTSTRAP} repeats the interval is a plain range (min-max) over the repeats actually run, not a statistical confidence interval, and is labelled "range over N repeats" rather than "bootstrap 95% CI".`,
  );
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
    lines.push("| component | repeats | values | mean | stddev | interval |");
    lines.push("|---|---|---|---|---|---|");
    for (const v of report.variance) {
      lines.push(`| ${v.component} | ${v.repeats} | ${v.values.map(pct).join(", ")} | ${pct(v.mean)} | ${pct(v.stddev)} | ${varianceIntervalLabel(v)} |`);
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
