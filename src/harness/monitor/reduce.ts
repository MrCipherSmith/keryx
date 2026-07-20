// Deterministic subagent monitoring fold (flow 092, multi-agent engine Phase 4).
//
// Two-layer monitoring (spec §Data Contracts.4): this module is the PURE
// accounting layer. `reduceAgents` folds a canonical `agent-event` stream
// (`.metaproject/core/gdskills/contracts/agent-event.schema.json`) into a
// per-dispatch snapshot; `diffAgents` derives ordered delta events between two
// snapshots. Neither reads a clock/RNG, the network, or the filesystem — all I/O
// and any arrival-ordered rendering live in the CLI/display layer (`keryx agents
// monitor`). Identical inputs yield deep-equal, stable-ordered output, so a
// snapshot is replayable and hashable.

/** A canonical agent-event (mirrors agent-event.schema.json). */
export interface AgentEvent {
  contract_version: string;
  run_id: string;
  event_id: string;
  dispatch_id?: string | null;
  type:
    | "run_started"
    | "run_completed"
    | "run_failed"
    | "dispatch_created"
    | "dispatch_completed"
    | "dispatch_blocked"
    | "artifact_written"
    | "question_asked"
    | "decision_recorded"
    | "validation_failed";
  message?: string;
  data?: Record<string, unknown>;
  timestamp_utc: string;
}

/** The folded status of a single subagent dispatch. */
export type AgentStatus = "running" | "done" | "blocked" | "failed" | "unknown";

/** Token usage for a dispatch. `exact` is false once ANY inexact usage was seen. */
export interface AgentUsage {
  /** Sum of provider-reported EXACT input tokens only. */
  inputTokens: number;
  /** Sum of provider-reported EXACT output tokens only. */
  outputTokens: number;
  /** True only when every folded usage sample was provider-reported exact. */
  exact: boolean;
}

/** The folded record for one subagent dispatch. */
export interface AgentRecord {
  dispatchId: string;
  status: AgentStatus;
  model?: string;
  source?: string;
  /** Remaining runtime budget (ms) if an event reported it. */
  budgetRemaining?: number;
  usage: AgentUsage;
}

/** The full accounting snapshot: the run id plus per-dispatch records (sorted). */
export interface AgentsSnapshot {
  runId: string | null;
  agents: AgentRecord[];
}

/** Terminal statuses that a later non-terminal event must not downgrade. */
const TERMINAL: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["done", "blocked", "failed"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Extract a `provider/model`-style label from an event's `data`, if present. */
function modelFrom(data: Record<string, unknown> | undefined): string | undefined {
  if (data === undefined) return undefined;
  const model = str(data.model);
  const provider = str(data.provider);
  if (provider !== undefined && model !== undefined) return `${provider}/${model}`;
  return model ?? provider;
}

/**
 * Fold a canonical agent-event array into an {@link AgentsSnapshot}. Events are
 * folded in array order (the caller supplies chronological order). Status maps:
 * `dispatch_created`→running, `dispatch_completed`→done, `dispatch_blocked`→
 * blocked, `validation_failed`/`run_failed` (with a dispatch_id)→failed; a
 * terminal status is never downgraded. `model`/`source`/`budgetRemaining` are
 * taken from event `data` (e.g. `dispatch_created` / `decision_recorded`). Usage
 * sums ONLY `data.usage` samples with `exact:true`; any inexact sample flips the
 * record's `usage.exact` to false and its tokens are NOT summed. Pure and
 * deterministic; records are returned sorted by `dispatchId`.
 */
export function reduceAgents(events: readonly AgentEvent[]): AgentsSnapshot {
  const byDispatch = new Map<string, AgentRecord>();
  let runId: string | null = null;

  const ensure = (dispatchId: string): AgentRecord => {
    let rec = byDispatch.get(dispatchId);
    if (rec === undefined) {
      rec = { dispatchId, status: "unknown", usage: { inputTokens: 0, outputTokens: 0, exact: true } };
      byDispatch.set(dispatchId, rec);
    }
    return rec;
  };

  const setStatus = (rec: AgentRecord, next: AgentStatus): void => {
    if (TERMINAL.has(rec.status)) return; // never downgrade a terminal status
    rec.status = next;
  };

  for (const event of events) {
    if (runId === null) runId = event.run_id;

    const dispatchId = event.dispatch_id ?? undefined;
    if (dispatchId === undefined) continue; // run-level events carry no per-agent record

    const rec = ensure(dispatchId);

    switch (event.type) {
      case "dispatch_created":
        setStatus(rec, "running");
        break;
      case "dispatch_completed":
        setStatus(rec, "done");
        break;
      case "dispatch_blocked":
        setStatus(rec, "blocked");
        break;
      case "validation_failed":
      case "run_failed":
        setStatus(rec, "failed");
        break;
      default:
        break;
    }

    // Model / source / budget from any event that carries them.
    const model = modelFrom(event.data);
    if (model !== undefined) rec.model = model;
    const source = str(event.data?.source);
    if (source !== undefined) rec.source = source;
    const budgetRemaining = num((event.data?.budgetRemaining as unknown) ?? undefined);
    if (budgetRemaining !== undefined) rec.budgetRemaining = budgetRemaining;

    // Usage: sum exact-only; mark the record inexact on any non-exact sample.
    const usage = event.data?.usage as { inputTokens?: unknown; outputTokens?: unknown; exact?: unknown } | undefined;
    if (usage !== undefined) {
      if (usage.exact === true) {
        rec.usage.inputTokens += num(usage.inputTokens) ?? 0;
        rec.usage.outputTokens += num(usage.outputTokens) ?? 0;
      } else {
        rec.usage.exact = false;
      }
    }
  }

  const agents = [...byDispatch.values()].sort((a, b) =>
    a.dispatchId < b.dispatchId ? -1 : a.dispatchId > b.dispatchId ? 1 : 0,
  );
  return { runId, agents };
}

/** A single monitoring delta between two snapshots. */
export interface AgentDelta {
  dispatchId: string;
  kind: "spawned" | "running" | "idle" | "done" | "failed" | "blocked";
}

/**
 * Derive ordered delta events between two snapshots: a dispatch present only in
 * `next` is `spawned`; one present only in `prev` is `idle` (stopped reporting);
 * one present in both whose status changed emits its new status
 * (running/done/failed/blocked). Deterministic; deltas are sorted by
 * `dispatchId`. Pure.
 */
export function diffAgents(prev: AgentsSnapshot, next: AgentsSnapshot): AgentDelta[] {
  const prevById = new Map(prev.agents.map((a) => [a.dispatchId, a]));
  const nextById = new Map(next.agents.map((a) => [a.dispatchId, a]));
  const deltas: AgentDelta[] = [];

  for (const rec of next.agents) {
    const before = prevById.get(rec.dispatchId);
    if (before === undefined) {
      deltas.push({ dispatchId: rec.dispatchId, kind: "spawned" });
    } else if (before.status !== rec.status && rec.status !== "unknown") {
      deltas.push({ dispatchId: rec.dispatchId, kind: rec.status });
    }
  }
  for (const rec of prev.agents) {
    if (!nextById.has(rec.dispatchId)) {
      deltas.push({ dispatchId: rec.dispatchId, kind: "idle" });
    }
  }

  return deltas.sort((a, b) => (a.dispatchId < b.dispatchId ? -1 : a.dispatchId > b.dispatchId ? 1 : 0));
}
