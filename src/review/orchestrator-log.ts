// The orchestrator's call log, written by keryx (flow 454). `<package>/tool-calls/orchestrator.jsonl` is what
// the readiness item `memory-outside-stage` reads; until now the host agent was asked to write it itself, which
// made the check depend on the behaviour it checks. Every line is one JSON object in the shape `memoryCalls`
// (./layers-usage.ts) already parses: `{time, source, caller, tool | command, input}`.
//
// Three layers record, one each: the `keryx memory` CLI, the keryx MCP memory tools and the keryx shell's tool
// executor. Which package is being recorded is named by the active-review pointer (./active-review.ts); with no
// pointer, or a stale one, nothing is recorded and no file is created.

import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { resolveProjectRoot } from "../lib/contained-path";
import { resolveActiveReview, writeActiveReview } from "./active-review";
import { classifyToolCall, ORCHESTRATOR_LOG, TOOL_LOG_DIR } from "./layers-usage";

/** Set in the environment of every command a spawned review child runs; absent from the orchestrator's own. */
export const ENV_REVIEW_CALLER = "KERYX_REVIEW_CALLER";
/** Set where a keryx layer has already recorded the call it is about to run, so the CLI or MCP process does not record it again. */
export const ENV_REVIEW_RECORDED = "KERYX_REVIEW_RECORDED";
/**
 * Flow 457: the caller token `review start` wrote into the active-review pointer. A host that can set env on the
 * orchestrator's commands exports it; a CLI or MCP call that carries the pointer's token is the orchestrator's.
 */
export const ENV_REVIEW_CALLER_TOKEN = "KERYX_REVIEW_CALLER_TOKEN";

export const CALLER_ORCHESTRATOR = "orchestrator";
export const CALLER_UNATTRIBUTED = "unattributed";

const RESERVED_CALLERS: ReadonlySet<string> = new Set([CALLER_ORCHESTRATOR, CALLER_UNATTRIBUTED]);
const CALLER_PATTERN = /^[\w.:@-]{1,64}$/;
const MAX_COMMAND_CHARS = 1500;
const MAX_INPUT_CHARS = 500;
const MAX_INPUT_KEYS = 12;

export type OrchestratorLogSource = "cli" | "mcp" | "shell" | "tool";

export interface OrchestratorLogEntry {
  source: OrchestratorLogSource;
  caller: string;
  /** An MCP or built-in tool name (`memory_search`). */
  tool?: string;
  /** A shell command line (`keryx memory search "q" --status accepted`). */
  command?: string;
  input?: Record<string, unknown>;
  time?: string;
}

/** Where a package's orchestrator log is. */
export function orchestratorLogPath(packageDir: string): string {
  return path.join(packageDir, TOOL_LOG_DIR, `${ORCHESTRATOR_LOG}.jsonl`);
}

const warned = new Set<string>();

function warnOnce(key: string, message: string, warn: (line: string) => void): void {
  if (warned.has(key)) return;
  warned.add(key);
  warn(message);
}

const stderrWarn = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function boundedInput(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (input === undefined) return undefined;
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, MAX_INPUT_KEYS)) {
    bounded[key] = typeof value === "string" ? clip(value, MAX_INPUT_CHARS) : value;
  }
  return bounded;
}

/**
 * Appends one line to the package's orchestrator log with `O_APPEND`, in a single write, so concurrent writers
 * (the shell, a CLI process, an MCP server) never interleave. Never throws: a failed append prints one warning
 * line and the call it observed keeps its exit code and output. Returns whether the line was written.
 */
export async function recordOrchestratorCall(
  packageDir: string,
  entry: OrchestratorLogEntry,
  options: { now?: Date; warn?: (line: string) => void } = {},
): Promise<boolean> {
  const file = orchestratorLogPath(packageDir);
  try {
    const input = boundedInput(entry.input);
    const line = JSON.stringify({
      time: entry.time ?? (options.now ?? new Date()).toISOString(),
      source: entry.source,
      caller: entry.caller,
      ...(entry.tool === undefined ? {} : { tool: entry.tool }),
      ...(entry.command === undefined ? {} : { command: clip(entry.command, MAX_COMMAND_CHARS) }),
      ...(input === undefined ? {} : { input }),
    });
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    try {
      await handle.write(`${line}\n`);
    } finally {
      await handle.close();
    }
    return true;
  } catch (cause) {
    warnOnce(file, `orchestrator log not written (${file}): ${cause instanceof Error ? cause.message : String(cause)}`, options.warn ?? stderrWarn);
    return false;
  }
}

