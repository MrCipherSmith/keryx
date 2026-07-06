import { createCodeHealthService } from "../health/service";
import { computeTrend, loadHistory } from "../health/history";
import type { ScopeSelector } from "../health/types";

const service = createCodeHealthService();

export async function healthCommand(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "run") {
    await runRun(args.slice(1));
    return;
  }
  if (command === "status") {
    await runStatus();
    return;
  }
  if (command === "gate") {
    await runGate(args.slice(1));
    return;
  }
  if (command === "sources") {
    await runSources();
    return;
  }
  if (command === "explain") {
    await runExplain(args.slice(1));
    return;
  }
  if (command === "baseline") {
    await runBaseline(args.slice(1));
    return;
  }
  if (command === "trend") {
    await runTrend(args.slice(1));
    return;
  }

  console.error(`Unknown health command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function runRun(args: string[]): Promise<void> {
  const scope = parseScope(args);
  const sourcesArg = valueAfter(args, "--source");
  const result = await service.run({
    cwd: process.cwd(),
    strict: args.includes("--strict"),
    ...(scope ? { scope } : {}),
    ...(sourcesArg ? { sources: sourcesArg.split(",").map((s) => s.trim()) } : {}),
  });

  const project = result.report.metrics.find((m) => m.key === "project");
  console.log(`# Code Health: ${result.report.gate.status.toUpperCase()}`);
  console.log("");
  console.log(`scope: ${result.report.scope}${result.report.strict ? " (strict)" : ""}`);
  console.log(`project score: ${project?.health_score ?? "n/a"} (trend: ${project?.trend ?? "unknown"})`);
  console.log(`findings: ${result.report.findings.length}`);
  console.log("");
  for (const reason of result.report.gate.reasons) {
    console.log(`- ${reason}`);
  }
  console.log("");
  console.log(`report: ${result.markdownPath}`);
  console.log(`json: ${result.jsonPath}`);

  process.exitCode = result.report.gate.status === "fail" ? 1 : 0;
}

async function runStatus(): Promise<void> {
  const status = await service.status({ cwd: process.cwd() });
  console.log("# health status");
  console.log("");
  console.log(`enabled: ${status.enabled ? "yes" : "no"}`);
  console.log(`last run: ${status.lastRunAt ?? "never"}`);
  console.log(`gate: ${status.gate ?? "n/a"}`);
  console.log(`project score: ${status.projectScore ?? "n/a"}`);
  console.log(`regressed scopes: ${status.regressions}`);

  const trend = computeTrend(await loadHistory(process.cwd()), "project");
  if (trend.count >= 2) {
    console.log(
      `trend (last ${trend.count} runs): ${trend.direction} (${trend.first} -> ${trend.current}, Δ ${signed(trend.delta)})`,
    );
  }

  if (status.sources.length > 0) {
    console.log("");
    console.log("## Sources");
    for (const source of status.sources) {
      console.log(`- ${source.source}: ${source.status}`);
    }
  }
}

async function runGate(args: string[]): Promise<void> {
  const result = await service.gate({
    cwd: process.cwd(),
    strictWarn: args.includes("--strict-warn"),
  });
  console.log(`gate: ${result.status}`);
  for (const reason of result.reasons) {
    console.log(`- ${reason}`);
  }
  process.exitCode = result.exitCode;
}

async function runSources(): Promise<void> {
  const result = await service.sources({ cwd: process.cwd() });
  console.log("# health sources");
  console.log("");
  for (const source of result.sources) {
    console.log(
      `- ${source.source}: ${source.status} (mode ${source.mode}, ${source.required ? "required" : "optional"})`,
    );
  }
}

async function runExplain(args: string[]): Promise<void> {
  const target = args[0];
  if (!target) {
    console.error("Usage: gd-metapro health explain <file-or-module>");
    process.exitCode = 1;
    return;
  }
  const result = await service.explain({ cwd: process.cwd(), target });
  if (!result.found) {
    console.log(`No health metrics for ${target}. Run \`gd-metapro health run\` first.`);
    return;
  }
  const m = result.metrics;
  console.log(`# health explain: ${target}`);
  console.log("");
  if (m) {
    console.log(`kind: ${m.kind}`);
    console.log(`health_score: ${m.health_score} (trend: ${m.trend}, regression: ${m.regression_score})`);
    console.log(`risk_score: ${m.risk_score}`);
    console.log(`findings: ${m.findingCounts.total}`);
    console.log(`coverage: ${m.coverage ?? "n/a"}`);
    console.log(`complexity: ${m.complexity ? `max ${m.complexity.max}, ${m.complexity.aboveThreshold} above threshold` : "n/a"}`);
  }
  console.log("");
  console.log("## Findings");
  if (result.findings.length === 0) {
    console.log("- none");
  } else {
    for (const f of result.findings.slice(0, 20)) {
      console.log(`- [${f.priority}] ${f.source}: ${f.message}${f.line ? ` (line ${f.line})` : ""}`);
    }
  }
}

async function runBaseline(args: string[]): Promise<void> {
  if (args[0] !== "update") {
    console.error("Usage: gd-metapro health baseline update [--scope ...]");
    process.exitCode = 1;
    return;
  }
  const scope = parseScope(args.slice(1));
  const result = await service.updateBaseline({
    cwd: process.cwd(),
    ...(scope ? { scope } : {}),
  });
  console.log(`Updated baseline (${result.updated.length} scope(s)): ${result.path}`);
}

async function runTrend(args: string[]): Promise<void> {
  const scopeKey = valueAfter(args, "--scope") ?? "project";
  const limitArg = valueAfter(args, "--limit");
  const limit = limitArg ? Math.max(2, Number(limitArg)) : 20;
  const history = await loadHistory(process.cwd(), limit);
  const trend = computeTrend(history, scopeKey);

  console.log(`# health trend: ${scopeKey}`);
  console.log("");
  if (trend.count === 0) {
    console.log("No history yet. Run `gd-metapro health run` a few times.");
    return;
  }
  console.log(`runs: ${trend.count}`);
  console.log(`direction: ${trend.direction}`);
  console.log(`score: ${trend.first} -> ${trend.current} (Δ ${signed(trend.delta)})`);
  console.log(`range: min ${trend.min}, max ${trend.max}`);
  console.log(`series: ${trend.series.join(" ")}`);
}

function signed(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return value > 0 ? `+${value}` : `${value}`;
}

function parseScope(args: string[]): ScopeSelector | undefined {
  if (args.includes("--changed")) {
    const since = valueAfter(args, "--since");
    return { kind: "changed", since: since ?? null };
  }
  const value = valueAfter(args, "--scope");
  if (!value) {
    return undefined;
  }
  if (value === "project") {
    return { kind: "project" };
  }
  if (value.startsWith("module:")) {
    return { kind: "module", name: value.slice("module:".length) };
  }
  if (value.startsWith("file:")) {
    return { kind: "file", path: value.slice("file:".length) };
  }
  return undefined;
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`gd-metapro health

Usage:
  gd-metapro health run [--strict] [--scope project|module:<name>|file:<path>] [--changed [--since <ref>]] [--source eslint,typescript]
  gd-metapro health status
  gd-metapro health gate [--strict-warn]
  gd-metapro health sources
  gd-metapro health explain <file-or-module>
  gd-metapro health baseline update [--scope ...]
  gd-metapro health trend [--scope <scope-key>] [--limit <n>]
`);
}
