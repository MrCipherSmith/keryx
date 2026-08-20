// Bridge from `ExternalEvent` to the canonical `AgentEvent` fold (flow 176, T22).
// Package: docs/requirements/keryx-external-agent-runtime, AC5.
//
// AC5's exact text: "Each codec parses its recorded fixtures into the
// canonical event sequence, and `reduceAgents` folds that sequence without
// modification to the fold." That phrasing rules out the other fork this task
// could have taken — widening `reduceAgents`'s switch or `AgentEvent.type`'s
// enum, which would require a schema change to `agent-event.schema.json` — so
// this module is a pure translation, not an extension. `reduceAgents`
// (`../monitor/reduce.ts`) is imported nowhere here and must stay unmodified;
// this file's only job is to produce `AgentEvent`s that the EXISTING fold
// already knows how to consume.
//
// `ExternalEvent` (`./types.ts`) carries no ids and no timestamps — it is a
// single child's transcript, not a multi-dispatch orchestration log — so every
// bridged event borrows its identity from a single `BridgeContext` supplied by
// the caller. That is also why `dispatch_id` is IDENTICAL across every event
// one bridge call produces: this is one child run, not several dispatches
// sharing a stream.
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../monitor/reduce";
import type { ExternalEvent } from "./types";

/** contract_version stamped on every bridged event when the caller does not override it. */
const DEFAULT_CONTRACT_VERSION = "1.0.0";

/** Everything one `bridgeExternalEvent(s)` call needs that `ExternalEvent` itself does not carry. */
export interface BridgeContext {
  /** The AgentEvent.run_id every bridged event carries. */
  readonly runId: string;
  /** The AgentEvent.dispatch_id every bridged event carries — required by reduceAgents to fold at all. */
  readonly dispatchId: string;
  /** contract_version stamped on every bridged event. Defaults to "1.0.0", matching reduce-state.ts's own fallback. */
  readonly contractVersion?: string;
  /** Injected for deterministic tests — defaults to `new Date()`. */
  readonly now?: () => Date;
  /** Injected for deterministic tests — defaults to `randomUUID()`. */
  readonly eventId?: () => string;
}

/**
 * Map one `ExternalEvent` onto the canonical `AgentEvent` shape `reduceAgents`
 * already folds, per this table (specification-equivalent to AC5):
 *
 * | ExternalEvent.kind | AgentEvent.type | data | message |
 * |---|---|---|---|
 * | `child_started` | `dispatch_created` | `{sessionRef}` if present | — |
 * | `child_finished` | `dispatch_completed` | — | `event.text` if present |
 * | `child_failed` | `run_failed` | — | `event.message` |
 * | `usage` | `artifact_written` | `{usage: {inputTokens, outputTokens, exact: true}}` (only present fields) | — |
 * | `tool_call`, `tool_result`, `assistant_text`, `thinking`, `user_message`, `retry` | `artifact_written` | omitted | the event's own text/detail/message |
 *
 * The seven kinds mapped to `artifact_written` — `usage` plus the six
 * transcript-detail kinds — are a DELIBERATE, named compromise, not a gap
 * hidden by a generic bucket: `reduceAgents`'s switch sets status for exactly
 * four types (`dispatch_created`, `dispatch_completed`, `dispatch_blocked`,
 * `validation_failed`/`run_failed`) and falls through everything else to
 * `default: break` — no status change. `artifact_written` is one of those
 * status-neutral types, chosen SPECIFICALLY for `usage` because `reduceAgents`
 * reads `event.data?.usage` from every event unconditionally, outside the
 * switch, so this is the one kind whose payload the existing, unmodified fold
 * actually consumes. The other six carry no information the fold would ever
 * read either way — `reduceAgents` has no concept of tool calls, transcript
 * text, or retries for INTERNAL agents either — so `artifact_written` is
 * reused for them rather than inventing new AgentEvent.type values, which
 * AC5's "without modification to the fold" forbids. Their `message` is kept
 * anyway, purely so a human reading a dumped `agent-event.jsonl` sees
 * something recognisable; `reduceAgents` itself never reads `message`.
 *
 * `timestamp_utc` is `(ctx.now?.() ?? new Date()).toISOString()` — this is a
 * real, documented limitation, not an approximation of something better
 * available: `ExternalEvent` carries no vendor-side timestamp on ANY variant,
 * so `timestamp_utc` is the time the event was OBSERVED by the bridge, never
 * the time it happened on the vendor CLI's side. A caller needing wall-clock
 * fidelity for latency analysis cannot get it from this bridge.
 */
export function bridgeExternalEvent(event: ExternalEvent, ctx: BridgeContext): AgentEvent {
  const base = {
    contract_version: ctx.contractVersion ?? DEFAULT_CONTRACT_VERSION,
    run_id: ctx.runId,
    dispatch_id: ctx.dispatchId,
    event_id: ctx.eventId?.() ?? randomUUID(),
    timestamp_utc: (ctx.now?.() ?? new Date()).toISOString(),
  };

  switch (event.kind) {
    case "child_started":
      return {
        ...base,
        type: "dispatch_created",
        ...(event.sessionRef !== undefined ? { data: { sessionRef: event.sessionRef } } : {}),
      };

    case "child_finished":
      return {
        ...base,
        type: "dispatch_completed",
        ...(event.text !== undefined ? { message: event.text } : {}),
      };

    case "child_failed":
      return { ...base, type: "run_failed", message: event.message };

    case "usage": {
      const usage: Record<string, unknown> = { exact: true };
      if (event.inputTokens !== undefined) usage.inputTokens = event.inputTokens;
      if (event.outputTokens !== undefined) usage.outputTokens = event.outputTokens;
      return { ...base, type: "artifact_written", data: { usage } };
    }

    case "tool_call":
      // `detail` is the richer field when present (e.g. codex's command line);
      // `name` is the only field guaranteed to exist, so it is the fallback.
      return { ...base, type: "artifact_written", message: event.detail ?? event.name };

    case "tool_result":
      return { ...base, type: "artifact_written", ...(event.detail !== undefined ? { message: event.detail } : {}) };

    case "assistant_text":
    case "thinking":
    case "user_message":
      return { ...base, type: "artifact_written", message: event.text };

    case "retry":
      return { ...base, type: "artifact_written", message: event.message };
  }
}

/** Bridge a whole transcript in order. `bridgeExternalEvent` applied per element. */
export function bridgeExternalEvents(events: readonly ExternalEvent[], ctx: BridgeContext): AgentEvent[] {
  return events.map((event) => bridgeExternalEvent(event, ctx));
}
