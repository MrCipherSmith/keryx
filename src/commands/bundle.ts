// Flow 313 (W4 portability), T10 — `keryx bundle export|import|inspect|verify|uninstall`,
// the CLI surface over the portable-bundle core (`src/bundle/service.ts`,
// T6-T9) plus `--external` (an Agent-Skills-standard catalog, W4-AC9,
// `src/bundle/external.ts`) and `--render-for` (rules-export, T9,
// `src/integrations/rules-export.ts`). See
// docs/requirements/keryx-agent-platform-expansion/workstreams/W4-portability.md.
//
// This command never prints file CONTENTS — only paths, sha256 and counts —
// and every write goes through the core's own plan -> W8 audit -> apply
// lifecycle: any refusal here means zero bytes were written (the core's
// `applyBundlePlan` is all-or-nothing with rollback on the first failure).

import path from "node:path";
import { helpOptions, helpTitle, helpUsage, style } from "../lib/ui";
import { optionValue } from "../lib/args";
import packageJson from "../../package.json" with { type: "json" };
import {
  BUNDLE_CONTENT_KINDS,
  BUNDLE_SCOPES,
  applyBundlePlan,
  applyExternalImports,
  auditBundlePlan,
  exportBundle,
  inspectBundle,
  openBundle,
  parseManifest,
  planBundleImport,
  uninstallBundle,
  verifyBundlePath,
  verifyExternalImports,
  vetExternalCatalog,
  type BundleContentKind,
  type BundleRefusal,
  type BundleScope,
  type PlanEntry,
} from "../bundle/service";
import { installedRulesExportHarnesses, renderRulesForHarnesses, type RulesExportResult } from "../integrations/rules-export";

const CLI_VERSION = packageJson.version as string;

export async function bundleCommand(args: string[], cwd: string = process.cwd()): Promise<void> {
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    printBundleHelp();
    return;
  }
  const rest = args.slice(1);

  if (sub === "export") {
    await handleExport(rest, cwd);
    return;
  }
  if (sub === "import") {
    await handleImport(rest, cwd);
    return;
  }
  if (sub === "inspect") {
    await handleInspect(rest, cwd);
    return;
  }
  if (sub === "verify") {
    await handleVerify(rest, cwd);
    return;
  }
  if (sub === "uninstall") {
    await handleUninstall(rest, cwd);
    return;
  }

  console.error(`Unknown bundle command: ${sub}`);
  printBundleHelp();
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// shared argument helpers
// ---------------------------------------------------------------------------

function isBundleScope(value: string): value is BundleScope {
  return (BUNDLE_SCOPES as readonly string[]).includes(value);
}

function isBundleContentKind(value: string): value is BundleContentKind {
  return (BUNDLE_CONTENT_KINDS as readonly string[]).includes(value);
}

/** Every occurrence of `--flag <value>`/`--flag=<value>`, one entry per occurrence — no comma splitting (paths/globs may legitimately not want it). */
function collectRepeatableRaw(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === flag) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) out.push(next);
    } else if (token?.startsWith(`${flag}=`)) {
      out.push(token.slice(flag.length + 1));
    }
  }
  return out;
}

/** Like `collectRepeatableRaw`, but each occurrence's value is also comma-split, trimmed and de-duplicated — for `--kind`/`--target-harness`/`--render-for`. */
function collectRepeatableCsv(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (const value of collectRepeatableRaw(args, flag).flatMap((v) => v.split(","))) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** Positional (non-flag) tokens: every `valueFlags` occurrence consumes its own following value (only when that value doesn't itself look like a flag, matching `optionValue`'s own "missing value" semantics), every `boolFlags` occurrence is skipped, and any other `--...` token is skipped too (an unknown flag is not mistaken for a positional). */
function extractPositionals(args: readonly string[], valueFlags: readonly string[], boolFlags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (boolFlags.includes(token)) continue;
    if (valueFlags.includes(token)) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) i += 1;
      continue;
    }
    if (valueFlags.some((flag) => token.startsWith(`${flag}=`))) continue;
    if (token.startsWith("--")) continue;
    out.push(token);
  }
  return out;
}

function failUsage(message: string): void {
  console.error(message);
  process.exitCode = 2;
}

function printRefusals(refusals: readonly { reason: string; path?: string; message: string }[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, refusals }, null, 2));
    return;
  }
  console.error("Refused:");
  for (const refusal of refusals) {
    console.error(`  ${refusal.reason}${refusal.path !== undefined ? ` (${refusal.path})` : ""}: ${refusal.message}`);
  }
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

