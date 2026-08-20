// Per-addressee operator message queues and delivery intents (flow 176, T16).
// Package: docs/requirements/keryx-external-agent-runtime §7.5; D-09.
//
// The busy-input router already queues what the operator types while the main
// agent works. An external child is a SECOND addressee for the same behaviour:
// the operator wants to say something to the codex run in the sidebar without
// interrupting the main agent, and `remove`/`edit`/`force` must mean there
// exactly what they already mean here. So this module keeps `main-queue.ts`'s
// three pure moves as the implementation (they were widened, not copied) and
// adds only the addressee dimension plus the thing an external child needs that
// the main agent does not: a DELIVERY ROUTE.
//
// Two rules here are the whole reason the module exists, and both are easy to
// get wrong in a way that looks fine until it is live:
//
//   1. `force` ON AN EXTERNAL CHILD IS KILL PLUS RESUME, NOT AN ABORT. The main
//      agent has an abort controller; a subprocess does not. The only way to
//      make a running vendor CLI take a message immediately is to terminate it
//      and restart it with `buildResumeArgv(sessionRef, message, input)`, which
//      retains prior context — so intervention costs a process restart rather
//      than the accumulated work (§7.5).
//   2. RESUME IS NOT ALWAYS AVAILABLE, AND PRETENDING OTHERWISE LOSES THE
//      MESSAGE. keryx ASSIGNS claude's session id, so its handle exists before
//      the child says anything; codex's handle is the `thread_id` it announces
//      on `thread.started`, so a codex run killed before that event CANNOT be
//      resumed at all and `force` degrades to a plain kill. That degradation is
//      a named intent (`kill-only`) rather than a silent failure, because an
//      operator who believes a message was delivered stops watching for it.
//
// Everything is pure: intents are DESCRIBED here and EXECUTED by the caller,
// which owns the `ExternalRunHandle` (kill/writeStdin) and the codec (argv,
// stdin encoding). That split is what lets every branch be tested with no
// subprocess and no TTY.
import type { ExternalEvent } from "../harness/external/types";
import {
  editMainQueueItem,
  reinsertMainQueueItem,
  removeMainQueueItem,
  type QueuedMainQuestion,
} from "./main-queue";

/** The addressee id of the main agent's own queue — the flow 167 behaviour, unchanged. */
export const MAIN_ADDRESSEE = "main";

/** Addressee key. `MAIN_ADDRESSEE` for the main agent; any stable run id for a child. */
export type AddresseeId = string;

/**
 * Every queue, keyed by addressee.
 *
 * A `Map` rather than a record so a run id with a `:` or a `/` in it (they all
 * have) needs no escaping, and empty queues are DROPPED rather than kept as
 * empty arrays — otherwise a finished child's dead addressee lingers in every
 * listing for the rest of the session.
 */
export type AddresseeQueues = ReadonlyMap<AddresseeId, readonly QueuedMainQuestion[]>;

/** An empty queue set. */
export function emptyAddresseeQueues(): AddresseeQueues {
  return new Map();
}

/** The queue for one addressee; an empty array when that addressee has none. */
export function queueFor(queues: AddresseeQueues, addressee: AddresseeId): readonly QueuedMainQuestion[] {
  return queues.get(addressee) ?? [];
}

/** Addressees that currently hold at least one queued message, in insertion order. */
export function addresseesWithQueue(queues: AddresseeQueues): AddresseeId[] {
  return [...queues.keys()];
}

/** Total queued messages across every addressee. */
export function totalQueued(queues: AddresseeQueues): number {
  let total = 0;
  for (const items of queues.values()) total += items.length;
  return total;
}

/** Append one message to an addressee's queue. Non-destructive. */
export function enqueueForAddressee<T extends QueuedMainQuestion>(
  queues: AddresseeQueues,
  addressee: AddresseeId,
  item: T,
): AddresseeQueues {
  return withQueue(queues, addressee, [...queueFor(queues, addressee), item]);
}

/**
 * `remove` for one addressee. Same semantics as the main queue: out of range is
 * a no-op copy, never a throw, so a stale `qN` from a reflowed queue cannot
 * crash the shell.
 */
