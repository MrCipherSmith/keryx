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
// AC4 (flow 140) — an edge found only by the regex fallback (never seen by
// scanImports) is marked with an explicit unknown/static marker, never
// inferred dynamic.
//
// SUPERSEDED for the TS/JS type-only case by AFC-11 (flow 234, below): a
// fallback-only edge whose file the transpiler DID successfully scan is now
// known to be type-only, not merely "unknown" — it gets its own
// `TYPE_ONLY_IMPORT_KIND` so cycle detection can exclude it while impact
// analysis keeps it. The Java case is untouched: Java is routed straight to
// the fallback (`extractImportRecords` never calls `scanImports` for it), so
// its provenance is genuinely unknown and it keeps `unknown-static`.
// ---------------------------------------------------------------------------

test("AC4 (flow 140, still applies to Java) — a fallback-only Java edge is marked unknown-static, never inferred dynamic", async () => {
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

// ---------------------------------------------------------------------------
// AFC-11 (flow 234, phase 2) — frozen AC4:
//   "Type-only цикл не попадает в runtime список; mixed import с
//    runtime-частью попадает; consumer типа виден в impact; цикл сам по себе
//    не блокирует gate."
//
// Reproduced first (see the task report for the exact repro run), then fixed:
// a type-only cycle (`import type` on both sides) built as `unknown-static`
// and was reported by `getCycles` as a real runtime cycle, because
// `unknown-static` was — and for Java/unparseable TS still is — treated as
// load-order. The fix gives TS/JS type-only edges their own kind,
// `TYPE_ONLY_IMPORT_KIND` ("type-only"), which `getCycles` (query.ts)
// excludes from load-order adjacency the same way it already excludes
// `dynamic-import`, while every impact-analysis consumer (`getOrphans`,
// `getAffected`, `computeAffected`) is untouched because they read
// `edge.kind`, not `edge.importKind`.
// ---------------------------------------------------------------------------

// --- requirement 1 + classification table: the four "is it type-only?"
// spellings this task must distinguish. Each RED-failed against the
// pre-fix code with `edge?.importKind === "unknown-static"` (see report).

test("AFC-11 req1 — `import type { X } from './m'` (whole-statement) is classified type-only", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-afc11-import-type-whole");
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

  expect(edge?.importKind).toBe("type-only");
});

test("AFC-11 req1 — `import { type X } from './m'` (inline, all-type) is classified type-only", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-afc11-import-type-inline");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "consumer.ts"),
    "import { type Shape } from './types';\nexport const consumer: Shape = { ok: true } as Shape;\n",
  );
  await writeFile(path.join(root, "src", "types.ts"), "export interface Shape { ok: boolean }\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edge = graph.edges.find((item) => item.from === "src/consumer.ts" && item.to === "src/types.ts");

  expect(edge?.importKind).toBe("type-only");
});

test("AFC-11 req1 — `export type { X } from './m'` (whole-statement re-export) is classified type-only", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-afc11-export-type-whole");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "types.ts"), "export interface Shape { ok: boolean }\n");
  await writeFile(path.join(root, "src", "reexport.ts"), "export type { Shape } from './types';\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edge = graph.edges.find((item) => item.from === "src/reexport.ts" && item.to === "src/types.ts");

  expect(edge?.importKind).toBe("type-only");
});

test("AFC-11 req1 — `export { type X } from './m'` (inline re-export, all-type) is classified type-only", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-afc11-export-type-inline");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "types.ts"), "export interface Shape { ok: boolean }\n");
  await writeFile(path.join(root, "src", "reexport.ts"), "export { type Shape } from './types';\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edge = graph.edges.find((item) => item.from === "src/reexport.ts" && item.to === "src/types.ts");

  expect(edge?.importKind).toBe("type-only");
});

// --- requirement 1: the actual reported symptom — a two-file cycle formed
// only by type-only edges must not show up in `getCycles`.

test("AFC-11 req1 — a two-file cycle formed only by `import type` on both sides is NOT reported", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-afc11-cycle-import-type");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "a.ts"),
    "import type { BType } from './b';\nexport type AType = { b?: BType };\n",
  );
  await writeFile(
    path.join(root, "src", "b.ts"),
    "import type { AType } from './a';\nexport type BType = { a?: AType };\n",
  );

  await buildGraph(root);
  const graph = await loadGraph(root);
  const cycles = getCycles(graph);

  expect(cycles.some((cycle) => cycle.includes("src/a.ts") && cycle.includes("src/b.ts"))).toBe(false);
});

