import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { guardOutput, redactRaw, formatGuardWarning } from "../security/guard";
import type {
  TestingConfig,
  TestingContext,
  TestingFallbackWhenEmpty,
  TestingFailure,
  TestingReport,
  TestingRunInput,
  TestingRunResult,
  TestingScript,
  TestingStatus,
} from "./types";

const IGNORED_DIRS = new Set([
  ".git",
  ".metaproject",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
]);

const TEST_FILE_RE = /(^|\/)(__tests__\/.*|.*\.(test|spec)\.[cm]?[tj]sx?$|e2e\/.*\.[cm]?[tj]sx?$|tests\/.*\.[cm]?[tj]sx?$)/;
const CONFIG_FILE_RE = /(^|\/)(bunfig\.toml|vitest\.config\.[cm]?[tj]s|jest\.config\.[cm]?[tj]s|playwright\.config\.[cm]?[tj]s|cypress\.config\.[cm]?[tj]s|tsconfig.*\.json)$/;
const CI_FILE_RE = /(^|\/)(\.github\/workflows\/.*\.ya?ml|\.gitlab-ci\.yml)$/;
const INSTRUCTION_FILE_RE = /(^|\/)(AGENTS\.md|agents\.md|CLAUDE\.md|claude\.md|docs\/.*\.md|\.metaproject\/rules\/.*\.md|\.metaproject\/wiki\/.*\.md)$/;

const DEFAULT_TESTING_CONFIG: TestingConfig = {
  schemaVersion: 1,
  enabled: true,
  runner: "auto",
  changedSelection: {
    strategies: ["runner", "gdgraph", "naming"],
    fallbackWhenEmpty: "warn",
  },
  hooks: {
    postCommitRefresh: false,
    prePushGate: false,
  },
  artifacts: {
    keepRawLogs: true,
    historyLimit: 50,
  },
};

export function testingDataRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "testing");
}

export async function analyzeTestingProject(cwd: string): Promise<TestingContext> {
  const files = await listProjectFiles(cwd);
  const pkg = await readPackageJson(cwd);
  const scripts = getTestingScripts(pkg);
  const dependencies = {
    ...(asRecord(pkg?.dependencies)),
    ...(asRecord(pkg?.devDependencies)),
  };
  const configs = files.filter((file) => CONFIG_FILE_RE.test(file)).sort();
  const testFiles = files.filter((file) => TEST_FILE_RE.test(file)).sort();
  const ciFiles = files.filter((file) => CI_FILE_RE.test(file)).sort();
  const instructionFiles = files.filter((file) => INSTRUCTION_FILE_RE.test(file)).slice(0, 80).sort();
  const frameworks = detectFrameworks({ dependencies, scripts, configs, files });
  const conventions = await extractConventions(cwd, instructionFiles);
  const recommendations = buildRecommendations({
    frameworks,
    scripts,
    configs,
    testFiles,
    ciFiles,
  });

  const context: TestingContext = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    frameworks,
    scripts,
    configs,
    testFiles,
    ciFiles,
    instructionFiles,
    conventions,
    recommendations,
  };

  await writeContext(cwd, context);
  return context;
}

