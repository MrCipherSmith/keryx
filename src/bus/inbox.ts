// The per-session bus inbox (specification §4.2, §5.3; flow 274 T5).
//
// `BusClient.onEvent` (`./client.ts`) fires for every event addressed to this
// instance as it is polled off the shared log. A shell wires that callback to
// `createBusInbox().push`, and `runAgentTurn` (`../commands/agent.ts`) drains
// it at the same three points it already drains the task-completion inbox:
// turn start (`origin: "bus-message"`), the round boundary, and the
// text-only-finish site. `drainUndelivered` hands back the pending events and
// clears them — each one reaches agent history exactly once, whichever of the
// three sites gets there first.
//
// Pure in-memory queue: no clock, no I/O, no network. Bounded so a burst of
// peer traffic while the agent is busy elsewhere cannot grow this without
// limit; the oldest pending events are dropped first, and the drop count is
// exposed so a caller/test can tell it happened.

import type { RenderedBusEvent } from "./client";

/**
 * The shape `createBusInbox().push` accepts: a rendered bus event, with the
 * full body REQUIRED (`RenderedBusEvent.body` is optional only so pre-flow-274
 * fixtures elsewhere keep compiling; the real delivery path — `BusClient`'s
 * `doPoll`, `../commands/agent.ts`'s only caller — always sets it) and the
 * addressing flag left optional (absent reads as "addressed by name", the
 * common case in tests).
 */
export type BusInboxEvent = RenderedBusEvent & { toStar?: boolean; body: string; replyTo?: string };

/** Kinds that justify waking an idle agent (specification §4.2); a `notice` only counts when addressed by name, never a broadcast. */
function isWakeEligible(event: BusInboxEvent): boolean {
  switch (event.kind) {
    case "question":
    case "reply":
    case "handoff":
      return true;
    case "notice":
      return event.toStar !== true;
    default:
      return false;
  }
}

/** Pending events dropped before delivery once the bound is exceeded (oldest first). */
export const MAX_PENDING_BUS_EVENTS = 200;

export interface BusInbox {
  /** Enqueue one delivered event. Never throws. */
  push(event: BusInboxEvent): void;
  /** Return every pending event (oldest first) and mark them delivered. Each event is returned by exactly one `drainUndelivered` call. */
  drainUndelivered(): BusInboxEvent[];
  /** True when at least one pending event would justify waking an idle agent. */
  hasWakeEligible(): boolean;
  /** Events currently pending (not yet drained). */
  readonly size: number;
  /** Total pending events dropped so far because the queue exceeded {@link MAX_PENDING_BUS_EVENTS}. */
  readonly droppedCount: number;
}

/** A fresh, empty bus inbox. One per joined session. */
export function createBusInbox(): BusInbox {
  let pending: BusInboxEvent[] = [];
  let droppedCount = 0;

  return {
    push(event) {
      pending.push(event);
      if (pending.length > MAX_PENDING_BUS_EVENTS) {
        pending.shift();
        droppedCount += 1;
      }
    },
    drainUndelivered() {
      if (pending.length === 0) return [];
      const drained = pending;
      pending = [];
      return drained;
    },
    hasWakeEligible() {
      return pending.some(isWakeEligible);
    },
    get size() {
      return pending.length;
    },
    get droppedCount() {
      return droppedCount;
    },
  };
}
