// Flow 242 (forgetting), lane E — the graph layer's answer to a reference into
// deleted code.
//
// Measured on a scratch project before this module existed. `src/orders.ts`
// imports `./billing`; `src/billing.ts` is deleted; the graph is rebuilt.
//
//     $ keryx gdgraph affected src/orders.ts
//     ## Dependencies
//     - none
//     $ keryx gdgraph query orphans
//     src/orders.ts
//
// Both answers are produced by the same line, repeated in three places:
// `edge.kind !== "unresolved"`. `computeAffected`, `getAffected` and
// `getOrphans` (`./affected.ts`, `./query.ts`) all drop unresolved edges before
// they answer, so a file whose dependency was deleted reports the same
// "Dependencies: none" as a file that never had one, and a file left holding
// nothing but a broken import is reported as an ORPHAN — a positive claim that
// nothing references it and it references nothing.
//
// That filter is correct for what those three functions compute: an unresolved
// edge has no node on the other end, so it cannot participate in a dependency
// closure, a blast radius or a cycle. What was missing is a second answer
// alongside them, saying that the edge is there and does not land. This module
// is that answer, and it deliberately does NOT change the three: their results
// stay byte-identical (`./dangling.test.ts` pins the orphan set to
// `getOrphans`'s own), because a "fix" that folded unresolved targets into
// `dependencies` would put strings that are not files into a set every caller
// reads as file paths.
//
// The one distinction that decides whether an unresolved edge means anything:
// SCOPE. On this repository's own graph, 60 of the unresolved edges are npm
// packages and Python standard-library modules (`collections`, `datetime`,
// `os`) — specifiers that were never expected to resolve to a file in this
// tree. Reporting those as dangling references would bury the two or three
// that matter under sixty that do not, which is how a report stops being read.
// Only a RELATIVE specifier addresses this project's own file tree, so only a
// relative specifier can dangle in it.

import type { GraphData, ImportKind } from "./types";
import { getOrphans } from "./query";

/**
 * Whether a specifier addresses this project's own file tree.
 *
 * `in-project` is a relative specifier (`./x`, `../x`) — the only form whose
 * failure to resolve is a statement about THIS repository. `external` is
 * everything else: a bare package name, a Node/Python builtin, a URL. An
 * external specifier that does not resolve is not a dangling reference into
 * removed knowledge; it is a dependency this graph does not index, and calling
 * it dangling would be a false positive sixty times over on this repo alone.
 */
export type DanglingScope = "in-project" | "external";

export function classifyDanglingScope(specifier: string): DanglingScope {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === ".."
    ? "in-project"
    : "external";
}

export type DanglingEdge = {
  /** The file holding the reference. */
  from: string;
  /** The specifier as written in the source. */
  specifier: string;
  scope: DanglingScope;
  /** What the transpiler reported for the statement, or null on an old graph. */
  importKind: ImportKind | null;
};

export type DanglingEdgeOptions = {
  /** Restrict to edges out of this file (exact `GraphNode.path` match). */
  from?: string;
  /** Restrict to one scope. Omit for both. */
  scope?: DanglingScope;
};

/**
 * Every unresolved edge in the graph, with its scope — the references that
 * `dependencies`/`dependents`/`orphans` drop.
 *
 * Deterministic order (from, then specifier) so a report diffed between two
 * runs shows only what actually changed.
 */
export function getDanglingEdges(graph: GraphData, options: DanglingEdgeOptions = {}): DanglingEdge[] {
  const found: DanglingEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== "unresolved") {
      continue;
    }
    if (options.from !== undefined && edge.from !== options.from) {
      continue;
    }
    const scope = classifyDanglingScope(edge.specifier);
    if (options.scope !== undefined && scope !== options.scope) {
      continue;
    }
    found.push({
      from: edge.from,
      specifier: edge.specifier,
      scope,
      importKind: edge.importKind ?? null,
    });
  }
  return found.sort((a, b) => a.from.localeCompare(b.from) || a.specifier.localeCompare(b.specifier));
}

/**
 * Does this unresolved specifier name one of `deletedPaths`?
 *
 * A SECOND distinction, on top of scope, and the report is unusable without it.
 * Run over this repository's own graph, `in-project` unresolved edges number in
 * the dozens and almost all of them are import statements written inside test
 * FIXTURE strings (`src/gdgraph/build-integrity.test.ts` contains
 * `import "./dep"` as fixture content) — specifiers that never resolved to
 * anything and never will. Listing those beside the one edge whose target was
 * actually deleted buries it, and a report nobody reads reports nothing.
 *
 * So an edge is only called a reference into DELETED knowledge when its
 * specifier names a file the caller can show was deleted. Everything else stays
 * unclassified — explicitly, as "this stage cannot tell whether it once
 * resolved", which is the true state and is not the same as "it is fine".
 *
 * The match is textual and deliberately does not re-run module resolution: this
 * answers "is this plausibly that file", and the caller labels it as a match,
 * never as a resolution.
 */
export function namesDeletedFile(
  edge: Pick<DanglingEdge, "from" | "specifier">,
  deletedPaths: ReadonlySet<string>,
): boolean {
  const fromDir = edge.from.includes("/") ? edge.from.slice(0, edge.from.lastIndexOf("/")) : "";
  const joined = normalizePosix(fromDir.length > 0 ? `${fromDir}/${edge.specifier}` : edge.specifier);
  if (joined === null) {
    return false;
  }
  for (const deleted of deletedPaths) {
    if (deleted === joined || deleted.startsWith(`${joined}.`) || deleted.startsWith(`${joined}/index.`)) {
      return true;
    }
  }
  return false;
}

/** Resolve `.`/`..` segments textually. Null when the path escapes the root. */
function normalizePosix(value: string): string | null {
  const parts: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

/**
 * Why a file appears in `getOrphans`.
 *
 * `isolated` is the answer the query has always implied: nothing points at this
 * file and it points at nothing. `dangling-only` is the answer it was giving
 * WITHOUT saying so: the file does reference something, and the something is
 * not there. Rendering the two identically is the defect — "nothing depends on
 * this, delete it" and "its dependency was deleted, this is now broken" are
 * opposite conclusions drawn from the same line of output.
 */
export type OrphanCause =
  | { path: string; cause: "isolated" }
  | { path: string; cause: "dangling-only"; unresolved: DanglingEdge[] };

/**
 * Explain, never re-decide.
 *
 * The path set returned here is exactly `getOrphans(graph)` — this function
 * classifies that set and does not add to or subtract from it, so an orphan
 * count taken from either stays the same number. `./dangling.test.ts` asserts
 * the equality rather than trusting the comment.
 */
export function explainOrphans(graph: GraphData): OrphanCause[] {
  const orphans = getOrphans(graph);
  const unresolvedByFile = new Map<string, DanglingEdge[]>();
  for (const edge of getDanglingEdges(graph)) {
    const bucket = unresolvedByFile.get(edge.from);
    if (bucket) {
      bucket.push(edge);
    } else {
      unresolvedByFile.set(edge.from, [edge]);
    }
  }

  return orphans.map((orphanPath) => {
    const unresolved = unresolvedByFile.get(orphanPath) ?? [];
    return unresolved.length > 0
      ? ({ path: orphanPath, cause: "dangling-only", unresolved } as const)
      : ({ path: orphanPath, cause: "isolated" } as const);
  });
}
