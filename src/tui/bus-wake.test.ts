// Flow 274 (agent bus P3, T7; specification §5.3, AC5/AC6): `decideBusWake`'s
// decision table, driven directly — no renderer needed.
//
// Review r1 F11 adds `createBusWakeController` below: the STATEFUL half of
// the TUI's bus-wake handling (what used to live only in `tui-shell.ts`'s
// `onBusPollSettled`, pinned only by source-text audits and a reimplemented
// loop). Driving the real factory here is what makes F1 (capped notice prints
// once per batch) and F4 (no wake before `deps.busInbox`/`busAck` exist)
// actually testable, per review r1.
import { describe, expect, test } from "bun:test";
import { createBusInbox, type BusInboxEvent } from "../bus/inbox";
import { busInboxFullNotice, createBusDropNotifier, createBusWakeController, decideBusWake } from "./bus-wake";

/** A minimal `BusInboxEvent`, overridable per test (mirrors `tui-bus.test.ts`'s `renderedEvent`). */
function inboxEvent(overrides: Partial<BusInboxEvent> = {}): BusInboxEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    seq: 1,
    shortId: "00000000",
    fromName: "release",
    fromInstanceId: "00000000-0000-4000-8000-000000000001",
    kind: "notice",
    preview: "ready for review",
    body: "ready for review",
    ...overrides,
  };
}

describe("decideBusWake (specification §5.3)", () => {
  test("idle and eligible, under the cap: wake", () => {
    expect(decideBusWake({ idle: true, eligible: true, wakes: 0, cap: 3 })).toBe("wake");
    expect(decideBusWake({ idle: true, eligible: true, wakes: 2, cap: 3 })).toBe("wake");
  });

  test("not eligible: never wakes, even when idle and under the cap", () => {
    expect(decideBusWake({ idle: true, eligible: false, wakes: 0, cap: 3 })).toBe("none");
  });

  test("busy (not idle): never wakes, even when eligible", () => {
    expect(decideBusWake({ idle: false, eligible: true, wakes: 0, cap: 3 })).toBe("none");
  });

  test("busy AND not eligible: still just none (not idle wins first)", () => {
    expect(decideBusWake({ idle: false, eligible: false, wakes: 0, cap: 3 })).toBe("none");
  });

  test("at the cap: capped, not wake — the counter must not be pushed past the cap here", () => {
    expect(decideBusWake({ idle: true, eligible: true, wakes: 3, cap: 3 })).toBe("capped");
  });

  test("past the cap (defensive): still capped, never wake", () => {
    expect(decideBusWake({ idle: true, eligible: true, wakes: 5, cap: 3 })).toBe("capped");
  });

  test("cap of 0: even the first wake is capped", () => {
    expect(decideBusWake({ idle: true, eligible: true, wakes: 0, cap: 0 })).toBe("capped");
  });
});

// AC5: "a broadcast notice never wakes" — proven end to end through the real
// `BusInbox` (`../bus/inbox.ts`, T5's), not just `decideBusWake` in
// isolation: a `notice` addressed via `@all` (`toStar: true`) must never make
// `hasWakeEligible()` true, so the `eligible` input `decideBusWake` sees for
// it is always `false`.
describe("a broadcast notice never wakes (specification §4.2, AC5), end to end through BusInbox", () => {
  test("an idle shell with only a broadcast notice pending: none", () => {
    const inbox = createBusInbox();
    inbox.push(inboxEvent({ kind: "notice", toStar: true }));
    expect(inbox.hasWakeEligible()).toBe(false);
    expect(decideBusWake({ idle: true, eligible: inbox.hasWakeEligible(), wakes: 0, cap: 3 })).toBe("none");
  });

  test("a notice addressed BY NAME (not broadcast) is wake-eligible: wake", () => {
    const inbox = createBusInbox();
    inbox.push(inboxEvent({ kind: "notice", toStar: false }));
    expect(inbox.hasWakeEligible()).toBe(true);
    expect(decideBusWake({ idle: true, eligible: inbox.hasWakeEligible(), wakes: 0, cap: 3 })).toBe("wake");
  });

  test("a question always wakes, even mixed with a pending broadcast notice", () => {
    const inbox = createBusInbox();
    inbox.push(inboxEvent({ kind: "notice", toStar: true }));
    inbox.push(inboxEvent({ id: "b", kind: "question" }));
    expect(inbox.hasWakeEligible()).toBe(true);
    expect(decideBusWake({ idle: true, eligible: inbox.hasWakeEligible(), wakes: 0, cap: 3 })).toBe("wake");
  });
});

