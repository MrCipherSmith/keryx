// Mechanism + volume instrumentation for the long-session tasks (flow 387 T22a).
//
// A long run is only evidence for AC11 if the mechanisms actually fired, and only evidence
// of "no quality loss" if the agent really read the volume the task is built around. This
// module therefore records, per run:
//   - mechanisms: how many prune / compaction events the agent reported through the
//     `onContextCompaction` hook (kind "prune" vs everything else), and what the FINAL
//     history looks like (cleared tool results, collapsed records, spilled outputs,
//     assistant messages still carrying a reasoning replay);
//   - volume: tool calls by kind, distinct task files read, and the tool-output size.
// Pure, no I/O: the runners feed it the callbacks the agent already exposes. The marker
// strings are copied from src/session/prune.ts and src/harness/tool/output-spill.ts on
// purpose, so this script also runs against a checkout where those modules do not exist
// (the `main` baseline) and simply reports zero there.

import path from "node:path";
import type { NormalizedMessage } from "../../src/harness/provider/types";

/** Start of every cleared-result placeholder (src/session/prune.ts CLEARED_PREFIX). */
export const CLEARED_PREFIX = "[Old tool result cleared";
/** Start of a collapsed record (src/session/prune.ts COLLAPSED_HEADER). */
export const COLLAPSED_PREFIX = "[Earlier tool calls, collapsed";
/** The spill marker (src/harness/tool/output-spill.ts renderSpillPreview). */
const SPILL_MARKER = /full output saved to .+? — read it with read_file/;

/** The AgentDeps hook the prune event is reported through (kind: "prune"). */
export const PRUNE_HOOK_NAME = "onContextCompaction";

/** Fewer tool-output tokens than this and the prune window (newest 40K, batch >= 20K) cannot have been exceeded by much. */
export const MIN_VOLUME_TOKENS = 60_000;

export type MechanismCounts = {
  /** The context window the agent was given (compaction trips at 85% of it); null when none. */
  readonly contextWindow: number | null;
  readonly pruneHook: typeof PRUNE_HOOK_NAME;
  /** `onContextCompaction` calls with kind "prune" (one per prune batch that collapsed old exchanges). */
  readonly pruneEvents: number;
  /** `onContextCompaction` calls that were not a prune: real compactions. */
  readonly compactionEvents: number;
  /** In the final history: collapsed records (old tool exchanges folded into one text record). */
  readonly collapsedRecords: number;
  /** In the final history: tool results replaced by a placeholder. */
  readonly clearedResults: number;
  /** Tool results whose output went over the spill threshold and was saved to a file. */
  readonly spilledOutputs: number;
  /** Assistant messages in the final history. */
  readonly assistantMessages: number;
  /** Assistant messages in the final history that still carry an opaque reasoning replay (<= 3 when trimming works and the provider emits replays). */
  readonly replayCarryingAssistants: number;
  readonly fired: {
    readonly prune: boolean;
    readonly collapse: boolean;
    readonly compaction: boolean;
    readonly spill: boolean;
  };
};

export class MechanismTracker {
  private prunes = 0;
  private compactions = 0;
  private spills = 0;

  /** Wire to `deps.onContextCompaction`. `kind` is undefined on a checkout that predates the prune event. */
  onContextCompaction(r: { readonly kind?: string }): void {
    if (r.kind === "prune") this.prunes += 1;
    else this.compactions += 1;
  }

  /** Wire to `io.onToolResult`. */
  onToolResult(output: string): void {
    if (SPILL_MARKER.test(output)) this.spills += 1;
  }

  /** Call once, after the turn, with the (mutated in place) history the turn ran on. */
  finish(history: readonly NormalizedMessage[], contextWindow: number | null): MechanismCounts {
    let cleared = 0;
    let collapsed = 0;
    let assistants = 0;
    let replay = 0;
    for (const m of history) {
      if (m.role === "tool" && m.content.startsWith(CLEARED_PREFIX)) cleared += 1;
      if (m.role === "assistant") {
        assistants += 1;
        if (m.content.includes(COLLAPSED_PREFIX)) collapsed += 1;
        if ((m.reasoning?.replay?.length ?? 0) > 0) replay += 1;
      }
    }
    return {
      contextWindow,
      pruneHook: PRUNE_HOOK_NAME,
      pruneEvents: this.prunes,
      compactionEvents: this.compactions,
      collapsedRecords: collapsed,
      clearedResults: cleared,
      spilledOutputs: this.spills,
      assistantMessages: assistants,
      replayCarryingAssistants: replay,
      fired: {
        prune: this.prunes > 0 || cleared > 0 || collapsed > 0,
        collapse: collapsed > 0 || this.prunes > 0,
        compaction: this.compactions > 0,
        spill: this.spills > 0,
      },
    };
  }
}

