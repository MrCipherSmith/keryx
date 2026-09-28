import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CallEdge,
  DescribesEdge,
  GraphData,
  GraphEdge,
  GraphNode,
  SymbolNode,
  WikiPageNode,
} from "./types";
import { TYPE_ONLY_IMPORT_KIND } from "./types";
import { resolveGraphTarget } from "./target";

export async function loadGraph(projectRoot: string): Promise<GraphData> {
  const storageDir = path.join(projectRoot, ".metaproject", "data", "gdgraph", "storage");
  const nodes = await readJsonl<GraphNode>(path.join(storageDir, "nodes.jsonl"));
  const edges = await readJsonl<GraphEdge>(path.join(storageDir, "edges.jsonl"));
  // B1 symbol layer: loaded ONLY if present. Missing files ⇒ empty/omitted layer
  // (never an error — mirrors `readJsonl` tolerance). File-level graph unchanged.
  const symbols = await readJsonl<SymbolNode>(path.join(storageDir, "symbols.jsonl"));
  const calls = await readJsonl<CallEdge>(path.join(storageDir, "calls.jsonl"));
  // LWG wiki layer (flow 223): same contract as the symbol layer above —
  // loaded only if present, absent ⇒ omitted, never an error. A graph built
  // before this layer existed therefore loads byte-for-byte as it always did.
  const wikiPages = await readJsonl<WikiPageNode>(path.join(storageDir, "wiki-pages.jsonl"));
  const describes = await readJsonl<DescribesEdge>(path.join(storageDir, "describes.jsonl"));
  const graph: GraphData = { nodes, edges };
  if (symbols.length > 0) {
    graph.symbols = symbols;
  }
  if (calls.length > 0) {
    graph.calls = calls;
  }
  if (wikiPages.length > 0) {
    graph.wikiPages = wikiPages;
  }
  if (describes.length > 0) {
    graph.describes = describes;
  }
  return graph;
}

/**
 * Reverse the `describes` layer: which wiki pages document this file?
 * (LWG-1, flow 223 AC3.)
 *
 * The layer stores only page → file, so this is the index every caller would
 * otherwise rebuild. An absent layer yields an empty array — the honest
 * answer is "no information", and a caller must not read that as "this file
 * is undocumented"; only a layer that IS present can support that claim.
 */
export function getPagesDescribing(graph: GraphData, filePath: string): string[] {
  const target = filePath.replace(/^\.\//, "");
  const pages = new Set<string>();
  for (const edge of graph.describes ?? []) {
    if (edge.to === target) {
      pages.add(edge.from);
    }
  }
  return [...pages].sort();
}

/** Every file the given page documents (LWG-1). Empty when undecidable. */
export function getFilesDescribedBy(graph: GraphData, pageId: string): string[] {
  const files = new Set<string>();
  for (const edge of graph.describes ?? []) {
    if (edge.from === pageId) {
      files.add(edge.to);
    }
  }
  return [...files].sort();
}

/**
 * `roots` (A-8, flow 356): files reached OUT OF BAND — never by any `import`
 * statement this graph's builder can see, so they carry no inbound OR
 * outbound edge and would otherwise report as orphans. `src/lib/
 * test-preload.ts` is the motivating case: `bunfig.toml`'s `[test].preload`
 * loads it before any test module runs, which is a real caller this scan
 * simply cannot see (it is not written as an `import`). Reporting it dead is
 * a false positive, not a finding — `bunfigPreloadRoots` below is the one
 * caller (`commands/gdgraph.ts`, `gdgraph/service.ts`) resolves and passes
 * in; a caller that does not know about a project's `bunfig.toml` (e.g. this
 * module's own unit tests, `forgetting/propagation.ts`) omits it and gets
 * the previous, unfiltered behaviour.
 */
export function getOrphans(graph: GraphData, roots: ReadonlySet<string> = new Set()): string[] {
  const inbound = new Set(
    graph.edges.filter((edge) => edge.kind !== "unresolved").map((edge) => edge.to),
  );
  const outbound = new Set(
    graph.edges.filter((edge) => edge.kind !== "unresolved").map((edge) => edge.from),
  );
  return graph.nodes
    .map((node) => node.path)
    .filter((file) => !inbound.has(file) && !outbound.has(file) && !roots.has(file))
    .sort();
}

/**
 * `bunfig.toml`'s declared `preload` entries, resolved to graph-relative
 * paths (forward-slash, relative to `projectRoot` — the same shape
 * `GraphNode.path` uses) — the roots {@link getOrphans} excludes (A-8).
 *
 * Handles the two shapes Bun actually reads a `preload` array from: a
 * top-level `preload = […]` (`bun run`/`bunx`) and a table-scoped one
 * (`[test]\npreload = […]`, this repository's own `bunfig.toml`). Not a
 * general TOML parser — narrow on purpose, one array key, matching this
 * repository's own `mcp-servers/compat.ts` precedent of a small reader over
 * a dependency for one config shape. An absent or unreadable `bunfig.toml`
 * yields no roots rather than an error: most projects this graph runs
 * against have none at all.
 */
/**
 * Strip `#`-to-end-of-line comments from `text`, leaving string literals
 * (single- or double-quoted, double-quoted honoring a `\"` escape) alone —
 * a `#` inside a string is content, not a comment start. Review round 1,
 * L3: without this, a commented-out `# preload = […]` line still matched
 * {@link bunfigPreloadRoots}'s array pattern, since that pattern searched
 * the raw text with no comment awareness.
 */
function stripTomlComments(text: string): string {
  let result = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== undefined) {
      result += ch;
      if (ch === "\\" && quote === '"' && i + 1 < text.length) {
        result += text[i + 1];
        i++;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      result += ch;
      continue;
    }
    if (ch === "#") {
      const newlineIndex = text.indexOf("\n", i);
      if (newlineIndex === -1) {
        break;
      }
      i = newlineIndex - 1;
      continue;
    }
    result += ch;
  }
  return result;
}

