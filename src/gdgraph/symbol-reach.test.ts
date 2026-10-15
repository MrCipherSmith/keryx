// Flow 457 AC1: the review blast radius follows changed exported symbols.

import { describe, expect, test } from "bun:test";
import { affectedExports, computeSymbolReach, type FileDiff, outlineModule, parseDiffHunks, type SourceReader } from "./symbol-reach";
import type { GraphData, GraphEdge } from "./types";

type Fixture = Record<string, string>;

/** A graph whose edges are the fixture's own relative imports, resolved to `.ts` files. */
function graphOf(files: Fixture): GraphData {
  const edges: GraphEdge[] = [];
  for (const [from, source] of Object.entries(files)) {
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      const specifier = match[1] as string;
      const dir = from.split("/").slice(0, -1).join("/");
      const to = `${dir}/${specifier.replace(/^\.\//, "")}.ts`;
      if (files[to] === undefined) continue;
      edges.push({ id: `${from}->${to}`, from, to, kind: "imports", specifier });
    }
  }
  return { nodes: Object.keys(files).map((path) => ({ id: path, kind: "file", path, language: "typescript" })), edges };
}

function reader(head: Fixture, base?: Fixture): SourceReader {
  return { head: (file) => head[file], ...(base === undefined ? {} : { base: (file: string) => base[file] }) };
}

const lineOf = (source: string, needle: string): number => source.split("\n").findIndex((line) => line.includes(needle)) + 1;

function edit(file: string, newStart: number, newLines = 1, oldStart = newStart, oldLines = newLines): Map<string, FileDiff> {
  return new Map([[file, { path: file, oldPath: file, hunks: [{ oldStart, oldLines, newStart, newLines }] }]]);
}

const CORE = [
  "import { join } from \"node:path\";",
  "",
  "/** alpha */",
  "export function alpha(): number {",
  "  return helper() + 1;",
  "}",
  "",
  "function helper(): number {",
  "  return 41;",
  "}",
  "",
  "export function beta(): string {",
  "  return join(\"a\", \"b\");",
  "}",
  "",
  "export const gamma = 3;",
  "",
].join("\n");

const BASE_FILES: Fixture = {
  "src/core.ts": CORE,
  "src/uses-alpha.ts": 'import { alpha } from "./core";\n\nexport function useAlpha(): number {\n  return alpha();\n}\n\nexport const other = 1;\n',
  "src/uses-beta.ts": 'import { beta } from "./core";\n\nexport const b = beta();\n',
  "src/index.ts": 'export * from "./core";\n',
  "src/via-barrel.ts": 'import { alpha } from "./index";\n\nexport const viaBarrel = alpha();\n',
  "src/via-barrel-beta.ts": 'import { beta } from "./index";\n\nexport const viaBarrelBeta = beta();\n',
  "src/second-hop.ts": 'import { useAlpha } from "./uses-alpha";\n\nexport const second = useAlpha();\n',
  "src/other-hop.ts": 'import { other } from "./uses-alpha";\n\nexport const third = other;\n',
  "src/ns.ts": 'import * as core from "./core";\n\nexport const n = core.gamma;\n',
};

function reach(files: Fixture, diff: Map<string, FileDiff>, options: { base?: Fixture; depth?: number; changed?: string[] } = {}) {
  const changed = options.changed ?? [...diff.keys()];
  return computeSymbolReach({
    graph: graphOf(files),
    seeds: changed,
    changedFiles: changed,
    diff,
    read: reader(files, options.base),
    depth: options.depth ?? 2,
  });
}

const files = (result: ReturnType<typeof reach>): string[] => result.reached.map((entry) => entry.file);