test("AFC-11 req1 — a two-file cycle formed only by `export type … from` on both sides is NOT reported", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-afc11-cycle-export-type");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export type { BType } from './b';\nexport type AType = {};\n");
  await writeFile(path.join(root, "src", "b.ts"), "export type { AType } from './a';\nexport type BType = {};\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const cycles = getCycles(graph);

  expect(cycles.some((cycle) => cycle.includes("src/a.ts") && cycle.includes("src/b.ts"))).toBe(false);
});

// --- a fifth, non-type-erasing spelling: a plain value import whose binding
// is used only in a type position at the use site. `import { x } from './m'`
// carries no `type` keyword anywhere, so the transpiler (this repo's
// tsconfig sets neither `importsNotUsedAsValues` nor `verbatimModuleSyntax`,
// so TypeScript's/Bun's default elision applies — see the report) does NOT
// erase it: erasure here is purely syntactic (was `type` written?), never a
// usage analysis (is the binding read only as a type elsewhere?). This test
// guards against a fix that tries to be "smarter" than the transpiler by
// inferring type-only-ness from usage — it must stay a real runtime edge.

test("`import { x } from './m'` used only in a type position stays import-statement (no usage-based erasure)", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-afc11-value-used-as-type");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "consumer.ts"),
    "import { value } from './lib';\nexport const y: typeof value = value;\n",
  );
  await writeFile(path.join(root, "src", "lib.ts"), "export const value = { ok: true };\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edge = graph.edges.find((item) => item.from === "src/consumer.ts" && item.to === "src/lib.ts");

  expect(edge?.importKind).toBe("import-statement");
});

// --- requirement 2 (over-correction guard) — a mixed import (one runtime
// specifier alongside a type specifier) still produces a real load-order
// edge, and a cycle closed through it IS reported. This is the test that
// would fail if requirement 1 were implemented too bluntly (e.g. by
// excluding every edge whose statement merely CONTAINS the word `type`).

test("AFC-11 req2 — `import { x, type Y } from './m'` (mixed) is classified import-statement, a real runtime edge", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-afc11-mixed-classification");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "consumer.ts"),
    "import { value, type Shape } from './lib';\nexport const consumer: Shape = value;\n",
  );
  await writeFile(
    path.join(root, "src", "lib.ts"),
    "export interface Shape { ok: boolean }\nexport const value = { ok: true };\n",
  );

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edge = graph.edges.find((item) => item.from === "src/consumer.ts" && item.to === "src/lib.ts");

  expect(edge?.importKind).toBe("import-statement");
});

test("AFC-11 req2 (the over-correction guard) — a two-file cycle where both directions are mixed imports IS reported", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-afc11-cycle-mixed-both");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "a.ts"),
    "import { b, type BType } from './b';\nexport type AType = { b?: BType };\nexport const a = () => b();\n",
  );
  await writeFile(
    path.join(root, "src", "b.ts"),
    "import { a, type AType } from './a';\nexport type BType = { a?: AType };\nexport const b = () => a();\n",
  );

  await buildGraph(root);
  const graph = await loadGraph(root);
  const cycles = getCycles(graph);

  expect(cycles.some((cycle) => cycle.includes("src/a.ts") && cycle.includes("src/b.ts"))).toBe(true);
});

// --- requirement 4 — a detected cycle is information only; it never throws,
// never sets a failure flag, and the JSON `getCycles` returns is exactly what
// a caller (CLI/MCP) renders as a plain list. There is no "gate" primitive in
// this module's return type to fail: proving that is proving there is no
// exception and no truthy/falsy "blocked" field mixed into the result.

// ---------------------------------------------------------------------------
// T19 finding 2 (flow 234 review) — `extractImportRecords` hardcoded the
// `tsx` transpiler loader for every `.ts` file. Under `tsx`, valid TypeScript
// syntax that collides with JSX grammar throws: a generic arrow function
// (`<T>(x: T): T => x`) and an angle-bracket cast (`<string>value`) are both
// ambiguous with a JSX opening tag. When the scan throws, EVERY specifier in
// the file falls back to the regex extractor with `scanResult.succeeded ===
// false`, so a type-only cycle between two such files was still classified
// `UNKNOWN_IMPORT_KIND` — which `getCycles` treats as load-order — defeating
// AC4 clause 1 on a real, constructible TypeScript input. Reproduced directly
// against `src/tui/shell-chrome.ts` / `src/sac/fwk-service.test.ts` (both
// throw under the `tsx` loader, both parse under `ts`) — see the task report.
// Fixed by choosing the loader from the file extension (`ts` for `.ts`,
// `tsx` for `.tsx`/`.jsx`), so a `.ts` file — which can never legally contain
// JSX — is parsed with JSX grammar disabled.
// ---------------------------------------------------------------------------

