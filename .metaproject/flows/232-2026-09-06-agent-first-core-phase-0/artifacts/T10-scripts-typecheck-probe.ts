/**
 * T10 aggregate acceptance review — independent probe for AC5.
 *
 * The committed `scripts/typecheck.test.ts` proves coverage and the injected
 * error SEPARATELY: it asserts the include globs resolve the real scripts, and
 * then injects a TS2322 into a NEW file inside a config that merely extends the
 * scripts target. This probe closes that gap by injecting the error into a REAL
 * covered script (`scripts/stress/keryx-shell-stress.ts` and
 * `scripts/benchmark/run-containment.ts`), through an in-memory compiler host
 * overlay, so the working tree is never modified and the file set is exactly the
 * one `tsconfig.scripts.json` produces.
 *
 * Read-only: no file in the repository is written or changed. No network.
 */
import path from "node:path";
import ts from "typescript";

const REPO_ROOT = "/Users/Goodea/goodea/keryx";
const SCRIPTS_CONFIG = path.join(REPO_ROOT, "tsconfig.scripts.json");

const configText = ts.sys.readFile(SCRIPTS_CONFIG);
if (configText === undefined) throw new Error(`missing ${SCRIPTS_CONFIG}`);
const parsedJson = ts.parseConfigFileTextToJson(SCRIPTS_CONFIG, configText);
if (parsedJson.error !== undefined) throw new Error("tsconfig.scripts.json is not parseable");
const parsed = ts.parseJsonConfigFileContent(parsedJson.config, ts.sys, REPO_ROOT);

const fileNames = parsed.fileNames.map((f) => path.resolve(f));
const COVERED = [
  "scripts/stress/keryx-shell-stress.ts",
  "scripts/benchmark/run-containment.ts",
  "scripts/stress/concurrent-suite-stress.ts",
  "scripts/benchmark/run-ablation.ts",
].map((rel) => path.join(REPO_ROOT, rel));

function compile(overlay: Map<string, string>): ts.Diagnostic[] {
  const host = ts.createCompilerHost(parsed.options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    const overridden = overlay.get(path.resolve(name));
    if (overridden !== undefined) {
      return ts.createSourceFile(name, overridden, languageVersion, true);
    }
    return originalGetSourceFile(name, languageVersion, onError, shouldCreate);
  };
  host.readFile = (name) => overlay.get(path.resolve(name)) ?? ts.sys.readFile(name);
  const program = ts.createProgram({ rootNames: fileNames, options: parsed.options, host });
  return [...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics()];
}

const cases: Record<string, unknown> = {};

// P1 — every benchmark/stress entrypoint under review is actually in the
// project's resolved file set.
{
  const missing = COVERED.filter((file) => !fileNames.includes(file));
  cases.P1_covered_scripts_are_in_the_project = {
    totalFiles: fileNames.length,
    checked: COVERED.map((f) => path.relative(REPO_ROOT, f)),
    missing: missing.map((f) => path.relative(REPO_ROOT, f)),
    pass: missing.length === 0,
  };
}

// P2 — the project is clean as it stands (same file set, no overlay).
{
  const diagnostics = compile(new Map());
  cases.P2_scripts_project_is_clean = {
    diagnosticCount: diagnostics.length,
    firstDiagnostics: diagnostics.slice(0, 5).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
    pass: diagnostics.length === 0,
  };
}

// P3/P4 — an injected strict type error inside a REAL covered script is
// reported against that script.
for (const [caseName, target] of [
  ["P3_injected_error_in_stress_script_is_caught", path.join(REPO_ROOT, "scripts/stress/keryx-shell-stress.ts")],
  ["P4_injected_error_in_containment_script_is_caught", path.join(REPO_ROOT, "scripts/benchmark/run-containment.ts")],
] as const) {
  const original = ts.sys.readFile(target);
  if (original === undefined) throw new Error(`missing ${target}`);
  const overlay = new Map([[target, `${original}\nconst t10InjectedTypeError: number = "M10";\n`]]);
  const diagnostics = compile(overlay);
  const hits = diagnostics.filter((d) => d.file !== undefined && path.resolve(d.file.fileName) === target && d.code === 2322);
  cases[caseName] = {
    target: path.relative(REPO_ROOT, target),
    totalDiagnostics: diagnostics.length,
    ts2322InTarget: hits.length,
    message: hits[0] === undefined ? null : ts.flattenDiagnosticMessageText(hits[0].messageText, " "),
    pass: hits.length === 1,
  };
}

const failed = Object.entries(cases).filter(([, value]) => (value as { pass: boolean }).pass !== true);
console.log(JSON.stringify({ cases, failedCases: failed.map(([n]) => n), allPassed: failed.length === 0 }, null, 2));
if (failed.length > 0) process.exitCode = 1;
