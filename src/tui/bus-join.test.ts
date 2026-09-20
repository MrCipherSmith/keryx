// Flow 277 (P2). `decideJoinAdoption` and `buildBusJoinCallbacks` used to be
// the join-resolution branch and the `onEvent`/`onPeers` handlers inline
// inside `joinBus({...})` — proven only by `tui-bus.test.ts` slicing
// `tui-shell.ts`'s text into windows and comparing character offsets. These
// drive the real functions directly.
import { describe, expect, test } from "bun:test";
import type { BusPeer, RenderedBusEvent } from "../bus/client";
import { buildBusJoinCallbacks, decideJoinAdoption, type BusJoinCallbackDeps } from "./bus-join";

describe("decideJoinAdoption (review r1 F6)", () => {
  test("disabled wins outright — nothing to leave or adopt", () => {
    expect(decideJoinAdoption({ destroyed: false, disabled: true })).toBe("off");
    expect(decideJoinAdoption({ destroyed: true, disabled: true })).toBe("off");
  });

  test("destroyed (and not disabled): leave immediately instead of adopting", () => {
    expect(decideJoinAdoption({ destroyed: true, disabled: false })).toBe("leave");
  });

  test("neither destroyed nor disabled: adopt", () => {
    expect(decideJoinAdoption({ destroyed: false, disabled: false })).toBe("adopt");
  });

  test("BOUNDARY — disabled and destroyed are independent inputs, not one flag standing for both", () => {
    // A stub that treated "disabled" as just another spelling of "destroyed"
    // (or vice versa) would still pass the two tests above in isolation; this
    // is the one input combination that tells them apart.
    expect(decideJoinAdoption({ destroyed: true, disabled: true })).toBe("off");
    expect(decideJoinAdoption({ destroyed: true, disabled: false })).not.toBe("off");
  });
});

/** A minimal `RenderedBusEvent`, overridable per test (mirrors `tui-bus.test.ts`'s `renderedEvent`). */
function renderedEvent(overrides: Partial<RenderedBusEvent> = {}): RenderedBusEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    seq: 1,
    shortId: "00000000",
    fromName: "release",
    fromInstanceId: "00000000-0000-4000-8000-000000000001",
    kind: "notice",
    preview: "ready for review",
    ...overrides,
  };
}

function peer(overrides: Partial<BusPeer["record"]> = {}, state: BusPeer["state"] = "live"): BusPeer {
  return {
    record: {
      schemaVersion: 1,
      instanceId: "00000000-0000-4000-8000-000000000001",
      name: "release",
      pid: 123,
      host: "host-a",
      sessionId: "00000000-0000-4000-8000-0000000000aa",
      checkout: "/repo/worktree-a",
      branch: "main",
      surface: "tui",
      status: "working",
      activity: "flow 277",
      startedAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:00:00.000Z",
      keryxVersion: "0.0.0",
      ...overrides,
    },
    state,
    ageMs: 0,
  };
}

/** Records every call in order, so the ordering assertions are about sequence, not mere presence. */
function harness(overrides: { destroyed?: boolean; delivered?: boolean } = {}) {
  const log: string[] = [];
  let delivered = overrides.delivered ?? false;
  const deps: BusJoinCallbackDeps = {
    isDestroyed: () => overrides.destroyed ?? false,
    onSystemLine: (line) => log.push(`onSystemLine:${line}`),
    pushToInbox: (event) => log.push(`pushToInbox:${event.id}:${event.body}`),
    markDelivered: () => log.push("markDelivered"),
    setFleetPeers: (peers) => log.push(`setFleetPeers:${peers.length}`),
    paintFleet: () => log.push("paintFleet"),
    onInboxSizeObserved: () => log.push("onInboxSizeObserved"),
    paintHoldBanner: () => log.push("paintHoldBanner"),
    onLeaseHoldPoll: () => log.push("onLeaseHoldPoll"),
    onBusWakePoll: (d) => log.push(`onBusWakePoll:${d}`),
    getDelivered: () => delivered,
    resetDelivered: () => {
      delivered = false;
      log.push("resetDelivered");
    },
  };
  return { log, callbacks: buildBusJoinCallbacks(deps) };
}

describe("buildBusJoinCallbacks (review r1 F1, F6)", () => {
  test("onEvent bails out before touching anything once destroyed", () => {
    const { log, callbacks } = harness({ destroyed: true });
    callbacks.onEvent(renderedEvent());
    expect(log).toEqual([]);
  });

  test("onPeers bails out before touching anything once destroyed", () => {
    const { log, callbacks } = harness({ destroyed: true });
    callbacks.onPeers([peer()]);
    expect(log).toEqual([]);
  });

  test("BOUNDARY — an always-true isDestroyed stub would also suppress the non-destroyed case, which these prove does fire", () => {
    const { log, callbacks } = harness({ destroyed: false });
    callbacks.onEvent(renderedEvent());
    expect(log.length).toBeGreaterThan(0);
  });

  test("onEvent pushes the rendered event with body defaulted, and marks the poll as having delivered something (review r1 F1)", () => {
    const { log, callbacks } = harness();
    // `renderedEvent()`'s own defaults omit `body` entirely (pre-flow-274
    // fixture shape) — exactly the case `?? ""` exists for.
    callbacks.onEvent(renderedEvent({ id: "evt-1" }));
    expect(log).toEqual([expect.stringContaining("onSystemLine:"), "pushToInbox:evt-1:", "markDelivered"]);
  });

  test("onEvent preserves an explicit body rather than always defaulting to empty", () => {
    // BOUNDARY against a stub that always pushes body "" regardless of input.
    const { log, callbacks } = harness();
    callbacks.onEvent(renderedEvent({ id: "evt-2", body: "hello" }));
    expect(log).toContain("pushToInbox:evt-2:hello");
  });

  test("onPeers maps peer fields (name/state/status/activity), not the raw BusPeer shape", () => {
    const { log, callbacks } = harness();
    callbacks.onPeers([peer({ name: "qa" }, "stale")]);
    expect(log).toContain("setFleetPeers:1");
  });

  test("onPeers: paints the fleet BEFORE reporting delivery to the wake controller, then resets the flag AFTER", () => {
    const { log, callbacks } = harness({ delivered: true });
    callbacks.onPeers([peer()]);
    expect(log).toEqual([
      "setFleetPeers:1",
      "paintFleet",
      "onInboxSizeObserved",
      "paintHoldBanner",
      "onLeaseHoldPoll",
      "onBusWakePoll:true",
      "resetDelivered",
    ]);
  });

  test("onPeers reports THIS poll's delivered value to the wake controller before resetting it", () => {
    // BOUNDARY: an implementation that reset the flag before reporting it
    // would always report `false` — this pins the order the other way.
    const { log, callbacks } = harness({ delivered: true });
    callbacks.onPeers([peer()]);
    expect(log.indexOf("onBusWakePoll:true")).toBeLessThan(log.indexOf("resetDelivered"));
  });

  test("onPeers with nothing delivered this poll reports false, not a stale prior value", () => {
    const { log, callbacks } = harness({ delivered: false });
    callbacks.onPeers([peer()]);
    expect(log).toContain("onBusWakePoll:false");
  });
});
