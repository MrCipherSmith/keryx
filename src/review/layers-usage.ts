// Which project layers a reviewer actually consulted, counted from the log of its tool calls.
// A reviewer with no log is `unknown`, never zero: zero would claim "looked and used nothing".

import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { splitSegments, stripAssignments } from "../lib/shell-syntax";

export const LAYER_NAMES = ["graph", "wiki", "memory", "ctx"] as const;
export type LayerName = (typeof LAYER_NAMES)[number];
export type LayerCount = number | "unknown";
export type LayersUsed = Record<LayerName, LayerCount>;

export const UNKNOWN_LAYERS_USED: Readonly<LayersUsed> = { graph: "unknown", wiki: "unknown", memory: "unknown", ctx: "unknown" };

// An MCP tool is credited by its name alone, never by what its arguments mention.
const MCP_TOOLS: ReadonlyArray<readonly [LayerName, RegExp]> = [
  ["graph", /^(?:mcp__[a-z0-9-]+__)?(?:gdgraph|graph)_(?:affected|cycles|find|orphans|path|query|symbol)$/],
  ["wiki", /^(?:mcp__[a-z0-9-]+__)?(?:wiki_(?:ask|backlinks|evidence|freshness|query|resolve)|read_wiki)$/],
  ["memory", /^(?:mcp__[a-z0-9-]+__)?memory_(?:search|handoff|propose)$/],
  ["ctx", /^(?:mcp__[a-z0-9-]+__)?search_code$/],
];

/** The `keryx <group>` that names a layer. */
const KERYX_GROUPS: Readonly<Record<string, LayerName>> = { gdgraph: "graph", graph: "graph", wiki: "wiki", memory: "memory", ctx: "ctx" };

const COMMAND_PREFIXES: ReadonlySet<string> = new Set(["env", "sudo", "time", "nohup", "command", "exec", "nice", "timeout"]);
const JS_LAUNCHERS: ReadonlySet<string> = new Set(["bun", "bunx", "npx", "node", "pnpx", "tsx", "deno"]);
const SHELL_NAMES: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash"]);

function layersOfToolName(name: string): LayerName[] {
  const trimmed = name.trim();
  return MCP_TOOLS.filter(([, pattern]) => pattern.test(trimmed)).map(([layer]) => layer);
}

function layersOfCommand(command: string, found: Set<LayerName>, depth = 0): void {
  for (const segment of splitSegments(command)) {
    let words = stripAssignments(segment.words);
    while (words.length > 0 && COMMAND_PREFIXES.has(path.basename(words[0]!))) words = stripAssignments(words.slice(1).filter((w) => !w.startsWith("-")));
    const head = path.basename(words[0] ?? "");
    if (SHELL_NAMES.has(head) && depth < 4) {
      const at = words.findIndex((w, i) => i > 0 && /^-[a-z]*c$/.test(w));
      if (at > 0 && words[at + 1] !== undefined) layersOfCommand(words[at + 1]!, found, depth + 1);
      continue;
    }
    let at = 0;
    if (JS_LAUNCHERS.has(head)) at = words.findIndex((w, i) => i > 0 && !w.startsWith("-") && w !== "run" && w !== "x");
    if (at < 0 || !["keryx", "cli.ts", "cli.js"].includes(path.basename(words[at] ?? ""))) continue;
    const group = words.slice(at + 1).find((w) => !w.startsWith("-"));
    const layer = group === undefined ? undefined : KERYX_GROUPS[group];
    if (layer !== undefined) found.add(layer);
  }
}

/**
 * The layers one tool call consulted, empty for a call that touches none of the four. A shell command is judged
 * by the command word of each of its segments (`keryx ctx rg "keryx wiki"` is ctx, and a chain credits every layer
 * it runs); an MCP tool by its name.
 */
export function classifyToolCall(call: string): LayerName[] {
  const found = new Set<LayerName>(layersOfToolName(call));
  layersOfCommand(call, found);
  return LAYER_NAMES.filter((layer) => found.has(layer));
}

function commandOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      return commandOf(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  if (value !== null && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    for (const key of ["command", "cmd"]) if (typeof entry[key] === "string") return entry[key] as string;
  }
  return undefined;
}

function callLayers(line: string): LayerName[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return classifyToolCall(line);
  }
  if (parsed === null || typeof parsed !== "object") return classifyToolCall(line);
  const entry = parsed as Record<string, unknown>;
  const found = new Set<LayerName>();
  for (const key of ["name", "tool"]) if (typeof entry[key] === "string") for (const layer of layersOfToolName(entry[key] as string)) found.add(layer);
  for (const command of [commandOf(entry), commandOf(entry.input), commandOf(entry.arguments)]) if (command !== undefined) layersOfCommand(command, found);
  return LAYER_NAMES.filter((layer) => found.has(layer));
}

/** Counts per layer for one log: JSON lines (`name`, `command`, `arguments`, `input`) or one plain command per line. */
export function countLayerUsage(log: string): Record<LayerName, number> {
  const counts: Record<LayerName, number> = { graph: 0, wiki: 0, memory: 0, ctx: 0 };
  for (const line of log.split("\n")) {
    if (line.trim() === "") continue;
    for (const layer of callLayers(line)) counts[layer] += 1;
  }
  return counts;
}

/** `undefined` (no log) and a log with no line at all (a driver that failed before writing) are unknown; a log with calls but none into a layer is a real zero. */
export function layersUsedFrom(log: string | undefined): LayersUsed {
  return log === undefined || log.trim() === "" ? { ...UNKNOWN_LAYERS_USED } : countLayerUsage(log);
}

export const TOOL_LOG_DIR = "tool-calls";

/**
 * The orchestrator's own log, `<package>/tool-calls/orchestrator.jsonl`, beside the per-reviewer logs. A reviewer's
 * calls are in its own file, so the orchestrator's reads are told from the reviewers' by the file they are in.
 */
export const ORCHESTRATOR_LOG = "orchestrator";

/** One call into the memory layer: what it asked, and whether it asked for accepted entries only. */
export type MemoryCall = { search: boolean; accepted: boolean; query?: string; time?: string; summary: string };

const SEARCH_VALUE_FLAGS: ReadonlySet<string> = new Set(["--module", "--entity", "--status", "--limit", "--scope", "--kind"]);

/** `keryx memory search "<query>" --status accepted` inside one shell command, or undefined when it holds none. */
function memorySearchOfCommand(command: string): Pick<MemoryCall, "accepted" | "query"> | undefined {
  for (const segment of splitSegments(command)) {
    const words = stripAssignments(segment.words);
    const at = words.findIndex((word, i) => i >= 2 && word === "search" && words[i - 1] === "memory" && ["keryx", "cli.ts", "cli.js"].includes(path.basename(words[i - 2] ?? "")));
    if (at < 0) continue;
    let query: string | undefined;
    let accepted = false;
    for (let i = at + 1; i < words.length; i++) {
      const word = words[i]!;
      if (word === "--status" && words[i + 1] === "accepted") accepted = true;
      if (word === "--status=accepted") accepted = true;
      if (SEARCH_VALUE_FLAGS.has(word)) i++;
      else if (!word.startsWith("-") && query === undefined) query = word;
    }
    return { accepted, ...(query === undefined ? {} : { query }) };
  }
  return undefined;
}

function entryTime(entry: Record<string, unknown>): string | undefined {
  for (const key of ["time", "timestamp", "ts", "at"]) if (typeof entry[key] === "string") return entry[key] as string;
  return undefined;
}