describe("symbol reach (AC1)", () => {
  test("a body edit seeds only the export it sits in, and importers of other exports are unrelated", () => {
    const result = reach(BASE_FILES, edit("src/core.ts", lineOf(CORE, "return helper() + 1")));
    expect(result.seeds[0]).toMatchObject({ file: "src/core.ts", mode: "symbol", names: ["alpha"] });
    expect(files(result)).toEqual(["src/ns.ts", "src/uses-alpha.ts", "src/via-barrel.ts", "src/second-hop.ts"]);
    const omitted = Object.fromEntries(result.omitted.map((entry) => [entry.file, entry.reason]));
    expect(omitted["src/uses-beta.ts"]).toBe("unrelated-symbol");
    expect(omitted["src/via-barrel-beta.ts"]).toBe("unrelated-symbol");
    expect(omitted["src/other-hop.ts"]).toBe("unrelated-symbol");
    expect(result.omitted.find((entry) => entry.file === "src/uses-beta.ts")?.detail).toContain("imports {beta}");
  });

  test("a barrel passes the names through without counting a hop", () => {
    const result = reach(BASE_FILES, edit("src/core.ts", lineOf(CORE, "return helper() + 1")));
    expect(result.barrels).toEqual(["src/index.ts"]);
    const viaBarrel = result.reached.find((entry) => entry.file === "src/via-barrel.ts");
    expect(viaBarrel?.hop).toBe(1);
    expect(viaBarrel?.path).toEqual(["src/via-barrel.ts", "src/index.ts", "src/core.ts"]);
    expect(files(result)).not.toContain("src/index.ts");
  });

  test("an edit to a non-exported helper reaches the exports that call it", () => {
    const result = reach(BASE_FILES, edit("src/core.ts", lineOf(CORE, "return 41")));
    expect(result.seeds[0]?.names).toEqual(["alpha"]);
    expect(files(result)).toContain("src/uses-alpha.ts");
    expect(files(result)).not.toContain("src/uses-beta.ts");
  });

  test("an edited import line reaches the exports that use the binding", () => {
    const result = reach(BASE_FILES, edit("src/core.ts", 1));
    expect(result.seeds[0]?.names).toEqual(["beta"]);
    expect(files(result)).toContain("src/uses-beta.ts");
    expect(files(result)).not.toContain("src/uses-alpha.ts");
  });

  test("a comment-only edit changes no export and reaches nothing", () => {
    const result = reach(BASE_FILES, edit("src/core.ts", lineOf(CORE, "/** alpha */")));
    expect(result.seeds[0]?.names).toEqual([]);
    expect(result.reached).toEqual([]);
  });

  test("an export removed at the head reaches its importers through the base", () => {
    const base = { ...BASE_FILES, "src/core.ts": `${CORE}export function delta(): number {\n  return 4;\n}\n` };
    const head = { ...BASE_FILES, "src/uses-delta.ts": 'import { delta } from "./core";\n\nexport const d = delta();\n' };
    const deletedAt = CORE.split("\n").length;
    const result = reach(head, edit("src/core.ts", deletedAt - 1, 0, deletedAt, 3), { base });
    expect(result.seeds[0]?.names).toEqual(["delta"]);
    // The namespace importer is a consumer of every name; the named importers of other exports are not.
    expect(files(result)).toEqual(["src/ns.ts", "src/uses-delta.ts"]);
  });

  test("an `export { a, b }` list edit seeds the names on the list", () => {
    const source = "function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\nexport { a, b as bee };\n";
    const head: Fixture = { "src/m.ts": source, "src/x.ts": 'import { bee } from "./m";\nexport const x = bee();\n', "src/y.ts": 'import { a } from "./m";\nexport const y = a();\n' };
    const result = reach(head, edit("src/m.ts", lineOf(source, "export {")));
    expect(result.seeds[0]?.names).toEqual(["a", "bee"]);
    expect(files(result)).toEqual(["src/x.ts", "src/y.ts"]);
    const bodyOnly = reach(head, edit("src/m.ts", lineOf(source, "return 2")));
    expect(bodyOnly.seeds[0]?.names).toEqual(["bee"]);
    expect(files(bodyOnly)).toEqual(["src/x.ts"]);
  });

  test("a high fan-in hub damps its importers instead of walking them", () => {
    const hub: Fixture = { "src/hub.ts": "export function t(key: string): string {\n  return key;\n}\n" };
    for (let index = 0; index < 400; index += 1) hub[`src/c${index}.ts`] = `import { t } from "./hub";\nexport const v${index} = t("k");\n`;
    const result = reach(hub, edit("src/hub.ts", 2));
    expect(result.reached).toEqual([]);
    expect(result.omitted).toHaveLength(400);
    expect(new Set(result.omitted.map((entry) => entry.reason))).toEqual(new Set(["hub-damped"]));
    expect(result.omitted[0]?.detail).toContain("fan-in 400");
    // The same hub under the free fan-in is walked.
    const small: Fixture = { "src/hub.ts": hub["src/hub.ts"] as string, "src/c0.ts": hub["src/c0.ts"] as string };
    expect(files(reach(small, edit("src/hub.ts", 2)))).toEqual(["src/c0.ts"]);
  });

  test("damping multiplies along the path: a mid fan-in node behind another is cut at hop 2", () => {
    const fixture: Fixture = { "src/a.ts": "export function f(): number {\n  return 1;\n}\n", "src/b.ts": 'import { f } from "./a";\nexport function g(): number {\n  return f();\n}\n' };
    for (let index = 0; index < 150; index += 1) fixture[`src/p${index}.ts`] = `import { f } from "./a";\nexport const p${index} = f();\n`;
    for (let index = 0; index < 150; index += 1) fixture[`src/q${index}.ts`] = `import { g } from "./b";\nexport const q${index} = g();\n`;
    const result = reach(fixture, edit("src/a.ts", 2));
    expect(result.reached.filter((entry) => entry.hop === 1)).toHaveLength(151);
    expect(result.reached.filter((entry) => entry.hop === 2)).toHaveLength(0);
    expect(result.omitted.filter((entry) => entry.reason === "hub-damped")).toHaveLength(150);
  });

  describe("hop 2 goes only through exports that depend on the changed names", () => {
    const changeAlpha = (): Map<string, FileDiff> => edit("src/core.ts", lineOf(CORE, "return helper() + 1"));
    const withImporter = (file: string, source: string): Fixture => ({
      "src/core.ts": CORE,
      [file]: source,
      "src/downstream.ts": `import { exposed } from "./${file.slice(4, -3)}";\nexport const d = exposed;\n`,
    });

    test("an importer that uses the changed symbol only internally is a leaf: reached, not expanded", () => {
      const fixture = withImporter(
        "src/leaf.ts",
        'import { alpha } from "./core";\n\nfunction inner(): number {\n  return alpha();\n}\nconsole.log(inner());\n\nexport const exposed = 1;\n',
      );
      const result = reach(fixture, changeAlpha());
      expect(result.reached.find((entry) => entry.file === "src/leaf.ts")).toMatchObject({ hop: 1, names: [] });
      expect(files(result)).not.toContain("src/downstream.ts");
    });

    test("a wrapper export (body or signature) is expanded to its importers", () => {
      const wrapper = withImporter("src/wrapper.ts", 'import { alpha } from "./core";\n\nexport function exposed(): number {\n  return alpha() * 2;\n}\n');
      expect(files(reach(wrapper, changeAlpha()))).toEqual(["src/wrapper.ts", "src/downstream.ts"]);
      const typed = withImporter("src/typed.ts", 'import type { alpha } from "./core";\n\nexport type exposed = ReturnType<typeof alpha>;\n');
      expect(files(reach(typed, changeAlpha()))).toEqual(["src/typed.ts", "src/downstream.ts"]);
    });

    test("an importer that re-exports the changed symbol is expanded under the re-exported name", () => {
      const listed = withImporter("src/relay.ts", 'import { alpha } from "./core";\n\nconsole.log(alpha());\nexport { alpha as exposed };\n');
      expect(files(reach(listed, changeAlpha()))).toEqual(["src/relay.ts", "src/downstream.ts"]);
      const from = withImporter("src/relay.ts", 'import { alpha } from "./core";\nexport { alpha as exposed } from "./core";\nconsole.log(alpha());\n');
      const result = reach(from, changeAlpha());
      expect(files(result)).toEqual(["src/relay.ts", "src/downstream.ts"]);
    });
  });

  describe("fallback to the file edge", () => {
    test("module-level code (a side effect) reaches every importer", () => {
      const source = `${CORE}console.log("loaded");\n`;
      const head = { ...BASE_FILES, "src/core.ts": source };
      const result = reach(head, edit("src/core.ts", lineOf(source, "console.log")));
      expect(result.seeds[0]).toMatchObject({ mode: "file-edge", names: "*" });
      // Every importer consumes the module; the barrel passes everything through; hop 2 still goes only through
      // exports that depend on the module (useAlpha does, `other` does not).
      expect(files(result)).toEqual(["src/ns.ts", "src/uses-alpha.ts", "src/uses-beta.ts", "src/via-barrel-beta.ts", "src/via-barrel.ts", "src/second-hop.ts"]);
      expect(result.barrels).toEqual(["src/index.ts"]);
      expect(result.omitted.map((entry) => [entry.file, entry.reason])).toEqual([["src/other-hop.ts", "unrelated-symbol"]]);
    });

    test("a source that does not parse reaches every importer", () => {
      const head = { ...BASE_FILES, "src/core.ts": `${CORE}export function broken( {\n` };
      const result = reach(head, edit("src/core.ts", 5));
      expect(result.seeds[0]?.mode).toBe("file-edge");
      expect(result.seeds[0]?.detail).toContain("did not parse");
      expect(files(result)).toContain("src/uses-beta.ts");
    });

    test("a non-JS/TS file and a file without hunks fall back", () => {
      const graph = graphOf(BASE_FILES);
      graph.nodes.push({ id: "src/data.py", kind: "file", path: "src/data.py", language: "python" });
      graph.edges.push({ id: "x", from: "src/uses-beta.ts", to: "src/data.py", kind: "imports", specifier: "./data.py" });
      const result = computeSymbolReach({ graph, seeds: ["src/data.py", "src/core.ts"], changedFiles: ["src/data.py", "src/core.ts"], diff: new Map(), read: reader(BASE_FILES), depth: 1 });
      expect(result.seeds.map((seed) => [seed.file, seed.mode])).toEqual([
        ["src/core.ts", "file-edge"],
        ["src/data.py", "file-edge"],
      ]);
      expect(files(result)).toContain("src/uses-beta.ts");
    });

    test("an importer that does not parse is reached by its file edge; a dynamic importer walks on through the export holding the call", () => {
      const head = {
        ...BASE_FILES,
        "src/uses-beta.ts": 'import { beta } from "./core";\nexport const b = beta( {;\n',
        "src/dynamic.ts": 'export async function load() {\n  const m = await import("./core");\n  return m;\n}\n\nexport const unrelated = 1;\n',
      };
      const result = reach(head, edit("src/core.ts", lineOf(CORE, "return helper() + 1")), { depth: 1 });
      expect(result.reached.find((entry) => entry.file === "src/uses-beta.ts")?.mode).toBe("file-edge");
      expect(result.reached.find((entry) => entry.file === "src/dynamic.ts")).toMatchObject({ mode: "symbol", names: ["load"] });
    });
  });
});