export async function runTesting(input: TestingRunInput): Promise<TestingRunResult> {
  const cwd = input.cwd;
  const started = Date.now();
  const config = await loadTestingConfig(cwd);
  const context = await ensureContext(cwd);
  const selectedTests = input.changed
    ? await selectChangedTests(cwd, context, input.since, config.changedSelection.fallbackWhenEmpty)
    : selectScopeTests(context, input.scope);
  const command = resolveTestCommand(cwd, context, {
    changed: Boolean(input.changed),
    kind: input.kind,
    selectedTests: selectedTests.selectedTests,
  });

  let status: TestingStatus = "skipped";
  let exitCode: number | null = null;
  let raw = "";
  // Security-safe copy of the raw output used for everything that flows into the
  // committable report (failures/counts/messages). Redaction is byte-identical
  // when security is disabled or nothing is detected, so normal output is
  // unaffected; when a secret IS present it is masked here so it never reaches
  // artifacts/latest.{md,json} — the raw-log write is gated separately below.
  let safeRaw = "";
  let rawLogPath: string | null = null;
  const securityWarnings: string[] = [];

  if (command) {
    const result = await runCommand(command.argv, cwd);
    exitCode = result.exitCode;
    raw = result.combined;
    // Security write seam (§11): gate the raw log before persisting it.
    // Advisory reports only and still writes; enforced/ci suppresses raw-log
    // persistence with a reason and never breaks the run.
    const guard = await guardOutput({
      cwd,
      content: raw,
      target: "report",
      source: "tool-output",
    });
    if (guard.allowed) {
      rawLogPath = await writeRawLog(cwd, raw);
      const warning = formatGuardWarning(guard.decision, "testing");
      if (warning) {
        securityWarnings.push(warning);
      }
    } else {
      securityWarnings.push(
        `raw log not persisted: ${guard.reason ?? "security gate blocked"}`,
      );
    }
    // Everything derived from output and put into the committable report must
    // use the redacted copy, so a secret in the test output cannot reach the
    // report via failure messages even though the raw-log write was suppressed.
    safeRaw = (await redactRaw({ cwd, content: raw, source: "tool-output" })).content;
    status = result.exitCode === 0 ? "pass" : "fail";
  }

  const failures = parseFailures(safeRaw);
  const counts = parseCounts(safeRaw, failures);
  if (!command) {
    counts.total = context.testFiles.length;
  }
  if (status === "pass" && failures.length > 0) {
    status = "fail";
  }
  if (status !== "pass" && status !== "skipped" && failures.length === 0) {
    failures.push({
      file: null,
      name: "test-command-failed",
      message: safeRaw.trim() ? firstMeaningfulLine(safeRaw) : "Test command failed with a non-zero exit code.",
      priority: "P0",
    });
    counts.failed = Math.max(counts.failed, 1);
    counts.total = Math.max(counts.total, counts.passed + counts.failed);
  }
  if (input.strict && input.changed && !command && selectedTests.fallback !== "none") {
    status = "fail";
    exitCode = 1;
    failures.push({
      file: null,
      name: "no-related-tests-selected",
      message: `Changed-scope test selection found no related tests (fallback: ${selectedTests.fallback}).`,
      priority: "P0",
    });
    counts.failed = Math.max(counts.failed, 1);
    counts.total = Math.max(counts.total, counts.passed + counts.failed);
  }

  const report: TestingReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitRef: await currentGitRef(cwd),
    status,
    scope: describeScope(input),
    runner: command?.runner ?? null,
    command: command?.display ?? null,
    exitCode,
    durationMs: Date.now() - started,
    counts,
    selection: {
      changed: Boolean(input.changed),
      strategies: ["runner", "gdgraph", "naming"],
      selectedTests: selectedTests.selectedTests,
      changedFiles: selectedTests.changedFiles,
      fallback: selectedTests.fallback,
    },
    failures,
    relatedFiles: Array.from(new Set([...selectedTests.changedFiles, ...selectedTests.selectedTests])).sort(),
    relatedSkills: [],
    rawLogPath,
  };

  const paths = await writeReport(cwd, report);
  const runResult: TestingRunResult = {
    report,
    markdownPath: paths.markdownPath,
    jsonPath: paths.jsonPath,
  };
  if (securityWarnings.length > 0) {
    runResult.securityWarnings = securityWarnings;
  }
  return runResult;
}

export async function loadTestingContext(cwd: string): Promise<TestingContext | null> {
  const file = path.join(testingDataRoot(cwd), "context.json");
  if (!(await pathExists(file))) {
    return null;
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as TestingContext;
  } catch {
    return null;
  }
}

export async function loadTestingReport(cwd: string): Promise<TestingReport | null> {
  const file = path.join(testingDataRoot(cwd), "artifacts", "latest.json");
  if (!(await pathExists(file))) {
    return null;
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as TestingReport;
  } catch {
    return null;
  }
}