/** `review start|attach` writes this first, so a log that holds no memory call is told apart from no log at all. */
export async function recordLogStart(packageDir: string, options: { now?: Date; warn?: (line: string) => void } = {}): Promise<boolean> {
  const file = orchestratorLogPath(packageDir);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    try {
      await handle.write(`${JSON.stringify({ time: (options.now ?? new Date()).toISOString(), event: "log-start" })}\n`);
    } finally {
      await handle.close();
    }
    return true;
  } catch (cause) {
    warnOnce(file, `orchestrator log not written (${file}): ${cause instanceof Error ? cause.message : String(cause)}`, options.warn ?? stderrWarn);
    return false;
  }
}

/**
 * `review start|attach`: writes the log's first line and points the project at the package, so every keryx layer
 * that sees a memory call from now until `review complete` knows where to put it. Never throws.
 */
export async function startOrchestratorLog(cwd: string, reviewId: string, packagePath: string, callerToken?: string): Promise<boolean> {
  try {
    const root = resolveProjectRoot(cwd);
    const dir = path.resolve(cwd, packagePath);
    await recordLogStart(dir);
    return await writeActiveReview(root, { id: reviewId, dir, callerToken });
  } catch {
    return false;
  }
}

/** Records into the package the project's pointer names; nothing, silently, when there is none. Never throws. */
export async function recordActiveCall(
  startDir: string,
  entry: OrchestratorLogEntry,
  options: { warn?: (line: string) => void; callerToken?: string | undefined } = {},
): Promise<boolean> {
  try {
    const active = await resolveActiveReview(resolveProjectRoot(startDir));
    if (active === undefined) return false;
    // A call that carries the review's own token is the orchestrator's, whatever caller the process could name.
    const attributed =
      entry.caller === CALLER_UNATTRIBUTED && options.callerToken !== undefined && active.callerToken !== undefined && options.callerToken === active.callerToken
        ? { ...entry, caller: CALLER_ORCHESTRATOR }
        : entry;
    return await recordOrchestratorCall(active.dir, attributed, options);
  } catch {
    return false;
  }
}

/** The caller a CLI or MCP process can name for itself: the marker a keryx shell set on a review child's commands, else `unattributed`. */
export function callerFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const marked = env[ENV_REVIEW_CALLER]?.trim();
  return marked !== undefined && CALLER_PATTERN.test(marked) ? marked : CALLER_UNATTRIBUTED;
}

/**
 * The CLI and MCP recording point. Skipped when a keryx layer above this process already recorded the call
 * (`KERYX_REVIEW_RECORDED=1`), so one call is one line.
 */
export async function recordProcessCall(
  startDir: string,
  entry: Omit<OrchestratorLogEntry, "caller">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (env[ENV_REVIEW_RECORDED] === "1") return false;
  const token = env[ENV_REVIEW_CALLER_TOKEN]?.trim();
  return recordActiveCall(startDir, { ...entry, caller: callerFromEnv(env) }, token === undefined || token === "" ? {} : { callerToken: token });
}

/** The id a review child is recorded under: its label, or its worker id when the label is empty or collides with a reserved caller. */
export function reviewerCallerId(label: string, workerId: string): string {
  const trimmed = label.trim();
  if (trimmed === "") return workerId;
  const id = trimmed.replace(/[^\w.:@-]/g, "-").slice(0, 64);
  return id === "" ? workerId : RESERVED_CALLERS.has(id) ? `child:${id}` : id;
}

/** `keryx memory <args>` as the shell word list `memoryCalls` reads back. */
export function memoryCliCommand(args: readonly string[], quote: (value: string) => string): string {
  return ["keryx", "memory", ...args.map((arg) => (/^[\w./:@=,-]+$/.test(arg) ? arg : quote(arg)))].join(" ");
}

/**
 * Wraps the tools of one session so the memory calls they make are recorded under `caller`:
 * the built-in `memory_search`, and a `shell_exec` command that is a memory call. A recorded shell command runs
 * with `KERYX_REVIEW_RECORDED=1`, so the `keryx memory` process it starts does not record it a second time.
 * Every other tool is returned as it is.
 */
export function withOrchestratorLog(tool: InteractiveTool, options: { cwd: string; caller: string }): InteractiveTool {
  const name = tool.definition.name;
  if (name === "memory_search") {
    return {
      ...tool,
      invoke: async (input, ctx) => {
        await recordActiveCall(options.cwd, { source: "tool", caller: options.caller, tool: name, input });
        return tool.invoke(input, ctx);
      },
    };
  }
  if (name === "shell_exec") {
    return {
      ...tool,
      invoke: async (input, ctx) => {
        const command = typeof input.command === "string" ? input.command : "";
        if (command === "" || !classifyToolCall(command).includes("memory")) return tool.invoke(input, ctx);
        const recorded = await recordActiveCall(options.cwd, { source: "shell", caller: options.caller, command });
        return tool.invoke(recorded ? { ...input, command: `export ${ENV_REVIEW_RECORDED}=1; ${command}` } : input, ctx);
      },
    };
  }
  return tool;
}
