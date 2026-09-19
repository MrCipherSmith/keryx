// RED tests for the bus inbox (flow 274 T5, AC1). Pure in-memory queue: no
// clock, no I/O — every case below is synchronous.
import { describe, expect, test } from "bun:test";
import { createBusInbox, MAX_PENDING_BUS_EVENTS, type BusInboxEvent } from "./inbox";
import type { RenderableBusEventKind } from "./client";

function event(overrides: Partial<BusInboxEvent> = {}): BusInboxEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    seq: 1,
    shortId: "11111111",
    fromName: "release",
    fromInstanceId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    kind: "notice",
    preview: "hi",
    body: "hi",
    ...overrides,
  };
}

describe("AC1: createBusInbox — exactly-once delivery", () => {
  test("push then drainUndelivered returns the event", () => {
    const inbox = createBusInbox();
    inbox.push(event());
    expect(inbox.drainUndelivered()).toEqual([event()]);
  });

  test("a second drain is empty: the same event is never delivered twice", () => {
    const inbox = createBusInbox();
    inbox.push(event());
    inbox.drainUndelivered();
    expect(inbox.drainUndelivered()).toEqual([]);
  });

  test("draining an empty inbox returns []", () => {
    const inbox = createBusInbox();
    expect(inbox.drainUndelivered()).toEqual([]);
  });

  test("several pushes drain together, oldest first, in one call", () => {
    const inbox = createBusInbox();
    inbox.push(event({ id: "a", seq: 1 }));
    inbox.push(event({ id: "b", seq: 2 }));
    inbox.push(event({ id: "c", seq: 3 }));
    const drained = inbox.drainUndelivered();
    expect(drained.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(inbox.drainUndelivered()).toEqual([]);
  });

  test("size reflects pending events and drops to 0 after a drain", () => {
    const inbox = createBusInbox();
    expect(inbox.size).toBe(0);
    inbox.push(event());
    inbox.push(event());
    expect(inbox.size).toBe(2);
    inbox.drainUndelivered();
    expect(inbox.size).toBe(0);
  });
});

describe("AC1: hasWakeEligible", () => {
  test.each(["question", "reply", "handoff"] as RenderableBusEventKind[])(
    "%s is wake-eligible regardless of addressing",
    (kind) => {
      const inbox = createBusInbox();
      inbox.push(event({ kind }));
      expect(inbox.hasWakeEligible()).toBe(true);
    },
  );

  test("a notice addressed by name (toStar false/absent) is wake-eligible", () => {
    const inbox = createBusInbox();
    inbox.push(event({ kind: "notice", toStar: false }));
    expect(inbox.hasWakeEligible()).toBe(true);

    const inboxAbsent = createBusInbox();
    inboxAbsent.push(event({ kind: "notice" }));
    expect(inboxAbsent.hasWakeEligible()).toBe(true);
  });

  test("a broadcast notice (toStar true) is never wake-eligible", () => {
    const inbox = createBusInbox();
    inbox.push(event({ kind: "notice", toStar: true }));
    expect(inbox.hasWakeEligible()).toBe(false);
  });

  test("an empty inbox is never wake-eligible", () => {
    expect(createBusInbox().hasWakeEligible()).toBe(false);
  });

  test("wake eligibility clears once the eligible event is drained", () => {
    const inbox = createBusInbox();
    inbox.push(event({ kind: "question" }));
    expect(inbox.hasWakeEligible()).toBe(true);
    inbox.drainUndelivered();
    expect(inbox.hasWakeEligible()).toBe(false);
  });
});

describe("AC1: the 200-pending bound", () => {
  test("pushing past the bound drops the oldest and counts the drop", () => {
    const inbox = createBusInbox();
    for (let i = 0; i < MAX_PENDING_BUS_EVENTS + 5; i++) {
      inbox.push(event({ id: `id-${i}`, seq: i }));
    }
    expect(inbox.size).toBe(MAX_PENDING_BUS_EVENTS);
    expect(inbox.droppedCount).toBe(5);

    const drained = inbox.drainUndelivered();
    expect(drained.length).toBe(MAX_PENDING_BUS_EVENTS);
    // The 5 oldest (id-0..id-4) were dropped; the surviving window starts at id-5.
    expect(drained[0]?.id).toBe("id-5");
    expect(drained[drained.length - 1]?.id).toBe(`id-${MAX_PENDING_BUS_EVENTS + 4}`);
  });

  test("staying at exactly the bound drops nothing", () => {
    const inbox = createBusInbox();
    for (let i = 0; i < MAX_PENDING_BUS_EVENTS; i++) {
      inbox.push(event({ id: `id-${i}`, seq: i }));
    }
    expect(inbox.size).toBe(MAX_PENDING_BUS_EVENTS);
    expect(inbox.droppedCount).toBe(0);
  });

  // review r1 F10: a drop used to be silent — droppedCount changed, but
  // nothing told a caller (a shell surface) it happened unless it happened to
  // poll the counter itself.
  test("onDrop fires once per dropped event, with the cumulative droppedCount, and never for a push within the bound", () => {
    const drops: number[] = [];
    const inbox = createBusInbox({ onDrop: (total) => drops.push(total) });
    for (let i = 0; i < MAX_PENDING_BUS_EVENTS; i++) {
      inbox.push(event({ id: `id-${i}`, seq: i }));
    }
    expect(drops).toEqual([]); // nothing dropped yet: no calls at all

    for (let i = 0; i < 3; i++) {
      inbox.push(event({ id: `overflow-${i}`, seq: MAX_PENDING_BUS_EVENTS + i }));
    }
    expect(drops).toEqual([1, 2, 3]); // one call per drop, running total
    expect(inbox.droppedCount).toBe(3);
  });

  test("omitting onDrop is safe: drops still happen without a callback", () => {
    const inbox = createBusInbox();
    for (let i = 0; i < MAX_PENDING_BUS_EVENTS + 2; i++) {
      inbox.push(event({ id: `id-${i}`, seq: i }));
    }
    expect(inbox.droppedCount).toBe(2);
  });
});
