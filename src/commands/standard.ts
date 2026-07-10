import {
  heading,
  helpTitle,
  helpUsage,
  note,
  style,
  symbols,
} from "../lib/ui";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runCapabilities,
  runDoctor,
  runValidate,
} from "../standard/service";
import { STANDARD_VERSION } from "../standard/profiles";
import { emitLlms, validateLlms } from "../standard/emit-llms";
import type { Issue, ValidationResult } from "../standard/types";
import { classifyBaselineStatuses, type BaselineStatus } from "../standard/baseline";
import { optionValue } from "../lib/args";

// Thin handler for `keryx standard <validate|doctor|capabilities>`.
// Renders service results with lib/ui and owns process.exitCode.
export async function standardCommand(
  args: string[] = [],
  projectRoot: string = process.cwd(),
): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printStandardHelp();
    return;
  }

  switch (subcommand) {
    case "validate":
      await handleValidate(projectRoot);
      return;
    case "doctor":
      await handleDoctor(projectRoot);
      return;
    case "capabilities":
      await handleCapabilities(projectRoot);
      return;
    case "baseline":
      await handleBaseline(args.slice(1));
      return;
    case "emit":
      await handleEmit(projectRoot, args.slice(1));
      return;
    default:
      console.error(`Unknown standard command: ${subcommand}`);
      printStandardHelp();
      process.exitCode = 1;
  }
}

async function handleValidate(projectRoot: string): Promise<void> {
  const result = await runValidate(projectRoot);
  heading("keryx standard validate");
  note(`Standard version ${STANDARD_VERSION}`);

  renderIssues("Errors", result.errors, style.red(symbols.cross));
  renderIssues("Warnings", result.warnings, style.yellow(symbols.bullet), false);

  console.log("");
  if (result.ok) {
    const warned = result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : "";
    console.log(`  ${style.green(symbols.ok)} ${style.bold("PASS")} — workspace is Metaproject Standard compliant${warned}`);
    return;
  }

  console.log(
    `  ${style.red(symbols.cross)} ${style.bold("FAIL")} — ${result.errors.length} error(s), ${result.warnings.length} warning(s)`,
  );
  process.exitCode = 1;
}

async function handleDoctor(projectRoot: string): Promise<void> {
  const result = await runDoctor(projectRoot);
  heading("keryx standard doctor");
  note(`Standard version ${STANDARD_VERSION}`);

  const items = [...result.errors, ...result.warnings];
  if (items.length === 0) {
    console.log("");
    console.log(`  ${style.green(symbols.ok)} No issues found. Workspace is healthy.`);
    return;
  }

  heading("Diagnostics");
  for (const item of result.errors) {
    renderDiagnostic(item, style.red(symbols.cross));
  }
  for (const item of result.warnings) {
    renderDiagnostic(item, style.yellow(symbols.bullet));
  }

  console.log("");
  console.log(
    `  ${result.ok ? style.yellow(symbols.bullet) : style.red(symbols.cross)} ${result.errors.length} error(s), ${result.warnings.length} warning(s)`,
  );
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function handleCapabilities(projectRoot: string): Promise<void> {
  const { report, profiles } = await runCapabilities(projectRoot);
  heading("keryx standard capabilities");
  note(`Standard version ${report.standardVersion ?? "unknown"}`);

  console.log("");
  console.log(`  ${style.bold("Declared profiles:")} ${report.profiles.length > 0 ? report.profiles.join(", ") : "(none)"}`);
  console.log(`  ${style.bold("Satisfied profiles:")} ${profiles.satisfied.length > 0 ? profiles.satisfied.join(", ") : "(none)"}`);

  heading("Modules");
  const enabled = report.modules.filter((module) => module.enabled);
  const disabled = report.modules.filter((module) => !module.enabled);
  for (const module of enabled) {
    const ops = module.commands.length > 0 ? module.commands : module.capabilities;
    const suffix = ops.length > 0 ? style.dim(` — ${ops.join(", ")}`) : "";
    console.log(`  ${style.green(symbols.ok)} ${module.key}${suffix}`);
  }
  for (const module of disabled) {
    console.log(`  ${style.gray(symbols.off)} ${style.gray(module.key)} ${style.dim("(disabled)")}`);
  }
}

async function handleBaseline(args: string[]): Promise<void> {
  const baseline = optionValue(args, "--baseline") as BaselineStatus | undefined;
  const pr = optionValue(args, "--pr") as BaselineStatus | undefined;
  if (!baseline || !pr || !["pass", "fail", "unknown"].includes(baseline) || !["pass", "fail", "unknown"].includes(pr)) {
    console.error("Usage: keryx standard baseline --baseline pass|fail|unknown --pr pass|fail|unknown");
    process.exitCode = 1;
    return;
  }
  const result = classifyBaselineStatuses(baseline, pr);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.classification === "baseline-red" ? 0 : result.prIntroducedFailure ? 1 : 0;
}

// `standard emit llms` — generate the deterministic llms.txt (spec §10.1).
async function handleEmit(projectRoot: string, args: string[]): Promise<void> {
  const kind = args[0];
  if (kind !== "llms") {
    console.error("Usage: keryx standard emit llms [--stdout]");
    process.exitCode = 1;
    return;
  }

  const result = await emitLlms(projectRoot);
  const problems = validateLlms(result.content);

  if (args.includes("--stdout")) {
    process.stdout.write(result.content);
  } else {
    await mkdir(path.dirname(result.path), { recursive: true });
    await writeFile(result.path, result.content, "utf8");
    heading("keryx standard emit llms");
    if (problems.length === 0) {
      console.log(`  ${style.green(symbols.ok)} wrote ${path.relative(projectRoot, result.path)} (valid llms.txt)`);
    } else {
      for (const problem of problems) {
        console.log(`  ${style.red(symbols.cross)} ${problem}`);
      }
    }
  }

  if (problems.length > 0) {
    process.exitCode = 1;
  }
}

function renderIssues(
  label: string,
  issues: Issue[],
  marker: string,
  headingWhenEmpty = false,
): void {
  if (issues.length === 0) {
    if (headingWhenEmpty) {
      heading(label);
      note("none");
    }
    return;
  }
  heading(label);
  for (const item of issues) {
    console.log(`  ${marker} ${item.message} ${style.dim(`[${item.code}]`)}`);
  }
}

function renderDiagnostic(item: Issue, marker: string): void {
  console.log(`  ${marker} ${item.message} ${style.dim(`[${item.code}]`)}`);
  if (item.fix) {
    console.log(`      ${style.cyan(symbols.arrow)} ${style.dim(item.fix)}`);
  }
}

export function printStandardHelp(): void {
  helpTitle("keryx standard", "validate a workspace against the Metaproject Standard");
  helpUsage([
    "keryx standard validate",
    "keryx standard doctor",
    "keryx standard capabilities",
    "keryx standard baseline --baseline pass|fail|unknown --pr pass|fail|unknown",
    "keryx standard emit llms [--stdout]",
  ]);
  heading("Commands");
  for (const [name, desc] of [
    ["validate", "Check the workspace against the standard; exits non-zero on failure."],
    ["doctor", "Print actionable diagnostics with fix hints; exits non-zero on unresolved issues."],
    ["capabilities", "Print the standard version, active profiles, and enabled modules."],
    ["baseline", "Classify PR validation against the independently measured main baseline."],
    ["emit llms", "Generate a deterministic llms.txt from the manifest + artifact index."],
  ] as const) {
    console.log(`  ${style.cyan(name.padEnd(13))} ${style.dim(desc)}`);
  }
}
