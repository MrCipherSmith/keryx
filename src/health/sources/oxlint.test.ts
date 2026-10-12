import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { OXLINT_MISSING_CONFIG, OXLINT_MISSING_PACKAGE, OXLINT_NO_FILES, oxlintAdapter } from "./oxlint";
import { eslintAdapter } from "./eslint";
import { typescriptAdapter } from "./typescript";
import { runAdapter, runHealth } from "../run";
import { DEFAULT_HEALTH_CONFIG } from "../config";
import type { HealthContext, RawSourceResult } from "../types";

// AC1/AC2/AC6 fixtures. A fixture root is a temp tree holding only what the
// adapter under test looks for -- a config file and/or a fake
// `node_modules/.bin/<tool>` -- so "which linter does this project use" is
// decided by the tree, never by this repository's own tooling.
function root(label: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(tmpdir(), `keryx-${label}-${unique}`);
}

function ctx(cwd: string): HealthContext {
  return { cwd } as HealthContext;
}

// `run` mode, and `required` straight from the shipped defaults, so these
// fixtures exercise the same required/optional split the gate will see.
function runCfg(source: string): { mode: "run"; required: boolean } {
  const entry = DEFAULT_HEALTH_CONFIG.sources[source] ?? { mode: "auto", required: false };
  return { mode: "run", required: entry.required };
}

// A tool that answers `--version` and otherwise prints the given body and
// exits with the given code -- the shape a real lint/type run has (findings
// AND a non-zero exit), which `runAdapter` must not read as a broken source.
function fakeTool(body: string, exitCode: number, version = "Version 1.0.0"): string {
  return [
    "#!/bin/sh",
    `if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi`,
    "cat <<'TOOL_OUT'",
    body,
    "TOOL_OUT",
    `exit ${exitCode}`,
    "",
  ].join("\n");
}

// ESLint's own `--format json`: an array of per-file records. Used only for
// the eslint adapter below -- oxlint does NOT emit this shape.
const ESLINT_ONE_ERROR = JSON.stringify([
  { filePath: "src/a.ts", messages: [{ ruleId: "no-unused-vars", severity: 2, message: "unused", line: 4 }] },
]);

// Captured from a real `oxlint . --format json` run (oxlint 1.81.0, exit 1) over
// `const unused = 1;\ndebugger;\n` with no-unused-vars=warn, no-debugger=error.
// Field for field as the tool printed it. A hand-written ESLint-shaped fixture
// is how the first version of this parser passed every test while dropping
// every real diagnostic -- keep this one real.
const REAL_DIAGNOSTICS = [
  {
    message: "Variable 'unused' is declared but never used. Unused variables should start with a '_'.",
    code: "eslint(no-unused-vars)",
    severity: "warning",
    url: "https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unused-vars.html",
    help: "Consider removing this declaration.",
    filename: "src/a.js",
    labels: [{ label: "'unused' is declared here", span: { offset: 6, length: 6, line: 1, column: 7 } }],
  },
  {
    message: "`debugger` statement is not allowed",
    code: "eslint(no-debugger)",
    severity: "error",
    url: "https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-debugger.html",
    help: "Remove the debugger statement",
    filename: "src/a.js",
    labels: [{ span: { offset: 18, length: 9, line: 2, column: 1 } }],
  },
];
function realOutput(diagnostics: unknown[]): string {
  return JSON.stringify({ diagnostics, number_of_files: 1, number_of_rules: 96, threads_count: 12, start_time: 0.016584166 });
}
const OXLINT_WARN_AND_ERROR = realOutput(REAL_DIAGNOSTICS);

async function oxlintProject(label: string, output: string, exitCode: number): Promise<{ cwd: string; bin: string }> {
  const cwd = root(label);
  const bin = path.join(cwd, "node_modules", ".bin", "oxlint");
  await mkdir(path.dirname(bin), { recursive: true });
  await writeFile(path.join(cwd, ".oxlintrc.json"), "{}\n");
  await writeFile(bin, fakeTool(output, exitCode));
  await chmod(bin, 0o755);
  return { cwd, bin };
}