export async function loadCompatibleTestingReport(
  cwd: string,
  input: { scope: "project" | "changed"; since?: string | null },
): Promise<TestingReport | null> {
  const report = await loadTestingReport(cwd);
  if (!report) {
    return null;
  }
  const gitRef = await currentGitRef(cwd);
  if (!report.gitRef || !gitRef || report.gitRef !== gitRef) {
    return null;
  }
  if (input.scope === "project") {
    return !report.selection.changed && report.scope === "project" ? report : null;
  }
  if (!report.selection.changed) {
    return null;
  }
  const expectedScope = input.since ? `changed since ${input.since}` : "changed";
  return report.scope === expectedScope ? report : null;
}

export async function findRelatedTests(cwd: string, target: string): Promise<string[]> {
  const context = (await loadTestingContext(cwd)) ?? (await analyzeTestingProject(cwd));
  return relatedByNamingAndDirectory(normalizePath(target), context.testFiles);
}

async function ensureContext(cwd: string): Promise<TestingContext> {
  return (await loadTestingContext(cwd)) ?? (await analyzeTestingProject(cwd));
}

async function writeContext(cwd: string, context: TestingContext): Promise<void> {
  const root = testingDataRoot(cwd);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "context.json"), `${JSON.stringify(context, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "context.md"), renderContextMarkdown(context), "utf8");
  await writeFile(path.join(root, "recommendations.md"), renderRecommendationsMarkdown(context), "utf8");
}

async function writeReport(
  cwd: string,
  report: TestingReport,
): Promise<{ markdownPath: string; jsonPath: string }> {
  const root = testingDataRoot(cwd);
  const artifacts = path.join(root, "artifacts");
  const history = path.join(root, "history");
  await mkdir(artifacts, { recursive: true });
  await mkdir(history, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const json = path.join(artifacts, "latest.json");
  const markdown = path.join(artifacts, "latest.md");
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(json, serialized, "utf8");
  await writeFile(markdown, renderReportMarkdown(report), "utf8");
  await writeFile(path.join(history, `${stamp}.json`), serialized, "utf8");
  return {
    markdownPath: path.relative(cwd, markdown),
    jsonPath: path.relative(cwd, json),
  };
}

async function writeRawLog(cwd: string, raw: string): Promise<string> {
  const logs = path.join(testingDataRoot(cwd), "logs");
  await mkdir(logs, { recursive: true });
  const latest = path.join(logs, "latest.raw.log");
  await writeFile(latest, raw, "utf8");
  return path.relative(cwd, latest);
}

async function listProjectFiles(cwd: string): Promise<string[]> {
  const out: string[] = [];
  await walk(cwd, cwd, out);
  return out.sort();
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".tmp-")) {
        continue;
      }
      await walk(root, abs, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(normalizePath(path.relative(root, abs)));
    }
  }
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown> | null> {
  const file = path.join(cwd, "package.json");
  if (!(await pathExists(file))) {
    return null;
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function loadTestingConfig(cwd: string): Promise<TestingConfig> {
  const file = path.join(cwd, ".metaproject", "testing.config.json");
  if (!(await pathExists(file))) {
    return DEFAULT_TESTING_CONFIG;
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<TestingConfig>;
    return {
      schemaVersion: parsed.schemaVersion ?? DEFAULT_TESTING_CONFIG.schemaVersion,
      enabled: parsed.enabled ?? DEFAULT_TESTING_CONFIG.enabled,
      runner: parsed.runner ?? DEFAULT_TESTING_CONFIG.runner,
      changedSelection: {
        ...DEFAULT_TESTING_CONFIG.changedSelection,
        ...(parsed.changedSelection ?? {}),
      },
      hooks: {
        ...DEFAULT_TESTING_CONFIG.hooks,
        ...(parsed.hooks ?? {}),
      },
      artifacts: {
        ...DEFAULT_TESTING_CONFIG.artifacts,
        ...(parsed.artifacts ?? {}),
      },
    };
  } catch {
    return DEFAULT_TESTING_CONFIG;
  }
}

function getTestingScripts(pkg: Record<string, unknown> | null): TestingScript[] {
  const scripts = asRecord(pkg?.scripts);
  return Object.entries(scripts)
    .filter(([name, command]) => /test|spec|e2e|playwright|vitest|jest|cypress/i.test(`${name} ${String(command)}`))
    .map(([name, command]) => ({ name, command: String(command) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function detectFrameworks(input: {
  dependencies: Record<string, unknown>;
  scripts: TestingScript[];
  configs: string[];
  files: string[];
}): string[] {
  const haystack = [
    ...Object.keys(input.dependencies),
    ...input.scripts.map((script) => `${script.name} ${script.command}`),
    ...input.configs,
    ...input.files.filter((file) => file.includes("bun.lockb")),
  ].join("\n");
  const frameworks: string[] = [];
  for (const [name, pattern] of [
    ["bun", /\bbun\b|bun:test|bun\.lockb/i],
    ["vitest", /\bvitest\b|vitest\.config/i],
    ["jest", /\bjest\b|jest\.config/i],
    ["playwright", /\bplaywright\b|playwright\.config/i],
    ["cypress", /\bcypress\b|cypress\.config/i],
    ["testing-library", /@testing-library\//i],
  ] as const) {
    if (pattern.test(haystack)) {
      frameworks.push(name);
    }
  }
  return frameworks;
}

async function extractConventions(cwd: string, files: string[]): Promise<string[]> {
  const conventions = new Set<string>();
  for (const file of files.slice(0, 40)) {
    const abs = path.join(cwd, file);
    if (!(await pathExists(abs))) {
      continue;
    }
    const text = await readFile(abs, "utf8");
    for (const line of text.split("\n")) {
      if (/test|testing|spec|coverage|playwright|vitest|jest|bun:test/i.test(line)) {
        const trimmed = line.trim().replace(/^[-*#\s]+/, "");
        if (trimmed.length >= 12 && trimmed.length <= 220) {
          conventions.add(`${file}: ${trimmed}`);
        }
      }
      if (conventions.size >= 30) {
        return Array.from(conventions);
      }
    }
  }
  return Array.from(conventions);
}

function buildRecommendations(input: {
  frameworks: string[];
  scripts: TestingScript[];
  configs: string[];
  testFiles: string[];
  ciFiles: string[];
}): string[] {
  const recommendations: string[] = [];
  if (input.frameworks.length === 0) {
    recommendations.push("No test framework detected. Choose a project test stack explicitly before adding generated tests.");
  }
  if (!input.scripts.some((script) => script.name === "test")) {
    recommendations.push("No package.json test script detected. Add a canonical `test` script when the project test stack is chosen.");
  }
  if (input.testFiles.length === 0) {
    recommendations.push("No test files detected. Keep module-specific recommendations here; do not generate test files automatically during init.");
  }
  if (input.configs.length === 0) {
    recommendations.push("No dedicated test config detected. Reuse existing TypeScript/runtime config or add one explicitly later.");
  }
  if (input.ciFiles.length === 0) {
    recommendations.push("No CI test workflow detected. Add CI gate separately from local Metaproject hooks.");
  }
  return recommendations;
}

async function selectChangedTests(
  cwd: string,
  context: TestingContext,
  since?: string | null,
  fallbackWhenEmpty: TestingFallbackWhenEmpty = "warn",
): Promise<{
  selectedTests: string[];
  changedFiles: string[];
  fallback: "none" | "warn" | "full" | "skipped";
}> {
  const changedFiles = await getChangedFiles(cwd, since ?? "HEAD");
  const selected = new Set<string>();
  for (const file of changedFiles) {
    if (TEST_FILE_RE.test(file)) {
      selected.add(file);
    }
    for (const related of relatedByNamingAndDirectory(file, context.testFiles)) {
      selected.add(related);
    }
  }
  if (selected.size === 0 && fallbackWhenEmpty === "full") {
    return {
      selectedTests: context.testFiles,
      changedFiles,
      fallback: "full",
    };
  }
  return {
    selectedTests: Array.from(selected).sort(),
    changedFiles,
    fallback: selected.size > 0 ? "none" : fallbackWhenEmpty === "skipped" ? "skipped" : "warn",
  };
}

function selectScopeTests(
  context: TestingContext,
  scope?: string | null,
): {
  selectedTests: string[];
  changedFiles: string[];
  fallback: "none" | "warn" | "full" | "skipped";
} {
  if (!scope) {
    return { selectedTests: [], changedFiles: [], fallback: "none" };
  }
  const normalized = normalizePath(scope);
  return {
    selectedTests: context.testFiles.filter((file) => file.startsWith(normalized) || file.includes(normalized)),
    changedFiles: [normalized],
    fallback: "none",
  };
}

async function getChangedFiles(cwd: string, since: string): Promise<string[]> {
  if (!Bun.which("git")) {
    return [];
  }
  const result = await runCommand(["git", "diff", "--name-only", since], cwd);
  const files = new Set(result.combined
    .split("\n")
    .map((line) => normalizePath(line.trim()))
    .filter((file) => file.length > 0 && !isIgnoredProjectFile(file)));
  const untracked = await runCommand(["git", "ls-files", "--others", "--exclude-standard"], cwd);
  for (const file of untracked.combined
    .split("\n")
    .map((line) => normalizePath(line.trim()))
    .filter((file) => file.length > 0 && !isIgnoredProjectFile(file))) {
    files.add(file);
  }
  if (files.size > 0) {
    return Array.from(files).sort();
  }
  const lastCommit = await runCommand(["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "HEAD"], cwd);
  return lastCommit.combined
    .split("\n")
    .map((line) => normalizePath(line.trim()))
    .filter((file) => file.length > 0 && !isIgnoredProjectFile(file));
}

function isIgnoredProjectFile(file: string): boolean {
  return (
    file.startsWith(".tmp-") ||
    file.includes("/.tmp-") ||
    file.startsWith(".metaproject/data/")
  );
}

function relatedByNamingAndDirectory(target: string, testFiles: string[]): string[] {
  const normalized = normalizePath(target);
  const ext = path.extname(normalized);
  const withoutExt = ext ? normalized.slice(0, -ext.length) : normalized;
  const base = path.basename(withoutExt);
  const dir = path.dirname(normalized);
  return testFiles
    .filter((file) => {
      const fileDir = path.dirname(file);
      const fileBase = path.basename(file);
      return (
        file.startsWith(`${withoutExt}.`) ||
        file.includes(`${withoutExt}.`) ||
        (fileDir === dir && fileBase.startsWith(`${base}.`)) ||
        (fileDir.startsWith(dir) && fileBase.includes(base))
      );
    })
    .sort();
}

function resolveTestCommand(
  cwd: string,
  context: TestingContext,
  input: { changed: boolean; kind?: string | null | undefined; selectedTests: string[] },
): { runner: string; argv: string[]; display: string } | null {
  const tests = input.selectedTests;
  if (input.changed && tests.length === 0) {
    return null;
  }
  const preferred = input.kind
    ? context.scripts.find((script) => script.name.includes(input.kind ?? ""))
    : context.scripts.find((script) => script.name === "test") ?? context.scripts[0];
  if (preferred) {
    const bunBin = resolveBunBin();
    if (bunBin && /\bbun\b/i.test(preferred.command)) {
      const argv = [bunBin, "run", preferred.name, ...tests];
      return { runner: "bun-script", argv, display: argv.join(" ") };
    }
    const packageManager = detectPackageManager(cwd);
    if (packageManager === "bun") {
      const argv = ["bun", "run", preferred.name, ...tests];
      return { runner: "bun-script", argv, display: argv.join(" ") };
    }
    if (packageManager === "pnpm") {
      const argv = ["pnpm", "run", preferred.name, ...tests];
      return { runner: "pnpm-script", argv, display: argv.join(" ") };
    }
    if (packageManager === "yarn") {
      const argv = ["yarn", preferred.name, ...tests];
      return { runner: "yarn-script", argv, display: argv.join(" ") };
    }
    const argv = ["npm", "run", preferred.name, "--", ...tests];
    return { runner: "npm-script", argv, display: argv.join(" ") };
  }
  const bunBin = resolveBunBin();
  if (context.frameworks.includes("bun") && bunBin) {
    const argv = [bunBin, "test", ...tests];
    return { runner: "bun", argv, display: argv.join(" ") };
  }
  return null;
}

function detectPackageManager(cwd: string): "bun" | "pnpm" | "yarn" | "npm" {
  if (resolveBunBin() && pathExistsSync(path.join(cwd, "bun.lockb"))) {
    return "bun";
  }
  if (Bun.which("pnpm") && pathExistsSync(path.join(cwd, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (Bun.which("yarn") && pathExistsSync(path.join(cwd, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

function resolveBunBin(): string | null {
  return Bun.which("bun") ?? ((process.versions as { bun?: string }).bun ? process.execPath : null);
}

function pathExistsSync(filePath: string): boolean {
  return existsSync(filePath);
}

async function runCommand(command: string[], cwd: string): Promise<{
  combined: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    combined: [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : ""),
    exitCode,
  };
}

function parseFailures(raw: string): TestingFailure[] {
  const failures: TestingFailure[] = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/\(fail\)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const name = (match[1] ?? "").trim();
    failures.push({
      file: name.match(/([\w./-]+\.(?:test|spec)\.[cm]?[tj]sx?)/)?.[1] ?? null,
      name,
      message: `Failing test: ${name}`,
      priority: "P0",
    });
  }
  return failures;
}

function parseCounts(
  raw: string,
  failures: TestingFailure[],
): { passed: number; failed: number; skipped: number; total: number } {
  const testLine = raw.match(/(\d+)\s+pass(?:es|ed)?(?:[\s,]+(\d+)\s+fail(?:ures|ed)?)?/i);
  const passed = testLine ? Number(testLine[1] ?? 0) : 0;
  const failed = failures.length;
  return {
    passed,
    failed,
    skipped: 0,
    total: passed + failed,
  };
}

async function currentGitRef(cwd: string): Promise<string | null> {
  if (!Bun.which("git")) {
    return null;
  }
  const result = await runCommand(["git", "rev-parse", "--short", "HEAD"], cwd);
  return result.exitCode === 0 ? result.combined.trim() : null;
}

function firstMeaningfulLine(raw: string): string {
  return raw.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 240) ?? "Test command failed.";
}

function describeScope(input: TestingRunInput): string {
  if (input.changed) {
    return `changed${input.since ? ` since ${input.since}` : ""}`;
  }
  if (input.scope) {
    return input.scope;
  }
  if (input.kind) {
    return input.kind;
  }
  return "project";
}

function renderContextMarkdown(context: TestingContext): string {
  return `# Testing Context

