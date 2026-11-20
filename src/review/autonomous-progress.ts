// What the runner learns from the child shell's `--events-file` NDJSON.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { isFloorRefusal, isLoopGuardRefusal } from "./autonomous-profile";

import { sameReviewer, sumCounts, usageCounts, UsageRanges, type ReviewRunUsage, type ReviewerUsage, type ReviewUsageCounts } from "./run-usage";

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
  readonly usage?: ReviewRunUsage;
  readonly requests?: ReadonlyMap<string, RequestObservation>;
  readonly rounds: number;
  readonly turnEnded: boolean;
  readonly errorMessage?: string;
  readonly floorRefusals: readonly FloorRefusal[];
  /** Whether the latest tool result was the loop guard refusing a repeated call. */
  readonly endedOnLoopGuard: boolean;
}

export function emptyProgress(): Progress {
  return { toolCalls: 0, openCalls: 0, phase: "starting", tokens: 0, usageSum: 0, rounds: 0, turnEnded: false, floorRefusals: [], endedOnLoopGuard: false };
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

interface RequestObservation {
  source?: "external-runtime";
  partial?: boolean;
  reviewer?: string;
  provider?: string;
  model?: string;
  usage?: ReviewUsageCounts;
}
interface RawEvent {
  type?: string; name?: string; input?: string; output?: string; isError?: boolean; errorMessage?: string;
  requestId?: string; source?: "external-runtime"; partial?: boolean; participant?: string; provider?: string; model?: string; reviewer?: string;
  usage?: ReviewUsageCounts & { exact?: boolean };
}

function reportRequests(requests: ReadonlyMap<string, RequestObservation>): ReviewRunUsage {
  let coordinator: ReviewUsageCounts | undefined;
  let total: ReviewUsageCounts | undefined;
  let partial = false;
  const reviewers: ReviewerUsage[] = [];
  for (const { reviewer, provider, model, source, usage, partial: incomplete } of requests.values()) {
    const counts = usage ?? {};
    const missing = incomplete === true || counts.inputTokens === undefined || counts.outputTokens === undefined;
    if (missing) partial = true;
    total = sumCounts(total, counts);
    if (reviewer === undefined) {
      coordinator = sumCounts(coordinator, counts);
    } else {
      const row = { reviewer, ...(missing ? { partial: true as const } : {}), ...(source ? { source } : {}), ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
      const i = reviewers.findIndex(it => sameReviewer(it, row));
      const prior = reviewers[i];
      if (prior) reviewers[i] = { ...row, ...(prior.partial ? { partial: true } : {}), ...sumCounts(prior, counts) };
      else reviewers.push({ ...row, ...counts });
    }
  }
  return { coordinator: coordinator ?? {}, total: total ?? {}, reviewers, partial };
}

function requestObservation(event: RawEvent): RequestObservation | undefined {
  if (!event.requestId || (event.participant !== "coordinator" && event.participant !== "reviewer")) return undefined;
  return {
    ...(event.source === "external-runtime" ? { source: event.source } : {}),
    ...(event.partial ? { partial: true } : {}),
    ...(event.participant === "reviewer" ? { reviewer: event.reviewer || "subagent" } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.usage ? { usage: usageCounts(event.usage) } : {}),
  };
}

function measuredState(state: Progress, requests: ReadonlyMap<string, RequestObservation>): Progress {
  const usage = reportRequests(requests);
  return { ...state, requests, usage, tokens: usage.total.totalTokens ?? 0 };
}

export function foldEvent(state: Progress, event: RawEvent): Progress {
  if (event.type === "request_start" || event.type === "request_usage") {
    const observation = requestObservation(event);
    if (!observation || (event.type === "request_start" && state.requests?.has(event.requestId!))) return state;
    const requests = new Map(state.requests);
    requests.set(event.requestId!, observation);
    return measuredState(state, requests);
  }
  return foldProgress(state, event, state.requests !== undefined);
}

function foldProgress(state: Progress, event: RawEvent, hasRequests: boolean): Progress {
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
        endedOnLoopGuard: event.isError === true && isLoopGuardRefusal(output),
        floorRefusals: refused ? [...state.floorRefusals, { phase: state.phase, output }] : state.floorRefusals,
      };
    }
    case "usage": {
      // Request receipts already include the coordinator. Legacy shells only emitted these echoes.
      if (hasRequests || !event.usage) return state;
      const coordinator = sumCounts(state.usage?.coordinator, usageCounts(event.usage));
      const usageSum = coordinator.totalTokens ?? 0;
      return { ...state, usageSum, tokens: usageSum, usage: { coordinator, total: coordinator, reviewers: [], partial: true } };
    }
    case "turn_end": {
      let usage = state.usage;
      if (!hasRequests && event.usage) {
        const end = usageCounts(event.usage);
        if (!usage || (end.totalTokens ?? 0) >= (usage.total.totalTokens ?? 0)) {
          const coordinator = { ...usage?.coordinator, ...end };
          usage = { coordinator, total: coordinator, reviewers: [], partial: true };
        }
      }
      return {
        ...state,
        turnEnded: true,
        tokens: usage?.total.totalTokens ?? state.tokens,
        ...(usage ? { usage } : {}),
        ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
      };
    }
    default:
      return state;
  }
}

