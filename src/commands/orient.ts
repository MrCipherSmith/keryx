import path from "node:path";
import { pathExists } from "../lib/fs";
import { optionValue } from "../lib/args";
import { buildOrientation } from "../ctx/orient";
import {
  getOrientRuntime,
  installOrientRuntime,
  orientRuntimeIds,
  resolveOrientRuntimes,
  uninstallOrientRuntime,
  UNSUPPORTED_ORIENT,
  type OrientRuntime,
} from "../ctx/orient-runtimes";

// `keryx orient` — the graph+wiki orientation injector and its installer.
//   keryx orient [<runtime>]                emit the orientation (hook target)
//   keryx orient install-hook [--runtime]   install the session/prompt hook
//   keryx orient uninstall-hook [--runtime]
//
// `--dry-run` was accepted by the shell and ignored by this file: nothing parsed
// it, so the install ran and wrote settings anyway. A --dry-run that mutates is
// worse than no flag, because it is exactly the flag someone reaches for when
// they are unsure the command is safe to run.

export async function orientCommand(args: string[]): Promise<void> {
  const first = args[0];

  if (first === "--help" || first === "-h") {
    printHelp();
    return;
  }
  if (first === "install-hook") {
    await handleInstall(args.slice(1));
    return;
  }
  if (first === "uninstall-hook") {
    await handleUninstall(args.slice(1));
    return;
  }

  // Default: emit the orientation for a runtime (invoked by the installed hook).
  const runtime = getOrientRuntime(first ?? "claude") ?? getOrientRuntime("claude");
  const orientation = await buildOrientation(process.cwd());
  process.stdout.write(`${runtime ? runtime.format(orientation) : orientation}\n`);
}

function parseRuntimeArg(args: string[]): string[] {
  const value = optionValue(args, "--runtime") ?? "claude";
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function isDryRun(args: string[]): boolean {
  return args.includes("--dry-run");
}

async function installOne(cwd: string, runtime: OrientRuntime): Promise<string[]> {
  return installOrientRuntime(cwd, runtime.id);
}

async function uninstallOne(cwd: string, runtime: OrientRuntime): Promise<boolean> {
  const file = runtime.locate(cwd);
  if (!(await pathExists(file))) return false;
  await uninstallOrientRuntime(cwd, runtime.id);
  return true;
}

function reportUnsupported(ids: string[]): void {
  for (const id of ids) {
    console.log(`  · ${id} — no context-injection hook: ${UNSUPPORTED_ORIENT[id]}`);
  }
}

async function handleInstall(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const dryRun = isDryRun(args);
  const { runtimes, unknown, unsupported } = resolveOrientRuntimes(parseRuntimeArg(args));
  if (unknown.length > 0) {
    console.error(`Unknown runtime(s): ${unknown.join(", ")}`);
    console.error(`Supported: ${orientRuntimeIds().join(", ")}, all`);
    process.exitCode = 1;
    return;
  }

  console.log(`# keryx orientation injector ${dryRun ? "install — dry run, nothing written" : "installed"}`);
  console.log("");
  console.log("injects: compact code-graph map + wiki index + freshness at turn start");
  console.log("");
  for (const runtime of runtimes) {
    const target = path.relative(cwd, runtime.locate(cwd));
    if (dryRun) {
      console.log(`  · ${runtime.id} -> would write ${target}`);
      continue;
    }
    const errors = await installOne(cwd, runtime);
    if (errors.length > 0) {
      for (const e of errors) console.error(`  ✗ ${e}`);
      process.exitCode = 1;
    } else {
      console.log(`  ✓ ${runtime.id} -> ${target}`);
    }
  }
  reportUnsupported(unsupported);
}

async function handleUninstall(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const dryRun = isDryRun(args);
  const { runtimes, unknown, unsupported } = resolveOrientRuntimes(parseRuntimeArg(args));
  if (unknown.length > 0) {
    console.error(`Unknown runtime(s): ${unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`# keryx orientation injector uninstall${dryRun ? " — dry run, nothing written" : ""}`);
  console.log("");
  for (const runtime of runtimes) {
    const target = path.relative(cwd, runtime.locate(cwd));
    if (dryRun) {
      const present = await pathExists(runtime.locate(cwd));
      console.log(`  · ${runtime.id} ${present ? `-> would strip ${target}` : "nothing to remove"}`);
      continue;
    }
    try {
      const removed = await uninstallOne(cwd, runtime);
      console.log(`  ${removed ? "✓" : "·"} ${runtime.id} ${removed ? `-> ${target}` : "nothing to remove"}`);
    } catch (error) {
      console.error(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  reportUnsupported(unsupported);
}

function printHelp(): void {
  console.log(`keryx orient — inject a compact graph map + wiki index at turn start

Usage:
  keryx orient [<runtime>]                      emit the orientation block
  keryx orient install-hook [--runtime <id|all>] [--dry-run]
  keryx orient uninstall-hook [--runtime <id|all>] [--dry-run]

Options:
  --dry-run    report what would be written or stripped; change nothing

Runtimes with a context-injection hook: ${orientRuntimeIds().join(", ")}
(Windsurf/Zed have no context-injection hook — use their rules/memories.)
`);
}
