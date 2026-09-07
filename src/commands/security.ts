import { allowAction, refusalAction, type HookAction } from "../ctx/runtimes";
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
import { readJsonObjectFile } from "../lib/json";
import {
  buildMcpBaseline,
  scanMcpManifest,
} from "../security/detect/mcp";
import type { DetectorMatch } from "../security/types";
import {
  analyze,
  createSecurityService,
  runReport,
  runScanPath,
} from "../security/service";
import {
  loadSecurityConfig,
  verifyConfigChecksum,
  validateSecurityConfig,
  configPath,
  securityDataRoot,
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
  "skill",
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
  const file = scanPathArgument(args);
  if (!file) {
    console.error("Usage: keryx security scan <path> [--json] [--recursive|--no-recursive] [--exclude <path>] [--max-files <n>] [--max-bytes <n>]");
    process.exitCode = 1;
    return;
  }
  const maxFiles = positiveScanLimit(args, "--max-files");
  const maxBytes = positiveScanLimit(args, "--max-bytes");
  if (maxFiles === null || maxBytes === null) {
    console.error("Usage: keryx security scan <path> [--max-files <positive integer>] [--max-bytes <positive integer>]");
    process.exitCode = 1;
    return;
  }
  const exclusions = scanOptionValues(args, "--exclude");
  const recursive = recursiveScanFlag(args);
  const projectRoot = resolveProjectRoot(cwd);
  // Contain before opening: the scanner reads whatever it is pointed at and
  // renders findings from the content, so an uncontained path turns a scanner
  // into a file reader for anything the process can reach.
  const contained = await resolveContainedPath(projectRoot, file);
  if (!contained.ok) {
    console.error(contained.message);
    process.exitCode = 1;
    return;
  }
  const source = parseSource(args, "trusted-project");
  const result = await runScanPath(cwd, {
    ownerRoot: projectRoot,
    targetPath: contained.path,
    source,
    path: path.relative(projectRoot, contained.path) || ".",
    ...(exclusions.length > 0 ? { exclusions } : {}),
    ...(recursive !== undefined ? { recursive } : {}),
    ...(maxFiles !== undefined ? { limits: { maxFiles } } : {}),
    ...(maxBytes !== undefined
      ? { limits: { ...(maxFiles !== undefined ? { maxFiles } : {}), maxBytes } }
      : {}),
  });
  const asJson = args.includes("--json");

  if (asJson) {
    console.log(JSON.stringify(result.report, null, 2));
  } else {
    heading("keryx security scan");
    note(file);
    surfaceWarnings(result.warnings);
    renderDecision(result.decision);
    if (result.report.coverage !== undefined) {
      console.log(`  coverage: ${result.report.coverage.status} (${result.report.files?.filter((entry) => entry.status === "scanned").length ?? 0} scanned)`);
    }
    console.log("");
    console.log(`  report: ${result.markdownPath}`);
    console.log(`  json:   ${result.jsonPath}`);
  }

  process.exitCode = exitCodeFor(result.decision, cwd, await modeOf(cwd));
}

function scanOptionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (argument === undefined) continue;
    if (argument === name) {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        values.push(value);
        i += 1;
      }
    } else if (argument.startsWith(`${name}=`)) {
      const value = argument.slice(name.length + 1);
      if (value.length > 0) values.push(value);
    }
  }
  return values;
}

// `--recursive` and `--no-recursive` mean what they say: forward an explicit
// choice to `runScanPath`/`scanContainedPath`, and leave it undefined (so the
// API's own default of `true` applies) when neither flag is present. Never
// silently force recursion on when the caller asked for `--no-recursive`.
function recursiveScanFlag(args: string[]): boolean | undefined {
  if (args.includes("--no-recursive")) return false;
  if (args.includes("--recursive")) return true;
  return undefined;
}

