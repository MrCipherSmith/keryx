import { expect, test } from "bun:test";
import { findPath, labelNode } from "./path";
import type { GraphData, SymbolNode } from "./types";

function fileNode(path: string) {
  return { id: path, kind: "file" as const, path, language: "typescript" as const };
}
function importEdge(from: string, to: string) {
  return { id: `${from}->${to}`, from, to, kind: "imports" as const, specifier: to };
}
function sym(id: string, name: string, path: string, line: number): SymbolNode {
  return { id, kind: "function", path, name, container: null, startLine: line, endLine: line + 3, language: "typescript" };
}
function call(from: string, to: string) {
  return { id: `${from}=>${to}`, from, to, kind: "calls" as const, resolved: true };
}

// a.ts imports b.ts imports c.ts; symbols foo(a) -> bar(b)
const GRAPH: GraphData = {
  nodes: [fileNode("src/a.ts"), fileNode("src/b.ts"), fileNode("src/c.ts")],
  edges: [importEdge("src/a.ts", "src/b.ts"), importEdge("src/b.ts", "src/c.ts")],
  symbols: [sym("src/a.ts#foo", "foo", "src/a.ts", 1), sym("src/b.ts#bar", "bar", "src/b.ts", 2)],
  calls: [call("src/a.ts#foo", "src/b.ts#bar")],
};

test("finds a file-to-file import path", () => {
  const r = findPath(GRAPH, "src/a.ts", "src/c.ts");
  expect(r.nodes).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
});

test("connects two symbols across the file+call layers", () => {
  const r = findPath(GRAPH, "foo", "bar");
  // foo -> bar via the resolved call edge (or foo -> a.ts -> b.ts -> bar)
  expect(r.nodes[0]).toBe("src/a.ts#foo");
  expect(r.nodes.at(-1)).toBe("src/b.ts#bar");
  expect(r.nodes.length).toBeGreaterThanOrEqual(2);
});

test("resolves endpoints by symbol name and by file substring", () => {
  const r = findPath(GRAPH, "foo", "c.ts");
  expect(r.fromResolved).toContain("src/a.ts#foo");
  expect(r.toResolved).toContain("src/c.ts");
  expect(r.nodes.length).toBeGreaterThan(0);
});

test("returns empty nodes when an endpoint cannot be resolved", () => {
  const r = findPath(GRAPH, "foo", "does-not-exist-xyz");
  expect(r.toResolved).toEqual([]);
  expect(r.nodes).toEqual([]);
});

test("labelNode renders symbols as name (path:line) and files verbatim", () => {
  const byId = new Map(GRAPH.symbols!.map((s) => [s.id, s]));
  expect(labelNode("src/a.ts#foo", byId)).toBe("foo (src/a.ts:1)");
  expect(labelNode("src/c.ts", byId)).toBe("src/c.ts");
});
