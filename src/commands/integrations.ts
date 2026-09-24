// Flow 307 (W5-b), T8: `keryx integrations install|uninstall|doctor|matrix` —
// the CLI surface over the installer core (`src/integrations/installer.ts`,
// T6) and the generated capability matrix (`src/integrations/matrix.ts`, T7).
//
// This is NOT a fourth implementation: every write here goes through
// `installIntegration`/`uninstallIntegration`/`doctorIntegration`, the exact
// same functions the legacy `ctx install-hook`, `orient install-hook` and
// `security hooks install|uninstall` commands already delegate to (see
// `src/ctx/hook-install.ts` and `src/security/agent-hooks.ts`) — so this
// command and those three aliases can never drift into writing different
// bytes for the same surface.

import path from "node:path";
import { helpOptions, helpTitle, helpUsage, heading, note, style, symbols } from "../lib/ui";
import { optionValue } from "../lib/args";
import {
  doctorIntegration,
  getHarnessAdapter,
  harnessAdapterIds,
  installIntegration,
  uninstallIntegration,
  type DoctorIntegrationResult,
  type HarnessAdapter,
  type InstallIntegrationResult,
  type SurfaceResult,
  type UninstallIntegrationResult,
} from "../integrations";
import {
  DEFAULT_MATRIX_ARTIFACT,
  SURFACE_FLAG_ORDER,
  checkCapabilityMatrix,
  generateCapabilityMatrix,
  writeCapabilityMatrix,
  type CapabilityMatrixDocument,
} from "../integrations/matrix";

export async function integrationsCommand(args: string[], cwd: string = process.cwd()): Promise<void> {
  const sub = args[0];

  if (sub === undefined || sub === "--help" || sub === "-h") {
    printIntegrationsHelp();
    return;
  }
  if (sub === "install") {
    await handleInstall(args.slice(1), cwd);
    return;
  }
  if (sub === "uninstall") {
    await handleUninstall(args.slice(1), cwd);
    return;
  }
  if (sub === "doctor") {
    await handleDoctor(args.slice(1), cwd);
    return;
  }
  if (sub === "matrix") {
    await handleMatrix(args.slice(1), cwd);
    return;
  }

  console.error(`Unknown integrations command: ${sub}`);
  printIntegrationsHelp();
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Shared argument parsing
// ---------------------------------------------------------------------------

/** Every occurrence of `--surface <v>`/`--surface=<v>`, comma-split, trimmed, de-duplicated. */
function collectRepeatable(args: readonly string[], flag: string): string[] {
  const raw: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === flag) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) raw.push(next);
    } else if (token?.startsWith(`${flag}=`)) {
      raw.push(token.slice(flag.length + 1));
    }
  }
  const out: string[] = [];
  for (const value of raw.flatMap((v) => v.split(","))) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

interface UnsupportedRuntimeReport {
  readonly runtimeId: string;
  readonly unsupported: true;
  readonly reasons: readonly string[];
}

/**
 * Resolve `--runtime`'s value into concrete adapter ids, splitting an adapter
 * with zero surfaces (`keryx-shell` today) out as an "unsupported" report
 * rather than handing it to the installer core — `all` in particular must
 * name every registered runtime while still reporting keryx-shell as
 * unsupported instead of silently omitting it.
 */
function resolveRuntimeIds(
  value: string,
): { supported: HarnessAdapter[]; unsupported: UnsupportedRuntimeReport[]; unknown: string[] } {
  const requested = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = requested.includes("all") ? harnessAdapterIds() : requested;

  const supported: HarnessAdapter[] = [];
  const unsupported: UnsupportedRuntimeReport[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const adapter = getHarnessAdapter(id);
    if (!adapter) {
      unknown.push(id);
      continue;
    }
    if (adapter.surfaces.length === 0) {
      const reasons = [...new Set(Object.values(adapter.unsupported))];
      unsupported.push({ runtimeId: adapter.id, unsupported: true, reasons });
      continue;
    }
    supported.push(adapter);
  }
  return { supported, unsupported, unknown };
}

function requireRuntimeArg(args: readonly string[]): string | undefined {
  return optionValue([...args], "--runtime");
}

function isFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------

function markerFor(status: string): string {
  if (status === "installed" || status === "removed") return style.green(symbols.ok);
  if (status === "failed") return style.red(symbols.cross);
  return style.gray(symbols.off);
}

function printSurfaceResult(cwd: string, result: SurfaceResult): void {
  const file = result.file ? path.relative(cwd, path.join(cwd, ...result.file.split("/"))) : undefined;
  const target = file ? ` -> ${file}` : "";
  console.log(`  ${markerFor(result.status)} ${result.surfaceId} (${result.flag})${target} ${style.dim(result.status)}`);
  for (const warning of result.warnings) {
    note(`    ${warning}`);
  }
  for (const error of result.errors) {
    console.error(`  ${style.red(symbols.cross)} ${result.surfaceId}: ${error}`);
  }
}

