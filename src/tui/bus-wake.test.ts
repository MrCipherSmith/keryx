// Flow 274 (agent bus P3, T7; specification §5.3, AC5/AC6): `decideBusWake`'s
// decision table, driven directly — no renderer needed.
import { describe, expect, test } from "bun:test";
import { createBusInbox, type BusInboxEvent } from "../bus/inbox";
import { decideBusWake } from "./bus-wake";

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
