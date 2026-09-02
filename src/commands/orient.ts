import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { optionValue } from "../lib/args";
import { buildOrientation } from "../ctx/orient";
import { formatRoutingBlock, routePrompt } from "../ctx/orient-routing";
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
  const routing = await routingBlockForStdin();
  const body = runtime ? runtime.format(orientation) : orientation;
  process.stdout.write(`${body}${routing}\n`);
}

// This command is installed as a `UserPromptSubmit` hook and its stdout is added
// to the turn's context. It never read the payload: its output was byte-identical
// for "сделай полное ревью" and "what is 2+2", so what reached the agent was the
// static Intent Router table — the same prose that failed to route the session
// which reported this. Reading the prompt turns a table of ten rows into one
// name.
//
// Advisory by construction. "The agent did not invoke a skill" is the ABSENCE of
// an action and `PreToolUse` intercepts actions, so there is nothing here to
// block; this injects a suggestion and blocks nothing.
async function routingBlockForStdin(): Promise<string> {
  try {
    const prompt = await readPromptFromStdin();
    if (!prompt) {
      return "";
    }
    return formatRoutingBlock(prompt, routePrompt(prompt));
  } catch {
    // A hook that runs on every prompt must never fail the turn. Losing the
    // routing block is the correct failure; losing the turn is not.
    return "";
  }
}

/**
 * The prompt from a `UserPromptSubmit` payload, or null.
 *
 * Absent, empty, non-JSON, or JSON without a prompt all return null, and the
 * caller then emits exactly the pre-change output — a runtime that pipes this
 * command nothing must keep working.
 */
async function readPromptFromStdin(): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null;
  }
  const raw = await Bun.stdin.text();
  if (!raw.trim()) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const prompt = (payload as { prompt?: unknown }).prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt : null;
}

function parseRuntimeArg(args: string[]): string[] {
  const value = optionValue(args, "--runtime") ?? "claude";
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function isDryRun(args: string[]): boolean {
  return args.includes("--dry-run");
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
    const removed = await uninstallOne(cwd, runtime);
    console.log(`  ${removed ? "✓" : "·"} ${runtime.id} ${removed ? `-> ${target}` : "nothing to remove"}`);
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
