import { expect, test } from "bun:test";
import { ReviewReadLane } from "./reviewReadLane";

test("rapid navigation starts at most two reads, shares matching calls and starts only the latest waiting PR", async () => {
  const lane = new ReviewReadLane<number>();
  const started: number[] = [];
  const finish = new Map<number, () => void>();
  const load = (n: number) => lane.read(String(n), () => {
    started.push(n);
    return new Promise<number>(resolve => finish.set(n, () => resolve(n)));
  });
  const first = load(1), second = load(2);
  expect(load(1)).toBe(first);
  const omitted = Array.from({ length: 20 }, (_, i) => load(3 + i).catch(e => e.message));
  const last = load(23);
  expect(load(23)).toBe(last);
  await Promise.resolve();
  expect(started).toEqual([1, 2]);
  finish.get(2)!();
  await second;
  expect(started).toEqual([1, 2, 23]);
  finish.get(1)!();
  finish.get(23)!();
  expect(await Promise.all([first, last])).toEqual([1, 23]);
  expect((await Promise.all(omitted)).every(x => typeof x === "string" && x.includes("superseded"))).toBe(true);
});
