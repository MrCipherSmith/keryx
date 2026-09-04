// LWG-8 impact propagation (flow 226): AC1, AC2, AC3.

import { describe, expect, test } from "bun:test";
import type { GraphData } from "../../gdgraph/types";
import type { ClassifiedChange } from "./classify-change";
import { propagate } from "./propagate";

function file(path: string) {
  return { id: path, kind: "file" as const, path, language: "typescript" as const };
}

function describes(page: string, to: string, id: string) {
  return { id, from: `wiki:${page}`, to, pattern: to, origin: "key-files" as const };
}

function imports(from: string, to: string, id: string) {
  return { id, from, to, kind: "imports" as const, specifier: to };
}

/**
 *   core.ts  <-- mid.ts  <-- leaf.ts        (imports point at what they use)
 *   pages: core.md -> core.ts, mid.md -> mid.ts, leaf.md -> leaf.ts
 */
const GRAPH: GraphData = {
  nodes: [file("src/core.ts"), file("src/mid.ts"), file("src/leaf.ts"), file("src/lonely.ts")],
  edges: [imports("src/mid.ts", "src/core.ts", "e1"), imports("src/leaf.ts", "src/mid.ts", "e2")],
  describes: [
    describes("components/core.md", "src/core.ts", "d1"),
    describes("components/mid.md", "src/mid.ts", "d2"),
    describes("components/leaf.md", "src/leaf.ts", "d3"),
  ],
};

function change(overrides: Partial<ClassifiedChange> & { path: string }): ClassifiedChange {
  return { changeClass: "body", symbols: [], ...overrides };
}

function byPage(result: ReturnType<typeof propagate>) {
  return Object.fromEntries(result.pages.map((p) => [p.pageId, p.confidence]));
}

describe("seeding", () => {
  test("a cosmetic change produces NO entry at all (AC1)", () => {
    const result = propagate({
      graph: GRAPH,
      changes: [change({ path: "src/core.ts", changeClass: "cosmetic" })],
    });
    // Not a weak entry — none. A fyi row per reflowed file is indistinguishable
    // from noise, which is what the class exists to prevent.
    expect(result.pages).toEqual([]);
  });

  test("a signature change reaches its own page at full strength (AC2)", () => {
    const result = propagate({
      graph: GRAPH,
      changes: [change({ path: "src/core.ts", changeClass: "signature", symbols: ["run"] })],
    });
    expect(byPage(result)["wiki:components/core.md"]).toBe("must-refresh");
  });

  test("a body-only change reaches its own page, weakly, and goes no further", () => {
    const result = propagate({
      graph: GRAPH,
      changes: [change({ path: "src/core.ts", changeClass: "body" })],
    });
    expect(byPage(result)).toEqual({ "wiki:components/core.md": "review-suggested" });
  });
});

describe("direction and decay", () => {
  test("a signature change walks to dependents, decaying each hop", () => {
    const result = propagate({
      graph: GRAPH,
      changes: [change({ path: "src/core.ts", changeClass: "signature", symbols: ["run"] })],
    });
    expect(byPage(result)).toEqual({
      "wiki:components/core.md": "must-refresh",
      "wiki:components/mid.md": "review-suggested",
      "wiki:components/leaf.md": "fyi",
    });
  });

  test("the walk stops when confidence is exhausted, not at a hop count", () => {
    // leaf.md is reached at `fyi`; anything importing leaf would decay below
    // it and must not appear.
    const deeper: GraphData = {
      ...GRAPH,
      nodes: [...GRAPH.nodes, file("src/outer.ts")],
      edges: [...GRAPH.edges, imports("src/outer.ts", "src/leaf.ts", "e3")],
      describes: [...(GRAPH.describes ?? []), describes("components/outer.md", "src/outer.ts", "d4")],
    };
    const result = propagate({
      graph: deeper,
      changes: [change({ path: "src/core.ts", changeClass: "signature" })],
    });
    expect(Object.keys(byPage(result))).not.toContain("wiki:components/outer.md");
  });

  test("dependencies are NOT walked — a consumer changing does not invalidate its dependency's docs", () => {
    const result = propagate({
      graph: GRAPH,
      changes: [change({ path: "src/leaf.ts", changeClass: "signature" })],
    });
    expect(Object.keys(byPage(result))).toEqual(["wiki:components/leaf.md"]);
  });

  test("a body change does not travel outward at all", () => {
    const result = propagate({
      graph: GRAPH,
      changes: [change({ path: "src/core.ts", changeClass: "body" })],
    });
    expect(Object.keys(byPage(result))).not.toContain("wiki:components/mid.md");
  });
});