export function removeFromAddresseeQueue(
  queues: AddresseeQueues,
  addressee: AddresseeId,
  index: number,
): { queues: AddresseeQueues; removed?: QueuedMainQuestion } {
  const items = queueFor(queues, addressee);
  const removed = index >= 0 && index < items.length ? items[index] : undefined;
  const next = removeMainQueueItem(items, index);
  return removed === undefined
    ? { queues: withQueue(queues, addressee, next) }
    : { queues: withQueue(queues, addressee, next), removed };
}

/**
 * `edit` for one addressee: pull the item out so its text can go back into the
 * composer, and hand the caller the item itself so
 * {@link reinsertIntoAddresseeQueue} can put it back AT THE SAME POSITION.
 */
export function editInAddresseeQueue(
  queues: AddresseeQueues,
  addressee: AddresseeId,
  index: number,
): { text: string; queues: AddresseeQueues; removed: QueuedMainQuestion } | undefined {
  const edited = editMainQueueItem(queueFor(queues, addressee), index);
  if (edited === undefined) return undefined;
  return { text: edited.text, queues: withQueue(queues, addressee, edited.rest), removed: edited.removed };
}

/** Put an edited item back at its original position (clamped, never throws). */
export function reinsertIntoAddresseeQueue<T extends QueuedMainQuestion>(
  queues: AddresseeQueues,
  addressee: AddresseeId,
  at: number,
  item: T,
): AddresseeQueues {
  return withQueue(queues, addressee, reinsertMainQueueItem(queueFor(queues, addressee), at, item));
}