generatedAt: ${context.generatedAt}

## Frameworks

${list(context.frameworks)}

## Scripts

${context.scripts.length > 0 ? context.scripts.map((script) => `- \`${script.name}\`: \`${script.command}\``).join("\n") : "- none"}

## Configs

${list(context.configs)}

## Test Files

${list(context.testFiles.slice(0, 80))}
${context.testFiles.length > 80 ? `\n- ... ${context.testFiles.length - 80} more` : ""}

## CI

${list(context.ciFiles)}

## Conventions

${list(context.conventions.slice(0, 30))}

## Recommendations

${list(context.recommendations)}
`;
}

function renderRecommendationsMarkdown(context: TestingContext): string {
  return `# Testing Recommendations

generatedAt: ${context.generatedAt}

${list(context.recommendations)}
`;
}

function renderReportMarkdown(report: TestingReport): string {
  return `# Test Report: ${report.status.toUpperCase()}

scope: ${report.scope}
runner: ${report.runner ?? "n/a"}
command: ${report.command ?? "n/a"}
durationMs: ${report.durationMs}

## Counts

- passed: ${report.counts.passed}
- failed: ${report.counts.failed}
- skipped: ${report.counts.skipped}
- total: ${report.counts.total}

## Selection

- changed: ${report.selection.changed ? "yes" : "no"}
- strategies: ${report.selection.strategies.join(", ")}
- fallback: ${report.selection.fallback}
- selected tests: ${report.selection.selectedTests.length}

${list(report.selection.selectedTests)}

## Failures

${report.failures.length > 0 ? report.failures.map((failure) => `- [${failure.priority}] ${failure.message}${failure.file ? ` (${failure.file})` : ""}`).join("\n") : "- none"}

## Related Files

${list(report.relatedFiles.slice(0, 80))}

## Raw Log

${report.rawLogPath ? `- \`${report.rawLogPath}\`` : "- none"}
`;
}

function list(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}