const EXPORT_VALUE_FLAGS = ["--scope", "--include", "--kind", "--id", "--target-harness"] as const;
const EXPORT_BOOL_FLAGS = ["--json"] as const;

async function handleExport(args: readonly string[], cwd: string): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printExportHelp();
    return;
  }
  const json = args.includes("--json");

  const scopeArg = optionValue([...args], "--scope");
  if (scopeArg === undefined) {
    failUsage("keryx bundle export requires --scope <project|team|user>");
    return;
  }
  if (!isBundleScope(scopeArg)) {
    failUsage(`--scope must be one of ${BUNDLE_SCOPES.join(", ")} (got ${JSON.stringify(scopeArg)})`);
    return;
  }

  const include = collectRepeatableRaw(args, "--include");
  const kindsRaw = collectRepeatableCsv(args, "--kind");
  for (const kind of kindsRaw) {
    if (!isBundleContentKind(kind)) {
      failUsage(`--kind must be one of ${BUNDLE_CONTENT_KINDS.join(", ")} (got ${JSON.stringify(kind)})`);
      return;
    }
  }
  const targetHarnesses = collectRepeatableCsv(args, "--target-harness");
  const bundleId = optionValue([...args], "--id");

  const positionals = extractPositionals(args, [...EXPORT_VALUE_FLAGS], [...EXPORT_BOOL_FLAGS]);
  const out = positionals[0];
  if (out === undefined) {
    failUsage("keryx bundle export requires an <out> path");
    return;
  }

  const outcome = await exportBundle({
    projectRoot: cwd,
    scope: scopeArg,
    out: path.resolve(cwd, out),
    include: include.length > 0 ? include : undefined,
    kinds: kindsRaw.length > 0 ? (kindsRaw as BundleContentKind[]) : undefined,
    bundleId,
    targetHarnesses: targetHarnesses.length > 0 ? targetHarnesses : undefined,
    keryxVersion: CLI_VERSION,
  });

  if (!outcome.ok) {
    printRefusals(outcome.refusals, json);
    process.exitCode = 1;
    return;
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          bundleId: outcome.result.manifest.bundleId,
          outPath: outcome.result.outPath,
          entries: outcome.result.entries.length,
          skipped: outcome.result.skipped,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`Exported bundle ${style.bold(outcome.result.manifest.bundleId)} to ${outcome.result.outPath}`);
  console.log(`  ${outcome.result.entries.length} entrie(s), ${outcome.result.skipped.length} skipped`);
  for (const skipped of outcome.result.skipped) {
    console.log(`  skipped ${skipped.path}: ${skipped.reason}`);
  }
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

const IMPORT_VALUE_FLAGS = ["--target-scope", "--render-for", "--force"] as const;
const IMPORT_BOOL_FLAGS = ["--dry-run", "--json", "--external"] as const;

