import { expect, test } from "bun:test";
import { stem, tokenize } from "./text";

test("tokenize supports latin text", () => {
  expect(tokenize("How does the gate work?")).toEqual(["how", "does", "the", "gate", "work"]);
});

test("tokenize supports Cyrillic text", () => {
  expect(tokenize("Как работает шлюз?")).toEqual(["как", "работает", "шлюз"]);
});

test("tokenize keeps mixed unicode and filters short tokens", () => {
  expect(tokenize("go  и yes  1 2 你好")).toEqual(["go", "yes", "你好"]);
});

// Flow 353 AC5: "release" must land on the same stem as its inflections, so
// `keryx memory search release` also matches an entry that only ever wrote
// "released"/"releases"/"releasing".
test("stem converges release/released/releases/releasing on one root", () => {
  const stemmed = new Set(["release", "released", "releases", "releasing"].map(stem));
  expect(stemmed.size).toBe(1);
});

test("stem leaves an already-short or already-bare word alone", () => {
  expect(stem("test")).toBe("test");
  expect(stem("go")).toBe("go");
});
