import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  heading,
  helpOptions,
  helpTitle,
  helpUsage,
  note,
  style,
  symbols,
} from "../lib/ui";
import { optionValue } from "../lib/args";
import { resolveContainedPath, resolveProjectRoot } from "../lib/contained-path";
import { pathExists as fsPathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import {
  buildMcpBaseline,
  scanMcpManifest,
} from "../security/detect/mcp";
import type { DetectorMatch } from "../security/types";
import {
  analyze,
  createSecurityService,
  runReport,
  runScan,
} from "../security/service";
import {
  loadSecurityConfig,
  verifyConfigChecksum,
  validateSecurityConfig,
  configPath,
} from "../security/config";
import { listIncidents } from "../security/incidents";
import {
  installRuntimeHooks,
  resolveRuntimes,
  uninstallRuntimeHooks,
  runtimeIds,
} from "../security/agent-hooks";
import { runDetectorsAsync } from "../security/detect";
import {
  DEFAULT_CORPORA,
  formatEvalReport,
  gateEval,
  loadThresholds,
  pureDetect,
  runEval,
  type DetectFn,
} from "../security/eval/harness";
import { pathExists } from "../lib/fs";
import type {
  SecurityCheck,
  SecurityDecision,
  SecuritySource,
  SecurityTarget,
} from "../security/types";

const SOURCES: SecuritySource[] = [
  "trusted-project",
  "trusted-user",
  "untrusted-external",
  "tool-output",
  "generated",
];
const TARGETS: SecurityTarget[] = [
  "model",
  "memory",
  "wiki",
  "report",
  "external",
  "task",
  "unknown",
];

export async function securityCommand(
  args: string[] = [],
  cwd: string = process.cwd(),
): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printSecurityHelp();
    return;
  }

  const rest = args.slice(1);
  switch (subcommand) {
    case "status":
      await handleStatus(cwd);
      return;
    case "scan":
      await handleScan(cwd, rest);
      return;
    case "scan-mcp":
      await handleScanMcp(cwd, rest);
      return;
    case "check-input":
      await handleCheck(cwd, rest, "input");
      return;
    case "check-output":
      await handleCheck(cwd, rest, "output");
      return;
    case "redact":
      await handleRedact(cwd, rest);
      return;
    case "report":
      await handleReport(cwd, rest);
      return;
    case "policy":
      await handlePolicy(cwd, rest);
      return;
    case "incidents":
      await handleIncidents(cwd, rest);
      return;
    case "hooks":
      await handleHooks(cwd, rest);
      return;
    case "eval":
      await handleEval(cwd, rest);
      return;
    default:
      console.error(`Unknown security command: ${subcommand}`);
      printSecurityHelp();
      process.exitCode = 1;
  }
}

function parseSource(args: string[], fallback: SecuritySource): SecuritySource {
  const value = optionValue(args, "--source");
  if (value && (SOURCES as string[]).includes(value)) {
    return value as SecuritySource;
  }
  return fallback;
}

function parseTarget(args: string[], fallback: SecurityTarget): SecurityTarget {
  const value = optionValue(args, "--target");
  if (value && (TARGETS as string[]).includes(value)) {
    return value as SecurityTarget;
  }
  return fallback;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readContent(file: string | undefined): Promise<string> {
  if (file) {
    return readFile(file, "utf8");
  }
  if (process.stdin.isTTY) {
    return "";
  }
  return readStdin();
}

function surfaceWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.log(`  ${style.yellow(symbols.bullet)} ${warning}`);
  }
}

async function handleStatus(cwd: string): Promise<void> {
  const config = await loadSecurityConfig(cwd);
  const checksum = verifyConfigChecksum(config);
  const hasConfig = await pathExists(configPath(cwd));

  heading("keryx security status");
  note(`config: ${hasConfig ? configPath(cwd) : "built-in defaults"}`);
  console.log("");
  console.log(`  mode: ${style.bold(config.mode)}`);
  console.log(`  raw retention: ${config.rawRetention}`);
  console.log(`  gate.failOn: ${config.gate.failOn} (minConfidence ${config.gate.minConfidence})`);
  console.log(
    `  configChecksum: ${checksum.match ? style.green("ok") : style.red("MISMATCH")}`,
  );

  heading("Policies");
  for (const [name, policy] of Object.entries(config.policies)) {
    const marker = policy.enabled ? style.green(symbols.ok) : style.gray(symbols.off);
    console.log(`  ${marker} ${name} ${style.dim(`→ ${policy.action}`)}`);
  }
}

