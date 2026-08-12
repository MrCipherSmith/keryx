// Independent JS import parser + resolver — the source of truth for the dependency-closure
// gold in src/metrics/gold.ts (`goldDependencyClosure`). This module deliberately does NOT
// call `keryx gdgraph` or anything under src/gdgraph/**: if the gold graph were built from
// gdgraph's own parse, scoring gdgraph's `affected` output against it would be circular
// (gdgraph would always agree with itself). Instead this is a small, self-contained
// regex-based CommonJS/ESM specifier extractor and relative-path resolver, built and tested
// from scratch against in-memory source strings (see src/metrics/gold.test.ts).
//
// What it parses (per specification.md's dependency-closure task):
//   - `require('./x')` / `require("./x")`
//   - `import('./x')` (dynamic import)
//   - `import ... from './x'` (default / named / namespace static import)
//
// What it deliberately does NOT parse (out of scope, documented so gaps are not silent):
//   - bare side-effect imports with no `from` clause: `import './x';`
//   - `export ... from './x'` re-exports
//   - template-literal or computed specifiers: `require(\`./${name}\`)`, `require(dep)`
//   - `require.resolve(...)`, `require.cache`, or any other property access on `require`
//     (the regex only matches a direct call: `require(<string>)`)
//
// What resolution does and does not do (per specification.md: "handle ./, ../, index files,
// .js omission"):
//   - Only specifiers starting with `./` or `../` are treated as internal/relative; every
//     other specifier (a bare package name like "express", a scoped package like
//     "@scope/pkg", or a `node:`-prefixed builtin) is EXTERNAL and excluded — resolution
//     returns `null` for it, it never becomes a graph edge.
//   - A relative specifier is resolved against the importing file's directory and tried, in
//     order, as: the literal path, the path with `.js` appended, and the path joined with
//     `/index.js` — the first that exists in the caller-supplied `knownFiles` set wins.
//   - No other extensions are tried (no `.json`, `.mjs`, `.cjs`, `.node`, `.ts`) and no
//     `package.json#main`/`exports` resolution is performed — this parser targets plain
//     CommonJS/ESM `.js` sources (express itself), not a general Node resolver.
//   - A specifier that walks above the repo root (e.g. `../../../outside`) resolves to
//     `null` rather than a path outside the known-files universe.
//   - A specifier that doesn't match any candidate in `knownFiles` (e.g. it points at a file
//     that doesn't exist in the pinned checkout, or an extension this resolver doesn't try)
//     resolves to `null` — it is dropped, not guessed at.

import { posix } from "node:path";

export type ImportKind = "require" | "import" | "dynamic-import";

export type ParsedImport = {
  readonly specifier: string;
  readonly kind: ImportKind;
};

// Matches `require(<string>)` and `import(<string>)` — a keyword directly followed by a
// parenthesized string literal. Static `import ... from '...'` does NOT match this (the
// token right after `import` is an identifier, `{`, or `*`, never `(`), so the two regexes
// below are mutually exclusive by construction.
const CALL_STRING_RE = /\b(require|import)\s*\(\s*(['"])((?:(?!\2)[^\\]|\\.)*)\2\s*\)/g;

// Matches `import <bindings> from '<specifier>'` (default/named/namespace, single- or
// multi-line binding lists). Lazy `[\s\S]*?` between `import` and `from` matches the
// shortest span, which is correct for well-formed single-statement imports; a specifier
// string that itself contains the literal substring "from" between unrelated `import`/`from`
// keywords could confuse it, an accepted edge case for this benchmark-fixture-scale parser.
const IMPORT_FROM_RE = /\bimport\b[\s\S]*?\bfrom\s+(['"])((?:(?!\1)[^\\]|\\.)*)\1/g;

/** Extract raw (unresolved) import/require specifiers from a JS source string. Pure, no I/O. */
export function parseImportSpecifiers(source: string): ParsedImport[] {
  const results: ParsedImport[] = [];

  for (const match of source.matchAll(CALL_STRING_RE)) {
    const keyword = match[1];
    const specifier = match[3];
    if (specifier === undefined) continue;
    results.push({ specifier, kind: keyword === "require" ? "require" : "dynamic-import" });
  }

  for (const match of source.matchAll(IMPORT_FROM_RE)) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    results.push({ specifier, kind: "import" });
  }

  return results;
}

/**
 * Resolve a raw specifier found in `fromFile` to a repo-relative path present in
 * `knownFiles`, or `null` if it is external (bare/package specifier) or cannot be resolved
 * against the known file set. See the module doc comment for the exact rule. Pure — takes
 * the known-file universe as data, never touches the filesystem itself.
 */
export function resolveImportSpecifier(
  fromFile: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    // Bare/package specifier (e.g. "express", "node:fs", "@scope/pkg") — external, excluded.
    return null;
  }

  const fromDir = posix.dirname(fromFile);
  const joined = posix.normalize(posix.join(fromDir, specifier));
  if (joined === ".." || joined.startsWith("../")) return null; // escapes the repo root

  const candidates = [joined, `${joined}.js`, posix.join(joined, "index.js")];
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

/** repo-relative file path -> its full source text. The in-memory corpus a graph is built from. */
export type RepoSourceMap = Readonly<Record<string, string>>;

/**
 * Build a direct-import graph (the `ImportGraph` shape `goldDependencyClosure` in
 * src/metrics/gold.ts expects) from an in-memory map of repo-relative file path -> source
 * text, by parsing and resolving every file's imports against the map's own key set. This
 * is the INDEPENDENT source of the dependency-closure gold: it never calls gdgraph or reads
 * anything gdgraph produced.
 */
export function buildImportGraph(sources: RepoSourceMap): Record<string, string[]> {
  const knownFiles = new Set(Object.keys(sources));
  const graph: Record<string, string[]> = {};

  for (const [file, source] of Object.entries(sources)) {
    const resolved = new Set<string>();
    for (const { specifier } of parseImportSpecifiers(source)) {
      const target = resolveImportSpecifier(file, specifier, knownFiles);
      if (target !== null && target !== file) resolved.add(target);
    }
    graph[file] = [...resolved].sort();
  }

  return graph;
}
