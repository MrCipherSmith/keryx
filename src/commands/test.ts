import {
  analyzeTestingProject,
  findRelatedTests,
  loadTestingConfig,
  loadTestingContext,
  loadTestingReport,
  runTesting,
  testingDataRoot,
} from "../testing/service";
import { buildCoverageMap, coverageMapPath, loadCoverageMap } from "../testing/coverage-map";
import { isTestingCapabilityEnabled } from "../testing/capability";
import { optionValue } from "../lib/args";

export async function testCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init" || command === "analyze") {
    await runAnalyze();
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
  if (command === "context") {
    await runContext();
    return;
  }
  if (command === "report") {
    await runReport(args.slice(1));
    return;
  }
  if (command === "related") {
    await runRelated(args.slice(1));
    return;
  }
  if (command === "explain") {
    await runExplain(args.slice(1));
    return;
  }
  if (command === "coverage-map") {
    await runCoverageMap(args.slice(1));
    return;
  }
  if (command === "suggest") {
    await runSuggest(args.slice(1));
    return;
  }

  console.error(`Unknown test command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function runSuggest(args: string[]): Promise<void> {
  const target = args.find((arg) => !arg.startsWith("--"));
  if (!target) {
    console.error("Usage: keryx test suggest <file> [--provider <p>] [--model <m>] [--json]");
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const [context, related] = await Promise.all([
    analyzeTestingProject(cwd),
    findRelatedTests(cwd, target),
  ]);
  const { readFile } = await import("node:fs/promises");
  const pathMod = (await import("node:path")).default;
  let source = "";
  try {
    source = await readFile(pathMod.resolve(cwd, target), "utf8");
  } catch {
    console.error(`Cannot read ${target}.`);
    process.exitCode = 1;
    return;
  }

  const { narrate } = await import("../lib/narrate");
  await narrate({
    args,
    requestId: `test-suggest:${target}`,
    maxOutputTokens: 1200,
    system:
      "You are a test engineer. Propose a concise, prioritized test plan (unit + edge cases) " +
      "for the given source file, matching the project's existing test frameworks and " +
      "conventions. List concrete cases as a bullet list; do not write full test code unless " +
      "a case needs a short illustrative snippet.",
    user: [
      `Frameworks: ${context.frameworks.join(", ") || "unknown"}`,
      `Existing related tests: ${related.length > 0 ? related.join(", ") : "none"}`,
      "",
      `Source file: ${target}`,
      "```",
      source.slice(0, 8000),
      "```",
    ].join("\n"),
  });
}

async function runAnalyze(): Promise<void> {
  const context = await analyzeTestingProject(process.cwd());
  console.log("# testing analyze");
  console.log("");
  console.log(`frameworks: ${context.frameworks.join(", ") || "none"}`);
  console.log(`scripts: ${context.scripts.length}`);
  console.log(`configs: ${context.configs.length}`);
  console.log(`test files: ${context.testFiles.length}`);
  console.log(`recommendations: ${context.recommendations.length}`);
  console.log("");
  console.log(`context: ${testingDataRoot(process.cwd())}/context.md`);
  console.log(`json: ${testingDataRoot(process.cwd())}/context.json`);
}

async function runRun(args: string[]): Promise<void> {
  const runId = optionValue(args, "--run-id");
  const result = await runTesting({
    cwd: process.cwd(),
    changed: args.includes("--changed"),
    since: optionValue(args, "--since") ?? null,
    scope: optionValue(args, "--scope") ?? null,
    kind: optionValue(args, "--kind") ?? null,
    strict: args.includes("--strict") || args.includes("--gate"),
    ...(runId ? { runId } : {}),
  });
  console.log(`# Test Report: ${result.report.status.toUpperCase()}`);
  console.log("");
  console.log(`scope: ${result.report.scope}`);
  console.log(`runner: ${result.report.runner ?? "n/a"}`);
  console.log(`command: ${result.report.command ?? "n/a"}`);
  console.log(`passed: ${result.report.counts.passed}`);
  console.log(`failed: ${result.report.counts.failed}`);
  console.log(`selected tests: ${result.report.selection.selectedTests.length}`);
  console.log("");
  console.log(`report: ${result.markdownPath}`);
  console.log(`json: ${result.jsonPath}`);
  if (result.securityWarnings && result.securityWarnings.length > 0) {
    console.log("");
    console.log("Security:");
    for (const warning of result.securityWarnings) {
      console.log(`- ${warning}`);
    }
  }
  process.exitCode = result.report.status === "fail" || result.report.status === "error" ? 1 : 0;
}

async function runStatus(): Promise<void> {
  const context = await loadTestingContext(process.cwd());
  const report = await loadTestingReport(process.cwd());
  console.log("# testing status");
  console.log("");
  console.log(`enabled: ${context ? "yes" : "no"}`);
  console.log(`frameworks: ${context?.frameworks.join(", ") || "none"}`);
  console.log(`test files: ${context?.testFiles.length ?? 0}`);
  console.log(`latest run: ${report?.generatedAt ?? "never"}`);
  console.log(`latest status: ${report?.status ?? "n/a"}`);
}

