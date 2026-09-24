// Flow 308 (W8 Design part A, Lane A) — CLI handler for
// `keryx security audit-harness`. A separate file (not a case inline in
// `src/commands/security.ts`) so Lane A and Lane B (`security-impact-evidence.ts`)
// can land in parallel without both editing the same 1.2k-line switch; T7
// wires this handler's export into `securityCommand`'s switch.

import path from "node:path";
import { optionValue } from "../lib/args";
import { resolveProjectRoot } from "../lib/contained-path";
import { heading, helpOptions, helpTitle, helpUsage, note, style, symbols } from "../lib/ui";
import {
  addBaselineEntry,
  applyAuditProposal,
  auditGate,
  defaultBaselinePath,
  runHarnessAudit,
} from "../security/service";
import type { AuditFinding, AuditReport, AuditSeverity } from "../security/service";
import { isPassGate } from "./security-gate";

const SEVERITIES: readonly AuditSeverity[] = ["critical", "high", "medium", "low"];

function isSeverity(value: string | undefined): value is AuditSeverity {
  return value !== undefined && (SEVERITIES as readonly string[]).includes(value);
}

function resolveRoot(cwd: string, args: string[]): string {
  const positional = args.find((a) => !a.startsWith("--") && a !== "apply" && a !== "baseline");
  if (positional) {
    return path.resolve(cwd, positional);
  }
  return resolveProjectRoot(cwd);
}

export async function handleAuditHarness(cwd: string, args: string[] = []): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h") {
    printAuditHarnessHelp();
    return;
  }
  if (args[0] === "apply") {
    await handleApply(cwd, args.slice(1));
    return;
  }
  if (args[0] === "baseline") {
    await handleBaseline(cwd, args.slice(1));
    return;
  }
  await handleRun(cwd, args);
}

async function handleRun(cwd: string, args: string[]): Promise<void> {
  const root = resolveRoot(cwd, args);
  const asJson = args.includes("--json");
  const fixProposals = args.includes("--fix-proposals");
  const ci = args.includes("--ci");
  const baselineArg = optionValue(args, "--baseline");
  const severityFloorArg = optionValue(args, "--severity-floor");
  if (severityFloorArg !== undefined && !isSeverity(severityFloorArg)) {
    console.error(`Invalid --severity-floor: ${severityFloorArg} (expected critical|high|medium|low)`);
    process.exitCode = 1;
    return;
  }

  const report = await runHarnessAudit(root, {
    fixProposals,
    ci,
    ...(baselineArg ? { baselinePath: path.resolve(root, baselineArg) } : {}),
    ...(severityFloorArg ? { severityFloor: severityFloorArg } : {}),
  });
  const gate = auditGate(report);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderHuman(report, root);
  }

  if (ci) {
    process.exitCode = isPassGate(gate) ? 0 : 1;
  }
}

function renderHuman(report: AuditReport, root: string): void {
  heading("keryx security audit-harness");
  note(root);
  console.log("");
  console.log(`  ${style.bold("Coverage")}: ${report.coverage.status}`);
  for (const surface of report.surfaces) {
    const marker =
      surface.status === "scanned"
        ? style.green(symbols.ok)
        : surface.status === "not-applicable"
          ? style.gray(symbols.off)
          : style.red(symbols.cross);
    console.log(`    ${marker} ${surface.surface}: ${surface.status} (${surface.pathsScanned.length} path(s))`);
    if (surface.error) {
      console.log(`        ${style.red(surface.error)}`);
    }
  }
  if (report.coverage.reasons && report.coverage.reasons.length > 0) {
    for (const reason of report.coverage.reasons) {
      console.log(`    ${style.yellow(symbols.bullet)} ${reason}`);
    }
  }

  console.log("");
  console.log(`  ${style.bold("Findings")}: ${report.findings.length}`);
  const bySeverity = new Map<AuditSeverity, AuditFinding[]>();
  for (const finding of report.findings) {
    const list = bySeverity.get(finding.severity) ?? [];
    list.push(finding);
    bySeverity.set(finding.severity, list);
  }
  for (const severity of SEVERITIES) {
    const list = bySeverity.get(severity) ?? [];
    if (list.length === 0) continue;
    console.log(`    ${style.bold(severity)} (${list.length})`);
    for (const finding of list) {
      const suppressed = finding.suppressed.value ? style.dim(" [suppressed]") : "";
      console.log(`      ${symbols.bullet} ${finding.check} ${finding.path ?? ""}${suppressed}`.trimEnd());
      console.log(`          ${style.dim(finding.message)}`);
      if (finding.fixProposal) {
        console.log(`          ${style.cyan("fix:")} ${finding.fixProposal.id} — ${finding.fixProposal.rationale}`);
      }
    }
  }

  console.log("");
  console.log(
    `  ${style.bold("Score")}: ${report.summary.score}/100 (${style.bold(report.summary.grade)}) — gate: ${auditGate(report) === "pass" ? style.green("PASS") : style.red("FAIL")}`,
  );
  if (report.baseline) {
    console.log(`  baseline: ${report.baseline.path} (${report.baseline.tamperState})`);
  }
}

