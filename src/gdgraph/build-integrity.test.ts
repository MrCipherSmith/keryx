// Regression tests for the three defects that made gdgraph return wrong answers
// on keryx's own repository (review 2026-07-26, finding B-02):
//
//   1. `.claude/worktrees/**` (nested git checkouts of this repo) was indexed as
//      first-class source — 74% of all nodes were stale duplicates.
//   2. `affected` resolved a target with one `===`-or-`endsWith` predicate, so an
//      earlier suffix match beat a later exact match and ambiguity was silent.
//   3. `Bun.Transpiler#scanImports` erases type-only imports, and the regex
//      fallback that handles them was only reached when the transpiler threw — so
//      every `import type` edge was missing and type-only modules were orphans.
//
// Plus the artifact-parity invariant: `summary.md` must describe the very graph
// that was written to `storage/nodes.jsonl` in the same build.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildGraph } from "./build";
import { computeAffected } from "./affected";
import { getAffected, getOrphans, loadGraph } from "./query";
import { resolveGraphTarget } from "./target";
import type { GraphData } from "./types";
import { uniqueTestRoot } from "../lib/test-tmp";

// --- 1. nested-worktree pollution -------------------------------------------

test("buildGraph never indexes a nested checkout under .claude/worktrees", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-worktree");
  await reset(root);
  await mkdir(path.join(root, "src", "lib"), { recursive: true });
  await mkdir(path.join(root, ".claude", "worktrees", "wt-1", "src", "lib"), { recursive: true });

  await writeFile(path.join(root, "src", "lib", "fs.ts"), "export const real = true;\n");
  // A byte-identical copy of the repo inside the agent-harness worktree dir.
  await writeFile(
    path.join(root, ".claude", "worktrees", "wt-1", "src", "lib", "fs.ts"),
    "export const real = true;\n",
  );

  await buildGraph(root);
  const graph = await loadGraph(root);
  const paths = graph.nodes.map((node) => node.path);

  expect(paths).toEqual(["src/lib/fs.ts"]);
  expect(paths.some((file) => file.startsWith(".claude/"))).toBe(false);
});

// --- 2. target resolution ----------------------------------------------------

function graphOf(...paths: string[]): GraphData {
  return {
    nodes: paths.map((file) => ({ id: file, kind: "file", path: file, language: "typescript" })),
    edges: [],
  };
}

test("an exact path wins over an earlier-sorted suffix match", () => {
  // `.claude/...` sorts before `src/...`, so the old single-predicate `find`
  // returned the worktree copy for the exact target `src/lib/fs.ts`.
  const graph = graphOf(".claude/worktrees/wt-1/src/lib/fs.ts", "src/lib/fs.ts");

  expect(resolveGraphTarget(graph, "src/lib/fs.ts")).toBe("src/lib/fs.ts");
  expect(computeAffected(graph, "src/lib/fs.ts").target).toBe("src/lib/fs.ts");
  expect(getAffected(graph, "src/lib/fs.ts").target).toBe("src/lib/fs.ts");
});

test("a suffix match only matches on a path-segment boundary", () => {
  const graph = graphOf("src/lib/myfs.ts", "src/lib/fs.ts");

  expect(resolveGraphTarget(graph, "lib/fs.ts")).toBe("src/lib/fs.ts");
  // `fs.ts` must not be satisfied by `myfs.ts`.
  expect(resolveGraphTarget(graph, "fs.ts")).toBe("src/lib/fs.ts");
});

test("an ambiguous suffix refuses instead of guessing the first candidate", () => {
  const graph = graphOf("src/a/config.ts", "src/b/config.ts");

  expect(() => resolveGraphTarget(graph, "config.ts")).toThrow(/ambiguous/i);
  expect(() => computeAffected(graph, "config.ts")).toThrow(/src\/a\/config\.ts/);
  expect(() => getAffected(graph, "config.ts")).toThrow(/src\/b\/config\.ts/);
});