async function handleScan(cwd: string, args: string[]): Promise<void> {
  const file = optionValue(args, "--file") ?? args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: keryx security scan <path> [--json]");
    process.exitCode = 1;
    return;
  }
  // Contain before opening: the scanner reads whatever it is pointed at and
  // renders findings from the content, so an uncontained path turns a scanner
  // into a file reader for anything the process can reach.
  const contained = await resolveContainedPath(resolveProjectRoot(cwd), file);
  if (!contained.ok) {
    console.error(contained.message);
    process.exitCode = 1;
    return;
  }
  const content = await readFile(contained.path, "utf8");
  const source = parseSource(args, "trusted-project");
  const result = await runScan(cwd, { content, source, path: file });
  const asJson = args.includes("--json");

  if (asJson) {
    console.log(JSON.stringify(result.report, null, 2));
  } else {
    heading("keryx security scan");
    note(file);
    surfaceWarnings(result.warnings);
    renderDecision(result.decision);
    console.log("");
    console.log(`  report: ${result.markdownPath}`);
    console.log(`  json:   ${result.jsonPath}`);
  }

  process.exitCode = exitCodeFor(result.decision, cwd, await modeOf(cwd));
}

type McpBaselineFile = { schemaVersion: number; tools: Record<string, string> };

function mcpBaselinePath(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "security", "mcp-baseline.json");
}

// Collect the manifest JSON files to scan: a single file, or every *.json under
// a directory (recursively — the mcp-threat corpus nests subcorpora).
async function collectManifestFiles(target: string): Promise<string[]> {
  if (!(await fsPathExists(target))) {
    return [];
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    // Not a directory — treat as a single file.
    return [target];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectManifestFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "cases.json") {
      files.push(full);
    }
  }
  return files.sort();
}

// A corpus/manifest file is either a bare MCP manifest (`{ tools: [...] }`) or a
// wrapper `{ manifest, baseline }` used to drive rug-pull cases self-contained.
function extractManifestAndBaseline(
  parsed: unknown,
  globalBaseline: Record<string, string>,
): { manifest: unknown; baseline: Record<string, string> } {
  if (parsed && typeof parsed === "object" && "manifest" in (parsed as object)) {
    const wrapper = parsed as { manifest?: unknown; baseline?: unknown };
    const baseline =
      wrapper.baseline && typeof wrapper.baseline === "object"
        ? (wrapper.baseline as Record<string, string>)
        : globalBaseline;
    return { manifest: wrapper.manifest, baseline };
  }
  return { manifest: parsed, baseline: globalBaseline };
}

