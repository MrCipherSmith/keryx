import { createCodeHealthService } from "../health/service";
import { computeTrend, loadHistory } from "../health/history";
import { optionValue } from "../lib/args";
import type { GateStatus, ScopeSelector } from "../health/types";

let service: ReturnType<typeof createCodeHealthService> | null = null;

function getService(): ReturnType<typeof createCodeHealthService> {
  service ??= createCodeHealthService();
  return service;
}

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
  const sourcesArg = optionValue(args, "--source");
  const runId = optionValue(args, "--run-id");
  const result = await getService().run({
    cwd: process.cwd(),
    strict: args.includes("--strict"),
    ...(scope ? { scope } : {}),
    ...(sourcesArg ? { sources: sourcesArg.split(",").map((s) => s.trim()) } : {}),
    ...(runId ? { runId } : {}),
  });

  if (args.includes("--json")) {
    console.log(JSON.stringify(result.report, null, 2));
    process.exitCode = runExitCode(result.report.gate.status, result.report.strict);
    return;
  }

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

  process.exitCode = runExitCode(result.report.gate.status, result.report.strict);
}

/**
 * Fold a health `GateStatus` into a process exit code for `keryx health run`.
 *
 * Exhaustive over `GateStatus` (`"pass" | "warn" | "incomplete" | "fail"`,
 * `src/health/types.ts`), with the default arm on the blocking side: a
 * status this fold has not been taught — a future `GateStatus` member, or a
 * runtime value the type checker would never let a caller construct
 * directly — refuses rather than falling through to a clean `0`. Mirrors
 * `isPassGate` (`src/commands/security.ts`), `runGate`
 * (`src/security/service.ts`) and `securityFlowGate`
 * (`src/security/guard.ts`) in *shape* only: health keeps its own
 * `GateStatus` vocabulary, not `SecurityGate` — no cross-module import.
 *
 * `fail` (an established threshold violation) and `incomplete` (a required
 * check that is missing, skipped, unparsed or unfinished) block
 * unconditionally, independent of `--strict` — policies.md never makes
 * either of those two contingent on strict mode, only "strict CI accepts
 * only PASS" is. `warn` blocks only under `--strict`, matching the sibling
 * fold in `src/health/service.ts`'s `gate()` (`strictWarn`). `pass` never
 * blocks. The previously-unreachable-by-type default arm blocks in both
 * strict and non-strict runs, the same as `fail`/`incomplete` already do,
 * because "an unrecognized or newly added value fails closed" carries no
 * strict-only qualifier.
 *
 * Exported so `health-gate-exit.test.ts` can drive every `GateStatus` value
 * directly, including one TypeScript's own union would refuse (cast through
 * `as unknown as GateStatus`) — the only way to exercise the default arm,
 * since `computeGate` (`src/health/gate.ts`) only ever produces one of the
 * four recognized values by the time either call site in `runRun` sees one.
 */
export function runExitCode(status: GateStatus, strict: boolean): number {
  switch (status) {
    case "pass":
      return 0;
    case "warn":
      return strict ? 1 : 0;
    case "fail":
    case "incomplete":
      return 1;
    default:
      return 1;
  }
}

async function runStatus(): Promise<void> {
  const status = await getService().status({ cwd: process.cwd() });
  console.log("# health status");
  console.log("");
  console.log(`enabled: ${status.enabled ? "yes" : "no"}`);
  console.log(`last run: ${status.lastRunAt ?? "never"}`);
  console.log(`gate: ${status.gate ?? "n/a"}`);
  console.log(`project score: ${status.projectScore ?? "n/a"}`);
  console.log(`declining scopes: ${status.decliningScopes}`);
  console.log(`regressed scopes: ${status.regressedScopes}`);

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
  const result = await getService().gate({
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
  const result = await getService().sources({ cwd: process.cwd() });
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
    console.error("Usage: keryx health explain <file-or-module>");
    process.exitCode = 1;
    return;
  }
  const result = await getService().explain({ cwd: process.cwd(), target });
  if (!result.found) {
    console.log(`No health metrics for ${target}. Run \`keryx health run\` first.`);
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

  if (args.includes("--narrate")) {
    const { narrate } = await import("../lib/narrate");
    console.log("");
    console.log("## Narration");
    await narrate({
      args,
      requestId: `health-explain:${target}`,
      maxOutputTokens: 800,
      system:
        "You are a senior engineer reviewing a code-health report for one file or module. " +
        "Explain what the metrics and findings mean and give concrete, prioritized remediation " +
        "steps. Be specific and concise. Do not invent findings beyond those provided.",
      user: `Target: ${target}\n\nHealth data (JSON):\n\`\`\`json\n${JSON.stringify(
        { metrics: result.metrics, findings: result.findings.slice(0, 30) },
        null,
        2,
      )}\n\`\`\``,
    });
  }
}

async function runBaseline(args: string[]): Promise<void> {
  if (args[0] !== "update") {
    console.error("Usage: keryx health baseline update [--scope ...]");
    process.exitCode = 1;
    return;
  }
  const scope = parseScope(args.slice(1));
  const result = await getService().updateBaseline({
    cwd: process.cwd(),
    ...(scope ? { scope } : {}),
  });
  console.log(`Updated baseline (${result.updated.length} scope(s)): ${result.path}`);
}

async function runTrend(args: string[]): Promise<void> {
  const scopeKey = optionValue(args, "--scope") ?? "project";
  const limitArg = optionValue(args, "--limit");
  const limit = limitArg ? Math.max(2, Number(limitArg)) : 20;
  const history = await loadHistory(process.cwd(), limit);
  const trend = computeTrend(history, scopeKey);

  console.log(`# health trend: ${scopeKey}`);
  console.log("");
  if (trend.count === 0) {
    console.log("No history yet. Run `keryx health run` a few times.");
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
    const since = optionValue(args, "--since");
    return { kind: "changed", since: since ?? null };
  }
  const value = optionValue(args, "--scope");
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

function printHelp(): void {
  console.log(`keryx health

Usage:
  keryx health run [--strict] [--scope project|module:<name>|file:<path>] [--changed [--since <ref>]] [--source eslint,typescript] [--run-id <id>]
  keryx health status
  keryx health gate [--strict-warn]
  keryx health sources
  keryx health explain <file-or-module> [--narrate] [--provider <p>] [--json]
  keryx health baseline update [--scope ...]
  keryx health trend [--scope <scope-key>] [--limit <n>]
`);
}
