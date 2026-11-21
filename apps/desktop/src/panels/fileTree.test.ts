import { expect, test } from "bun:test";
import { buildTree, limitLines, visibleRows } from "./fileTree";

test("builds a tree with folders first, each sorted by name", () => {
  const tree = buildTree(["b.txt", "src/z.ts", "src/a.ts", "src/lib/x.ts", "README.md", "a-dir/f"]);
  expect(tree.map((n) => n.name)).toEqual(["a-dir", "src", "b.txt", "README.md"]);
  const src = tree.find((n) => n.name === "src")!;
  expect(src.children.map((n) => n.name)).toEqual(["lib", "a.ts", "z.ts"]);
  expect(src.children[0]!.path).toBe("src/lib");
  expect(src.children[1]!.dir).toBe(false);
});

test("an empty list gives an empty tree", () => {
  expect(buildTree([])).toEqual([]);
});

test("visibleRows shows only the children of expanded folders", () => {
  const tree = buildTree(["src/a.ts", "src/lib/x.ts", "top.ts"]);
  expect(visibleRows(tree, new Set()).map((r) => r.node.path)).toEqual(["src", "top.ts"]);
  const rows = visibleRows(tree, new Set(["src"]));
  expect(rows.map((r) => [r.node.path, r.depth])).toEqual([["src", 0], ["src/lib", 1], ["src/a.ts", 1], ["top.ts", 0]]);
  // a collapsed ancestor hides an expanded descendant
  expect(visibleRows(tree, new Set(["src/lib"])).map((r) => r.node.path)).toEqual(["src", "top.ts"]);
});

test("limitLines cuts after the given number of lines", () => {
  expect(limitLines("a\nb\nc", 3)).toEqual({ text: "a\nb\nc", cut: false });
  expect(limitLines("a\nb\nc\nd", 2)).toEqual({ text: "a\nb", cut: true });
  expect(limitLines("", 2)).toEqual({ text: "", cut: false });
});