/** Drop an addressee's whole queue — the child ended, or the session was reset. */
export function clearAddresseeQueue(queues: AddresseeQueues, addressee: AddresseeId): AddresseeQueues {
  if (!queues.has(addressee)) return queues;
  const next = new Map(queues);
  next.delete(addressee);
  return next;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * What the delivery route depends on. Registry DATA plus one spawn-time fact.
 *
 * `launchedStreaming` is separate from `streamingInput` on purpose: a
 * `streamingInput: true` agent launched one-shot has no stdin route at all, so
 * its messages fall back to resume. That is why steerability is a spawn-time
 * decision and not a runtime one (§7.5), and why an intent computed from the
 * registry alone would be wrong for exactly the agent that supports streaming.
 */
export interface ExternalAddresseeState {
  readonly agentId: string;
  /** Registry: does this CLI accept operator messages mid-run at all? */
  readonly streamingInput: boolean;
  /** Was this run actually spawned in streaming mode (stdin piped)? */
  readonly launchedStreaming: boolean;
  /** Registry: can a killed session be resumed by handle? */
  readonly resumable: boolean;
  /** The resume handle, if known: assigned (claude) or announced (codex `thread_id`). */
  readonly sessionRef?: string;
  /** Is the child still alive? A finished run cannot take stdin and cannot be killed. */
  readonly running: boolean;
}

/**
 * What the caller must DO to deliver one operator message.
 *
 * Each variant names a real, distinguishable outcome. `hold` and `undeliverable`
 * exist so "not yet" and "never" do not collapse into one silent nothing.
 */
export type ExternalDeliveryIntent =
  /** Write the message to the live child's stdin (encode with the agent's codec). */
  | { readonly kind: "stdin"; readonly message: string }
  /**
   * Deliver by resuming the session. `when: "after-exit"` means the run is still
   * going and the message waits for it; `"now"` means the run already ended.
   */
  | {
      readonly kind: "resume";
      readonly when: "now" | "after-exit";
      readonly sessionRef: string;
      readonly message: string;
    }
  /** `force`: terminate the child, then resume with the message. Costs a restart, not the work. */
  | { readonly kind: "kill-then-resume"; readonly sessionRef: string; readonly message: string }
  /** `force` with no resume route: the child is killed and the message is LOST. Say so. */
  | { readonly kind: "kill-only"; readonly message: string; readonly reason: string }
  /** Deliverable later, once the child announces its handle. Keep it queued. */
  | { readonly kind: "hold"; readonly message: string; readonly reason: string }
  /** No route exists and none will appear. */
  | { readonly kind: "undeliverable"; readonly message: string; readonly reason: string };

/** One operator message aimed at one external child. */
export interface PlanExternalDeliveryInput {
  readonly state: ExternalAddresseeState;
  readonly message: string;
  /** The operator used `/queue force`: interrupt now rather than wait your turn. */
  readonly force?: boolean;
}

/**
 * Choose the delivery route for one operator message. Pure and total.
 *
 * The order below is the §7.5 table, plus the honesty rules from the file
 * header. Note that `force` does NOT prefer the stdin route even where one
 * exists: writing to stdin queues the message behind the turn already in
 * flight, which is precisely what the operator asked not to happen. Killing and
 * resuming is the only interruption a subprocess actually has.
 */
export function planExternalDelivery(input: PlanExternalDeliveryInput): ExternalDeliveryIntent {
  const { state, message } = input;
  const force = input.force === true;
  const sessionRef = state.sessionRef;

  if (force && state.running) {
    if (!state.resumable) {
      return {
        kind: "kill-only",
        message,
        reason: `${state.agentId} cannot resume a killed session, so force terminates the run and the message is not delivered`,
      };
    }
    if (sessionRef === undefined) {
      // The codex case §7.5 calls out by name: killed before `thread.started`,
      // so there is no handle and no resume. Reported, never pretended.
      return {
        kind: "kill-only",
        message,
        reason: `${state.agentId} has not announced a session handle yet, so this run cannot be resumed and the message is not delivered`,
      };
    }
    return { kind: "kill-then-resume", sessionRef, message };
  }

  if (state.streamingInput && state.launchedStreaming && state.running) {
    return { kind: "stdin", message };
  }

  if (!state.resumable) {
    return {
      kind: "undeliverable",
      message,
      reason: `${state.agentId} accepts neither streaming input nor resume, so operator messages cannot reach this run`,
    };
  }

  if (sessionRef === undefined) {
    return state.running
      ? {
          kind: "hold",
          message,
          reason: `${state.agentId} has not announced a session handle yet; the message stays queued`,
        }
      : {
          kind: "undeliverable",
          message,
          reason: `${state.agentId} ended without announcing a session handle, so the session cannot be resumed`,
        };
  }

  return { kind: "resume", when: state.running ? "after-exit" : "now", sessionRef, message };
}

/**
 * Whether this intent puts the message in front of the agent immediately.
 *
 * The `user_message` event (D-09) is emitted on DELIVERY, not on queueing —
 * emitting it for a held message would tell the parent's folded view that the
 * operator said something the child never received.
 */
export function intentDeliversNow(intent: ExternalDeliveryIntent): boolean {
  return (
    intent.kind === "stdin" ||
    intent.kind === "kill-then-resume" ||
    (intent.kind === "resume" && intent.when === "now")
  );
}

/**
 * The canonical event every delivered operator message must also emit (D-09).
 *
 * Delivery and awareness are separated: the message reaches the agent verbatim
 * AND a `user_message` lands in the stream the parent's folded view reads, so
 * the operator keeps direct control without desynchronising the parent's picture
 * of what happened.
 */
export function externalUserMessageEvent(message: string): ExternalEvent {
  return { kind: "user_message", text: message };
}

/**
 * The `user_message` event for an intent, or `undefined` when nothing was
 * delivered. Single choke point, so no future caller can deliver a message and
 * forget the event.
 */
export function deliveredUserMessageEvent(intent: ExternalDeliveryIntent): ExternalEvent | undefined {
  return intentDeliversNow(intent) ? externalUserMessageEvent(intent.message) : undefined;
}

/** One operator-readable line describing what an intent will do. */
export function describeDeliveryIntent(intent: ExternalDeliveryIntent): string {
  switch (intent.kind) {
    case "stdin":
      return "delivered to the running agent's stdin";
    case "resume":
      return intent.when === "now"
        ? `delivered by resuming session ${intent.sessionRef}`
        : `queued: will be delivered by resuming session ${intent.sessionRef} when the run ends`;
    case "kill-then-resume":
      return `force: killing the run and resuming session ${intent.sessionRef} with this message`;
    case "kill-only":
      return `force: killing the run — ${intent.reason}`;
    case "hold":
      return `held — ${intent.reason}`;
    case "undeliverable":
      return `not delivered — ${intent.reason}`;
    default:
      return "not delivered";
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Replace one addressee's queue, dropping the key when the queue is empty. */
function withQueue(
  queues: AddresseeQueues,
  addressee: AddresseeId,
  items: readonly QueuedMainQuestion[],
): AddresseeQueues {
  const next = new Map(queues);
  if (items.length === 0) next.delete(addressee);
  else next.set(addressee, items);
  return next;
}