function printUnsupported(report: UnsupportedRuntimeReport): void {
  console.log(`  ${style.gray(symbols.off)} ${report.runtimeId} — unsupported: ${report.reasons.join(" ")}`);
}

interface ParsedRuntimeOpts {
  readonly runtimeArg: string;
  readonly surfaces: string[];
  readonly dryRun: boolean;
  readonly json: boolean;
}

function parseRuntimeOpts(args: readonly string[], usage: string): ParsedRuntimeOpts | undefined {
  const runtimeArg = requireRuntimeArg(args);
  if (runtimeArg === undefined) {
    console.error("--runtime is required");
    console.error(`Usage: ${usage}`);
    process.exitCode = 1;
    return undefined;
  }
  return {
    runtimeArg,
    surfaces: collectRepeatable(args, "--surface"),
    dryRun: isFlag(args, "--dry-run"),
    json: isFlag(args, "--json"),
  };
}

async function handleInstall(args: string[], cwd: string): Promise<void> {
  const parsed = parseRuntimeOpts(
    args,
    "keryx integrations install --runtime <id>[,<id>...|all] [--surface <flag|id>]... [--dry-run] [--json]",
  );
  if (!parsed) return;
  const { runtimeArg, surfaces, dryRun, json } = parsed;

  const { supported, unsupported, unknown } = resolveRuntimeIds(runtimeArg);
  if (unknown.length > 0) {
    console.error(`Unknown runtime(s): ${unknown.join(", ")}`);
    console.error(`Supported: ${harnessAdapterIds().join(", ")}, all`);
    process.exitCode = 1;
    return;
  }

  const results: InstallIntegrationResult[] = [];
  for (const adapter of supported) {
    let result: InstallIntegrationResult;
    try {
      result = await installIntegration(cwd, adapter.id, { surfaces, dryRun });
    } catch (error) {
      result = { runtimeId: adapter.id, results: [], errors: [error instanceof Error ? error.message : String(error)] };
    }
    results.push(result);
    if (result.errors.length > 0) process.exitCode = 1;
  }

  if (json) {
    console.log(JSON.stringify({ results, unsupported }, null, 2));
    return;
  }

  heading(`keryx integrations install${dryRun ? " (dry run)" : ""}`);
  for (const result of results) {
    console.log(`  ${style.bold(result.runtimeId)}`);
    for (const surfaceResult of result.results) printSurfaceResult(cwd, surfaceResult);
    if (result.results.length === 0 && result.errors.length > 0) {
      for (const error of result.errors) console.error(`  ${style.red(symbols.cross)} ${error}`);
    }
  }
  for (const report of unsupported) printUnsupported(report);
}

