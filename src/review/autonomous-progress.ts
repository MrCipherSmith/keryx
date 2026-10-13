// What the runner learns from the child shell's `--events-file` NDJSON.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { isFloorRefusal } from "./autonomous-profile";

export interface FloorRefusal {
  readonly phase: string;
  readonly output: string;
}

export interface Progress {
  readonly toolCalls: number;
  readonly openCalls: number;
  readonly phase: string;
  readonly tokens: number;
  readonly usageSum: number;
  readonly rounds: number;
  readonly turnEnded: boolean;
  readonly errorMessage?: string;
  readonly floorRefusals: readonly FloorRefusal[];
}

export function emptyProgress(): Progress {
  return { toolCalls: 0, openCalls: 0, phase: "starting", tokens: 0, usageSum: 0, rounds: 0, turnEnded: false, floorRefusals: [] };
}

const REVIEW_SUBCOMMAND = /\bkeryx\s+review\s+([a-z][a-z-]*)/;

export function phaseOf(tool: string, rawInput: string): string {
  try {
    const command = (JSON.parse(rawInput) as { command?: unknown } | null)?.command;
    if (typeof command === "string") {
      const match = REVIEW_SUBCOMMAND.exec(command);
      if (match !== null) return `review ${match[1]}`;
    }
  } catch {
    // not JSON: the tool name stands
  }
  return tool;
}

type RawEvent = { type?: string; name?: string; input?: string; output?: string; isError?: boolean; usage?: Usage; errorMessage?: string };
type Usage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };

function usageTotal(usage: Usage | undefined): number {
  if (usage === undefined) return 0;
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

export function foldEvent(state: Progress, event: RawEvent): Progress {
  switch (event.type) {
    case "tool_call": {
      const phase = phaseOf(event.name ?? "tool", event.input ?? "");
      return {
        ...state,
        toolCalls: state.toolCalls + 1,
        openCalls: state.openCalls + 1,
        phase,
        rounds: phase === "review ingest" ? state.rounds + 1 : state.rounds,
      };
    }
    case "tool_result": {
      const output = event.output ?? "";
      const refused = event.isError === true && isFloorRefusal(output);
      return {
        ...state,
        openCalls: Math.max(0, state.openCalls - 1),
        floorRefusals: refused ? [...state.floorRefusals, { phase: state.phase, output }] : state.floorRefusals,
      };
    }
    case "usage": {
      const usageSum = state.usageSum + usageTotal(event.usage);
      return { ...state, usageSum, tokens: Math.max(state.tokens, usageSum) };
    }
    case "turn_end":
      return {
        ...state,
        turnEnded: true,
        tokens: Math.max(state.tokens, usageTotal(event.usage)),
        ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
      };
    default:
      return state;
  }
}

export interface EventTail {
  /** Fold everything appended since the last poll and return the state so far. */
  poll(): Progress;
  /** Bytes consumed so far, whole lines or not: growth here is what the stall watchdog watches. */
  bytesSeen(): number;
}

export function createEventTail(file: string): EventTail {
  let offset = 0;
  let pending = "";
  let state = emptyProgress();
  return {
    poll() {
      if (!existsSync(file)) return state;
      const size = statSync(file).size;
      if (size <= offset) return state;
      const fd = openSync(file, "r");
      try {
        const buffer = Buffer.alloc(size - offset);
        const read = readSync(fd, buffer, 0, buffer.length, offset);
        offset += read;
        pending += buffer.subarray(0, read).toString("utf8");
      } finally {
        closeSync(fd);
      }
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          state = foldEvent(state, JSON.parse(line) as RawEvent);
        } catch {
          // not an event
        }
      }
      return state;
    },
    bytesSeen: () => offset,
  };
}
