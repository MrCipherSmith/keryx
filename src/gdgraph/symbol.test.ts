import { expect, test } from "bun:test";
import { querySymbol, resolveSymbolCandidates, resolveSymbols, transitiveCallers } from "./symbol";
import type { GraphData, SymbolNode, CallEdge } from "./types";

function sym(id: string, name: string, path: string, startLine: number): SymbolNode {
  return { id, kind: "function", path, name, container: null, startLine, endLine: startLine + 5, language: "typescript" };
}
function call(from: string, to: string, resolved: boolean): CallEdge {
  return { id: `${from}->${to}`, from, to, kind: resolved ? "calls" : "unresolved-call", resolved };
}

const A = sym("src/a.ts#foo", "foo", "src/a.ts", 10);
const B = sym("src/b.ts#bar", "bar", "src/b.ts", 20);
const C = sym("src/c.ts#Foo", "Foo", "src/c.ts", 5);

const GRAPH: GraphData = {
  nodes: [],
  edges: [],
  symbols: [A, B, C],
  calls: [
    call("src/b.ts#bar", "src/a.ts#foo", true), // bar calls foo
    call("src/a.ts#foo", "src/c.ts#Foo", true), // foo calls Foo
    call("src/a.ts#foo", "someUnknown.method", false), // foo calls unresolved
  ],
};

test("resolveSymbols prefers exact name, then case-insensitive, then substring", () => {
  expect(resolveSymbols(GRAPH.symbols!, "foo").map((s) => s.id)).toEqual(["src/a.ts#foo"]);
  // case-insensitive tier only when no exact: "FOO" -> foo (exact 'foo'? no; ci matches foo AND Foo)
  const ci = resolveSymbols(GRAPH.symbols!, "FOO").map((s) => s.name).sort();
  expect(ci).toEqual(["Foo", "foo"]);
  // substring tier
  expect(resolveSymbols(GRAPH.symbols!, "ba").map((s) => s.name)).toEqual(["bar"]);
});

test("querySymbol returns definition, callers, and callees", () => {
  const r = querySymbol(GRAPH, "foo");
  expect(r.definitions.map((d) => d.id)).toEqual(["src/a.ts#foo"]);
  // bar calls foo -> caller
  expect(r.callers.map((c) => c.label)).toEqual(["bar (src/b.ts:20)"]);
  // foo calls Foo (resolved) + someUnknown.method (unresolved)
  const labels = r.callees.map((c) => c.label);
  expect(labels).toContain("Foo (src/c.ts:5)");
  expect(labels).toContain("someUnknown.method");
  const unresolved = r.callees.find((c) => c.label === "someUnknown.method");
  expect(unresolved?.resolved).toBe(false);
});

test("querySymbol on no match returns empty definitions", () => {
  expect(querySymbol(GRAPH, "nonexistent").definitions).toEqual([]);
});

test("querySymbol tolerates a graph with no symbol layer", () => {
  const r = querySymbol({ nodes: [], edges: [] }, "foo");
  expect(r.definitions).toEqual([]);
  expect(r.callers).toEqual([]);
});

test("transitiveCallers walks the reverse call graph with hop distances", () => {
  // chain: baz -> bar -> foo (bar calls foo, baz calls bar)
  const graph: GraphData = {
    nodes: [],
    edges: [],
    symbols: [A, B, sym("src/d.ts#baz", "baz", "src/d.ts", 40)],
    calls: [
      call("src/b.ts#bar", "src/a.ts#foo", true),
      call("src/d.ts#baz", "src/b.ts#bar", true),
    ],
  };
  const impact = transitiveCallers(graph, ["src/a.ts#foo"], 5);
  const byName = Object.fromEntries(impact.map((n) => [n.label.split(" ")[0], n.hop]));
  expect(byName["bar"]).toBe(1);
  expect(byName["baz"]).toBe(2);
  expect(impact.some((n) => n.label.startsWith("foo"))).toBe(false); // seed excluded
});

// AC6 (AFC-M04, flow 235) — the SYMBOL fixture must have explainable
// candidates. Measured before this change: `keryx gdgraph symbol "wikiAsk"`
// returned three definitions with no indication of WHY each was returned, so a
// reader could not tell an exact-name definition from a substring capture that
// merely contains the query. The tier is that reason, and it is carried in the
// data rather than re-derived by whichever renderer happens to print it.

test("a symbol candidate carries the tier that explains why it matched", () => {
  const exact = resolveSymbolCandidates(GRAPH.symbols!, "foo");
  expect(exact.map((c) => [c.symbol.id, c.tier])).toEqual([["src/a.ts#foo", "exact-name"]]);

  const insensitive = resolveSymbolCandidates(GRAPH.symbols!, "FOO");
  expect(insensitive.every((c) => c.tier === "case-insensitive-name")).toBe(true);
  expect(insensitive.map((c) => c.symbol.name).sort()).toEqual(["Foo", "foo"]);

  const substring = resolveSymbolCandidates(GRAPH.symbols!, "ba");
  expect(substring.map((c) => [c.symbol.name, c.tier])).toEqual([["bar", "name-contains-query"]]);
});

test("querySymbol reports which tier answered, so a substring hit is not read as a definition", () => {
  expect(querySymbol(GRAPH, "foo").matchTier).toBe("exact-name");
  expect(querySymbol(GRAPH, "ba").matchTier).toBe("name-contains-query");
  // No candidates at all ⇒ no tier to report, rather than a misleading one.
  expect(querySymbol(GRAPH, "nonexistent").matchTier).toBeUndefined();
});

test("transitiveCallers respects maxDepth", () => {
  const graph: GraphData = {
    nodes: [],
    edges: [],
    symbols: [A, B, sym("src/d.ts#baz", "baz", "src/d.ts", 40)],
    calls: [
      call("src/b.ts#bar", "src/a.ts#foo", true),
      call("src/d.ts#baz", "src/b.ts#bar", true),
    ],
  };
  const impact = transitiveCallers(graph, ["src/a.ts#foo"], 1);
  expect(impact.map((n) => n.label.split(" ")[0])).toEqual(["bar"]); // baz is hop 2, excluded
});
