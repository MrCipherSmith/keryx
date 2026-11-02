import { expect, test } from "bun:test";
import { parseJsonc } from "./jsonc";

test("strips line and block comments and trailing commas", () => {
  const source = `{\n  // a comment\n  "a": [1, 2, /* two */ ],\n  "b": { "c": true, },\n}`;
  expect(parseJsonc(source)).toEqual({ a: [1, 2], b: { c: true } });
});

test("leaves comment markers and commas inside strings alone", () => {
  const source = `{ "url": "https://example.test/a,}", "q": "say \\"//hi\\" /* no */", }`;
  expect(parseJsonc(source)).toEqual({ url: "https://example.test/a,}", q: 'say "//hi" /* no */' });
});

test("still rejects input that is invalid for another reason", () => {
  expect(() => parseJsonc(`{ "a": 1 "b": 2 }`)).toThrow();
  expect(() => parseJsonc(`{ "a": , }`)).toThrow();
});

test("stays linear on a long pathological input", () => {
  const source = `[${"1,".repeat(50_000)} ${"/* c */ ".repeat(10_000)}]`;
  const started = performance.now();
  expect((parseJsonc(source) as unknown[]).length).toBe(50_000);
  expect(performance.now() - started).toBeLessThan(250);
});