// review r1 F11/F1/F4: `createBusWakeController` — the stateful wiring around
// `decideBusWake`, driven directly through a fake inbox/clock instead of a
// reimplemented loop or a source-text audit of `tui-shell.ts`.
describe("createBusWakeController (review r1 F11, F1, F4)", () => {
  /** A tiny fake inbox: `eligible` is mutated directly by each test. */
  function fakeInbox(initial: boolean): { hasWakeEligible(): boolean; eligible: boolean } {
    return {
      eligible: initial,
      hasWakeEligible() {
        return this.eligible;
      },
    };
  }

  function harness(overrides: { cap?: number; idle?: boolean; hasBusDeps?: boolean } = {}) {
    let wakes = 0;
    const runs: number[] = [];
    const capped: number[] = [];
    const inbox = fakeInbox(true);
    const controller = createBusWakeController({
      isIdle: () => overrides.idle ?? true,
      inbox,
      getWakes: () => wakes,
      incWakes: () => {
        wakes += 1;
      },
      cap: () => overrides.cap ?? 3,
      runWake: () => runs.push(wakes),
      printCapped: () => capped.push(wakes),
      hasBusDeps: () => overrides.hasBusDeps ?? true,
    });
    return { controller, inbox, runs, capped, getWakes: () => wakes };
  }

  test("onPoll(true) wakes when idle, eligible, and under the cap", () => {
    const { controller, runs } = harness();
    controller.onPoll(true);
    expect(runs).toEqual([1]);
  });

  test("onPoll(false) never wakes, even when eligible and under the cap — F1: only a poll that delivered something is a fresh reason to decide", () => {
    const { controller, runs, capped } = harness();
    controller.onPoll(false);
    expect(runs).toEqual([]);
    expect(capped).toEqual([]);
  });

  test("F1: the capped notice prints once per pending batch, not once per poll", () => {
    const { controller, capped } = harness({ cap: 0 }); // cap 0: even the first wake is capped
    controller.onPoll(true);
    controller.onPoll(true);
    controller.onPoll(true);
    expect(capped.length).toBe(1); // NOT 3 — this is the exact review r1 F1 regression
  });

  test("F1: onSettle also respects the once-per-batch flag set by onPoll", () => {
    const { controller, capped } = harness({ cap: 0 });
    controller.onPoll(true);
    controller.onSettle();
    controller.onSettle();
    expect(capped.length).toBe(1);
  });

  test("F1: once the inbox stops being eligible (drained), the NEXT capped batch prints its own notice", () => {
    const { controller, inbox, capped } = harness({ cap: 0 });
    controller.onPoll(true);
    expect(capped.length).toBe(1);
    inbox.eligible = false; // drained, or the backlog otherwise cleared
    controller.onSettle(); // observes the drain; clears the flag
    inbox.eligible = true; // a fresh message arrives
    controller.onPoll(true);
    expect(capped.length).toBe(2);
  });

  test("onSettle re-checks pending messages even without a preceding onPoll(true) — a turn settling is itself the check", () => {
    const { controller, runs } = harness();
    controller.onSettle();
    expect(runs).toEqual([1]);
  });

  test("not idle: neither onPoll(true) nor onSettle wakes", () => {
    const { controller, runs, capped } = harness({ idle: false });
    controller.onPoll(true);
    controller.onSettle();
    expect(runs).toEqual([]);
    expect(capped).toEqual([]);
  });

  test("F4: hasBusDeps false suppresses onPoll(true) entirely — no wake, no capped notice, no counter increment", () => {
    const { controller, runs, capped, getWakes } = harness({ hasBusDeps: false, cap: 0 });
    controller.onPoll(true);
    expect(runs).toEqual([]);
    expect(capped).toEqual([]);
    expect(getWakes()).toBe(0);
  });

  test("F4: hasBusDeps false also suppresses onSettle", () => {
    const { controller, runs } = harness({ hasBusDeps: false });
    controller.onSettle();
    expect(runs).toEqual([]);
  });

  test("wakes increment across repeated onPoll(true) calls until the cap, then switches to capped", () => {
    const { controller, runs, capped } = harness({ cap: 2 });
    controller.onPoll(true); // wakes 0 -> 1
    controller.onPoll(true); // wakes 1 -> 2
    controller.onPoll(true); // at cap: capped
    expect(runs).toEqual([1, 2]);
    expect(capped).toEqual([2]);
  });
});

// review r1 F10: the inbox-overflow notice throttle, shared by both surfaces.
describe("createBusDropNotifier (review r1 F10)", () => {
  test("prints once per overflow episode, not once per dropped event", () => {
    const prints: number[] = [];
    const notifier = createBusDropNotifier((total) => prints.push(total));
    notifier.onDrop(1);
    notifier.onDrop(2);
    notifier.onDrop(3);
    expect(prints).toEqual([1]); // NOT [1, 2, 3] — this is the exact review r1 F10 regression
  });

  test("a fresh overflow episode after the inbox empties prints its own notice", () => {
    const prints: number[] = [];
    const notifier = createBusDropNotifier((total) => prints.push(total));
    notifier.onDrop(1);
    notifier.onInboxSizeObserved(0); // drained
    notifier.onDrop(2);
    expect(prints).toEqual([1, 2]);
  });

  test("observing a non-zero size does not reset the throttle", () => {
    const prints: number[] = [];
    const notifier = createBusDropNotifier((total) => prints.push(total));
    notifier.onDrop(1);
    notifier.onInboxSizeObserved(5);
    notifier.onDrop(2);
    expect(prints).toEqual([1]);
  });

  test("busInboxFullNotice formats the exact operator line review r1 F10 asks for", () => {
    expect(busInboxFullNotice(7)).toBe("bus: inbox full — 7 older message(s) dropped\n");
  });
});