async function handleApply(cwd: string, args: string[]): Promise<void> {
  const root = resolveProjectRoot(cwd);
  const proposalId = optionValue(args, "--proposal");
  if (!proposalId) {
    console.error("Usage: keryx security audit-harness apply --proposal <id>");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await applyAuditProposal(root, proposalId);
    heading("keryx security audit-harness apply");
    console.log(`  ${style.green(symbols.ok)} applied ${result.proposalId} → ${result.path}`);
  } catch (error) {
    console.error(`  ${style.red(symbols.cross)} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function handleBaseline(cwd: string, args: string[]): Promise<void> {
  if (args[0] !== "add") {
    console.error(
      "Usage: keryx security audit-harness baseline add --finding <id> --justification <text> [--expires YYYY-MM-DD] [--author <name>]",
    );
    process.exitCode = 1;
    return;
  }
  const root = resolveProjectRoot(cwd);
  const rest = args.slice(1);
  const findingIdArg = optionValue(rest, "--finding");
  const justification = optionValue(rest, "--justification");
  const expires = optionValue(rest, "--expires");
  const author = optionValue(rest, "--author");
  const baselineArg = optionValue(rest, "--baseline");
  if (!findingIdArg || !justification) {
    console.error(
      "Usage: keryx security audit-harness baseline add --finding <id> --justification <text> [--expires YYYY-MM-DD] [--author <name>]",
    );
    process.exitCode = 1;
    return;
  }
  await addBaselineEntry(
    root,
    {
      findingId: findingIdArg,
      justification,
      ...(expires ? { expiresAt: expires } : {}),
      ...(author ? { author } : {}),
    },
    baselineArg ? { baselinePath: path.resolve(root, baselineArg) } : {},
  );
  heading("keryx security audit-harness baseline add");
  console.log(`  ${style.green(symbols.ok)} recorded suppression for ${findingIdArg} → ${defaultBaselinePath(root)}`);
}

export function printAuditHarnessHelp(): void {
  helpTitle("keryx security audit-harness", "read-only sweep of harness-configuration surfaces");
  helpUsage([
    "keryx security audit-harness [path] [--fix-proposals] [--json] [--ci] [--baseline <file>] [--severity-floor <level>]",
    "keryx security audit-harness apply --proposal <id>",
    "keryx security audit-harness baseline add --finding <id> --justification <text> [--expires YYYY-MM-DD] [--author <name>]",
  ]);
  helpOptions([
    { flag: "--json", desc: "Emit the machine-readable report." },
    { flag: "--fix-proposals", desc: "Include fixProposal records in findings (never writes anything)." },
    { flag: "--ci", desc: "Set the process exit code from the pass/fail gate." },
    { flag: "--baseline <file>", desc: "Use a baseline/suppression file other than the project default." },
    { flag: "--severity-floor <level>", desc: "Filter displayed/scored findings below this severity." },
  ]);
}