/** Every call a log makes into the memory layer, in order: the shell command or the MCP tool, with its query when it is a search. */
export function memoryCalls(log: string): MemoryCall[] {
  const calls: MemoryCall[] = [];
  for (const line of log.split("\n")) {
    if (line.trim() === "" || !callLayers(line).includes("memory")) continue;
    let entry: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === "object") entry = parsed as Record<string, unknown>;
    } catch {
      // a plain command line
    }
    const time = entryTime(entry);
    const mcpName = [entry.name, entry.tool].find((value): value is string => typeof value === "string");
    const args = (value: unknown): Record<string, unknown> => {
      if (typeof value === "string") {
        try { return args(JSON.parse(value)); } catch { return {}; }
      }
      return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
    };
    const input = { ...args(entry.input), ...args(entry.arguments) };
    const base = { ...(time === undefined ? {} : { time }) };
    if (mcpName !== undefined && /memory_search$/.test(mcpName)) {
      const query = typeof input.query === "string" && input.query.trim() !== "" ? input.query : undefined;
      calls.push({ search: true, accepted: input.status === "accepted", ...(query === undefined ? {} : { query }), ...base, summary: `${mcpName}${query === undefined ? "" : ` "${query}"`}` });
      continue;
    }
    const command = commandOf(entry) ?? commandOf(entry.input) ?? commandOf(entry.arguments) ?? (mcpName === undefined && Object.keys(entry).length === 0 ? line : undefined);
    const search = command === undefined ? undefined : memorySearchOfCommand(command);
    calls.push(search === undefined ? { search: false, accepted: false, ...base, summary: (command ?? mcpName ?? line).trim().slice(0, 120) } : { search: true, ...search, ...base, summary: (command ?? "").trim().slice(0, 120) });
  }
  return calls;
}

/** A log above this is not read: the layers-used figure is then unknown, not wrong. */
export const MAX_TOOL_LOG_BYTES = 8 * 1024 * 1024;

/** The reviewer's tool-call log: the path its driver names (`toolLog`), else `<input-dir>/tool-calls/<reviewer>.jsonl`. Absent when neither is a readable file. */
export async function readToolLog(inputDir: string, reviewer: string, named?: string): Promise<string | undefined> {
  const candidate = named === undefined ? path.join(inputDir, TOOL_LOG_DIR, `${path.basename(reviewer)}.jsonl`) : path.resolve(inputDir, named);
  const inside = path.relative(inputDir, candidate);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
  try {
    // A symlink inside the input directory can point out of it, and a FIFO would block the read: resolve first, then require a regular file.
    const [real, realInput] = await Promise.all([realpath(candidate), realpath(inputDir)]);
    const realInside = path.relative(realInput, real);
    if (realInside.startsWith("..") || path.isAbsolute(realInside)) return undefined;
    // Open without blocking and judge the opened file, so a regular file swapped for a FIFO after the check cannot hang the read.
    const handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_TOOL_LOG_BYTES) return undefined;
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export type LayersUsageSummary = {
  /** Reviewers with a log. */
  withLog: number;
  /** Reviewers that consulted at least one layer. */
  usedAny: number;
  /** Reviewers without a log. */
  unknown: number;
  total: number;
  /** Reviewers that consulted each layer, among those with a log. */
  perLayer: Record<LayerName, number>;
};

/** What the panel shows for `layers used n/m` and `unknown k`, from the ledger's `dispatch.runs`. */
export function summarizeLayersUsage(runs: ReadonlyArray<Record<string, unknown>>): LayersUsageSummary {
  const summary: LayersUsageSummary = { withLog: 0, usedAny: 0, unknown: 0, total: 0, perLayer: { graph: 0, wiki: 0, memory: 0, ctx: 0 } };
  for (const run of runs) {
    if (run.status === "not-run") continue;
    summary.total += 1;
    const used = run.layersUsed;
    if (used === null || typeof used !== "object") {
      summary.unknown += 1;
      continue;
    }
    const counts = used as Record<string, unknown>;
    if (LAYER_NAMES.every((name) => counts[name] === "unknown" || counts[name] === undefined)) {
      summary.unknown += 1;
      continue;
    }
    summary.withLog += 1;
    let any = false;
    for (const name of LAYER_NAMES) {
      const count = counts[name];
      if (typeof count === "number" && count > 0) {
        summary.perLayer[name] += 1;
        any = true;
      }
    }
    if (any) summary.usedAny += 1;
  }
  return summary;
}
