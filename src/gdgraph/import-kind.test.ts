// P1 remediation (flow 140) — `keryx gdgraph query cycles` was folding
// `await import()` edges into the load-order cycle count. `Bun.Transpiler
// #scanImports` already reports whether a specifier is a static
// import-statement, a dynamic-import, a require-call, etc.; `build.ts` threw
// that classification away one line after receiving it. These tests are
// written FIRST (TDD RED) against the frozen acceptance criteria in
// `.metaproject/flows/140-2026-08-07-gdgraph-dynamic-import-edges/acceptance-criteria.md`.
//
// Conventions mirror build.test.ts / build-lang.test.ts: uniqueTestRoot(),
// reset(root), buildGraph(root), loadGraph(root).

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildGraph } from "./build";
import { getCycles, loadGraph } from "./query";
import { uniqueTestRoot } from "../lib/test-tmp";

async function reset(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
}

// ---------------------------------------------------------------------------
// AC1 — every edge the transpiler produced carries the kind scanImports
// actually returned, and it survives to the written edge record.
// ---------------------------------------------------------------------------

test("AC1 — the transpiler's import kind survives onto the written edge record", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-import-kind-ac1");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "index.ts"),
    [
      "import { staticValue } from './static';",
      "const loadDynamic = async () => { const { dynamicValue } = await import('./dynamic'); return dynamicValue; };",
      "const required = require('./required');",
      "export const result = { staticValue, loadDynamic, required };",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(root, "src", "static.ts"), "export const staticValue = 1;\n");
  await writeFile(path.join(root, "src", "dynamic.ts"), "export const dynamicValue = 2;\n");
  await writeFile(path.join(root, "src", "required.ts"), "export const requiredValue = 3;\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edgesFromIndex = graph.edges.filter(
    (edge) => edge.from === "src/index.ts" && edge.kind === "imports",
  );
  const importKindByTarget = new Map(edgesFromIndex.map((edge) => [edge.to, edge.importKind]));

  expect(importKindByTarget.get("src/static.ts")).toBe("import-statement");
  expect(importKindByTarget.get("src/dynamic.ts")).toBe("dynamic-import");
  expect(importKindByTarget.get("src/required.ts")).toBe("require-call");
});

test("a specifier imported both statically and dynamically in the same file keeps the static classification", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-import-kind-mixed-specifier");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "index.ts"),
    [
      "import './shared';",
      "const loadAgain = async () => { await import('./shared'); };",
      "export const result = loadAgain;",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(root, "src", "shared.ts"), "export const shared = true;\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edge = graph.edges.find((item) => item.from === "src/index.ts" && item.to === "src/shared.ts");

  expect(edge?.importKind).toBe("import-statement");
});

// ---------------------------------------------------------------------------
// AC2 — a fixture reproducing the target's shape: one static edge, one
// dynamic-import edge back, no longer reported as a load-order cycle.
// ---------------------------------------------------------------------------

test("AC2 — a cycle closed only through a dynamic-import edge is no longer reported as load-order", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-cycle-mixed");
  await reset(root);
  await mkdir(path.join(root, "bot", "commands"), { recursive: true });
  // Mirrors the target's shape: commands/menu.ts statically imports
  // callbacks.ts; callbacks.ts reaches back into menu.ts only via `await
  // import()`.
  await writeFile(
    path.join(root, "bot", "commands", "menu.ts"),
    "import { registerCallback } from '../callbacks';\nexport const menu = () => registerCallback();\n",
  );
  await writeFile(
    path.join(root, "bot", "callbacks.ts"),
    [
      "export const registerCallback = () => 1;",
      "export const handleMenuCallback = async () => {",
      "  const { menu } = await import('./commands/menu');",
      "  return menu();",
      "};",
      "",
    ].join("\n"),
  );

  await buildGraph(root);
  const graph = await loadGraph(root);
  const cycles = getCycles(graph);

  expect(
    cycles.some((cycle) => cycle.includes("bot/callbacks.ts") && cycle.includes("bot/commands/menu.ts")),
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// AC3 — classification both ways, same two-file cycle shape.
// ---------------------------------------------------------------------------

test("AC3 — a two-file cycle formed by static imports IS reported", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-cycle-static");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "import { b } from './b';\nexport const a = () => b();\n");
  await writeFile(path.join(root, "src", "b.ts"), "import { a } from './a';\nexport const b = () => a();\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const cycles = getCycles(graph);

  expect(cycles.some((cycle) => cycle.includes("src/a.ts") && cycle.includes("src/b.ts"))).toBe(true);
});

test("AC3 — the same two-file cycle formed by await import() is NOT reported as load-order", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-cycle-dynamic");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "a.ts"),
    "export const a = async () => { const { b } = await import('./b'); return b(); };\n",
  );
  await writeFile(
    path.join(root, "src", "b.ts"),
    "export const b = async () => { const { a } = await import('./a'); return a(); };\n",
  );

  await buildGraph(root);
  const graph = await loadGraph(root);
  const cycles = getCycles(graph);

  expect(cycles.some((cycle) => cycle.includes("src/a.ts") && cycle.includes("src/b.ts"))).toBe(false);
});

// ---------------------------------------------------------------------------
// AC4 — an edge found only by the regex fallback (never seen by scanImports)
// is marked with an explicit unknown/static marker, never inferred dynamic.
// A type-only import is the real-world case: `Bun.Transpiler#scanImports`
// erases `import type {...}` entirely, so it reaches the graph only through
// `extractImportSpecifiersFallback`.
// ---------------------------------------------------------------------------

test("AC4 — a fallback-only edge (type-only import) is marked unknown-static, never inferred dynamic", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-import-kind-ac4");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "consumer.ts"),
    "import type { Shape } from './types';\nexport const consumer: Shape = { ok: true } as Shape;\n",
  );
  await writeFile(path.join(root, "src", "types.ts"), "export interface Shape { ok: boolean }\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edge = graph.edges.find((item) => item.from === "src/consumer.ts" && item.to === "src/types.ts");

  expect(edge).toBeDefined();
  expect(edge?.importKind).toBe("unknown-static");
  expect(edge?.importKind).not.toBe("dynamic-import");
});

test("AC4 — Java imports (fallback-only language) are marked unknown-static, never dynamic", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-import-kind-java");
  await reset(root);
  const javaRoot = path.join(root, "src", "main", "java", "com", "example");
  await mkdir(javaRoot, { recursive: true });
  await writeFile(
    path.join(javaRoot, "Consumer.java"),
    "package com.example;\nimport com.example.Model;\npublic class Consumer {}\n",
  );
  await writeFile(path.join(javaRoot, "Model.java"), "package com.example;\npublic class Model {}\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edge = graph.edges.find(
    (item) =>
      item.from === "src/main/java/com/example/Consumer.java" &&
      item.to === "src/main/java/com/example/Model.java",
  );

  expect(edge).toBeDefined();
  expect(edge?.importKind).toBe("unknown-static");
});
