import { expect, test } from "bun:test";
import { sessionTree } from "./session-tree";

type S = { id: string; parent?: string };
const rows = (items: S[]) =>
  sessionTree(items, (s) => s.id, (s) => s.parent).map((row) => `${"  ".repeat(row.depth)}${row.item.id}${row.parentMissing ? "*" : ""}`);

test("children follow their parent, one level deeper, siblings in input order", () => {
  expect(rows([{ id: "c2", parent: "a" }, { id: "b" }, { id: "a" }, { id: "c1", parent: "a" }, { id: "g", parent: "c1" }])).toEqual([
    "b", "a", "  c2", "  c1", "    g",
  ]);
});

test("a child whose parent is not listed is a marked root", () => {
  expect(rows([{ id: "x", parent: "gone" }, { id: "y" }])).toEqual(["x*", "y"]);
});

test("a parent cycle or a self-parent is listed once each, never dropped", () => {
  expect(rows([{ id: "p", parent: "q" }, { id: "q", parent: "p" }, { id: "self", parent: "self" }])).toEqual(["self", "p*", "  q"]);
});
