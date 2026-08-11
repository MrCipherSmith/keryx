import { expect, test } from "bun:test";
import { tokenize } from "./text";

test("tokenize supports latin text", () => {
  expect(tokenize("How does the gate work?")).toEqual(["how", "does", "the", "gate", "work"]);
});

test("tokenize supports Cyrillic text", () => {
  expect(tokenize("Как работает шлюз?")).toEqual(["как", "работает", "шлюз"]);
});

test("tokenize keeps mixed unicode and filters short tokens", () => {
  expect(tokenize("go  и yes  1 2 你好")).toEqual(["go", "yes", "你好"]);
});