test("an unknown target still resolves to itself with an empty blast radius", () => {
  const graph = graphOf("src/lib/fs.ts");
  const result = computeAffected(graph, "./src/does-not-exist.ts");

  expect(result.target).toBe("src/does-not-exist.ts");
  expect(result.dependents).toEqual([]);
});

// --- 3. type-only import edges ----------------------------------------------

test("type-only imports produce graph edges and are not reported as orphans", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-typeonly");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });

  await writeFile(path.join(root, "src", "types.ts"), "export type Config = { ok: boolean };\n");
  // `import type` / `export type … from` are BOTH erased by the transpiler.
  await writeFile(
    path.join(root, "src", "consumer.ts"),
    [
      "import type { Config } from './types';",
      "export const make = (c: Config) => c;",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "src", "reexport.ts"),
    "export type { Config } from './types';\n",
  );

  await buildGraph(root);
  const graph = await loadGraph(root);

  const intoTypes = graph.edges
    .filter((edge) => edge.kind === "imports" && edge.to === "src/types.ts")
    .map((edge) => edge.from)
    .sort();
  expect(intoTypes).toEqual(["src/consumer.ts", "src/reexport.ts"]);

  // The whole point: a module imported only for its types is NOT an orphan.
  expect(getOrphans(graph)).not.toContain("src/types.ts");
  expect(getAffected(graph, "src/types.ts").dependents).toEqual([
    "src/consumer.ts",
    "src/reexport.ts",
  ]);
});

test("value imports still resolve when unioned with the regex fallback", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-union");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });

  await writeFile(path.join(root, "src", "dep.ts"), "export const dep = 1;\n");
  await writeFile(
    path.join(root, "src", "index.ts"),
    [
      "import { dep } from './dep';",
      "const lazy = () => import('./dep');",
      "export const out = { dep, lazy };",
      "",
    ].join("\n"),
  );

  await buildGraph(root);
  const graph = await loadGraph(root);

  // Unioning must not duplicate an edge the transpiler and the regex both see.
  const edges = graph.edges.filter((edge) => edge.from === "src/index.ts");
  expect(edges.map((edge) => edge.to)).toEqual(["src/dep.ts"]);
});

// --- 4. summary / storage parity --------------------------------------------

test("summary.md counts describe the graph written to storage in the same build", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-parity");
  await reset(root);
  await mkdir(path.join(root, "src", "feature"), { recursive: true });
  await mkdir(path.join(root, ".claude", "worktrees", "wt-1", "src"), { recursive: true });

  await writeFile(path.join(root, "src", "feature", "style.css"), ".x { color: red; }\n");
  await writeFile(
    path.join(root, "src", "feature", "index.ts"),
    ["import './style.css';", "export { value } from './value';", ""].join("\n"),
  );
  await writeFile(path.join(root, "src", "feature", "value.ts"), "export const value = 1;\n");
  await writeFile(path.join(root, ".claude", "worktrees", "wt-1", "src", "copy.ts"), "export const c = 1;\n");

  const result = await buildGraph(root);
  const graph = await loadGraph(root);
  const summary = await readFile(result.summaryPath, "utf8");

  const storedFiles = graph.nodes.filter((node) => node.kind === "file").length;
  const storedAssets = graph.nodes.filter((node) => node.kind === "asset").length;

  expect(summary).toContain(`- Source files indexed: ${storedFiles}`);
  expect(summary).toContain(`- Imported asset files indexed: ${storedAssets}`);
  expect(summary).toContain(`- Total nodes: ${graph.nodes.length}`);
  expect(summary).toContain(`- Edges: ${graph.edges.length}`);
  // And the storage file itself has exactly one line per node.
  const nodesJsonl = await readFile(
    path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
    "utf8",
  );
  expect(nodesJsonl.trimEnd().split("\n").length).toBe(graph.nodes.length);
});

async function reset(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
}