async function handleUninstall(args: string[], cwd: string): Promise<void> {
  const parsed = parseRuntimeOpts(
    args,
    "keryx integrations uninstall --runtime <id>[,<id>...|all] [--surface <flag|id>]... [--dry-run] [--json]",
  );
  if (!parsed) return;
  const { runtimeArg, surfaces, dryRun, json } = parsed;

  const { supported, unsupported, unknown } = resolveRuntimeIds(runtimeArg);
  if (unknown.length > 0) {
    console.error(`Unknown runtime(s): ${unknown.join(", ")}`);
    console.error(`Supported: ${harnessAdapterIds().join(", ")}, all`);
    process.exitCode = 1;
    return;
  }

  const results: UninstallIntegrationResult[] = [];
  for (const adapter of supported) {
    let result: UninstallIntegrationResult;
    try {
      result = await uninstallIntegration(cwd, adapter.id, { surfaces, dryRun });
    } catch (error) {
      result = { runtimeId: adapter.id, results: [], errors: [error instanceof Error ? error.message : String(error)] };
    }
    results.push(result);
    if (result.errors.length > 0) process.exitCode = 1;
  }

  if (json) {
    console.log(JSON.stringify({ results, unsupported }, null, 2));
    return;
  }

  heading(`keryx integrations uninstall${dryRun ? " (dry run)" : ""}`);
  for (const result of results) {
    console.log(`  ${style.bold(result.runtimeId)}`);
    for (const surfaceResult of result.results) printSurfaceResult(cwd, surfaceResult);
    if (result.results.length === 0 && result.errors.length > 0) {
      for (const error of result.errors) console.error(`  ${style.red(symbols.cross)} ${error}`);
    }
  }
  for (const report of unsupported) printUnsupported(report);
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function handleDoctor(args: string[], cwd: string): Promise<void> {
  const runtimeArg = requireRuntimeArg(args);
  if (runtimeArg === undefined) {
    console.error("--runtime is required");
    console.error("Usage: keryx integrations doctor --runtime <id>[,<id>...|all] [--json]");
    process.exitCode = 1;
    return;
  }
  const json = isFlag(args, "--json");

  const { supported, unsupported, unknown } = resolveRuntimeIds(runtimeArg);
  if (unknown.length > 0) {
    console.error(`Unknown runtime(s): ${unknown.join(", ")}`);
    console.error(`Supported: ${harnessAdapterIds().join(", ")}, all`);
    process.exitCode = 1;
    return;
  }

  const results: DoctorIntegrationResult[] = [];
  for (const adapter of supported) {
    const result = await doctorIntegration(cwd, adapter.id);
    results.push(result);
    if (!result.ok) process.exitCode = 1;
  }

  if (json) {
    console.log(JSON.stringify({ results, unsupported }, null, 2));
    return;
  }

  heading("keryx integrations doctor");
  for (const result of results) {
    console.log(`  ${style.bold(result.runtimeId)} ${result.ok ? style.green("ok") : style.red("problems found")}`);
    for (const surface of result.surfaces) {
      const marker = surface.drift ? style.yellow(symbols.bullet) : surface.live === "valid" ? style.green(symbols.ok) : style.gray(symbols.off);
      console.log(`  ${marker} ${surface.surfaceId} (${surface.flag}) — ${surface.live}${surface.recorded ? "" : " (not recorded)"}`);
      if (surface.drift) note(`    ${surface.drift}`);
      for (const problem of surface.problems) console.log(`    ${style.dim(problem)}`);
    }
  }
  for (const report of unsupported) printUnsupported(report);
}

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

function printMatrixTable(doc: CapabilityMatrixDocument): void {
  const rows = doc.harnesses.map((entry) => ({
    id: entry.id,
    state: entry.state,
    confidence: entry.confidence,
    flags: entry.surfaces_supported.map((s) => s.surface).join(","),
  }));
  const widths = {
    id: Math.max("id".length, ...rows.map((r) => r.id.length)),
    state: Math.max("state".length, ...rows.map((r) => r.state.length)),
    confidence: Math.max("confidence".length, ...rows.map((r) => r.confidence.length)),
  };
  const header = `  ${"id".padEnd(widths.id)}  ${"state".padEnd(widths.state)}  ${"confidence".padEnd(widths.confidence)}  supported flags`;
  console.log(header);
  for (const row of rows) {
    console.log(
      `  ${row.id.padEnd(widths.id)}  ${row.state.padEnd(widths.state)}  ${row.confidence.padEnd(widths.confidence)}  ${row.flags}`,
    );
  }
}

async function handleMatrix(args: string[], cwd: string): Promise<void> {
  const json = isFlag(args, "--json");
  const check = isFlag(args, "--check");
  const write = isFlag(args, "--write");
  const filePath = optionValue(args, "--file") ?? DEFAULT_MATRIX_ARTIFACT;

  if (check) {
    const result = await checkCapabilityMatrix(cwd, filePath);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      console.log(`${style.green(symbols.ok)} ${filePath} matches the registry`);
    } else {
      for (const problem of result.problems) console.error(`${style.red(symbols.cross)} ${problem}`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (write) {
    await writeCapabilityMatrix(cwd, filePath);
    if (json) {
      console.log(JSON.stringify({ written: filePath }, null, 2));
    } else {
      console.log(`${style.green(symbols.ok)} wrote ${filePath}`);
    }
    return;
  }

  const doc = generateCapabilityMatrix();
  if (json) {
    console.log(JSON.stringify(doc, null, 2));
    return;
  }
  printMatrixTable(doc);
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

export function printIntegrationsHelp(): void {
  helpTitle("keryx integrations", "install, remove, and audit Keryx's hooks/instructions in another coding agent");
  helpUsage([
    `keryx integrations install --runtime <id>[,<id>...|all] [--surface <flag|id>]... [--dry-run] [--json]`,
    `keryx integrations uninstall --runtime <id>[,<id>...|all] [--surface <flag|id>]... [--dry-run] [--json]`,
    `keryx integrations doctor --runtime <id>[,<id>...|all] [--json]`,
    `keryx integrations matrix [--check] [--write] [--json] [--file <path>]`,
  ]);
  helpOptions([
    { flag: "--runtime <id>", desc: "Required for install/uninstall/doctor. Comma-separated, or `all` for every registered adapter." },
    { flag: "--surface <flag|id>", desc: "Repeatable (and comma-separated). Selects surfaces by SurfaceFlag or surface id. Omit to select every surface the adapter declares." },
    { flag: "--dry-run", desc: "Report what would be written/removed; change nothing." },
    { flag: "--json", desc: "Print the structured result objects only." },
    { flag: "--check", desc: "matrix: regenerate, validate, and diff against the checked-in artifact; exits 1 on drift." },
    { flag: "--write", desc: "matrix: regenerate and overwrite the checked-in artifact." },
    { flag: "--file <path>", desc: "matrix: artifact path, relative to the project root (default docs/integrations/harness-capability-matrix.json)." },
  ]);
  heading("Notes");
  console.log(`  ${style.dim(`Runtimes: ${harnessAdapterIds().join(", ")}, or all.`)}`);
  console.log(`  ${style.dim(`Surface flags: ${SURFACE_FLAG_ORDER.join(", ")}.`)}`);
  console.log(
    `  ${style.dim("keryx ctx install-hook, keryx orient install-hook, and keryx security hooks install are legacy aliases that already delegate to this same installer core — see docs/docs/integrations.md.")}`,
  );
}