describe("the module outline", () => {
  test("splits formatted code at top-level statements and keeps template, regex and JSX bodies inside them", () => {
    const source = [
      'import React from "react";',
      "",
      "export const re = /[{(]/g;",
      "export const tpl = `",
      "${1 + 1}",
      "export const notReal = 1;",
      "`;",
      "export function View(): JSX.Element {",
      "  return <div className=\"a\">Don't {re.source}</div>;",
      "}",
      "export type Pair = Map<string, number>",
      "export default View;",
    ].join("\n");
    const outline = outlineModule("src/view.tsx", source);
    expect(outline).toBeDefined();
    expect(outline?.statements.map((s) => [s.kind, s.startLine, s.endLine])).toEqual([
      ["import", 1, 1],
      ["declaration", 3, 3],
      ["declaration", 4, 7],
      ["declaration", 8, 10],
      ["declaration", 11, 11],
      ["export-default", 12, 12],
    ]);
    expect([...(outline?.exportedNames ?? [])].sort()).toEqual(["Pair", "View", "default", "re", "tpl"]);
  });

  test("propagates a changed local through every export that mentions it, ignoring property access", () => {
    const source = "const base = 1;\nexport const a = base + 1;\nexport const b = other.base;\nexport function c() {\n  return a;\n}\n";
    const outline = outlineModule("src/m.ts", source);
    const result = affectedExports(outline!, { changedLocals: ["base"] });
    expect([...(result.names as Set<string>)].sort()).toEqual(["a", "c"]);
  });

  test("parses unified diff hunks per head path, with renames", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -3,2 +3,0 @@",
      "-x",
      "-y",
      "@@ -10 +8,3 @@",
      "diff --git a/src/gone.ts b/src/gone.ts",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
    ].join("\n");
    const parsed = parseDiffHunks(diff);
    expect([...parsed.keys()]).toEqual(["src/new.ts"]);
    expect(parsed.get("src/new.ts")).toEqual({
      path: "src/new.ts",
      oldPath: "src/old.ts",
      hunks: [
        { oldStart: 3, oldLines: 2, newStart: 3, newLines: 0 },
        { oldStart: 10, oldLines: 1, newStart: 8, newLines: 3 },
      ],
    });
  });
});
