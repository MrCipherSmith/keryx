// `keryx retention status|sweep` (flow 237 phase 5, T8 — AC3 / AC-29
// "forgetting", the retention/prune slice for stores that grow without
// bound). See `src/retention/policy.ts` for the policy rationale and
// `src/retention/sweep.ts` for the engine this is a thin argv adapter over.
//
// `status` is read-only: it lists what is on disk against the configured
// caps and touches nothing. `sweep` is a dry run BY DEFAULT — it prints
// exactly what `--apply` would remove, and only `--apply` actually deletes
// anything. That default is deliberate, not a convenience: the first thing
// anyone reaches for on a store this size is "show me what would go", and
// making that the default (rather than a flag away from an accidental
// delete) is the safer contract.

import { optionValue } from "../lib/args";
import { defaultFsDeps, type RetentionFsDeps } from "../retention/fs-deps";
import { sweepProject, type SweepReport, type TargetSweepResult } from "../retention/sweep";

export interface RetentionCommandDeps {
  cwd?: string;
  fsDeps?: RetentionFsDeps;
  now?: number;
}

function printHelp(): void {
  console.log(`keryx retention status|sweep — bound the size of stores that grow with every routed search or refused write

Usage:
  keryx retention status [--json]
  keryx retention sweep [--apply] [--target <id>]... [--max-age-days <n>] [--max-bytes <n>] [--json]

status  Read-only inventory: per-target entry count, bytes on disk, and the
        configured age/byte caps. Never removes anything.
sweep   Applies the retention policy (age cutoff, then a total-byte cap
        evicting the oldest remaining entries) to gdctx raw logs/artifacts
        and owner write-conflict sidecars under .metaproject/workspaces/.
        DRY RUN BY DEFAULT: without --apply, nothing is removed — the report
        shows what would go. Pass --apply to actually remove it.
        --target <id> restricts the sweep to one target id from \`status\`
        (repeatable). --max-age-days / --max-bytes override every target's
        cap uniformly for this run only; omit them to use each target's own
        default.

An unreachable store (cannot be listed, or an entry cannot be removed) is
reported "incomplete" with the reason, never folded into a clean success —
and the whole command then exits 1. This sweep only touches the local stores
named above: content already relayed to an agent, exported copies, and git
history are out of scope and are never promised erased by it.
`);
}

function targetIds(args: string[]): string[] | undefined {
  const ids: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--target") {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) ids.push(value);
    }
  }
  return ids.length > 0 ? ids : undefined;
}

function numericOption(args: string[], name: string): number | undefined {
  const raw = optionValue(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export async function retentionCommand(args: string[] = [], deps: RetentionCommandDeps = {}): Promise<void> {
  const subcommand = args[0];

  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return;
  }

  const cwd = deps.cwd ?? process.cwd();
  const fsDeps = deps.fsDeps ?? defaultFsDeps;
  const rest = args.slice(1);
  const json = args.includes("--json");

  switch (subcommand) {
    case "status":
      await runStatus(cwd, fsDeps, deps.now, json);
      return;
    case "sweep":
      await runSweep(cwd, fsDeps, deps.now, rest, json);
      return;
    default:
      console.error(`Unknown retention command: ${subcommand}`);
      printHelp();
      process.exitCode = 1;
  }
}

async function runStatus(cwd: string, fsDeps: RetentionFsDeps, now: number | undefined, json: boolean): Promise<void> {
  // `status` is a pure inventory read: run the same discovery + dry-run sweep
  // `sweep` uses, since "what is here and how old/big is it" is exactly what
  // a dry run already computes, and never let it apply.
  const report = await sweepProject(cwd, fsDeps, { dryRun: true, ...(now !== undefined ? { now } : {}) });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderReport(report, { statusOnly: true }));
  if (report.status === "incomplete") process.exitCode = 1;
}

async function runSweep(
  cwd: string,
  fsDeps: RetentionFsDeps,
  now: number | undefined,
  args: string[],
  json: boolean,
): Promise<void> {
  const apply = args.includes("--apply");
  const ids = targetIds(args);
  const maxAgeDays = numericOption(args, "--max-age-days");
  const maxBytes = numericOption(args, "--max-bytes");
  const overrides = maxAgeDays !== undefined || maxBytes !== undefined
    ? { ...(maxAgeDays !== undefined ? { maxAgeDays } : {}), ...(maxBytes !== undefined ? { maxBytes } : {}) }
    : undefined;

  const report = await sweepProject(cwd, fsDeps, {
    dryRun: !apply,
    ...(now !== undefined ? { now } : {}),
    ...(ids !== undefined ? { targetIds: ids } : {}),
    ...(overrides !== undefined ? { overrides } : {}),
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report, { statusOnly: false }));
  }
  if (report.status === "incomplete") process.exitCode = 1;
}

function renderReport(report: SweepReport, options: { statusOnly: boolean }): string {
  const lines: string[] = [];
  lines.push(options.statusOnly ? "keryx retention status" : `keryx retention sweep${report.dryRun ? " (dry run)" : " (applied)"}`);
  lines.push("");
  for (const target of report.targets) {
    lines.push(`${target.id} — ${target.label}`);
    lines.push(`  dir: ${target.dir}`);
    lines.push(`  status: ${target.status}`);
    if (target.status === "empty") {
      lines.push(`  (nothing on disk yet)`);
    } else {
      lines.push(`  entries: ${target.entriesScanned} scanned, ${target.entriesEligible} eligible, ${target.entriesRemoved} removed`);
      lines.push(`  bytes: ${target.bytesBefore} before, ${target.bytesEligible} eligible, ${target.bytesReclaimed} reclaimed, ${target.bytesRemaining} remaining`);
    }
    for (const reason of target.reasons) {
      lines.push(`  ! ${reason}`);
    }
    lines.push("");
  }
  if (report.discoveryIssues.length > 0) {
    lines.push("Discovery issues (some targets may not be listed above):");
    for (const issue of report.discoveryIssues) {
      lines.push(`  ! ${issue}`);
    }
    lines.push("");
  }
  lines.push(`Overall status: ${report.status}`);
  lines.push("");
  lines.push(report.scopeNote);
  return lines.join("\n");
}

// Re-export for callers that want the shaped report without going through
// stdout (e.g. a future MCP tool) — kept here rather than only in
// `src/retention/sweep.ts` so the CLI's own default `cwd`/`fsDeps` resolution
// is available too.
export type { SweepReport, TargetSweepResult };