async function handleImport(args: readonly string[], cwd: string): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printImportHelp();
    return;
  }
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const external = args.includes("--external");

  const positionals = extractPositionals(args, [...IMPORT_VALUE_FLAGS], [...IMPORT_BOOL_FLAGS]);
  const target = positionals[0];
  if (target === undefined) {
    failUsage(`keryx bundle import requires a ${external ? "<catalog-dir>" : "<bundle>"} argument`);
    return;
  }

  if (external) {
    await handleImportExternal(path.resolve(cwd, target), cwd, { dryRun, json });
    return;
  }

  const targetScopeArg = optionValue([...args], "--target-scope");
  if (targetScopeArg !== undefined && !isBundleScope(targetScopeArg)) {
    failUsage(`--target-scope must be one of ${BUNDLE_SCOPES.join(", ")} (got ${JSON.stringify(targetScopeArg)})`);
    return;
  }
  const targetScope = targetScopeArg as BundleScope | undefined;
  const renderFor = collectRepeatableCsv(args, "--render-for");
  const force = collectRepeatableRaw(args, "--force");

  const opened = await openBundle(path.resolve(cwd, target));
  if (!opened.ok) {
    printRefusals([opened.refusal], json);
    process.exitCode = 1;
    return;
  }
  const parsed = parseManifest(opened.value.manifestBytes);
  if (!parsed.ok) {
    printRefusals(parsed.refusals, json);
    process.exitCode = 1;
    return;
  }

  const plan = await planBundleImport({
    source: opened.value,
    manifest: parsed.manifest,
    projectRoot: cwd,
    targetScope,
    force: force.length > 0 ? force : undefined,
  });

  if (dryRun) {
    printPlan(plan, json);
    process.exitCode = plan.ok ? 0 : 1;
    return;
  }

  if (!plan.ok) {
    printRefusals(plan.refusals, json);
    process.exitCode = 1;
    return;
  }

  const auditResult = await auditBundlePlan(plan);
  if (!auditResult.ok) {
    printRefusals(auditResult.refusals, json);
    process.exitCode = 1;
    return;
  }

  const applyResult = await applyBundlePlan(plan, auditResult);
  if (applyResult.refusals.length > 0) {
    printRefusals(applyResult.refusals, json);
    process.exitCode = 1;
    return;
  }

  const writtenRuleEntries = plan.entries.filter((entry) => entry.kind === "rule" && applyResult.written.includes(entry.displayId));

  let rulesResult: RulesExportResult[] | undefined;
  if (writtenRuleEntries.length > 0) {
    const harnessIds = renderFor.length > 0 ? renderFor : await installedRulesExportHarnesses(cwd);
    if (harnessIds.length > 0) {
      rulesResult = await renderRulesForHarnesses(cwd, harnessIds, {});
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          bundleId: plan.bundleId,
          written: applyResult.written,
          unchanged: applyResult.unchanged,
          ...(rulesResult !== undefined ? { rendered: rulesResult } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Imported bundle ${style.bold(plan.bundleId)}`);
  console.log(`  written: ${applyResult.written.length}, unchanged: ${applyResult.unchanged.length}`);
  for (const written of applyResult.written) console.log(`    + ${written}`);
  if (rulesResult !== undefined) {
    console.log("Rendered rules:");
    for (const result of rulesResult) {
      console.log(`  ${result.harness}: ${result.status}${result.file !== undefined ? ` (${result.file})` : ""}`);
    }
  }
}

function printPlan(plan: { ok: boolean; bundleId: string; refusals: readonly BundleRefusal[]; entries: readonly PlanEntry[] }, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: plan.ok,
          bundleId: plan.bundleId,
          refusals: plan.refusals,
          entries: plan.entries.map((entry) => ({
            path: entry.path,
            kind: entry.kind,
            entryScope: entry.entryScope,
            targetScope: entry.targetScope,
            displayId: entry.displayId,
            bucket: entry.bucket,
            ...(entry.conflictReason !== undefined ? { conflictReason: entry.conflictReason } : {}),
            forced: entry.forced,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`Plan for bundle ${style.bold(plan.bundleId)} (${plan.ok ? "ok" : "has refusals"}):`);
  const byKind = new Map<string, PlanEntry[]>();
  for (const entry of plan.entries) {
    const bucket = byKind.get(entry.kind) ?? [];
    bucket.push(entry);
    byKind.set(entry.kind, bucket);
  }
  for (const kind of [...byKind.keys()].sort()) {
    console.log(`  ${kind}:`);
    for (const entry of byKind.get(kind) as PlanEntry[]) {
      console.log(`    [${entry.bucket}${entry.forced ? " forced" : ""}] ${entry.displayId}${entry.conflictReason !== undefined ? ` (${entry.conflictReason})` : ""}`);
    }
  }
  if (plan.refusals.length > 0) printRefusals(plan.refusals, false);
}

async function handleImportExternal(catalogDir: string, cwd: string, opts: { dryRun: boolean; json: boolean }): Promise<void> {
  const result = await vetExternalCatalog({ catalogPath: catalogDir, projectRoot: cwd });
  const anyAccepted = result.candidates.some((candidate) => candidate.decision === "accepted");

  let applied: Awaited<ReturnType<typeof applyExternalImports>> | undefined;
  if (!opts.dryRun && anyAccepted) {
    applied = await applyExternalImports(result);
    if (!applied.ok) {
      printRefusals([{ reason: applied.reason, message: applied.message }], opts.json);
      process.exitCode = 1;
      return;
    }
  }

  const publicCandidates = result.candidates.map((candidate) => ({
    name: candidate.name,
    dir: candidate.dir,
    decision: candidate.decision,
    reasons: candidate.reasons,
    scout: candidate.scout,
    audit: candidate.audit,
  }));

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: anyAccepted,
          candidates: publicCandidates,
          ...(applied !== undefined && applied.ok ? { written: applied.written } : {}),
          ...(opts.dryRun ? { dryRun: true } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`External catalog: ${catalogDir}`);
    for (const candidate of publicCandidates) {
      const marker = candidate.decision === "accepted" ? style.green("accepted") : style.red("rejected");
      console.log(`  ${marker} ${candidate.name}${candidate.reasons.length > 0 ? ` — ${candidate.reasons.join(", ")}` : ""}`);
    }
    if (applied !== undefined && applied.ok && applied.written.length > 0) {
      console.log(`Recorded: ${applied.written.join(", ")}`);
    }
    if (opts.dryRun) console.log("--dry-run: nothing recorded");
  }

  process.exitCode = anyAccepted ? 0 : 1;
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

async function handleInspect(args: readonly string[], cwd: string): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printInspectHelp();
    return;
  }
  const json = args.includes("--json");
  const targetScopeArg = optionValue([...args], "--target-scope");
  if (targetScopeArg !== undefined && !isBundleScope(targetScopeArg)) {
    failUsage(`--target-scope must be one of ${BUNDLE_SCOPES.join(", ")} (got ${JSON.stringify(targetScopeArg)})`);
    return;
  }

  const positionals = extractPositionals(args, ["--target-scope"], ["--json"]);
  const bundlePath = positionals[0];
  if (bundlePath === undefined) {
    failUsage("keryx bundle inspect requires a <bundle> argument");
    return;
  }

  const result = await inspectBundle(path.resolve(cwd, bundlePath), {
    projectRoot: cwd,
    targetScope: targetScopeArg as BundleScope | undefined,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Bundle ${result.manifest?.bundleId ?? "(unreadable)"}: ${result.ok ? style.green("ok") : style.red("has issues")}`);
    for (const warning of result.warnings) console.log(`  warning: ${warning}`);
    for (const entry of result.entries) console.log(`  [${entry.bucket}] ${entry.displayId}`);
    if (result.refusals.length > 0) printRefusals(result.refusals, false);
  }
  process.exitCode = result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

async function handleVerify(args: readonly string[], cwd: string): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printVerifyHelp();
    return;
  }
  const json = args.includes("--json");

  if (args.includes("--external-imports")) {
    const result = await verifyExternalImports();
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const entry of result.entries) {
        const marker = entry.status === "ok" ? style.green("ok") : style.red(entry.status);
        console.log(`  ${marker} ${entry.name}${entry.message !== undefined ? ` — ${entry.message}` : ""}`);
      }
      if (result.refusal !== undefined) console.error(`${result.refusal.reason}: ${result.refusal.message}`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const positionals = extractPositionals(args, [], ["--json", "--external-imports"]);
  const bundlePath = positionals[0];
  if (bundlePath === undefined) {
    failUsage("keryx bundle verify requires a <bundle> argument (or --external-imports)");
    return;
  }

  const outcome = await verifyBundlePath(path.resolve(cwd, bundlePath));
  if (!outcome.ok) {
    printRefusals(outcome.refusals, json);
    process.exitCode = 1;
    return;
  }

  if (json) {
    console.log(
      JSON.stringify(
        { ok: outcome.result.ok, bundleId: outcome.manifest.bundleId, entries: outcome.result.entries, unlisted: outcome.result.unlisted },
        null,
        2,
      ),
    );
  } else {
    console.log(`Bundle ${outcome.manifest.bundleId}: ${outcome.result.ok ? style.green("verified") : style.red("verification failed")}`);
    for (const entry of outcome.result.entries) {
      if (entry.status !== "ok") console.log(`  ${entry.status}: ${entry.path}`);
    }
    for (const unlisted of outcome.result.unlisted) console.log(`  unlisted: ${unlisted}`);
  }
  process.exitCode = outcome.result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

async function handleUninstall(args: readonly string[], cwd: string): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printUninstallHelp();
    return;
  }
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");

  const targetScopeArg = optionValue([...args], "--target-scope");
  if (targetScopeArg === undefined) {
    failUsage("keryx bundle uninstall requires --target-scope <project|team|user>");
    return;
  }
  if (!isBundleScope(targetScopeArg)) {
    failUsage(`--target-scope must be one of ${BUNDLE_SCOPES.join(", ")} (got ${JSON.stringify(targetScopeArg)})`);
    return;
  }

  const positionals = extractPositionals(args, ["--target-scope"], ["--json", "--dry-run"]);
  const bundleId = positionals[0];
  if (bundleId === undefined) {
    failUsage("keryx bundle uninstall requires a <bundleId> argument");
    return;
  }

  const result = await uninstallBundle({ bundleId, targetScope: targetScopeArg, projectRoot: cwd, dryRun });

  if (result.refusals.length > 0) {
    printRefusals(result.refusals, json);
    process.exitCode = 1;
    return;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Uninstall ${bundleId} (${targetScopeArg})${dryRun ? " [dry-run]" : ""}:`);
  console.log(`  removed: ${result.removed.length}, kept: ${result.kept.length}, missing: ${result.missing.length}`);
  for (const removed of result.removed) console.log(`    - ${removed}`);
  for (const kept of result.kept) console.log(`    kept (${kept.reason}): ${kept.path}`);
  for (const missing of result.missing) console.log(`    missing: ${missing}`);
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

export function printBundleHelp(): void {
  helpTitle("bundle", "Portable bundle export/import of skills, rules, agents, memory and hooks (W4)");
  helpUsage([
    "keryx bundle export --scope <project|team|user> [--include <glob>]... [--kind <k,...>] [--id <id>] [--target-harness <h,...>] <out> [--json]",
    "keryx bundle import <bundle> [--target-scope <scope>] [--render-for <h,...>] [--force <path>]... [--dry-run] [--json]",
    "keryx bundle import <catalog-dir> --external [--dry-run] [--json]",
    "keryx bundle inspect <bundle> [--target-scope <scope>] [--json]",
    "keryx bundle verify <bundle> [--json]",
    "keryx bundle verify --external-imports [--json]",
    "keryx bundle uninstall <bundleId> --target-scope <scope> [--dry-run] [--json]",
  ]);
}

function printExportHelp(): void {
  helpTitle("bundle export", "Export a scope's content into a portable bundle");
  helpUsage(["keryx bundle export --scope <project|team|user> [--include <glob>]... [--kind <k,...>] [--id <id>] [--target-harness <h,...>] <out> [--json]"]);
  helpOptions([
    { flag: "--scope <s>", desc: "project|team|user — the scope to export from" },
    { flag: "--include <glob>", desc: "restrict to matching bundle-relative paths; repeatable" },
    { flag: "--kind <k,...>", desc: `content kinds to export: ${BUNDLE_CONTENT_KINDS.join(", ")}` },
    { flag: "--id <id>", desc: "override the default deterministic bundleId" },
    { flag: "--target-harness <h,...>", desc: "harness ids recorded in the manifest's compat.targetHarnesses" },
    { flag: "--json", desc: "print the export result as JSON" },
  ]);
}

function printImportHelp(): void {
  helpTitle("bundle import", "Plan -> W8 audit -> apply a bundle into a target scope");
  helpUsage([
    "keryx bundle import <bundle> [--target-scope <scope>] [--render-for <h,...>] [--force <path>]... [--dry-run] [--json]",
    "keryx bundle import <catalog-dir> --external [--dry-run] [--json]",
  ]);
  helpOptions([
    { flag: "--target-scope <s>", desc: "retarget every entry to this scope" },
    { flag: "--render-for <h,...>", desc: "render imported rules into these harnesses (default: already-installed ones)" },
    { flag: "--force <path>", desc: "overwrite this conflicting entry anyway; repeatable" },
    { flag: "--external", desc: "treat <bundle> as an Agent-Skills-standard catalog directory" },
    { flag: "--dry-run", desc: "plan/vet only; write nothing" },
    { flag: "--json", desc: "print the result as JSON" },
  ]);
}

function printInspectHelp(): void {
  helpTitle("bundle inspect", "Read-only preview of what `bundle import` would do");
  helpUsage(["keryx bundle inspect <bundle> [--target-scope <scope>] [--json]"]);
  helpOptions([
    { flag: "--target-scope <s>", desc: "preview against this target scope" },
    { flag: "--json", desc: "print the inspection result as JSON" },
  ]);
}

function printVerifyHelp(): void {
  helpTitle("bundle verify", "Recompute checksums against a bundle's actual bytes");
  helpUsage(["keryx bundle verify <bundle> [--json]", "keryx bundle verify --external-imports [--json]"]);
  helpOptions([
    { flag: "--external-imports", desc: "verify recorded external skill imports instead of a bundle file" },
    { flag: "--json", desc: "print the verification result as JSON" },
  ]);
}

function printUninstallHelp(): void {
  helpTitle("bundle uninstall", "Remove only the files a bundleId wrote and that are still unmodified");
  helpUsage(["keryx bundle uninstall <bundleId> --target-scope <scope> [--dry-run] [--json]"]);
  helpOptions([
    { flag: "--target-scope <s>", desc: "project|team|user — scope to uninstall from" },
    { flag: "--dry-run", desc: "report what would be removed/kept without writing" },
    { flag: "--json", desc: "print the uninstall result as JSON" },
  ]);
}