// `security scan-mcp <manifest.json|dir>` — the E3 detector command (spec §8).
// Pure & network-free. Findings are leak-safe (category + policy id only). With
// `--pin <manifest>` it records a rug-pull baseline instead of scanning.
async function handleScanMcp(cwd: string, args: string[]): Promise<void> {
  const target =
    optionValue(args, "--file") ??
    optionValue(args, "--pin") ??
    args.find((a) => !a.startsWith("--"));
  const asJson = args.includes("--json");

  if (!target) {
    console.error("Usage: keryx security scan-mcp <manifest.json | dir> [--json] [--pin <manifest.json>]");
    process.exitCode = 1;
    return;
  }

  if (args.includes("--pin")) {
    const parsed = await readJsonFileOr<unknown>(target, null);
    const { manifest } = extractManifestAndBaseline(parsed, {});
    const baseline: McpBaselineFile = { schemaVersion: 1, tools: buildMcpBaseline(manifest) };
    const outPath = mcpBaselinePath(cwd);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    if (asJson) {
      console.log(JSON.stringify({ pinned: Object.keys(baseline.tools).length, path: outPath }, null, 2));
    } else {
      heading("keryx security scan-mcp --pin");
      console.log(`  ${style.green(symbols.ok)} pinned ${Object.keys(baseline.tools).length} tool definition(s) → ${outPath}`);
    }
    return;
  }

  const globalBaselineFile = await readJsonFileOr<Partial<McpBaselineFile>>(
    mcpBaselinePath(cwd),
    {},
  );
  const globalBaseline =
    globalBaselineFile.tools && typeof globalBaselineFile.tools === "object"
      ? globalBaselineFile.tools
      : {};

  const files = await collectManifestFiles(target);
  if (files.length === 0) {
    console.error(`No manifest JSON files found at: ${target}`);
    process.exitCode = 1;
    return;
  }

  const perFile: Array<{ file: string; matches: DetectorMatch[] }> = [];
  for (const file of files) {
    const parsed = await readJsonFileOr<unknown>(file, null);
    const { manifest, baseline } = extractManifestAndBaseline(parsed, globalBaseline);
    const matches = scanMcpManifest(manifest, { baseline, source: file });
    perFile.push({ file, matches });
  }

  const flagged = perFile.filter((entry) => entry.matches.length > 0);
  const totalFindings = perFile.reduce((sum, entry) => sum + entry.matches.length, 0);

  if (asJson) {
    // Leak-safe JSON: policy ids + categories only, never raw manifest content.
    console.log(
      JSON.stringify(
        {
          scanned: files.length,
          flaggedFiles: flagged.length,
          totalFindings,
          files: perFile.map((entry) => ({
            file: path.relative(cwd, entry.file),
            findings: entry.matches.map((m) => ({
              category: m.category,
              policyId: m.policyId,
              severity: m.severity,
              confidence: m.confidence,
            })),
          })),
        },
        null,
        2,
      ),
    );
  } else {
    heading("keryx security scan-mcp");
    note(`scanned ${files.length} manifest(s); ${flagged.length} flagged; ${totalFindings} finding(s)`);
    for (const entry of flagged) {
      console.log("");
      console.log(`  ${style.bold(path.relative(cwd, entry.file))}`);
      for (const m of entry.matches) {
        console.log(
          `    ${severityMarker(m.severity)} ${m.category}/${m.policyId} ${style.dim(`(conf ${m.confidence})`)}`,
        );
      }
    }
    if (flagged.length === 0) {
      console.log(`  ${style.green(symbols.ok)} no MCP threats detected`);
    }
  }

  // Gate-usable: non-zero exit when threats found and --strict is requested.
  if (args.includes("--strict") && totalFindings > 0) {
    process.exitCode = 1;
  }
}

async function handleCheck(
  cwd: string,
  args: string[],
  kind: "input" | "output",
): Promise<void> {
  const file = optionValue(args, "--file");
  const content = await readContent(file);
  const check: SecurityCheck = {
    content,
    source: parseSource(args, kind === "input" ? "untrusted-external" : "generated"),
  };
  if (kind === "output") {
    check.target = parseTarget(args, "unknown");
  }
  if (file) {
    check.path = file;
  }

  const { decision, warnings } = await analyze(cwd, check);
  const asJson = args.includes("--json");

  if (asJson) {
    console.log(JSON.stringify(decision, null, 2));
  } else {
    heading(`keryx security check-${kind}`);
    surfaceWarnings(warnings);
    renderDecision(decision);
    if (decision.redacted !== undefined) {
      heading("Redacted");
      console.log(decision.redacted);
    }
  }

  process.exitCode = exitCodeFor(decision, cwd, await modeOf(cwd));
}

async function handleRedact(cwd: string, args: string[]): Promise<void> {
  const file = optionValue(args, "--file") ?? args.find((a) => !a.startsWith("--"));
  const out = optionValue(args, "--out");
  const content = await readContent(file);
  const source = parseSource(args, "generated");
  const { redacted, findings } = await createSecurityService(cwd).redact(content, {
    source,
  });

  if (out) {
    await writeFile(out, redacted, "utf8");
    heading("keryx security redact");
    console.log(`  ${style.green(symbols.ok)} redacted ${findings.length} span(s) → ${out}`);
  } else {
    process.stdout.write(redacted.endsWith("\n") ? redacted : `${redacted}\n`);
  }
}

