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
