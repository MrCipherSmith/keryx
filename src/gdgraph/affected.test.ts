import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { computeAffected } from "./affected";
import { getAffected } from "./query";
import type { GraphData } from "./types";

const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/transitive-closure/", import.meta.url));

async function loadFixtureGraph(): Promise<GraphData> {
  const raw = JSON.parse(await readFile(path.join(FIXTURE_DIR, "graph.json"), "utf8"));
  return { nodes: raw.nodes, edges: raw.edges };
}

async function loadExpected(): Promise<any> {
  return JSON.parse(await readFile(path.join(FIXTURE_DIR, "expected.json"), "utf8"));
}

// The pre-block default renderer, replicated verbatim so we can assert the new
// path is byte-for-byte identical at depth 1 (AC2.2).
function renderDefault(result: { target: string; dependencies: string[]; dependents: string[] }): string {
  const lines: string[] = [];
  lines.push(`# Affected context for ${result.target}`);
  lines.push("");
  lines.push("## Dependencies");
  printList(lines, result.dependencies);
  lines.push("");
  lines.push("## Dependents");
  printList(lines, result.dependents);
  return lines.join("\n");
}

function printList(lines: string[], items: string[]): void {
  if (items.length === 0) {
    lines.push("- none");
    return;
  }
  for (const item of items) {
    lines.push(`- ${item}`);
  }
}

test("AC2.1 — exact N-hop dependent closure per target per depth", async () => {
  const graph = await loadFixtureGraph();
  const expected = await loadExpected();

  for (const [target, byDepth] of Object.entries(expected.closures) as [string, Record<string, string[]>][]) {
    for (const [depthKey, expectedSet] of Object.entries(byDepth)) {
      const result = computeAffected(graph, target, { depth: Number(depthKey) });
      expect(result.dependents).toEqual(expectedSet);
    }
  }
});

test("AC2.3 — cyclic fixture terminates and is deterministic across runs", async () => {
  const graph = await loadFixtureGraph();
  const a = computeAffected(graph, "src/x.ts", { depth: 10 });
  const b = computeAffected(graph, "src/x.ts", { depth: 10 });
  expect(a.dependents).toEqual(["src/y.ts", "src/z.ts"]);
  expect(a.dependents).toEqual(b.dependents);
});

test("AC2.2 — default / --depth 1 renderer is byte-identical to pre-block getAffected", async () => {
  const graph = await loadFixtureGraph();
  for (const target of ["src/a.ts", "src/b.ts", "src/e.ts", "src/x.ts"]) {
    const legacy = getAffected(graph, target);
    const next = computeAffected(graph, target, { depth: 1 });

    // Underlying data is set-equal (dependents + dependencies).
    expect(next.dependents).toEqual(legacy.dependents);
    expect(next.dependencies).toEqual(legacy.dependencies);
    // Rendered stdout is byte-for-byte identical.
    expect(renderDefault(next)).toBe(renderDefault(legacy));
  }
});

test("AC2.2 — no-flag default depth equals depth 1", async () => {
  const graph = await loadFixtureGraph();
  const noFlag = computeAffected(graph, "src/a.ts");
  const depth1 = computeAffected(graph, "src/a.ts", { depth: 1 });
  expect(noFlag.dependents).toEqual(depth1.dependents);
  expect(renderDefault(noFlag)).toBe(renderDefault(depth1));
});

test("AC2.4 — ranked output ordered hop asc → fanIn desc → path asc", async () => {
  const graph = await loadFixtureGraph();
  const expected = await loadExpected();
  const result = computeAffected(graph, "src/a.ts", { depth: 4, ranked: true });
  expect(result.ranked).toEqual(expected.ranked["src/a.ts"]["4"]);
});

test("AC2.4 — dependencies are the unchanged one-hop forward set", async () => {
  const graph = await loadFixtureGraph();
  const expected = await loadExpected();
  for (const [target, deps] of Object.entries(expected.dependencies) as [string, string[]][]) {
    const result = computeAffected(graph, target, { depth: 3 });
    expect(result.dependencies).toEqual(deps);
  }
});