export async function bunfigPreloadRoots(projectRoot: string): Promise<Set<string>> {
  const roots = new Set<string>();
  let text: string;
  try {
    text = await readFile(path.join(projectRoot, "bunfig.toml"), "utf8");
  } catch {
    return roots;
  }
  // Review round 1, L3: strip `#` comments (outside string literals) before
  // matching, and anchor the key to a line start — a commented-out
  // `# preload = […]` line must never contribute a root, and a key that
  // merely ENDS in "preload" mid-line must never match either.
  const stripped = stripTomlComments(text);
  const arrayPattern = /^[ \t]*preload\s*=\s*\[([^\]]*)\]/gm;
  const stringPattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  for (const arrayMatch of stripped.matchAll(arrayPattern)) {
    const body = arrayMatch[1] ?? "";
    for (const stringMatch of body.matchAll(stringPattern)) {
      const raw = stringMatch[1] ?? stringMatch[2] ?? "";
      if (raw.length === 0) {
        continue;
      }
      const absolute = path.resolve(projectRoot, raw);
      const relative = path.relative(projectRoot, absolute).split(path.sep).join("/");
      roots.add(relative);
    }
  }
  return roots;
}

export function getAffected(
  graph: GraphData,
  target: string,
): { target: string; dependencies: string[]; dependents: string[] } {
  // Exact-then-suffix, refusing an ambiguous suffix (see ./target.ts). Shared
  // with `computeAffected` so the two entry points cannot drift apart.
  const resolvedTarget = resolveGraphTarget(graph, target);

  return {
    target: resolvedTarget,
    dependencies: graph.edges
      .filter((edge) => edge.kind !== "unresolved" && edge.from === resolvedTarget)
      .map((edge) => edge.to)
      .sort(),
    dependents: graph.edges
      .filter((edge) => edge.kind !== "unresolved" && edge.to === resolvedTarget)
      .map((edge) => edge.from)
      .sort(),
  };
}

export function getCycles(graph: GraphData): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) {
    adjacency.set(node.path, []);
  }
  for (const edge of graph.edges) {
    // A `dynamic-import` (`await import()`) resolves at call time, not
    // module-load time, so a cycle closed only through one is not the
    // load-order cycle this query answers (P1, flow 140). Excluding it here
    // — rather than reclassifying `edge.kind` — leaves orphans/affected
    // untouched (AC5): both still treat the edge as a normal import.
    //
    // A `type-only` edge (AFC-11, flow 234) is excluded for the same reason:
    // `import type`/`export type … from`/an all-`type`-specifier import is
    // erased by the compiler, so it never runs at module-load time and a
    // cycle closed only through such edges is not a real runtime deadlock.
    // Same non-reclassification rule applies — `edge.kind` stays "imports"
    // so getOrphans/getAffected/computeAffected still see it as a real
    // dependency for impact analysis; only this load-order adjacency drops it.
    if (
      edge.kind !== "imports" ||
      edge.importKind === "dynamic-import" ||
      edge.importKind === TYPE_ONLY_IMPORT_KIND
    ) {
      continue;
    }
    adjacency.get(edge.from)?.push(edge.to);
  }

  const cycles = new Map<string, string[]>();
  const visited = new Set<string>();
  const stack = new Set<string>();
  const pathStack: string[] = [];

  function visit(node: string): void {
    visited.add(node);
    stack.add(node);
    pathStack.push(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!visited.has(next)) {
        visit(next);
        continue;
      }

      if (stack.has(next)) {
        const start = pathStack.indexOf(next);
        const cycle = [...pathStack.slice(start), next];
        cycles.set(canonicalCycle(cycle), cycle);
      }
    }

    stack.delete(node);
    pathStack.pop();
  }

  for (const node of graph.nodes.map((item) => item.path)) {
    if (!visited.has(node)) {
      visit(node);
    }
  }

  return [...cycles.values()].sort((a, b) => a.join("").localeCompare(b.join("")));
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    // Absent file ⇒ empty layer (the symbol layer is optional, and a missing
    // core file should degrade rather than crash graph navigation).
    return [];
  }
  const items: T[] = [];
  for (const line of content.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    try {
      items.push(JSON.parse(line) as T);
    } catch {
      // Ignore malformed JSONL records so one bad line does not break graph navigation.
    }
  }
  return items;
}

function canonicalCycle(cycle: string[]): string {
  const withoutLast = cycle.slice(0, -1);
  const variants = withoutLast.map((_, index) => [
    ...withoutLast.slice(index),
    ...withoutLast.slice(0, index),
  ].join("->"));
  return variants.sort()[0] ?? cycle.join("->");
}
