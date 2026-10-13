// Which project layers a reviewer actually consulted, counted from the log of its tool calls.
// A reviewer with no log is `unknown`, never zero: zero would claim "looked and used nothing".

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const LAYER_NAMES = ["graph", "wiki", "memory", "ctx"] as const;
export type LayerName = (typeof LAYER_NAMES)[number];
export type LayerCount = number | "unknown";
export type LayersUsed = Record<LayerName, LayerCount>;

export const UNKNOWN_LAYERS_USED: Readonly<LayersUsed> = { graph: "unknown", wiki: "unknown", memory: "unknown", ctx: "unknown" };

const LAYER_PATTERNS: ReadonlyArray<readonly [LayerName, RegExp]> = [
  ["graph", /\bkeryx\s+(gdgraph|graph)\b|(?<![a-z0-9])(gdgraph|graph)_(affected|cycles|find|orphans|path|query|symbol)\b/],
  ["wiki", /\bkeryx\s+wiki\b|(?<![a-z0-9])(wiki_(ask|backlinks|evidence|freshness|query|resolve)|read_wiki)\b/],
  ["memory", /\bkeryx\s+memory\b|(?<![a-z0-9])memory_(search|handoff|propose)\b/],
  ["ctx", /\bkeryx\s+ctx\b|(?<![a-z0-9])search_code\b/],
];

/** The layer one tool call consulted, or undefined for a call that touches none of the four. */
export function classifyToolCall(call: string): LayerName | undefined {
  return LAYER_PATTERNS.find(([, pattern]) => pattern.test(call))?.[0];
}

function callText(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (parsed === null || typeof parsed !== "object") return line;
  const entry = parsed as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["name", "tool", "command", "cmd", "arguments", "input"]) {
    const value = entry[key];
    if (typeof value === "string") parts.push(value);
    else if (value !== undefined && value !== null) parts.push(JSON.stringify(value));
  }
  return parts.join(" ");
}

/** Counts per layer for one log: JSON lines (`name`, `command`, `arguments`, `input`) or one plain command per line. */
export function countLayerUsage(log: string): Record<LayerName, number> {
  const counts: Record<LayerName, number> = { graph: 0, wiki: 0, memory: 0, ctx: 0 };
  for (const line of log.split("\n")) {
    if (line.trim() === "") continue;
    const layer = classifyToolCall(callText(line));
    if (layer !== undefined) counts[layer] += 1;
  }
  return counts;
}

/** `undefined` (no log) and a log with no line at all (a driver that failed before writing) are unknown; a log with calls but none into a layer is a real zero. */
export function layersUsedFrom(log: string | undefined): LayersUsed {
  return log === undefined || log.trim() === "" ? { ...UNKNOWN_LAYERS_USED } : countLayerUsage(log);
}

export const TOOL_LOG_DIR = "tool-calls";

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
    if (!(await stat(real)).isFile()) return undefined;
    return await readFile(real, "utf8");
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
