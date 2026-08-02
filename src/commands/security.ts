import { allowAction, refusalAction } from "../ctx/runtimes";
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

function surfaceWarnings(warnings: string[], emit: (line: string) => void = console.log): void {
  for (const warning of warnings) {
    emit(`  ${style.yellow(symbols.bullet)} ${warning}`);
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

  // WHERE the report goes is decided by whether a runtime is asking.
  //
  // With `--runtime <id>`, stdout belongs to that runtime's contract and to
  // nothing else. Cursor and Antigravity decide from a stdout JSON document, and
  // this command printed the human report onto the same stream first — so the
  // document arrived as the last of nine lines, `JSON.parse` failed on
  // `keryx securi…`, the exit code was 0, and the input proceeded. That is the
  // "reported but did not refuse" defect this command was fixed for, surviving
  // one more round in a different shape.
  //
  // `src/ctx/hook.ts` had it right all along: it writes `action.stdout` and
  // nothing else. The previous fix copied the refusal DOCUMENT from the module
  // that owns it and not the CONTRACT, and the contract is "stdout is exactly
  // this one document".
  //
  // The report is not dropped — it goes to stderr, where every exit-code runtime
  // already surfaces it to the operator. That also fixes a second thing on
  // Claude: `UserPromptSubmit` stdout on exit 0 is appended to the model's
  // context, so every prompt was injecting the report plus a redacted copy of
  // itself back into the conversation it was scanning.
  const forRuntime = optionValue(args, "--runtime") !== undefined;
  const report = forRuntime ? (line: string) => process.stderr.write(`${line}\n`) : console.log;

  if (asJson) {
    report(JSON.stringify(decision, null, 2));
  } else {
    heading(`keryx security check-${kind}`, report);
    surfaceWarnings(warnings, report);
    renderDecision(decision, report);
    if (decision.redacted !== undefined) {
      heading("Redacted", report);
      report(decision.redacted);
    }
  }

  process.exitCode = applyRuntimeDecision(
    args,
    exitCodeFor(decision, cwd, await modeOf(cwd)),
    `keryx security: this ${kind} was refused by the configured security policy (gate: ${decision.gate}).`,
  );
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
        // The guard is INSTALLED, which is not the same as ARMED. `exitCodeFor`
        // returns 0 for every gate under the default `advisory` mode, so a hook
        // that detects a live credential still lets the call proceed. An
        // operator who reads "✓" and stops reading has a guard that reports and
        // does not refuse — the defect this whole surface has been fixed for
        // twice — and nothing on this screen said so.
        if ((await modeOf(cwd)) === "advisory") {
          note(
            `advisory mode: ${runtime.id} will report findings and allow the call. Set \`mode\` to \`enforced\` or \`ci\` in ${path.join(".metaproject", "security.config.json")} to make it refuse.`,
          );
        }
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

function renderDecision(decision: SecurityDecision, emit: (line: string) => void = console.log): void {
  emit("");
  emit(`  gate: ${gateLabel(decision.gate)}`);
  emit(`  action: ${decision.action}`);
  emit(`  findings: ${decision.findings.length}`);
  for (const finding of decision.findings.slice(0, 20)) {
    const loc = finding.location?.line ? ` (line ${finding.location.line})` : "";
    emit(
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
 * The exit code, and for an agent hook it is a PROCEED/REFUSE.
 *
 * `scan` and the two `check` commands share this. `ci` refuses on a gate fail,
 * `enforced` also on `needs-approval`, `advisory` reports and proceeds —
 * report-only in advisory is a stated §11 invariant.
 *
 * What is NOT here any more is a hardcoded rule that refused on any
 * prompt-injection finding regardless of the gate. It was added to close "the
 * installed guard detects an injection and returns success", and it was wrong
 * in three ways that took a second review round to see:
 *
 *   - it overrode a DOCUMENTED policy. `resolve.ts` §7a keeps a lone injection
 *     at `warn` and escalates only when an egress signal co-occurs, and
 *     `security.test.ts` pins that for `untrusted-external` specifically. The
 *     override contradicted a decision this codebase had already made and
 *     tested, without changing either.
 *   - it was unappealable. No floor, no override, no way for an operator to
 *     disagree, over a detector that fires on ordinary prose. Re-measured with
 *     `detectInjection` over the tracked tree, because the figure previously
 *     quoted here — "3.3%, including its operator guide and README" — was
 *     carried out of a review report without being re-derived and does not
 *     reproduce for any population:
 *
 *         docs/**.md   7 of 166   4.22%
 *         src/**.ts   12 of 624   1.92%
 *         both        19 of 790   2.41%
 *         everything  23 of 2538  0.91%
 *
 *     The operator guide does match. README.md matches ZERO times, so the
 *     sentence naming it was false as well as imprecise.
 *   - it emitted `exit 1`, which no runtime keryx installs into treats as a
 *     block. The refusal did not refuse.
 *
 * The mechanism an operator actually has is the one that was already there and
 * unreachable: every injection detector scores 0.35 to 0.45, the default gate
 * floor is 0.5, so the declared `policies.promptInjection.action` never
 * applied. Lowering `policies.promptInjection.minConfidence` below the detector
 * band makes the declared action apply — verified end to end — and raising it
 * or setting `action: "warn"` turns it back off. That is a policy the operator
 * writes down, not a rule compiled into a CLI.
 */
function exitCodeFor(decision: SecurityDecision, _cwd: string, mode: string): number {
  if (mode === "ci") {
    return decision.gate === "fail" ? 1 : 0;
  }
  if (mode === "enforced") {
    return decision.gate === "fail" || decision.gate === "needs-approval" ? 1 : 0;
  }
  return 0;
}

/**
 * Emit the decision in the shape the invoking runtime reads, and return its code.
 *
 * `--runtime <id>` is written into the command by `security hooks install`, so
 * a hook knows which harness is asking. Without it — a human at a terminal, or
 * a script — the plain CLI convention of a non-zero exit stands.
 *
 * BOTH halves, and the second one is here because the first version of this
 * function was only the first half. It returned early on `code === 0` having
 * written nothing, so a passing check handed a stdout-JSON runtime zero bytes
 * and left the outcome to whatever that runtime does with an empty response.
 * `src/ctx/hook.ts` writes `action.stdout` on both branches and always did; this
 * surface copied the refusal DOCUMENT out of the module that owns it and not
 * the CONTRACT — which is word for word the sentence written about the previous
 * round's version of this bug, one branch over.
 *
 * The shapes come from `src/ctx/runtimes.ts`, which owns them.
 */
function applyRuntimeDecision(args: string[], code: number, message: string): number {
  const runtime = optionValue(args, "--runtime");
  if (runtime === undefined) {
    return code;
  }
  const action = code === 0 ? allowAction(runtime) : refusalAction(runtime, message);
  if (action.stdout !== undefined) {
    process.stdout.write(action.stdout);
  }
  if (action.stderr !== undefined) {
    process.stderr.write(action.stderr);
  }
  return action.exitCode;
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
    "keryx security check-input [--source <kind>] [--file <path>] [--runtime <id>]",
    "keryx security check-output [--target <kind>] [--file <path>] [--runtime <id>]",
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
    {
      flag: "--runtime <id>",
      desc: "Refuse in the shape this agent runtime reads. `hooks install` writes claude|cursor|windsurf|generic-mcp; codex and antigravity are also understood here. A bare exit code with no --runtime.",
    },
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