function positiveScanLimit(args: string[], name: string): number | null | undefined {
  const value = optionValue(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function scanPathArgument(args: string[]): string | undefined {
  const valueOptions = new Set(["--file", "--source", "--target", "--exclude", "--max-files", "--max-bytes"]);
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (argument === undefined) continue;
    if (argument === "--json" || argument === "--recursive" || argument === "--no-recursive") continue;
    if (valueOptions.has(argument)) {
      i += 1;
      continue;
    }
    if (argument.startsWith("--")) continue;
    return argument;
  }
  return optionValue(args, "--file");
}

type McpBaselineFile = { schemaVersion: number; tools: Record<string, string> };

function mcpBaselinePath(cwd: string): string {
  return path.join(securityDataRoot(cwd), "mcp-baseline.json");
}

/**
 * Read the pinned rug-pull baseline on the three-way distinction the decision
 * needs: never pinned, pinned and readable, or pinned and unusable.
 *
 * `absent` is the ordinary case (no `--pin` has ever run) and is not a fault:
 * there is nothing to compare against and nothing to report. `unreadable` is a
 * file that EXISTS and cannot be used — it did not parse, it is not an object,
 * or its `tools` member is not the map every pinned baseline carries. That case
 * used to collapse into the same empty `{}` as `absent`, so every rug-pull
 * comparison was silently skipped while the scan still reported a clean result.
 */
async function readMcpBaseline(
  file: string,
): Promise<{ state: "absent" | "ok" | "unreadable"; tools: Record<string, string> }> {
  if (!(await fsPathExists(file))) {
    return { state: "absent", tools: {} };
  }
  const read = await readJsonObjectFile(file);
  if (read.state !== "object") {
    return { state: "unreadable", tools: {} };
  }
  const tools = read.value.tools;
  if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
    return { state: "unreadable", tools: {} };
  }
  return { state: "ok", tools: tools as Record<string, string> };
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
    // Pinning writes the rug-pull baseline every later scan is measured
    // against, so it is a persisted security decision and an unreadable
    // manifest must not produce one. Through `readJsonFileOr(target, null)`
    // this used to hand `null` to `buildMcpBaseline`, write
    // `{"schemaVersion":1,"tools":{}}` and report "pinned 0 tool
    // definition(s)" — a baseline nothing can ever drift from, recorded as
    // though the operator had chosen it (T39 "Judgement calls" #4).
    const read = await readJsonObjectFile(target);
    if (read.state !== "object") {
      // Leak-safe: names the file, never its bytes.
      console.error(
        `Cannot pin: ${target} is not a readable MCP manifest object (unparsed or not a JSON object).`,
      );
      process.exitCode = 1;
      return;
    }
    const { manifest } = extractManifestAndBaseline(read.value, {});
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

  // The pinned baseline, on the same three-way distinction. ABSENT is the
  // ordinary "never pinned" case and stays silent and non-blocking. A file that
  // EXISTS but cannot be read as a baseline is different in kind: it used to
  // degrade to `{}` — every rug-pull comparison silently skipped, the scan
  // still reporting a clean result — which is the same "unestablished evidence
  // read as a pass" this phase is closing everywhere else.
  const baselinePath = mcpBaselinePath(cwd);
  const baselineState = await readMcpBaseline(baselinePath);
  const globalBaseline = baselineState.tools;

  const files = await collectManifestFiles(target);
  if (files.length === 0) {
    console.error(`No manifest JSON files found at: ${target}`);
    process.exitCode = 1;
    return;
  }

  const perFile: Array<{ file: string; readable: boolean; matches: DetectorMatch[] }> = [];
  for (const file of files) {
    // A manifest that does not parse, or parses to something that is not an
    // object, is a manifest that was NOT scanned. `readJsonFileOr(file, null)`
    // used to hand `null` to `scanMcpManifest`, which finds no tools in it and
    // returns no matches, so the file was counted as scanned and clean.
    const read = await readJsonObjectFile(file);
    if (read.state !== "object") {
      perFile.push({ file, readable: false, matches: [] });
      continue;
    }
    const { manifest, baseline } = extractManifestAndBaseline(read.value, globalBaseline);
    const matches = scanMcpManifest(manifest, { baseline, source: file });
    perFile.push({ file, readable: true, matches });
  }

  const flagged = perFile.filter((entry) => entry.matches.length > 0);
  const totalFindings = perFile.reduce((sum, entry) => sum + entry.matches.length, 0);
  const unreadable = perFile.filter((entry) => !entry.readable).length;
  // policies.md ("Health и security gate"): a required check that is missing,
  // skipped, unparsed or unfinished is INCOMPLETE, never PASS. Findings and
  // incompleteness are independent — both are reported, and a scan can be
  // incomplete while still having found something.
  const coverage =
    unreadable > 0 || baselineState.state === "unreadable" ? "incomplete" : "complete";

  if (asJson) {
    // Leak-safe JSON: policy ids + categories only, never raw manifest content.
    console.log(
      JSON.stringify(
        {
          scanned: files.length,
          flaggedFiles: flagged.length,
          totalFindings,
          unreadable,
          coverage,
          baseline: baselineState.state,
          files: perFile.map((entry) => ({
            file: path.relative(cwd, entry.file),
            readable: entry.readable,
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
    note(
      `scanned ${files.length} manifest(s); ${flagged.length} flagged; ${totalFindings} finding(s); coverage ${coverage}`,
    );
    if (unreadable > 0) {
      console.log("");
      console.log(`  ${style.bold(`${unreadable} manifest(s) could not be read and were NOT scanned:`)}`);
      for (const entry of perFile.filter((e) => !e.readable)) {
        console.log(`    ${symbols.cross} ${path.relative(cwd, entry.file)}`);
      }
    }
    if (baselineState.state === "unreadable") {
      console.log("");
      console.log(
        `  ${symbols.cross} pinned MCP baseline exists but could not be read; rug-pull comparisons were not performed`,
      );
    }
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

  // Gate-usable: non-zero exit when threats were found, and equally when the
  // scan could not establish its own coverage. Exiting 0 because an unreadable
  // manifest produced no findings is a clean exit code for a check that never
  // ran, which is the defect class this task closes at the reader.
  if (args.includes("--strict") && (totalFindings > 0 || coverage === "incomplete")) {
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
    decision,
    await policyIsUnderstood(cwd),
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

  // T39 F-003: the mode this exit code is judged against must come from the
  // workspace's own live configuration, not from `report.mode` (the stored
  // artifact under judgement). `runReport` returns a stored `latest.json`
  // verbatim once one exists, and `hasRecognizedGate` (`src/security/service.ts`)
  // validates only `gate`, never `mode` — so a workspace switched to `ci`
  // after an `advisory` scan ran would otherwise have its strictness chosen
  // by the very artifact it is judging. `modeOf(cwd)` is what the sibling
  // exit-code call sites in this file already use (`:250`, `:515`); this was
  // the one site that asked the payload instead. `report.mode` is still
  // printed above (`:551`) as the artifact's own provenance — a different
  // question from which posture this process exits under.
  process.exitCode = reportExitCode(report.gate, await modeOf(cwd));
}

/**
 * `security report` aggregates the *last stored scan* rather than a live
 * decision, but that is a fact about the surface, not a reason for its
 * strict check to accept a narrower set of gates than `exitCodeFor`'s. Until
 * T39 F-003 this function refused only in `ci`, so `enforced` returned 0 for
 * every gate including `fail` — an established threshold violation exiting
 * clean — making this the only fold in the codebase where `enforced` is more
 * permissive than `ci` (T35 F-002 called that inversion "backwards" for the
 * mode axis; T39 found it recurring here on the gate axis). `isBlockingMode`
 * (`guard.ts`), `exitCodeFor` (below) and `securityFlowGate`
 * (`src/security/guard.ts`) all already pair `enforced` with `ci`; this
 * function now does too. Delegates to `isPassGate` so this file carries one
 * gate vocabulary, not a second one next to `runGate`'s switch
 * (`src/security/service.ts`) and `securityFlowGate`'s
 * (`src/security/guard.ts`).
 *
 * `gateway` joins the strict arm as of T65, aligning with T61's correction
 * to `isBlockingMode` (`src/security/guard.ts`): that function used to group
 * `gateway` with `advisory` (report-only) while `MODE_RANK`
 * (`src/security/self-protect.ts`) ranked it the strictest recognized mode —
 * two disagreeing notions of the same mode. T61 resolved the disagreement in
 * `MODE_RANK`'s favor (anchored by must-keep-passing regressions and this
 * module's own fail-closed discipline elsewhere; see T61-spec.md) and moved
 * `isBlockingMode`, so `guardOutput`/`securityFlowGate` now refuse under
 * `gateway`. This fold had not followed: until T65 it still exited 0 for a
 * `gateway` workspace on every gate, identical to `advisory`, which is the
 * same "a value that blocks inside the module exits zero at its command"
 * defect this phase has repaired at eight other sites.
 */
export function reportExitCode(gate: string, mode: string): number {
  if (mode === "ci" || mode === "enforced" || mode === "gateway") {
    return isPassGate(gate) ? 0 : 1;
  }
  return 0;
}

/**
 * Whether a `SecurityGate` value is the one a strict mode accepts.
 * Exhaustive, with the default arm on the blocking side: a future
 * `SecurityGate` member — or, defensively, a runtime value the type checker
 * would never let a caller construct directly — is refused rather than
 * falling through to a pass. Mirrors `runGate`'s switch
 * (`src/security/service.ts:311-330`) and `securityFlowGate`'s
 * (`src/security/guard.ts:362-371`), which already treat `enforced` and `ci`
 * as the same blocking pair (`isBlockingMode`); this file's two folds
 * (`exitCodeFor`, `reportExitCode`) had not, until T35 F-002.
 */
function isPassGate(gate: string): boolean {
  switch (gate) {
    case "pass":
      return true;
    case "fail":
    case "needs-approval":
    case "incomplete":
      return false;
    default:
      return false;
  }
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
            `advisory mode: ${runtime.id} will report findings and allow the call. Set \`mode\` to \`enforced\`, \`ci\` or \`gateway\` in ${path.join(".metaproject", "security.config.json")} to make it refuse.`,
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
  if (gate === "incomplete") return style.yellow(style.bold("INCOMPLETE"));
  return style.green(style.bold("PASS"));
}

async function modeOf(cwd: string): Promise<string> {
  return (await loadSecurityConfig(cwd)).mode;
}

/**
 * The exit code, and for an agent hook it is a PROCEED/REFUSE.
 *
 * `scan` and the two `check` commands share this. `ci`, `enforced` and
 * `gateway` all refuse anything but a verified `pass`; `advisory` reports
 * and proceeds — report-only in advisory is a stated §11 invariant.
 *
 * Until T35 F-002, `ci` refused only on `fail`/`incomplete` — a two-value
 * denylist that let `needs-approval` exit 0, making `ci` *more* permissive
 * than `enforced` at the CLI, backwards from what "strict CI accepts only
 * PASS" (policies.md) requires, and the opposite of `guard.ts`'s
 * `isBlockingMode`, which already treats the two modes identically. Fixed by
 * `isPassGate`: an allowlist over the one acceptable value, exhaustive over
 * `SecurityGate`, shared with `reportExitCode` so the CLI carries one gate
 * vocabulary rather than a second one next to `runGate`'s.
 *
 * `gateway` joined this arm as of T65, for the same reason `reportExitCode`
 * (above) did: T61 corrected `isBlockingMode` to treat `gateway` as blocking
 * (it used to be grouped with `advisory` there, disagreeing with
 * `MODE_RANK`'s ranking of it as strictest), and this fold's own mode check
 * had not followed — until T65 a `gateway` workspace exited 0 here on every
 * gate, indistinguishable from `advisory`, while `guardOutput` already
 * refused the equivalent write.
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
// Exported so the T38 regression tests can drive every `SecurityGate` value
// directly, including one TypeScript's own union would refuse (cast through
// `as unknown as SecurityGate`) — the only way to exercise the exhaustive
// switch's default arm, since a live `SecurityDecision` has no on-disk JSON
// to attack the way `service.ts`'s `hasRecognizedGate` is attacked.
export function exitCodeFor(decision: SecurityDecision, _cwd: string, mode: string): number {
  if (mode === "ci" || mode === "enforced" || mode === "gateway") {
    return isPassGate(decision.gate) ? 0 : 1;
  }
  return 0;
}

/**
 * What a hook should tell its runtime. Three outcomes, named.
 *
 * WHY THIS IS A TYPE. Two blockers in two consecutive rounds came from the same
 * shape: branching on a value without enumerating what that value can mean.
 *
 *   round four   `code === 0` read as "the decision was clean". It also means
 *                "this mode does not refuse on that gate", and `advisory` — the
 *                default — returns 0 for `fail`. A live AWS key was approved.
 *   round six    `gate === "pass"` read as "nothing found". It also means "found
 *                something the policy asked us to REDACT". An SSN was approved.
 *
 * Both were one `if` on a value whose domain I never wrote down. The three
 * places in this codebase where I DID write the domain down — `outcomeOf`,
 * `isServerFault`, `isDefiniteAbsence`, each a total switch with no default arm
 * — have produced zero defects across six review rounds.
 *
 * So the outcome is a union and `decideHookOutcome` is total over it. A fourth
 * outcome, or a fourth reason to reach one, is a compile error here rather than
 * a fall-through into whichever arm happens to be last.
 */
type HookOutcome =
  /** The operator's mode refuses on this gate. Emit the refusal document. */
  | { kind: "refuse" }
  /** Nothing was asked of us. Emit the approval document. */
  | { kind: "approve" }
  /**
   * Something was asked of us that this surface cannot do, or the policy is one
   * this build cannot read — and the mode does not refuse. Emit NOTHING.
   *
   * Silence is a real answer on `cursor` and `antigravity`. On `claude`,
   * `windsurf` and `generic-mcp` it is byte-identical to approval, because
   * `allowAction` is a bare `{ exitCode: 0 }` there and exit 0 with no output IS
   * proceed. So on those three the protection is the operator's `mode`, not this
   * document, and what this function can honestly guarantee is that it never
   * AFFIRMS a decision the policy was unhappy with. Tracked as OQ-4.
   */
  | { kind: "silent"; because: "policy-asked-for-an-action" | "policy-unreadable" };

/**
 * Decide the outcome. Total over its inputs, and every branch says which
 * question it is answering.
 */
function decideHookOutcome(
  refusesUnderThisMode: boolean,
  decision: SecurityDecision,
  policyIsKnown: boolean,
): HookOutcome {
  if (refusesUnderThisMode) {
    return { kind: "refuse" };
  }
  if (!policyIsKnown) {
    // An unknown policy is not a permissive one. keryx cannot affirm a decision
    // it derived from rules it does not understand. It does not manufacture a
    // refusal either: the operator's mode decides that, and a typo in a config
    // file must not become an outage.
    return { kind: "silent", because: "policy-unreadable" };
  }
  // `gate: pass` is not "nothing found". `computeGate` returns it for anything
  // not `block`-actioned and not over `failOn` severity, which INCLUDES findings
  // the policy asked us to redact — and this surface has no channel to redact
  // anything. `warn` stays approvable: it is what the resolver assigns below the
  // confidence floor, and §7a already makes a lone injection advisory.
  const askedForAnAction = decision.findings.some(
    (finding) => finding.action !== "allow" && finding.action !== "warn",
  );
  if (decision.gate !== "pass" || askedForAnAction) {
    return { kind: "silent", because: "policy-asked-for-an-action" };
  }
  return { kind: "approve" };
}

/**
 * Emit the decision in the shape the invoking runtime reads, and return its code.
 *
 * `--runtime <id>` is written into the command by `security hooks install`, so a
 * hook knows which harness is asking. Without it — a human at a terminal, or a
 * script — the plain CLI convention of a non-zero exit stands.
 *
 * The document shapes come from `src/ctx/runtimes.ts`, which owns them; the
 * OUTCOME comes from `decideHookOutcome`, which owns that.
 */
function applyRuntimeDecision(
  args: string[],
  code: number,
  message: string,
  decision: SecurityDecision,
  policyIsKnown: boolean,
): number {
  const runtime = optionValue(args, "--runtime");
  if (runtime === undefined) {
    return code;
  }
  const emit = (action: HookAction): number => {
    if (action.stdout !== undefined) {
      process.stdout.write(action.stdout);
    }
    if (action.stderr !== undefined) {
      process.stderr.write(action.stderr);
    }
    return action.exitCode;
  };
  const outcome = decideHookOutcome(code !== 0, decision, policyIsKnown);
  switch (outcome.kind) {
    case "refuse":
      return emit(refusalAction(runtime, message));
    case "approve":
      return emit(allowAction(runtime));
    case "silent":
      return 0;
  }
}

/**
 * Is the operator's policy one this build can actually reason about?
 *
 * `loadSecurityConfig` never validates — it merges whatever parses over the
 * defaults, and `validateSecurityConfig` is called only by `policy validate`.
 * So a config that the validator rejects is applied verbatim on the enforcement
 * path, and a single out-of-range value rewrites the outcome:
 *
 *   {"gate":{"failOn":"nope","minConfidence":5}}
 *
 * `minConfidence: 5` puts every detector below the floor, so a `block` finding
 * is rewritten to `warn`; `failOn: "nope"` has no rank, so the severity branch
 * never fires. Gate `pass`, action `warn` — and a live AWS access key was
 * answered with `{"permission":"allow"}`. That is the round-four blocker
 * reachable through a config file rather than through a code path.
 *
 * An unknown policy is not a permissive one. keryx cannot affirm a decision it
 * derived from rules it does not understand, so an invalid config suppresses the
 * approval and says why on stderr. It does not manufacture a refusal: the
 * operator's `mode` still decides that, and inventing a block here would make a
 * typo in a config file into an outage.
 *
 * Fixing `loadSecurityConfig` to validate at the source is the better shape and
 * has eight call sites across four modules; this closes the hole at the one
 * place that turns a decision into a machine-readable approval.
 */
async function policyIsUnderstood(cwd: string): Promise<boolean> {
  // The LOADED config, not the raw file. The schema describes a fully populated
  // policy, and `loadSecurityConfig` merges a partial one over the defaults — so
  // validating the file rejected every ordinary config, which omits `enabled`
  // on each policy. The first version of this function did exactly that and
  // turned eight passing tests red, which is how it was caught. `policy
  // validate` validates the merged object for the same reason.
  //
  // Merging does not launder an out-of-range value: `minConfidence: 5` and
  // `failOn: "nope"` survive it, which is the case this exists for.
  const config = await loadSecurityConfig(cwd);
  const errors = validateSecurityConfig(config);
  if (errors.length > 0) {
    process.stderr.write(
      `keryx security: ${path.relative(cwd, configPath(cwd))} does not match the policy schema, so no approval is emitted — ${errors[0]}\n`,
    );
    return false;
  }
  return true;
}

export function printSecurityHelp(): void {
  helpTitle(
    "keryx security",
    "policy-based scanning, redaction, guardrails and audit reports",
  );
  helpUsage([
    "keryx security status",
    "keryx security scan <path> [--json] [--source <kind>] [--recursive|--no-recursive] [--exclude <path>] [--max-files <n>] [--max-bytes <n>]",
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
    { flag: "--recursive", desc: "Recursively scan directories (the default for directory targets)." },
    {
      flag: "--no-recursive",
      desc: "Scan only the target directory's own entry, not its contents; coverage reports incomplete rather than a clean pass.",
    },
    { flag: "--exclude <path>", desc: "Exclude a contained path; may be repeated." },
    { flag: "--max-files <n>", desc: "Required positive file-count limit for a scan." },
    { flag: "--max-bytes <n>", desc: "Required positive aggregate byte limit for a scan." },
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