test("T19 finding 2 — a generic arrow function no longer breaks the scan for a .ts file", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-t19-generic-arrow");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "identity.ts"),
    "import { helper } from './helper';\nexport const identity = <T>(x: T): T => x;\nexport const used = helper();\n",
  );
  await writeFile(path.join(root, "src", "helper.ts"), "export const helper = () => 1;\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edge = graph.edges.find((item) => item.from === "src/identity.ts" && item.to === "src/helper.ts");

  // Before the fix: the `tsx` scan of identity.ts throws on `<T>(x: T)`, the
  // whole file falls back to the regex extractor, and this edge is
  // classified `unknown-static`, not the real `import-statement`.
  expect(edge?.importKind).toBe("import-statement");
});

test("T19 finding 2 — an angle-bracket cast no longer breaks the scan for a .ts file", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-t19-angle-cast");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "cast.ts"),
    "import { helper } from './helper';\nexport const cast = (value: unknown) => <string>value;\nexport const used = helper();\n",
  );
  await writeFile(path.join(root, "src", "helper.ts"), "export const helper = () => 1;\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edge = graph.edges.find((item) => item.from === "src/cast.ts" && item.to === "src/helper.ts");

  expect(edge?.importKind).toBe("import-statement");
});

test("T19 finding 2 — a type-only cycle between two files that also use a generic arrow / angle-bracket cast is NOT reported as a runtime cycle", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-t19-cycle-jsx-collision");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "a.ts"),
    [
      "import type { BType } from './b';",
      "export type AType = { b?: BType };",
      "export const identity = <T>(x: T): T => x;",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "src", "b.ts"),
    [
      "import type { AType } from './a';",
      "export type BType = { a?: AType };",
      "export const cast = (value: unknown) => <string>value;",
      "",
    ].join("\n"),
  );

  await buildGraph(root);
  const graph = await loadGraph(root);

  const edgeAB = graph.edges.find((item) => item.from === "src/a.ts" && item.to === "src/b.ts");
  const edgeBA = graph.edges.find((item) => item.from === "src/b.ts" && item.to === "src/a.ts");
  // Before the fix, both scans throw (the file collides with JSX grammar
  // under `tsx`), so both edges fall back to `unknown-static` — which
  // `getCycles` treats as load-order — instead of the real `type-only`.
  expect(edgeAB?.importKind).toBe("type-only");
  expect(edgeBA?.importKind).toBe("type-only");

  const cycles = getCycles(graph);
  expect(cycles.some((cycle) => cycle.includes("src/a.ts") && cycle.includes("src/b.ts"))).toBe(false);
});

// A genuinely unparseable `.ts` file must still classify as unknown — the
// fix must not weaken AC4 (flow 140) by treating every scan failure as
// type-only. Unbalanced syntax throws under BOTH the `ts` and `tsx` loaders
// (verified directly against `Bun.Transpiler` — see the task report), so this
// proves the retry/extension-selection does not paper over a real parse
// failure.
test("T19 finding 2 (both directions) — a genuinely unparseable .ts file still classifies its edges as unknown-static", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-t19-unparseable-ts");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "broken.ts"),
    "import { helper } from './helper';\nexport const broken = {\n",
  );
  await writeFile(path.join(root, "src", "helper.ts"), "export const helper = () => 1;\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edge = graph.edges.find((item) => item.from === "src/broken.ts" && item.to === "src/helper.ts");

  expect(edge?.importKind).toBe("unknown-static");
});

test("AFC-11 req4 — a real runtime cycle is reported without throwing, as plain data (not a gate failure)", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-afc11-gate");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "import { b } from './b';\nexport const a = () => b();\n");
  await writeFile(path.join(root, "src", "b.ts"), "import { a } from './a';\nexport const b = () => a();\n");

  await buildGraph(root);
  const graph = await loadGraph(root);

  expect(() => getCycles(graph)).not.toThrow();
  const cycles = getCycles(graph);
  expect(Array.isArray(cycles)).toBe(true);
  expect(cycles.length).toBeGreaterThan(0);
  // The return type is `string[][]` — there is no boolean/gate field on it to
  // assert "false" for; the absence of one IS the requirement.
});
