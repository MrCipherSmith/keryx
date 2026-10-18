import { expect, test } from "bun:test";
import { mapBounded } from "./map-bounded";

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("results keep the input order whatever order the calls finish in", async () => {
  // Earlier items take longer, so completion order is the reverse of input order.
  const out = await mapBounded([30, 20, 10, 0], 4, async (ms) => {
    await tick(ms);
    return `item-${ms}`;
  });
  expect(out).toEqual(["item-30", "item-20", "item-10", "item-0"]);
});

test("at most `limit` calls are in flight, and every item is mapped once", async () => {
  let running = 0;
  let peak = 0;
  const seen: number[] = [];
  const items = Array.from({ length: 20 }, (_, index) => index);
  const out = await mapBounded(items, 3, async (item) => {
    running += 1;
    peak = Math.max(peak, running);
    seen.push(item);
    await tick(2);
    running -= 1;
    return item * 2;
  });
  expect(peak).toBe(3);
  expect(seen.slice().sort((a, b) => a - b)).toEqual(items);
  expect(out).toEqual(items.map((item) => item * 2));
});

test("an empty list maps nothing; a limit above the list size, or below one, still works", async () => {
  let calls = 0;
  const count = async (): Promise<number> => ++calls;
  expect(await mapBounded([], 4, count)).toEqual([]);
  expect(calls).toBe(0);
  expect(await mapBounded(["a", "b"], 100, async (item) => item.toUpperCase())).toEqual(["A", "B"]);
  expect(await mapBounded(["a", "b"], 0, async (item) => item.toUpperCase())).toEqual(["A", "B"]);
});

test("a rejected call rejects the whole map", async () => {
  await expect(
    mapBounded([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("two");
      return item;
    }),
  ).rejects.toThrow("two");
});
