// Flow 277 (shell god-file split, P2): the TUI's `joinBus({...})` decision and
// delivery callbacks, lifted out of `tui-shell.ts` so they are unit-testable
// without a renderer. See
// docs/requirements/keryx-shell-split/audits-tui-other.md ("`src/tui/tui-bus.test.ts`"
// and "flow 274 T7 — TUI bus delivery wiring") for the source-text audits this
// replaces.

import type { BusPeer, RenderedBusEvent } from "../bus/client";
import { formatBusEventLine } from "../bus/display";
import type { BusInboxEvent } from "../bus/inbox";
import type { FleetPeer } from "./worker-fleet";

/**
 * review r1 F6: whether a resolved `joinBus()` client should be adopted as
 * `liveBus`, left immediately, or was never joined at all.
 *
 * - `"off"`: `joinBus` reported a disabled bus (`"disabled" in joined`) —
 *   nothing to adopt or leave.
 * - `"leave"`: Ctrl+C (`onDestroy`) landed while the join was still in
 *   flight — the resolved client must `leave()` immediately rather than be
 *   adopted for a renderer that is already gone.
 * - `"adopt"`: the ordinary case — assign `liveBus` and proceed with the
 *   post-join rebuild.
 */
export type JoinAdoptionDecision = "leave" | "adopt" | "off";

/** Pure decision table for {@link JoinAdoptionDecision} — `disabled` wins over `destroyed` (there is nothing to leave). */
export function decideJoinAdoption(input: { destroyed: boolean; disabled: boolean }): JoinAdoptionDecision {
  if (input.disabled) return "off";
  if (input.destroyed) return "leave";
  return "adopt";
}

/**
 * What {@link buildBusJoinCallbacks}'s `onEvent`/`onPeers` need from the
 * enclosing `launchTuiAgentShell` closure. Every field is a function so the
 * callbacks always observe the CURRENT value of a mutable local (e.g.
 * `destroyed`, `busWakeController`) rather than one captured when the
 * `joinBus({...})` call was built — the same reason `bus-wake.ts`'s
 * `BusWakeControllerOptions` reads everything through getters.
 */
export interface BusJoinCallbackDeps {
  /** `() => destroyed` (review r1 F6) — Ctrl+C can land between polls; read fresh at every call. */
  isDestroyed: () => boolean;
  /** `(line) => io.onSystem?.(line)`. */
  onSystemLine: (line: string) => void;
  /** `busInbox.push(...)`. */
  pushToInbox: (event: BusInboxEvent) => void;
  /** `busPollDeliveredEvent = true` (review r1 F1) — marks THIS poll as having delivered at least one event. */
  markDelivered: () => void;
  /** `busFleetPeers = peers.map(...)`. */
  setFleetPeers: (peers: FleetPeer[]) => void;
  /** Repaint the fleet sidebar — must run BEFORE the wake decision below (a wake-triggered turn must never race a stale sidebar). */
  paintFleet: () => void;
  /** `busDropNotifier.onInboxSizeObserved(busInbox.size)` (review r1 F10) — re-arms the overflow-notice throttle every poll. */
  onInboxSizeObserved: () => void;
  /** Repaint the pause-lease status banner (flow 275 T7). */
  paintHoldBanner: () => void;
  /** `leaseHoldController?.onPoll()` (flow 275 T7). */
  onLeaseHoldPoll: () => void;
  /** `busWakeController?.onPoll(delivered)` — must be called with THIS poll's delivered flag before it resets (review r1 F1). */
  onBusWakePoll: (delivered: boolean) => void;
  /** Read `busPollDeliveredEvent` — called before {@link resetDelivered} in `onPeers`'s own body. */
  getDelivered: () => boolean;
  /** `busPollDeliveredEvent = false` — reset AFTER `onBusWakePoll` reports it (review r1 F1). */
  resetDelivered: () => void;
}

export interface BusJoinCallbacks {
  onEvent: (event: RenderedBusEvent) => void;
  onPeers: (peers: BusPeer[]) => void;
}

/**
 * Build the `joinBus({...})` `onEvent`/`onPeers` handlers. Both bail out
 * before doing anything (review r1 F6) once `deps.isDestroyed()` is true, so
 * an in-flight poll can never paint a renderer that Ctrl+C already tore down.
 */
export function buildBusJoinCallbacks(deps: BusJoinCallbackDeps): BusJoinCallbacks {
  return {
    onEvent: (event) => {
      if (deps.isDestroyed()) return; // review r1 F6: never paint after Ctrl+C
      deps.onSystemLine(`${formatBusEventLine(event)}\n`);
      // Every event `onEvent` sees is already not `ack`/`override`/
      // `lease-expired` (`BusClient`'s own `isRenderable` filter), so every
      // one of them is a candidate for agent delivery. `body` is optional
      // only on the TYPE (pre-flow-274 fixtures); the real poll path always
      // sets it — `?? ""` just satisfies `BusInboxEvent`.
      deps.pushToInbox({ ...event, body: event.body ?? "" });
      deps.markDelivered();
    },
    onPeers: (peers) => {
      if (deps.isDestroyed()) return; // review r1 F6: never paint after Ctrl+C
      deps.setFleetPeers(
        peers.map((peer) => ({
          name: peer.record.name,
          state: peer.state,
          status: peer.record.status,
          activity: peer.record.activity,
        })),
      );
      deps.paintFleet();
      // review r1 F10: the inbox may have drained to empty since the last
      // overflow notice — let the NEXT overflow episode print its own notice.
      deps.onInboxSizeObserved();
      // Flow 275 (agent bus P4, T7; specification §5.2 step 5): leases are
      // re-listed as part of THIS SAME poll (`BusClient.doPoll` refreshes
      // `leaseView()` before calling `onPeers`), so repainting the banner and
      // checking for a hold release here, right alongside the other
      // once-per-poll bookkeeping, is always looking at this poll's fresh
      // state.
      deps.paintHoldBanner();
      deps.onLeaseHoldPoll();
      // Flow 274 T7 (specification §5.3): `onPeers` fires exactly once per
      // poll, AFTER every event of that poll was already routed to `onEvent`
      // above, so this is the poll's natural "events settled" point. review
      // r1 F1: tell the controller whether THIS poll actually delivered
      // anything, then reset the flag for the next poll cycle.
      const delivered = deps.getDelivered();
      deps.onBusWakePoll(delivered);
      deps.resetDelivered();
    },
  };
}