export type VolumeMetrics = {
  readonly toolCalls: number;
  readonly readFileCalls: number;
  /** Distinct files under the task's path prefix that were opened with read_file. */
  readonly distinctPathsRead: number;
  readonly searchCalls: number;
  readonly shellCalls: number;
  readonly toolOutputChars: number;
  /** chars / 4, the same estimate src/session/prune.ts uses. */
  readonly estToolOutputTokens: number;
  /**
   * The run really consumed the volume the task is built around: it read at least 80% of the
   * task's files and the tool output reached {@link MIN_VOLUME_TOKENS}. A run that
   * bypassed the reads (a search or a shell filter over the corpus) is reported `false`, and its
   * quality number must not be read as evidence about the mechanisms.
   */
  readonly volumeOk: boolean;
};

function normalizePath(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");
}

export class VolumeTracker {
  private toolCalls = 0;
  private readCalls = 0;
  private searchCalls = 0;
  private shellCalls = 0;
  private chars = 0;
  private readonly distinct = new Set<string>();

  constructor(
    private readonly pathPrefix: string,
    private readonly expectedDistinctReads: number,
    private readonly minTokens: number = MIN_VOLUME_TOKENS,
  ) {}

  onToolCall(name: string, input: string): void {
    this.toolCalls += 1;
    if (name === "read_file") {
      this.readCalls += 1;
      try {
        const parsed = JSON.parse(input) as { path?: unknown };
        if (typeof parsed.path === "string") {
          const p = normalizePath(parsed.path);
          if (p.startsWith(this.pathPrefix)) this.distinct.add(p);
        }
      } catch {
        // unparseable arguments: counted as a read, not as a distinct path
      }
    } else if (name === "search_code") {
      this.searchCalls += 1;
    } else if (name === "shell_exec") {
      this.shellCalls += 1;
    }
  }

  onToolResult(output: string): void {
    this.chars += output.length;
  }

  result(): VolumeMetrics {
    const estTokens = Math.ceil(this.chars / 4);
    return {
      toolCalls: this.toolCalls,
      readFileCalls: this.readCalls,
      distinctPathsRead: this.distinct.size,
      searchCalls: this.searchCalls,
      shellCalls: this.shellCalls,
      toolOutputChars: this.chars,
      estToolOutputTokens: estTokens,
      volumeOk: this.distinct.size >= Math.ceil(this.expectedDistinctReads * 0.8) && estTokens >= this.minTokens,
    };
  }
}

/**
 * Volume for a codex `exec --json` run. codex has no read_file: it reads with shell commands, so
 * the distinct-path figure is the number of distinct `<prefix>...` paths named in command texts,
 * a heuristic (a command that reads a whole directory names no path), recorded as such.
 */
export function codexVolume(
  events: readonly { type: string; [key: string]: unknown }[],
  pathPrefix: string,
  expectedDistinctReads: number,
  minTokens: number = MIN_VOLUME_TOKENS,
): VolumeMetrics {
  let commands = 0;
  let chars = 0;
  let shell = 0;
  let search = 0;
  const distinct = new Set<string>();
  const re = new RegExp(`${pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Za-z0-9_./-]+`, "g");
  for (const event of events) {
    if (event.type !== "item.completed") continue;
    const item = event.item as { type?: string; command?: unknown; aggregated_output?: unknown } | undefined;
    if (item?.type !== "command_execution") continue;
    commands += 1;
    shell += 1;
    const command = typeof item.command === "string" ? item.command : "";
    if (/\b(rg|grep|ag|ack)\b/.test(command)) search += 1;
    if (typeof item.aggregated_output === "string") chars += item.aggregated_output.length;
    for (const m of command.matchAll(re)) distinct.add(normalizePath(m[0]));
  }
  const estTokens = Math.ceil(chars / 4);
  return {
    toolCalls: commands,
    readFileCalls: 0,
    distinctPathsRead: distinct.size,
    searchCalls: search,
    shellCalls: shell,
    toolOutputChars: chars,
    estToolOutputTokens: estTokens,
    volumeOk: distinct.size >= Math.ceil(expectedDistinctReads * 0.8) && estTokens >= minTokens,
  };
}