async function handleReport(cwd: string, args: string[]): Promise<void> {
  const since = optionValue(args, "--since");
  const report = await runReport({ cwd, ...(since ? { since } : {}) });
  const asJson = args.includes("--json");

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    heading("keryx security report");
    console.log("");
    console.log(`  gate: ${gateLabel(report.gate)}`);
    console.log(`  mode: ${report.mode}`);
    console.log(`  findings: ${report.summary.total}`);
    for (const [category, count] of Object.entries(report.summary.byCategory)) {
      console.log(`    ${category}: ${count}`);
    }
  }

  const mode = report.mode;
  process.exitCode = mode === "ci" && report.gate === "fail" ? 1 : 0;
}

async function handlePolicy(cwd: string, args: string[]): Promise<void> {
  const action = args[0];
  if (action !== "validate") {
    console.error("Usage: keryx security policy validate");
    process.exitCode = 1;
    return;
  }
  const config = await loadSecurityConfig(cwd);
  const schemaErrors = validateSecurityConfig(config);
  const checksum = verifyConfigChecksum(config);

  heading("keryx security policy validate");
  console.log("");
  if (schemaErrors.length === 0) {
    console.log(`  ${style.green(symbols.ok)} config schema: valid`);
  } else {
    for (const error of schemaErrors) {
      console.log(`  ${style.red(symbols.cross)} ${error}`);
    }
  }
  if (checksum.match) {
    console.log(`  ${style.green(symbols.ok)} configChecksum: ok`);
  } else {
    console.log(
      `  ${style.red(symbols.cross)} configChecksum: mismatch (expected ${checksum.expected})`,
    );
  }

  const ok = schemaErrors.length === 0 && checksum.match;
  process.exitCode = ok ? 0 : 1;
}

async function handleIncidents(cwd: string, args: string[]): Promise<void> {
  const limitArg = optionValue(args, "--limit");
  const limit = limitArg ? Math.max(1, Number(limitArg)) : undefined;
  const incidents = await listIncidents(cwd, limit);

  heading("keryx security incidents");
  console.log("");
  if (incidents.length === 0) {
    note("no incidents recorded");
    return;
  }
  for (const incident of incidents) {
    console.log(`  ${style.yellow(symbols.bullet)} ${incident.at} ${style.bold(incident.type)}`);
    console.log(`      ${style.dim(incident.message)}`);
  }
}