async function runContext(): Promise<void> {
  const context = await loadTestingContext(process.cwd());
  if (!context) {
    console.log("No testing context yet. Run `keryx test analyze`.");
    return;
  }
  console.log("# testing context");
  console.log("");
  console.log(`generatedAt: ${context.generatedAt}`);
  console.log(`frameworks: ${context.frameworks.join(", ") || "none"}`);
  console.log(`scripts: ${context.scripts.map((script) => script.name).join(", ") || "none"}`);
  console.log(`configs: ${context.configs.length}`);
  console.log(`test files: ${context.testFiles.length}`);
  console.log("");
  console.log("## Recommendations");
  for (const recommendation of context.recommendations) {
    console.log(`- ${recommendation}`);
  }
}

async function runReport(args: string[]): Promise<void> {
  if (args[0] && args[0] !== "latest") {
    console.error("Usage: keryx test report latest [--json]");
    process.exitCode = 1;
    return;
  }
  const report = await loadTestingReport(process.cwd());
  if (!report) {
    console.log("No testing report yet. Run `keryx test run`.");
    return;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`# Test Report: ${report.status.toUpperCase()}`);
  console.log("");
  console.log(`scope: ${report.scope}`);
  console.log(`runner: ${report.runner ?? "n/a"}`);
  console.log(`command: ${report.command ?? "n/a"}`);
  console.log(`failures: ${report.failures.length}`);
}

async function runRelated(args: string[]): Promise<void> {
  const target = args[0];
  if (!target) {
    console.error("Usage: keryx test related <file>");
    process.exitCode = 1;
    return;
  }
  const related = await findRelatedTests(process.cwd(), target);
  console.log(`# related tests: ${target}`);
  console.log("");
  if (related.length === 0) {
    console.log("- none");
    return;
  }
  for (const file of related) {
    console.log(`- ${file}`);
  }
}

async function runExplain(args: string[]): Promise<void> {
  const target = args[0];
  if (!target) {
    console.error("Usage: keryx test explain <file-or-scope>");
    process.exitCode = 1;
    return;
  }
  const context = await loadTestingContext(process.cwd());
  const report = await loadTestingReport(process.cwd());
  const related = await findRelatedTests(process.cwd(), target);
  console.log(`# testing explain: ${target}`);
  console.log("");
  console.log(`frameworks: ${context?.frameworks.join(", ") || "none"}`);
  console.log(`related tests: ${related.length}`);
  for (const file of related) {
    console.log(`- ${file}`);
  }
  console.log("");
  console.log("## Latest Failures");
  const failures = report?.failures.filter((failure) =>
    [failure.file, failure.name, failure.message].filter(Boolean).some((value) => String(value).includes(target)),
  ) ?? [];
  if (failures.length === 0) {
    console.log("- none");
    return;
  }
  for (const failure of failures) {
    console.log(`- [${failure.priority}] ${failure.message}${failure.file ? ` (${failure.file})` : ""}`);
  }
}

async function runCoverageMap(args: string[]): Promise<void> {
  const sub = args[0];
  const cwd = process.cwd();
  const config = await loadTestingConfig(cwd);

  if (sub === "build") {
    const context = (await loadTestingContext(cwd)) ?? (await analyzeTestingProject(cwd));
    const gitRef = await gitRefOf(cwd);
    const result = await buildCoverageMap(cwd, config, { testFiles: context.testFiles, gitRef });
    console.log("# testing coverage-map build");
    console.log("");
    console.log(`source: ${config.coverageMap.source}`);
    console.log(`entries: ${Object.keys(result.map.map).length}`);
    console.log(`artifact: ${coverageMapPath(cwd, config)}`);
    for (const warning of result.securityWarnings) {
      console.log(`security: ${warning}`);
    }
    return;
  }

  if (sub === "status" || !sub) {
    const map = await loadCoverageMap(cwd, config);
    const enabled = await isTestingCapabilityEnabled(cwd, "coverageMap");
    const currentRef = await gitRefOf(cwd);
    console.log("# testing coverage-map status");
    console.log("");
    console.log(`capability: ${enabled ? "enabled" : "disabled"}`);
    console.log(`config.enabled: ${config.coverageMap.enabled}`);
    console.log(`map present: ${map ? "yes" : "no"}`);
    if (map) {
      console.log(`entries: ${Object.keys(map.map).length}`);
      console.log(`generatedAt: ${map.generatedAt}`);
      console.log(`gitRef: ${map.gitRef ?? "n/a"}`);
      const stale = map.gitRef && currentRef && map.gitRef !== currentRef;
      console.log(`stale: ${stale ? "yes (falls back to static selection)" : "no"}`);
    }
    return;
  }

  console.error("Usage: keryx test coverage-map build|status");
  process.exitCode = 1;
}

async function gitRefOf(cwd: string): Promise<string | null> {
  if (!Bun.which("git")) {
    return null;
  }
  const proc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out.trim() : null;
}

function printHelp(): void {
  console.log(`keryx test

Usage:
  keryx test init
  keryx test analyze
  keryx test run [--changed] [--strict] [--since <ref>] [--scope <path>] [--kind unit|integration|e2e|smoke] [--run-id <id>]
  keryx test status
  keryx test context
  keryx test explain <file-or-scope>
  keryx test related <file>
  keryx test report latest [--json]
  keryx test suggest <file> [--provider <p>] [--model <m>] [--json]
  keryx test coverage-map build
  keryx test coverage-map status
`);
}
