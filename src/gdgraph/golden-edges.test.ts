// Flow 304 T8 (W7 AC5, GDGRAPH-2/GDGRAPH-3): golden edge-set fixtures.
//
// W7's correctness benchmark asks for EXACT edge-set equality (not fuzzy
// match) pinning three previously-unverified behaviors:
//   - a barrel `index.ts` (`export * from` + a type-only `export { type X }
//     from` re-export) — locks in the GDGRAPH-2 "verified correct" finding
//     so it cannot silently regress.
//   - a dynamic `import()` in ordinary application code — edge present,
//     kind `dynamic-import`.
//   - a `tsconfig.json` that `extends` a base config carrying `paths`
//     (GDGRAPH-3) — this task IMPLEMENTED the fix (`loadTsconfigResolver`'s
//     `resolveTsconfigOptions`, `src/gdgraph/build.ts`), so the inherited
//     `@lib/*` alias resolves to a real edge, not an unresolved specifier.
//
// Conventions mirror `import-kind.test.ts` / `wiki-layer.test.ts`:
// `uniqueTestRoot()`, `buildGraph(root)`, `loadGraph(root)`.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildGraph } from "./build";
import { loadGraph } from "./query";
import type { GraphEdge } from "./types";
import { uniqueTestRoot } from "../lib/test-tmp";

async function reset(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
}

// Edge-set equality helper: strip the build-assigned `id` (an incrementing
// counter, not part of the semantic edge identity) and sort so the
// comparison does not depend on build's own edge-discovery order.
function normalizeEdges(edges: GraphEdge[]): Array<Omit<GraphEdge, "id">> {
  return edges
    .map(({ id: _id, ...rest }) => rest)
    .sort((a, b) => `${a.from}->${a.to}:${a.specifier}`.localeCompare(`${b.from}->${b.to}:${b.specifier}`));
}

test("GDGRAPH-2 golden — a barrel `export *` plus a type-only `export { type X } from` re-export produce exactly two edges", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-golden-barrel");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "index.ts"),
    'export * from "./a";\nexport { type B } from "./b";\n',
  );
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "src", "b.ts"), "export type B = { ok: boolean };\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edgesFromIndex = graph.edges.filter((edge) => edge.from === "src/index.ts");

  expect(normalizeEdges(edgesFromIndex)).toEqual([
    {
      from: "src/index.ts",
      to: "src/a.ts",
      kind: "imports",
      specifier: "./a",
      importKind: "import-statement",
    },
    {
      from: "src/index.ts",
      to: "src/b.ts",
      kind: "imports",
      specifier: "./b",
      importKind: "type-only",
    },
  ]);
});

test("golden — a runtime `import()` in ordinary application code produces a dynamic-import edge", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-golden-dynamic-import");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "app.ts"),
    'export const load = async () => { const m = await import("./lazy"); return m; };\n',
  );
  await writeFile(path.join(root, "src", "lazy.ts"), "export const value = 1;\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edgesFromApp = graph.edges.filter((edge) => edge.from === "src/app.ts");

  expect(normalizeEdges(edgesFromApp)).toEqual([
    {
      from: "src/app.ts",
      to: "src/lazy.ts",
      kind: "imports",
      specifier: "./lazy",
      importKind: "dynamic-import",
    },
  ]);
});

// ---------------------------------------------------------------------------
// GDGRAPH-3 — before this task's fix, `loadTsconfigResolver`
// (`src/gdgraph/build.ts`) read only the root `tsconfig.json`'s own
// `compilerOptions`; an inherited alias from an `extends` chain resolved to
// nothing (the import stayed `unresolved`, no edge). The fix
// (`resolveTsconfigOptions`) walks the `extends` chain — relative/local
// specifiers only, depth-capped, cycle-guarded, child overrides parent field-
// by-field — so an alias declared only in the base config now resolves the
// same way `tsc` itself would. This fixture asserts the RESOLVED edge, which
// only exists because the fix landed; see the sibling test just below for
// what the pre-fix behavior looked like (still true for a bare package
// `extends`, which this fix deliberately does not follow).
// ---------------------------------------------------------------------------

test("GDGRAPH-3 golden — an alias inherited through tsconfig `extends` resolves to a real edge (fix implemented)", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-golden-tsconfig-extends");
  await reset(root);
  await mkdir(path.join(root, "src", "lib"), { recursive: true });
  await writeFile(
    path.join(root, "tsconfig.base.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } }),
  );
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: {} }),
  );
  await writeFile(
    path.join(root, "src", "app.ts"),
    'import { helper } from "@lib/x";\nexport const use = helper;\n',
  );
  await writeFile(path.join(root, "src", "lib", "x.ts"), "export const helper = 1;\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edgesFromApp = graph.edges.filter((edge) => edge.from === "src/app.ts");

  expect(normalizeEdges(edgesFromApp)).toEqual([
    {
      from: "src/app.ts",
      to: "src/lib/x.ts",
      kind: "imports",
      specifier: "@lib/x",
      importKind: "import-statement",
    },
  ]);
});

