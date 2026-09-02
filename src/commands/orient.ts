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
  // Folded in BEFORE formatting, because `format` owns the runtime's envelope.
  // Appending after it emitted raw markdown behind `cursorAdditionalContext`'s
  // closing brace — `{"additional_context":"…"}## Routing…` — which is not
  // parseable JSON, so cursor would have dropped the ORIENTATION too, not just
  // the routing block. Latent only because cursor's sessionStart payload
  // carries no `prompt`; the runtime that does carry one happens to be the one
  // using plainStdout.
  const full = `${orientation}${await routingBlockForStdin()}`;
  process.stdout.write(`${runtime ? runtime.format(full) : full}\n`);
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
/** Long enough for a harness that writes then closes; short enough to never be felt. */
const STDIN_DEADLINE_MS = 250;

/**
 * Read stdin to EOF, or give up at the deadline and CANCEL the read.
 *
 * `Bun.stdin.text()` on a pipe that is never closed waits forever, and it waits
 * after buildOrientation has done its work, so nothing is written at all. Racing
 * it against a timer is not enough on its own: the abandoned read keeps its own
 * handle on the event loop, so the orientation gets written and the process
 * still never exits — and a hook that never exits hangs the harness just as
 * surely as one that never writes. Cancelling the reader releases it.
 *
 * `keryx orient` printed immediately before this feature existed; a CI step or
 * `ssh host \'keryx orient\'` inherits exactly the stdin that reintroduced the wait.
 */
async function readAllBounded(): Promise<string | null> {
  const reader = Bun.stdin.stream().getReader();
  const timer = setTimeout(() => void reader.cancel().catch(() => {}), STDIN_DEADLINE_MS);
  timer.unref?.();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } catch {
    return null; // cancelled at the deadline, or an unreadable stdin
  } finally {
    clearTimeout(timer);
    reader.releaseLock?.();
  }
  if (chunks.length === 0) return null;
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

async function readPromptFromStdin(): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null;
  }
  // Bounded, because `Bun.stdin.text()` on a pipe that is never closed waits
  // forever — and it waits AFTER buildOrientation has done its work, so nothing
  // is written at all. The try/catch around this cannot help: a block is not a
  // throw. `keryx orient` printed immediately before this change; a CI step or
  // `ssh host 'keryx orient'` inherits exactly such a stdin. A hook that runs on
  // every prompt must never fail the turn, and expiry is treated as the
  // no-prompt case the caller already handles correctly.
  const raw = await readAllBounded();
  if (raw === null || !raw.trim()) {
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