type ReviewerIdentity = Pick<ReviewerUsage, "reviewer" | "provider" | "model" | "source">;
interface UsageGroup {
  identity?: ReviewerIdentity;
  ranges: UsageRanges;
}

class LiveRequestUsage {
  private readonly total = new UsageRanges();
  private readonly coordinator: UsageGroup = { ranges: new UsageRanges() };
  private readonly reviewers = new Map<string, UsageGroup>();
  private readonly requests = new Map<string, { index: number; group: UsageGroup; key?: string }>();

  get hasRequests(): boolean { return this.requests.size > 0; }

  record(event: RawEvent): boolean {
    const id = event.requestId;
    if (!id) return false;
    const previous = this.requests.get(id);
    if (event.type === "request_start" && previous) return false;
    const observation = requestObservation(event);
    if (!observation) return false;
    const { reviewer, provider, model, source, usage: counts = {} } = observation;
    const index = previous?.index ?? this.requests.size;
    const key = reviewer === undefined ? undefined : JSON.stringify([reviewer, provider, model, source]);
    const group = key === undefined ? this.coordinator : this.reviewers.get(key) ?? {
      identity: { reviewer: reviewer!, ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(source ? { source } : {}) },
      ranges: new UsageRanges(),
    };
    if (previous && previous.group !== group) {
      previous.group.ranges.set(index, undefined);
      if (previous.key !== undefined && !previous.group.ranges.total) this.reviewers.delete(previous.key);
    }
    const range = { first: index, counts, partial: observation.partial === true || counts.inputTokens === undefined || counts.outputTokens === undefined };
    group.ranges.set(index, range);
    if (key !== undefined) this.reviewers.set(key, group);
    this.requests.set(id, { index, group, ...(key === undefined ? {} : { key }) });
    this.total.set(index, range);
    return true;
  }

  report(): ReviewRunUsage {
    const total = this.total.total;
    const reviewers = Array.from(this.reviewers.values(), group => {
      const range = group.ranges.total!;
      const row: ReviewerUsage = { ...group.identity!, ...range.counts, ...(range.partial ? { partial: true } : {}) };
      return { first: range.first, row };
    }).sort((a, b) => a.first - b.first).map(x => x.row);
    return { coordinator: this.coordinator.ranges.total?.counts ?? {}, total: total?.counts ?? {}, partial: total?.partial ?? false, reviewers };
  }
}

export interface EventTail {
  /** Fold everything appended since the last poll and return the state so far. */
  poll(): Omit<Progress, "requests">;
  /** Bytes consumed so far, whole lines or not: growth here is what the stall watchdog watches. */
  bytesSeen(): number;
}

export function createEventTail(file: string, observe?: (event: Record<string, unknown>) => void): EventTail {
  let offset = 0;
  let pending = "";
  const decoder = new StringDecoder("utf8");
  let state = emptyProgress();
  const requests = new LiveRequestUsage();
  return {
    poll() {
      if (!existsSync(file)) return state;
      const size = statSync(file).size;
      if (size <= offset) return state;
      const fd = openSync(file, "r");
      let usageChanged = false;
      try {
        // Recovery can replay a full run, including large tool results. Read in bounded chunks
        // and update only the subtotals affected by each request receipt.
        const buffer = Buffer.alloc(Math.min(size - offset, 64 * 1024));
        while (offset < size) {
          const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
          if (!read) break;
          offset += read;
          const lines = (pending + decoder.write(buffer.subarray(0, read))).split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            try {
              const event = JSON.parse(line) as RawEvent & Record<string, unknown>;
              observe?.(event);
              if (event.type === "request_start" || event.type === "request_usage") {
                if (requests.record(event)) usageChanged = true;
              } else state = foldProgress(state, event, requests.hasRequests);
            } catch {
              // Ignore malformed or unrelated transcript lines.
            }
          }
        }
      } finally {
        closeSync(fd);
      }
      if (usageChanged) {
        const usage = requests.report();
        state = { ...state, usage, tokens: usage.total.totalTokens ?? 0 };
      }
      return state;
    },
    bytesSeen: () => offset,
  };
}