test("GDGRAPH-3 — a bare package `extends` (e.g. \"@tsconfig/node20\") is documented as unresolved, not followed, but does not block this config's OWN `paths`", async () => {
  // This fix intentionally does not resolve a package-specifier `extends`
  // (no leading "." or "/") — doing so would mean replicating node_modules
  // package resolution inside this cheap, dependency-light graph-build
  // resolver. Fix round 1 (F6 review): the previous version of this fixture
  // had NO `paths` anywhere in the chain, so it passed trivially whether or
  // not the `extends`-walking fix existed at all — a near-tautological
  // golden. This version pairs the unresolvable `extends` with `paths`
  // declared directly on the SAME (root) config, so the assertion actually
  // exercises the fix: an unresolvable base link degrades to "nothing
  // inherited from THAT link" without corrupting or dropping this config's
  // own directly-declared alias.
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-golden-tsconfig-extends-package");
  await reset(root);
  await mkdir(path.join(root, "src", "lib"), { recursive: true });
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      extends: "@tsconfig/node20/tsconfig.json",
      compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } },
    }),
  );
  await writeFile(
    path.join(root, "src", "app.ts"),
    'import { helper } from "@lib/x";\nexport const use = helper;\n',
  );
  await writeFile(path.join(root, "src", "lib", "x.ts"), "export const helper = 1;\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edgesFromApp = graph.edges.filter((edge) => edge.from === "src/app.ts");

  // The config's own `paths` resolve exactly as if the unreachable package
  // `extends` were not there at all.
  expect(normalizeEdges(edgesFromApp)).toEqual([
    {
      from: "src/app.ts",
      to: "src/lib/x.ts",
      kind: "imports",
      specifier: "@lib/x",
      importKind: "import-statement",
    },
  ]);
});

// ---------------------------------------------------------------------------
// GDGRAPH-3 fix round 1 (F6) — `baseUrl`/`paths` inherited through `extends`
// must resolve relative to the config file that DECLARES them, not relative
// to the project root. Before this fix, `config/tsconfig.base.json`
// declaring `baseUrl: ".."` (meaning "one level up from `config/`", i.e. the
// project root) was read as a literal `".."` measured from the project root
// instead — escaping it entirely, so the alias never resolved. These
// fixtures pin both correct variants (`baseUrl` escaping the subdirectory,
// and `paths` doing so directly per TS 4.1's "no baseUrl" rule) and the
// negative control (`baseUrl: "."` in the subdirectory, which must NOT reach
// outside it).
// ---------------------------------------------------------------------------

test("GDGRAPH-3 F6 golden — a subdirectory base's `baseUrl: \"..\"` escapes to the project root", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-golden-tsconfig-subdir-baseurl");
  await reset(root);
  await mkdir(path.join(root, "config"), { recursive: true });
  await mkdir(path.join(root, "src", "lib"), { recursive: true });
  await writeFile(
    path.join(root, "config", "tsconfig.base.json"),
    JSON.stringify({ compilerOptions: { baseUrl: "..", paths: { "@lib/*": ["src/lib/*"] } } }),
  );
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ extends: "./config/tsconfig.base.json", compilerOptions: {} }),
  );
  await writeFile(
    path.join(root, "src", "app.ts"),
    'import { helper } from "@lib/x";\nexport const use = helper;\n',
  );
  await writeFile(path.join(root, "src", "lib", "x.ts"), "export const helper = 1;\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edgesFromApp = graph.edges.filter((edge) => edge.from === "src/app.ts");

  expect(normalizeEdges(edgesFromApp)).toEqual([
    {
      from: "src/app.ts",
      to: "src/lib/x.ts",
      kind: "imports",
      specifier: "@lib/x",
      importKind: "import-statement",
    },
  ]);
});

test("GDGRAPH-3 F6 golden — a subdirectory base's `paths` without `baseUrl` resolve relative to the base's own directory (TS 4.1)", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-golden-tsconfig-subdir-paths-no-baseurl");
  await reset(root);
  await mkdir(path.join(root, "config"), { recursive: true });
  await mkdir(path.join(root, "src", "lib"), { recursive: true });
  await writeFile(
    path.join(root, "config", "tsconfig.base.json"),
    JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["../src/lib/*"] } } }),
  );
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ extends: "./config/tsconfig.base.json", compilerOptions: {} }),
  );
  await writeFile(
    path.join(root, "src", "app.ts"),
    'import { helper } from "@lib/x";\nexport const use = helper;\n',
  );
  await writeFile(path.join(root, "src", "lib", "x.ts"), "export const helper = 1;\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edgesFromApp = graph.edges.filter((edge) => edge.from === "src/app.ts");

  expect(normalizeEdges(edgesFromApp)).toEqual([
    {
      from: "src/app.ts",
      to: "src/lib/x.ts",
      kind: "imports",
      specifier: "@lib/x",
      importKind: "import-statement",
    },
  ]);
});

test("GDGRAPH-3 F6 golden (negative) — a subdirectory base's `baseUrl: \".\"` stays scoped to that subdirectory, not the project root", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-golden-tsconfig-subdir-baseurl-dot");
  await reset(root);
  await mkdir(path.join(root, "config"), { recursive: true });
  await mkdir(path.join(root, "src", "lib"), { recursive: true });
  // `baseUrl: "."` declared IN `config/` means "config/ itself" — `@lib/x`
  // resolves to `config/src/lib/x.ts`, a file that does not exist here. It
  // must NOT resolve to the real `src/lib/x.ts` at the project root: doing
  // so would mean this resolver ignored the declaring config's own directory
  // entirely (exactly the pre-fix bug, which happened to get this literal
  // value "right" only by coincidence).
  await writeFile(
    path.join(root, "config", "tsconfig.base.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } }),
  );
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ extends: "./config/tsconfig.base.json", compilerOptions: {} }),
  );
  await writeFile(
    path.join(root, "src", "app.ts"),
    'import { helper } from "@lib/x";\nexport const use = helper;\n',
  );
  await writeFile(path.join(root, "src", "lib", "x.ts"), "export const helper = 1;\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edgesFromApp = graph.edges.filter((edge) => edge.from === "src/app.ts");

  expect(edgesFromApp.some((edge) => edge.to === "src/lib/x.ts")).toBe(false);
});