// ---------------------------------------------------------------------------
// AFC-11 (flow 234) requirement 3 — a type consumer is visible in impact
// analysis. `edge.importKind === "type-only"` is erased at runtime and is
// excluded from `getCycles`' load-order adjacency, but the edge itself is
// still `kind: "imports"` — a real dependency for "what do I have to
// re-check" — so `computeAffected` (and `getAffected`) must keep surfacing
// it. Constructed in-memory rather than through `buildGraph()`: this is a
// pure-function contract on `GraphData`, unrelated to how the edge's
// `importKind` was derived.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AC6 (AFC-M04, flow 235) — the IMPACT fixture's half of "важный связанный код
// не уступает нерелевантной глобальной популярности".
//
// This clause was measured as ALREADY HOLDING for `affected`: `rankOrder`
// sorts hop asc first and only then fanIn desc, so proximity to the target
// always beats global popularity. But "already holds" is a claim about a sort
// comparator, and a comparator can be reordered in one line by anyone who
// thinks fan-in is the more useful primary key. This fixture is the guard: it
// is built so the plausible-but-wrong ranking — fan-in first, which looks
// entirely reasonable in isolation — is visibly wrong.
//
//   direct.ts    is a hop-1 dependent with fanIn 0   (the file you must read)
//   celebrity.ts is a hop-2 dependent with fanIn 500 (everybody imports it)
//
// Under fan-in-first the celebrity leads the blast radius of a change it is two
// hops from. Under hop-first it does not.
// ---------------------------------------------------------------------------

test("AC6 — a direct dependent outranks a distant one no matter how popular it is", () => {
  const nodes = [
    { id: "src/target.ts", kind: "file" as const, path: "src/target.ts", language: "typescript" as const },
    { id: "src/direct.ts", kind: "file" as const, path: "src/direct.ts", language: "typescript" as const },
    { id: "src/celebrity.ts", kind: "file" as const, path: "src/celebrity.ts", language: "typescript" as const },
  ];
  const edges = [
    // direct.ts → target.ts (hop 1 dependent of target)
    { id: "e:direct", from: "src/direct.ts", to: "src/target.ts", kind: "imports" as const, specifier: "./target" },
    // celebrity.ts → direct.ts (hop 2 dependent of target)
    { id: "e:celeb", from: "src/celebrity.ts", to: "src/direct.ts", kind: "imports" as const, specifier: "./direct" },
    // …and 500 unrelated files import celebrity.ts.
    ...Array.from({ length: 500 }, (_, i) => ({
      id: `e:fan${i}`,
      from: `src/fan/${i}.ts`,
      to: "src/celebrity.ts",
      kind: "imports" as const,
      specifier: "../celebrity",
    })),
  ];

  // Depth 2: the 500 fans are hop-3 and out of scope here — the question is
  // only whether hop 1 beats a much more popular hop 2.
  const result = computeAffected({ nodes, edges }, "src/target.ts", { depth: 2, ranked: true });
  const order = result.ranked.map((entry) => entry.path);

  expect(order).toEqual(["src/direct.ts", "src/celebrity.ts"]);
  // The candidate's own explanation: hop is the reason, fan-in is the tie-break.
  expect(result.ranked[0]).toMatchObject({ path: "src/direct.ts", hop: 1, fanIn: 1 });
  expect(result.ranked[1]).toMatchObject({ path: "src/celebrity.ts", hop: 2, fanIn: 500 });
});

test("AFC-11 req3 — a file that only type-imports the target is still a visible dependent", () => {
  const graph: GraphData = {
    nodes: [
      { id: "src/types.ts", kind: "file", path: "src/types.ts", language: "typescript" },
      { id: "src/consumer.ts", kind: "file", path: "src/consumer.ts", language: "typescript" },
    ],
    edges: [
      {
        id: "edge:1",
        from: "src/consumer.ts",
        to: "src/types.ts",
        kind: "imports",
        specifier: "./types",
        importKind: "type-only",
      },
    ],
  };

  expect(computeAffected(graph, "src/types.ts").dependents).toEqual(["src/consumer.ts"]);
  expect(getAffected(graph, "src/types.ts").dependents).toEqual(["src/consumer.ts"]);
});