test("AC1: real oxlint output with an error (exit 1) is available, parsed, one finding per diagnostic", async () => {
  const { cwd, bin } = await oxlintProject("oxlint-only", OXLINT_WARN_AND_ERROR, 1);
  try {
    expect(await oxlintAdapter.detect(ctx(cwd))).toBe("available");
    const outcome = await runAdapter(oxlintAdapter, ctx(cwd), runCfg("oxlint"), `test-${Date.now()}`);
    expect(outcome.info.command).toContain(bin);
    expect(outcome.info.command).toContain("--format json");
    expect(outcome.info.status).toBe("available");
    expect(outcome.info.execution).toBe("completed");
    expect(outcome.info.parse).toBe("parsed");
    expect(outcome.info.capability).toBe("lint");
    expect(outcome.info.findings).toBe(REAL_DIAGNOSTICS.length);
    // The findings belong to the linter that actually ran -- NOT to eslint.
    expect(outcome.findings.map((f) => f.source)).toEqual(["oxlint", "oxlint"]);
    const [warning, error] = outcome.findings;
    expect(warning).toMatchObject({ severity: "warning", priority: "P2", file: "src/a.js", line: 1 });
    expect(warning?.id).toContain("no-unused-vars");
    expect(error).toMatchObject({ severity: "error", priority: "P1", file: "src/a.js", line: 2 });
    expect(error?.id).toContain("no-debugger");
    expect(error?.message).toBe("`debugger` statement is not allowed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AC6: real oxlint output with warnings only (exit 0) reports them, never an empty success", async () => {
  const { cwd } = await oxlintProject("oxlint-warn", realOutput([REAL_DIAGNOSTICS[0]]), 0);
  try {
    const outcome = await runAdapter(oxlintAdapter, ctx(cwd), runCfg("oxlint"), `test-${Date.now()}`);
    expect(outcome.info.status).toBe("available");
    expect(outcome.info.findings).toBe(1);
    expect(outcome.findings[0]?.priority).toBe("P2");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("end to end: an oxlint-only project is linted by oxlint and required eslint does not block", async () => {
  // Through `runHealth`, so the adapter's registration in FINDING_ADAPTERS,
  // the capability runAdapter copies, and the gate are exercised together --
  // the unit tests above would all stay green if any one link were cut.
  const { cwd } = await oxlintProject("oxlint-e2e", realOutput([REAL_DIAGNOSTICS[0]]), 0);
  try {
    await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(cwd, ".metaproject", "health.config.json"),
      JSON.stringify({
        sources: {
          eslint: { mode: "auto", required: true },
          oxlint: { mode: "auto", required: false },
          typescript: { mode: "disabled", required: false },
          tests: { mode: "disabled", required: false },
          coverage: { mode: "disabled", required: false },
          dependencyAudit: { mode: "disabled", required: false },
          sonarqube: { mode: "disabled", required: false },
          complexity: { mode: "disabled", required: false },
        },
      }),
    );
    const { report } = await runHealth({ cwd });
    const oxlint = report.sources.find((s) => s.source === "oxlint");
    const eslint = report.sources.find((s) => s.source === "eslint");
    expect(oxlint).toMatchObject({ status: "available", parse: "parsed", findings: 1, capability: "lint" });
    expect(eslint?.status).toBe("skipped");
    // A skipped source performed no lookup, so it carries no reason.
    expect(eslint?.error).toBeUndefined();
    expect(report.gate.status).not.toBe("incomplete");
    expect(report.gate.coverage).toBe("complete");
    expect(report.gate.reasons).toContain("NOTE: eslint skipped; lint capability provided by oxlint");
    expect(report.findings.filter((f) => f.source === "oxlint")).toHaveLength(1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("oxlint with no files to lint names that cause, not a format error", async () => {
  // Real oxlint 1.81.0 in a tree with nothing to lint: this line on STDOUT,
  // then an empty JSON run, exit 1.
  // Leading whitespace included: the preamble is matched after trimming it.
  const stdout = `\n  No files found to lint. Please check your paths and ignore patterns.\n${realOutput([]).replace('"number_of_files":1', '"number_of_files":0')}`;
  const { cwd } = await oxlintProject("oxlint-no-files", stdout, 1);
  try {
    const outcome = await runAdapter(oxlintAdapter, ctx(cwd), runCfg("oxlint"), `test-${Date.now()}`);
    expect(outcome.info.status).toBe("configured-but-failed");
    expect(outcome.info.error).toBe(OXLINT_NO_FILES);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("only severity \"error\" is P1: advice and a missing severity are warnings", () => {
  const advice = { ...REAL_DIAGNOSTICS[1], severity: "advice" };
  const { severity: _dropped, ...noSeverity } = REAL_DIAGNOSTICS[1]!;
  const raw = { source: "oxlint", content: realOutput([advice, noSeverity]), command: "oxlint", toolVersion: null, exitCode: 0, rawPath: "", imported: false } as RawSourceResult;
  const findings = oxlintAdapter.parse(raw, ctx("/tmp"));
  expect(findings.map((f) => [f.severity, f.priority])).toEqual([["warning", "P2"], ["warning", "P2"]]);
});

test("end to end: --sources oxlint leaves a required eslint unexcused, with the same capability as an unfiltered run", async () => {
  const { cwd } = await oxlintProject("oxlint-filter", realOutput([REAL_DIAGNOSTICS[0]]), 0);
  try {
    const { report } = await runHealth({ cwd, sources: ["oxlint"] });
    const eslint = report.sources.find((s) => s.source === "eslint");
    expect(eslint).toMatchObject({ status: "skipped", filtered: true, capability: "lint", error: "excluded by source filter" });
    expect(report.gate.status).toBe("incomplete");
    expect(report.gate.reasons.some((r) => /lint capability provided by/.test(r))).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a clean oxlint run (empty diagnostics) is a parsed run with zero findings", () => {
  const raw = { source: "oxlint", content: realOutput([]), command: "oxlint", toolVersion: null, exitCode: 0, rawPath: "", imported: false } as RawSourceResult;
  expect(oxlintAdapter.validate?.(raw)).toEqual({ valid: true, format: "oxlint-json" });
  expect(oxlintAdapter.parse(raw, ctx("/tmp"))).toEqual([]);
});

test("an absolute diagnostic filename is reported relative to the project", () => {
  const absolute = { ...REAL_DIAGNOSTICS[1], filename: "/work/app/src/b.js" };
  const raw = { source: "oxlint", content: realOutput([absolute]), command: "oxlint", toolVersion: null, exitCode: 1, rawPath: "", imported: false } as RawSourceResult;
  expect(oxlintAdapter.parse(raw, ctx("/work/app"))[0]?.file).toBe("src/b.js");
});

test("ESLint-shaped or non-diagnostic JSON is not oxlint output: invalid, not zero findings", () => {
  const cases = [ESLINT_ONE_ERROR, JSON.stringify({ diagnostics: [{ filePath: "a.ts", messages: [] }] }), JSON.stringify({})];
  for (const content of cases) {
    const raw = { source: "oxlint", content, command: "oxlint", toolVersion: null, exitCode: 1, rawPath: "", imported: false } as RawSourceResult;
    expect(oxlintAdapter.validate?.(raw)).toEqual({ valid: false, error: "oxlint JSON format was not recognized" });
  }
});

test("AC2: an eslint-only fixture still detects eslint, and skips oxlint", async () => {
  const cwd = root("eslint-only");
  const bin = path.join(cwd, "node_modules", ".bin", "eslint");
  try {
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(path.join(cwd, "eslint.config.js"), "export default [];\n");
    await writeFile(bin, fakeTool(ESLINT_ONE_ERROR, 1));
    await chmod(bin, 0o755);

    expect(await eslintAdapter.detect(ctx(cwd))).toBe("available");
    expect(await oxlintAdapter.detect(ctx(cwd))).toBe("skipped");
    const outcome = await runAdapter(eslintAdapter, ctx(cwd), runCfg("eslint"), `test-${Date.now()}`);
    expect(outcome.info.status).toBe("available");
    expect(outcome.findings[0]?.source).toBe("eslint");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AC2: a project with neither linter skips both", async () => {
  const cwd = root("no-linters");
  try {
    await mkdir(cwd, { recursive: true });
    expect(await oxlintAdapter.detect(ctx(cwd))).toBe("skipped");
    expect(await eslintAdapter.detect(ctx(cwd))).toBe("skipped");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("oxlint configured (config file or package.json) without a binary is missing, and says which signal fired", async () => {
  const configOnly = root("oxlint-config");
  const jsoncOnly = root("oxlint-jsonc");
  const packageOnly = root("oxlint-package");
  try {
    await mkdir(configOnly, { recursive: true });
    await writeFile(path.join(configOnly, ".oxlintrc.json"), "{}\n");
    expect(await oxlintAdapter.detect(ctx(configOnly))).toBe("missing");
    const fromConfig = await runAdapter(oxlintAdapter, ctx(configOnly), runCfg("oxlint"), `test-${Date.now()}`);
    expect(fromConfig.info.error).toBe(OXLINT_MISSING_CONFIG);

    await mkdir(jsoncOnly, { recursive: true });
    await writeFile(path.join(jsoncOnly, ".oxlintrc.jsonc"), "{}\n");
    expect(await oxlintAdapter.detect(ctx(jsoncOnly))).toBe("missing");

    await mkdir(packageOnly, { recursive: true });
    await writeFile(
      path.join(packageOnly, "package.json"),
      JSON.stringify({ name: "p", devDependencies: { oxlint: "^1.0.0" } }),
    );
    expect(await oxlintAdapter.detect(ctx(packageOnly))).toBe("missing");
    // No config file in this tree, so the reason must not claim one.
    const fromPackage = await runAdapter(oxlintAdapter, ctx(packageOnly), runCfg("oxlint"), `test-${Date.now()}`);
    expect(fromPackage.info.error).toBe(OXLINT_MISSING_PACKAGE);
  } finally {
    await rm(configOnly, { recursive: true, force: true });
    await rm(jsoncOnly, { recursive: true, force: true });
    await rm(packageOnly, { recursive: true, force: true });
  }
});

test("an oxlint binary with no project config is skipped -- config is the intent", async () => {
  // oxlint arrives transitively in repositories that lint with ESLint; a
  // present binary must never start a second, unrequested lint verdict.
  const cwd = root("oxlint-bin-only");
  const bin = path.join(cwd, "node_modules", ".bin", "oxlint");
  try {
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    expect(await oxlintAdapter.detect(ctx(cwd))).toBe("skipped");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AC6: unparseable oxlint output is configured-but-failed, not an empty success", async () => {
  const cwd = root("oxlint-garbage");
  const bin = path.join(cwd, "node_modules", ".bin", "oxlint");
  try {
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(path.join(cwd, ".oxlintrc.json"), "{}\n");
    await writeFile(bin, fakeTool("this is not json", 1));
    await chmod(bin, 0o755);
    const outcome = await runAdapter(oxlintAdapter, ctx(cwd), runCfg("oxlint"), `test-${Date.now()}`);
    expect(outcome.info.status).toBe("configured-but-failed");
    expect(outcome.info.parse).toBe("failed");
    expect(outcome.info.findings).toBe(0);
    // Named, and inside run.ts's closed validation vocabulary (T70 F-002).
    expect(outcome.info.error).toBe("oxlint JSON format was not recognized");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AC6: a non-zero tsc exit with recognized TS errors yields findings, not a missing source", async () => {
  const cwd = root("tsc-errors");
  const bin = path.join(cwd, "node_modules", ".bin", "tsc");
  try {
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(path.join(cwd, "tsconfig.json"), "{}\n");
    await writeFile(bin, fakeTool("src/a.ts(1,7): error TS2322: Type 'string' is not assignable.", 2, "Version 7.0.2"));
    await chmod(bin, 0o755);

    expect(await typescriptAdapter.detect(ctx(cwd))).toBe("available");
    const outcome = await runAdapter(typescriptAdapter, ctx(cwd), runCfg("typescript"), `test-${Date.now()}`);
    expect(outcome.info.status).toBe("available");
    expect(outcome.info.exitCode).toBe(2);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.source).toBe("typescript");
    expect(outcome.findings[0]?.message).toContain("TS2322");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
