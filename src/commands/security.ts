import { readFile, writeFile } from "node:fs/promises";
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

  heading("gd-metapro security status");
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
    console.error("Usage: gd-metapro security scan <path> [--json]");
    process.exitCode = 1;
    return;
  }
  const content = await readFile(file, "utf8");
  const source = parseSource(args, "trusted-project");
  const result = await runScan(cwd, { content, source, path: file });
  const asJson = args.includes("--json");

  if (asJson) {
    console.log(JSON.stringify(result.report, null, 2));
  } else {
    heading("gd-metapro security scan");
    note(file);
    surfaceWarnings(result.warnings);
    renderDecision(result.decision);
    console.log("");
    console.log(`  report: ${result.markdownPath}`);
    console.log(`  json:   ${result.jsonPath}`);
  }

  process.exitCode = exitCodeFor(result.decision, cwd, await modeOf(cwd));
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
    heading(`gd-metapro security check-${kind}`);
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
    heading("gd-metapro security redact");
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
    heading("gd-metapro security report");
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
    console.error("Usage: gd-metapro security policy validate");
    process.exitCode = 1;
    return;
  }
  const config = await loadSecurityConfig(cwd);
  const schemaErrors = validateSecurityConfig(config);
  const checksum = verifyConfigChecksum(config);

  heading("gd-metapro security policy validate");
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

  heading("gd-metapro security incidents");
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

// scan honors mode+gate: ci mode exits non-zero on a gate fail; advisory reports
// and exits 0. enforced also exits non-zero on fail/needs-approval.
function exitCodeFor(decision: SecurityDecision, _cwd: string, mode: string): number {
  if (mode === "ci") {
    return decision.gate === "fail" ? 1 : 0;
  }
  if (mode === "enforced") {
    return decision.gate === "fail" || decision.gate === "needs-approval" ? 1 : 0;
  }
  return 0;
}

export function printSecurityHelp(): void {
  helpTitle(
    "gd-metapro security",
    "policy-based scanning, redaction, guardrails and audit reports",
  );
  helpUsage([
    "gd-metapro security status",
    "gd-metapro security scan <path> [--json] [--source <kind>]",
    "gd-metapro security check-input [--source <kind>] [--file <path>]",
    "gd-metapro security check-output [--target <kind>] [--file <path>]",
    "gd-metapro security redact <path> [--out <path>]",
    "gd-metapro security report [--since <ref>] [--json]",
    "gd-metapro security policy validate",
    "gd-metapro security incidents [--limit <n>]",
  ]);
  helpOptions([
    { flag: "--json", desc: "Emit machine-readable JSON." },
    { flag: "--source <kind>", desc: "Trust level of the content source." },
    { flag: "--target <kind>", desc: "Write/publish target for check-output." },
    { flag: "--file <path>", desc: "Read content from a file instead of stdin." },
    { flag: "--out <path>", desc: "Write redacted output to a file." },
    { flag: "--since <ref>", desc: "Restrict report to findings since a ref/date." },
    { flag: "--limit <n>", desc: "Limit the number of incidents listed." },
  ]);
}
