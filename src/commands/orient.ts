import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { optionValue } from "../lib/args";
import { buildOrientation } from "../ctx/orient";
import {
  getOrientRuntime,
  orientRuntimeIds,
  resolveOrientRuntimes,
  UNSUPPORTED_ORIENT,
  type OrientRuntime,
  type Settings,
} from "../ctx/orient-runtimes";

// `keryx orient` — the graph+wiki orientation injector and its installer.
//   keryx orient [<runtime>]                emit the orientation (hook target)
//   keryx orient install-hook [--runtime]   install the session/prompt hook
//   keryx orient uninstall-hook [--runtime]

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

async function readSettings(file: string): Promise<Settings> {
  if (!(await pathExists(file))) return {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Settings)
      : {};
  } catch {
    throw new Error(`Cannot parse ${file}: file is not valid JSON`);
  }
}

async function writeSettings(file: string, settings: Settings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function installOne(cwd: string, runtime: OrientRuntime): Promise<string[]> {
  const file = runtime.locate(cwd);
  const settings = await readSettings(file);
  await writeSettings(file, runtime.merge(settings));
  return runtime.validate(await readSettings(file));
}

async function uninstallOne(cwd: string, runtime: OrientRuntime): Promise<boolean> {
  const file = runtime.locate(cwd);
  if (!(await pathExists(file))) return false;
  const settings = await readSettings(file);
  await writeSettings(file, runtime.strip(settings));
  return true;
}

function reportUnsupported(ids: string[]): void {
  for (const id of ids) {
    console.log(`  · ${id} — no context-injection hook: ${UNSUPPORTED_ORIENT[id]}`);
  }
}

async function handleInstall(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const { runtimes, unknown, unsupported } = resolveOrientRuntimes(parseRuntimeArg(args));
  if (unknown.length > 0) {
    console.error(`Unknown runtime(s): ${unknown.join(", ")}`);
    console.error(`Supported: ${orientRuntimeIds().join(", ")}, all`);
    process.exitCode = 1;
    return;
  }

  console.log("# keryx orientation injector installed");
  console.log("");
  console.log("injects: compact code-graph map + wiki index + freshness at turn start");
  console.log("");
  for (const runtime of runtimes) {
    const errors = await installOne(cwd, runtime);
    if (errors.length > 0) {
      for (const e of errors) console.error(`  ✗ ${e}`);
      process.exitCode = 1;
    } else {
      console.log(`  ✓ ${runtime.id} -> ${path.relative(cwd, runtime.locate(cwd))}`);
    }
  }
  reportUnsupported(unsupported);
}

async function handleUninstall(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const { runtimes, unknown, unsupported } = resolveOrientRuntimes(parseRuntimeArg(args));
  if (unknown.length > 0) {
    console.error(`Unknown runtime(s): ${unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log("# keryx orientation injector uninstall");
  console.log("");
  for (const runtime of runtimes) {
    const removed = await uninstallOne(cwd, runtime);
    console.log(`  ${removed ? "✓" : "·"} ${runtime.id} ${removed ? `-> ${path.relative(cwd, runtime.locate(cwd))}` : "nothing to remove"}`);
  }
  reportUnsupported(unsupported);
}

function printHelp(): void {
  console.log(`keryx orient — inject a compact graph map + wiki index at turn start

Usage:
  keryx orient [<runtime>]                      emit the orientation block
  keryx orient install-hook [--runtime <id|all>]
  keryx orient uninstall-hook [--runtime <id|all>]

Runtimes with a context-injection hook: ${orientRuntimeIds().join(", ")}
(Windsurf/Zed have no context-injection hook — use their rules/memories.)
`);
}