// `security hooks install|uninstall --runtime <id|all>[,...]` (E5). Merge-safe
// per-runtime installer; validates the rendered config after install.
async function handleHooks(cwd: string, args: string[]): Promise<void> {
  const action = args[0];
  if (action !== "install" && action !== "uninstall") {
    console.error(
      `Usage: keryx security hooks <install|uninstall> --runtime <${runtimeIds().join("|")}|all>`,
    );
    process.exitCode = 1;
    return;
  }
  const runtimeArg = optionValue(args, "--runtime") ?? "claude";
  const requested = runtimeArg.split(",").map((s) => s.trim()).filter(Boolean);
  const { runtimes, unknown } = resolveRuntimes(requested);
  if (unknown.length > 0) {
    console.error(`Unknown runtime(s): ${unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  heading(`keryx security hooks ${action}`);
  for (const runtime of runtimes) {
    if (action === "install") {
      await installRuntimeHooks(cwd, runtime);
      const errors = runtime.validate(
        JSON.parse(await readFile(runtime.settingsPath(cwd), "utf8")) as Record<string, unknown>,
      );
      if (errors.length === 0) {
        console.log(
          `  ${style.green(symbols.ok)} ${runtime.id} → ${path.relative(cwd, runtime.settingsPath(cwd))}`,
        );
      } else {
        for (const e of errors) {
          console.log(`  ${style.red(symbols.cross)} ${e}`);
        }
        process.exitCode = 1;
      }
    } else {
      const removed = await uninstallRuntimeHooks(cwd, runtime);
      console.log(
        `  ${removed ? style.green(symbols.ok) : style.gray(symbols.off)} ${runtime.id} ${style.dim(removed ? "removed" : "nothing to remove")}`,
      );
    }
  }
}

// Resolve the committed fixtures root (repo-local; not shipped in the package).
function fixturesRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
}

// `security eval [--corpus <name|all>] [--with-model]` (E6). Runs the labeled
// corpora through the detectors, prints a deterministic per-detector FN-rate
// report, and exits non-zero when a detector breaches its committed threshold.
async function handleEval(cwd: string, args: string[]): Promise<void> {
  const corpusArg = optionValue(args, "--corpus") ?? "all";
  const corpora =
    corpusArg === "all" ? DEFAULT_CORPORA : corpusArg.split(",").map((s) => s.trim());
  const withModel = args.includes("--with-model");
  const asJson = args.includes("--json");
  const root = fixturesRoot();

  let detect: DetectFn;
  if (withModel) {
    // Force the injection backend on for this run; when the asset is absent the
    // seam warns once and the pure path is used (AC6.3, C0-5).
    const config = await loadSecurityConfig(cwd);
    if (config.backends.injectionModel) {
      config.backends.injectionModel.enabled = true;
    }
    if (config.backends.piiModel) {
      config.backends.piiModel.enabled = true;
    }
    detect = (input: string) => runDetectorsAsync(cwd, input, config);
  } else {
    detect = await pureDetect(cwd);
  }

  const report = await runEval({ fixturesRoot: root, corpora, detect });
  const thresholds = await loadThresholds(path.join(root, "thresholds.json"));
  const gate = gateEval(report, thresholds);

  if (asJson) {
    console.log(JSON.stringify({ report, gate }, null, 2));
  } else {
    heading("keryx security eval");
    process.stdout.write(formatEvalReport(report, thresholds));
    if (gate.status === "fail") {
      console.log("");
      for (const reason of gate.reasons) {
        console.log(`  ${style.red(symbols.cross)} ${reason}`);
      }
    } else {
      console.log(`  ${style.green(symbols.ok)} all detectors within FN-rate ceilings`);
    }
  }

  process.exitCode = gate.status === "fail" ? 1 : 0;
}

function renderDecision(decision: SecurityDecision): void {
  console.log("");
  console.log(`  gate: ${gateLabel(decision.gate)}`);
  console.log(`  action: ${decision.action}`);
  console.log(`  findings: ${decision.findings.length}`);
  for (const finding of decision.findings.slice(0, 20)) {
    const loc = finding.location?.line ? ` (line ${finding.location.line})` : "";
    console.log(
      `    ${severityMarker(finding.severity)} ${finding.category}/${finding.policyId} → ${finding.action}${loc}`,
    );
  }
}

function severityMarker(severity: string): string {
  if (severity === "critical" || severity === "high") {
    return style.red(symbols.cross);
  }
  if (severity === "medium") {
    return style.yellow(symbols.bullet);
  }
  return style.gray(symbols.bullet);
}

function gateLabel(gate: string): string {
  if (gate === "fail") return style.red(style.bold("FAIL"));
  if (gate === "needs-approval") return style.yellow(style.bold("NEEDS-APPROVAL"));
  return style.green(style.bold("PASS"));
}

async function modeOf(cwd: string): Promise<string> {
  return (await loadSecurityConfig(cwd)).mode;
}

/**
 * The exit code, which for `check-input` is a PROCEED/REFUSE for a tool call.
 *
 * `scan` honours mode+gate: `ci` exits non-zero on a gate fail, `enforced` also
 * on `needs-approval`, `advisory` reports and exits 0.
 *
 * AND a prompt-injection finding over UNTRUSTED-EXTERNAL content refuses on its
 * own, whatever the gate said. That is a second rule and it needs stating,
 * because the first one alone made this command inert for the injection class:
 * every shipped injection detector scores 0.35 to 0.45 against a default
 * `gate.minConfidence` of 0.5, so a lone injection resolves to `warn`, the gate
 * to `pass`, and the exit code to 0 in every mode. `keryx security check-input
 * --source untrusted-external` is installed as the PreToolUse guard in Claude
 * Code and the other supported runtimes — so it DETECTED the injection, PRINTED
 * it, and let the tool call proceed. A guard that reports to a log nobody reads
 * and returns success is not a guard.
 *
 * The same asymmetry, on the same class, that the remote entry surface was
 * fixed for in this round: step 5 of the required decision path worked for the
 * secret class and was inert for the injection class. Three sites, and this was
 * the one nobody had looked at — it is a string constant in the hook installer,
 * not a call to the security service, so the grep that found the other two
 * could not see it.
 *
 * Scoped by SOURCE, not applied everywhere. `generated`, `tool-output` and
 * `trusted-project` are content keryx itself produced, and §7a's decision to
 * keep a lone injection at `warn` for those is right — escalating there would
 * fail the test suite of any repository whose fixtures contain the canonical
 * strings, including this one.
 *
 * Advisory still exits 0. Report-only in advisory is a stated §11 invariant, and
 * an operator who has not opted into enforcement has not asked to be blocked.
 */
function exitCodeFor(decision: SecurityDecision, _cwd: string, mode: string): number {
  if (mode === "advisory") {
    return 0;
  }
  if (refusesOnInjection(decision)) {
    return 1;
  }
  if (mode === "ci") {
    return decision.gate === "fail" ? 1 : 0;
  }
  if (mode === "enforced") {
    return decision.gate === "fail" || decision.gate === "needs-approval" ? 1 : 0;
  }
  return 0;
}

/**
 * A prompt-injection finding over content that arrived from outside.
 *
 * `source` is read HERE because nothing downstream reads it: `resolveDecision`
 * receives it and neither `buildFinding` nor `escalateInjection` consults it, so
 * the one signal distinguishing "a stranger sent this" from "we generated this"
 * is carried the whole way down and dropped. Every gate that needs the
 * distinction has to re-derive it at its own call site, and two of three now do.
 */
function refusesOnInjection(decision: SecurityDecision): boolean {
  return decision.findings.some(
    (finding) => finding.category === "prompt-injection" && finding.source.kind === "untrusted-external",
  );
}

export function printSecurityHelp(): void {
  helpTitle(
    "keryx security",
    "policy-based scanning, redaction, guardrails and audit reports",
  );
  helpUsage([
    "keryx security status",
    "keryx security scan <path> [--json] [--source <kind>]",
    "keryx security scan-mcp <manifest.json | dir> [--json] [--pin <manifest>] [--strict]",
    "keryx security check-input [--source <kind>] [--file <path>]",
    "keryx security check-output [--target <kind>] [--file <path>]",
    "keryx security redact <path> [--out <path>]",
    "keryx security report [--since <ref>] [--json]",
    "keryx security policy validate",
    "keryx security incidents [--limit <n>]",
    "keryx security hooks install --runtime <claude|cursor|windsurf|generic-mcp|all>",
    "keryx security hooks uninstall --runtime <...>",
    "keryx security eval [--corpus <injection|exfil|structured-pii|secret|all>] [--with-model]",
  ]);
  helpOptions([
    { flag: "--json", desc: "Emit machine-readable JSON." },
    { flag: "--source <kind>", desc: "Trust level of the content source." },
    { flag: "--target <kind>", desc: "Write/publish target for check-output." },
    { flag: "--file <path>", desc: "Read content from a file instead of stdin." },
    { flag: "--out <path>", desc: "Write redacted output to a file." },
    { flag: "--since <ref>", desc: "Restrict report to findings since a ref/date." },
    { flag: "--limit <n>", desc: "Limit the number of incidents listed." },
    { flag: "--runtime <id>", desc: "Agent runtime(s) for hook install/uninstall (comma list or 'all')." },
    { flag: "--corpus <name>", desc: "Eval corpus to run ('all' for every corpus)." },
    { flag: "--with-model", desc: "Include opt-in model backends in the eval run." },
  ]);
}