describe("reason chains (AC3)", () => {
  test("every affected page carries a non-empty, traceable reason", () => {
    const result = propagate({
      graph: GRAPH,
      changes: [change({ path: "src/core.ts", changeClass: "signature", symbols: ["run"] })],
    });
    for (const page of result.pages) {
      expect(page.reasons.length).toBeGreaterThan(0);
      for (const reason of page.reasons) {
        expect(reason.sourcePath).toBe("src/core.ts");
        expect(reason.changeClass).toBe("signature");
        expect(reason.edgePath.at(-1)).toBe("describes");
      }
    }
  });

  test("the edge path lengthens with distance, so a reader can see how far it travelled", () => {
    const result = propagate({
      graph: GRAPH,
      changes: [change({ path: "src/core.ts", changeClass: "signature" })],
    });
    const own = result.pages.find((p) => p.pageId === "wiki:components/core.md");
    const far = result.pages.find((p) => p.pageId === "wiki:components/leaf.md");
    expect(own?.reasons[0]?.edgePath).toEqual(["describes"]);
    expect(far?.reasons[0]?.edgePath).toEqual(["imports", "imports", "describes"]);
  });

  test("two changes reaching one page keep both reasons and the stronger confidence", () => {
    const result = propagate({
      graph: GRAPH,
      changes: [
        change({ path: "src/core.ts", changeClass: "signature" }),
        change({ path: "src/mid.ts", changeClass: "signature" }),
      ],
    });
    const mid = result.pages.find((p) => p.pageId === "wiki:components/mid.md");
    expect(mid?.confidence).toBe("must-refresh");
    expect(mid?.reasons.map((r) => r.sourcePath).sort()).toEqual(["src/core.ts", "src/mid.ts"]);
  });
});

describe("renames and partial graphs", () => {
  test("a rename also reaches the page describing the OLD path", () => {
    const result = propagate({
      graph: GRAPH,
      changes: [
        change({ path: "src/renamed.ts", previousPath: "src/core.ts", changeClass: "moved" }),
      ],
    });
    // Only the old path can find the page whose describes edge still points there.
    expect(byPage(result)["wiki:components/core.md"]).toBe("must-refresh");
  });

  test("unresolved edges are reported so partial coverage is visible", () => {
    const partial: GraphData = {
      ...GRAPH,
      edges: [
        ...GRAPH.edges,
        { id: "u1", from: "src/core.ts", to: "somewhere", kind: "unresolved", specifier: "x" },
      ],
    };
    const result = propagate({ graph: partial, changes: [change({ path: "src/core.ts" })] });
    expect(result.unresolvedEdgesPresent).toBe(true);
  });

  test("a change to a file no page describes yields nothing, without error", () => {
    const result = propagate({
      graph: GRAPH,
      changes: [change({ path: "src/lonely.ts", changeClass: "signature" })],
    });
    expect(result.pages).toEqual([]);
  });

  test("an absent describes layer yields no pages rather than throwing", () => {
    const result = propagate({
      graph: { nodes: GRAPH.nodes, edges: GRAPH.edges },
      changes: [change({ path: "src/core.ts", changeClass: "signature" })],
    });
    expect(result.pages).toEqual([]);
  });
});

describe("call edges", () => {
  const withCalls: GraphData = {
    ...GRAPH,
    calls: [
      { id: "c1", from: "src/lonely.ts#useIt", to: "src/core.ts#run", kind: "calls", resolved: true },
    ],
    describes: [...(GRAPH.describes ?? []), describes("components/lonely.md", "src/lonely.ts", "d5")],
  };

  test("callers are reached when the callee's shape moved", () => {
    const result = propagate({
      graph: withCalls,
      changes: [change({ path: "src/core.ts", changeClass: "signature", symbols: ["run"] })],
    });
    expect(byPage(result)["wiki:components/lonely.md"]).toBe("review-suggested");
  });

  test("callers are NOT reached for a body-only change — every call site is still valid", () => {
    const result = propagate({
      graph: withCalls,
      changes: [change({ path: "src/core.ts", changeClass: "body" })],
    });
    expect(Object.keys(byPage(result))).not.toContain("wiki:components/lonely.md");
  });
});
