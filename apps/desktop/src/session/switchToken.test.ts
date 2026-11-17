import { describe, expect, test } from "bun:test";
import { NewSessionBuffer, SwitchToken } from "./switchToken";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("SwitchToken", () => {
  test("a newer switch makes the older one stale; only the current one ends the in-flight state", () => {
    const t = new SwitchToken();
    const a = t.begin();
    const b = t.begin();
    expect(t.switching).toBeTrue();
    expect(t.isCurrent(a)).toBeFalse();
    expect(t.finish(a)).toBeFalse();
    expect(t.switching).toBeTrue();
    expect(t.finish(b)).toBeTrue();
    expect(t.switching).toBeFalse();
  });

  test("reset makes every outstanding switch stale", () => {
    const t = new SwitchToken();
    const a = t.begin();
    t.reset();
    expect(t.switching).toBeFalse();
    expect(t.finish(a)).toBeFalse();
  });

  test("two overlapping loads resolving out of order: the first one's writes are dropped", async () => {
    const t = new SwitchToken();
    const shown: string[] = [];
    // The shape of startSession: take the token before the first await, write only while current.
    const load = async (id: string, reply: Promise<void>) => {
      const seq = t.begin();
      try {
        await reply;
        if (!t.isCurrent(seq)) return;
        shown.push(id);
      } finally {
        t.finish(seq);
      }
    };
    const first = deferred<void>();
    const second = deferred<void>();
    const p1 = load("first", first.promise);
    const p2 = load("second", second.promise);
    second.resolve();
    await p2;
    expect(t.switching).toBeFalse();
    first.resolve();
    await p1;
    expect(shown).toEqual(["second"]);
    expect(t.switching).toBeFalse();
  });
});

describe("NewSessionBuffer", () => {
  test("holds nothing unless a session/new is pending", () => {
    const b = new NewSessionBuffer<string>();
    expect(b.offer("s1", "x")).toBeFalse();
  });

  test("replays only the updates for the returned id, in order", () => {
    const b = new NewSessionBuffer<string>();
    b.open(3);
    b.offer("old", "stale");
    b.offer("new", "hook notice 1");
    b.offer("new", "hook notice 2");
    expect(b.take(3, "new")).toEqual(["hook notice 1", "hook notice 2"]);
    expect(b.offer("new", "late")).toBeFalse();
  });

  test("a superseded switch gets nothing and cannot close the newer one's buffer", () => {
    const b = new NewSessionBuffer<string>();
    b.open(1);
    b.open(2);
    b.offer("n", "x");
    expect(b.take(1, "n")).toEqual([]);
    b.close(1);
    expect(b.take(2, "n")).toEqual(["x"]);
  });

  test("is bounded", () => {
    const b = new NewSessionBuffer<number>(3);
    b.open(1);
    for (let i = 0; i < 10; i++) b.offer("n", i);
    expect(b.take(1, "n")).toEqual([0, 1, 2]);
  });
});
