import { expect, test } from "bun:test";
import { createImageCache } from "./imageCache";

test("the oldest entry goes first when the count is exceeded, and a read refreshes an entry", () => {
  const c = createImageCache(2, 1000);
  c.set("a", "1");
  c.set("b", "2");
  expect(c.get("a")).toBe("1");
  c.set("c", "3");
  expect(c.get("b")).toBeUndefined();
  expect(c.get("a")).toBe("1");
  expect(c.get("c")).toBe("3");
});

test("the total size is bounded, not just the count", () => {
  const c = createImageCache(8, 10);
  c.set("a", "xxxx");
  c.set("b", "yyyy");
  c.set("c", "zzzz");
  expect(c.chars <= 10).toBe(true);
  expect(c.get("a")).toBeUndefined();
  expect(c.get("c")).toBe("zzzz");
});

test("one entry larger than the whole budget is not cached, and delete frees its size", () => {
  const c = createImageCache(8, 5);
  c.set("big", "123456");
  expect(c.size).toBe(0);
  c.set("ok", "123");
  c.delete("ok");
  expect(c.chars).toBe(0);
  c.set("ok", "1");
  c.set("ok", "22");
  expect(c.chars).toBe(2);
});
