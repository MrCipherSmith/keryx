// LWG-8 impact propagation (flow 226, phase 1).
//
// From a set of classified file changes, decide which wiki pages are in doubt
// and WHY. The traversal is bounded by edge semantics rather than a hop count
// — the approach RepoDoc reports as discovering components "ordered by
// distance from the original change, avoiding arbitrary threshold limits".
// A fixed depth is the wrong instrument: two hops through `describes` is
// certainty, two hops through `imports` is a guess, and one number cannot say
// both.
//
// Confidence decays with distance instead, and the decay IS the bound: below
// `fyi` there is nothing left to say and the walk stops. That keeps a hub
// module from dragging half the repository into the report while still
// letting a direct `describes` hit arrive at full strength.
//
// Every affected page carries a reason chain. A page in the backlog that
// cannot say why it is there is worse than an absent one: it costs a reader
// the time to work it out and teaches them to distrust the rest.

import type { CallEdge, GraphData } from "../../gdgraph/types";
import type { ChangeClass, ClassifiedChange } from "./classify-change";

export type Confidence = "must-refresh" | "review-suggested" | "fyi";

const ORDER: Confidence[] = ["must-refresh", "review-suggested", "fyi"];

export interface Reason {
  /** Repository-relative path of the change that reached this page. */
  sourcePath: string;
  changeClass: ChangeClass;
  /** Edge kinds traversed from the changed file to the page, nearest first. */
  edgePath: Array<"describes" | "imports" | "calls">;
  /** Exported symbols whose signature moved, when the class is `signature`. */
  symbols: string[];
}

export interface AffectedPage {
  /** `WikiPageNode.id`, e.g. `wiki:components/src-ctx.md`. */
  pageId: string;
  confidence: Confidence;
  reasons: Reason[];
}

export interface PropagationResult {
  pages: AffectedPage[];
  /** True when the graph carried `unresolved` edges, so coverage is partial. */
  unresolvedEdgesPresent: boolean;
}

/** Strengthen `current` to `candidate` if the candidate is more certain. */
function strongest(current: Confidence | undefined, candidate: Confidence): Confidence {
  if (current === undefined) return candidate;
  return ORDER.indexOf(candidate) < ORDER.indexOf(current) ? candidate : current;
}

function decay(confidence: Confidence): Confidence | null {
  const next = ORDER[ORDER.indexOf(confidence) + 1];
  return next ?? null;
}

/**
 * Initial confidence for the file that actually changed.
 *
 * `cosmetic` yields `null` — no entry at all, not a weak one. That is the
 * whole point of the class: a reformatting commit must leave the backlog
 * untouched, and a `fyi` row for every reflowed file would be indistinguishable
 * from noise.
 */
function seedConfidence(changeClass: ChangeClass): Confidence | null {
  switch (changeClass) {
    case "signature":
    case "added":
    case "removed":
    case "moved":
      return "must-refresh";
    case "body":
      return "review-suggested";
    case "cosmetic":
      return null;
  }
}

/** Whether a change class justifies walking outward to dependents at all. */
function propagatesToDependents(changeClass: ChangeClass): boolean {
  // A body-only edit cannot break a dependent's documentation: the contract
  // the dependent documents did not move. Only shape changes travel.
  return changeClass === "signature" || changeClass === "added" || changeClass === "removed";
}

export function propagate(input: {
  graph: GraphData;
  changes: readonly ClassifiedChange[];
}): PropagationResult {
  const { graph, changes } = input;

  // page ← file index, built once from the describes layer.
  const pagesByFile = new Map<string, string[]>();
  for (const edge of graph.describes ?? []) {
    const list = pagesByFile.get(edge.to) ?? [];
    list.push(edge.from);
    pagesByFile.set(edge.to, list);
  }

  // dependents: importer paths keyed by the file they import.
  const dependents = new Map<string, string[]>();
  let unresolvedEdgesPresent = false;
  for (const edge of graph.edges) {
    if (edge.kind === "unresolved") {
      unresolvedEdgesPresent = true;
      continue;
    }
    if (edge.kind !== "imports") {
      continue;
    }
    const list = dependents.get(edge.to) ?? [];
    list.push(edge.from);
    dependents.set(edge.to, list);
  }

  const callers = buildCallerIndex(graph.calls ?? []);

  const affected = new Map<string, { confidence: Confidence; reasons: Reason[] }>();

  const attach = (
    filePath: string,
    confidence: Confidence,
    reason: Reason,
  ): void => {
    for (const pageId of pagesByFile.get(filePath) ?? []) {
      const existing = affected.get(pageId);
      const merged = strongest(existing?.confidence, confidence);
      const reasons = existing?.reasons ?? [];
      reasons.push({ ...reason, edgePath: [...reason.edgePath, "describes"] });
      affected.set(pageId, { confidence: merged, reasons });
    }
  };

  for (const change of changes) {
    const seed = seedConfidence(change.changeClass);
    if (seed === null) {
      continue;
    }

    // Distance 0: the changed file itself.
    attach(change.path, seed, {
      sourcePath: change.path,
      changeClass: change.changeClass,
      edgePath: [],
      symbols: change.symbols,
    });
    // A rename leaves edges pointing at the old path; the page describing it
    // is in doubt too, and only the previous path can find it.
    if (change.previousPath) {
      attach(change.previousPath, seed, {
        sourcePath: change.previousPath,
        changeClass: change.changeClass,
        edgePath: [],
        symbols: change.symbols,
      });
    }

    if (!propagatesToDependents(change.changeClass)) {
      continue;
    }

    // Outward: dependents, then their dependents, decaying each hop. The
    // opposite direction is deliberately not walked — a consumer changing does
    // not make its dependency's documentation wrong.
    let frontier: Array<{ path: string; confidence: Confidence; hops: number }> = [
      { path: change.path, confidence: seed, hops: 0 },
    ];
    const seen = new Set<string>([change.path]);

    while (frontier.length > 0) {
      const next: typeof frontier = [];
      for (const node of frontier) {
        const stepped = decay(node.confidence);
        if (stepped === null) {
          continue;
        }
        const neighbours = [
          ...(dependents.get(node.path) ?? []).map((path) => ({ path, kind: "imports" as const })),
          ...(callersOf(callers, node.path, change.changeClass)).map((path) => ({
            path,
            kind: "calls" as const,
          })),
        ];
        for (const neighbour of neighbours) {
          if (seen.has(neighbour.path)) {
            continue;
          }
          seen.add(neighbour.path);
          attach(neighbour.path, stepped, {
            sourcePath: change.path,
            changeClass: change.changeClass,
            edgePath: [...Array<"imports" | "calls">(node.hops).fill("imports"), neighbour.kind],
            symbols: change.symbols,
          });
          next.push({ path: neighbour.path, confidence: stepped, hops: node.hops + 1 });
        }
      }
      frontier = next;
    }
  }

  const pages: AffectedPage[] = [...affected.entries()]
    .map(([pageId, value]) => ({
      pageId,
      confidence: value.confidence,
      // One row per (source, class), keeping the SHORTEST path that reached
      // it. A page reachable by four routes from one change produced four
      // near-identical rows, which buried the distinct causes it also had.
      reasons: dedupeReasons(value.reasons),
    }))
    .sort((a, b) => {
      const byConfidence = ORDER.indexOf(a.confidence) - ORDER.indexOf(b.confidence);
      return byConfidence !== 0 ? byConfidence : a.pageId.localeCompare(b.pageId);
    });

  return { pages, unresolvedEdgesPresent };
}

/** Caller file paths keyed by the file that owns the called symbol. */
function buildCallerIndex(calls: readonly CallEdge[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const call of calls) {
    if (call.kind !== "calls") {
      continue;
    }
    const calleeFile = fileOfSymbolId(call.to);
    const callerFile = fileOfSymbolId(call.from);
    if (!calleeFile || !callerFile || calleeFile === callerFile) {
      continue;
    }
    const set = index.get(calleeFile) ?? new Set<string>();
    set.add(callerFile);
    index.set(calleeFile, set);
  }
  return index;
}

function callersOf(
  index: Map<string, Set<string>>,
  path: string,
  changeClass: ChangeClass,
): string[] {
  // Call edges only carry information when the callee's shape moved. A body
  // edit leaves every call site valid.
  if (changeClass !== "signature" && changeClass !== "removed") {
    return [];
  }
  return [...(index.get(path) ?? [])].sort();
}

function fileOfSymbolId(symbolId: string): string | null {
  const hash = symbolId.indexOf("#");
  const path = hash >= 0 ? symbolId.slice(0, hash) : symbolId;
  return path.length > 0 ? path : null;
}


function dedupeReasons(reasons: readonly Reason[]): Reason[] {
  const best = new Map<string, Reason>();
  for (const reason of reasons) {
    const key = `${reason.sourcePath}\u0000${reason.changeClass}`;
    const existing = best.get(key);
    if (!existing || reason.edgePath.length < existing.edgePath.length) {
      best.set(key, reason);
    }
  }
  return [...best.values()].sort((a, b) =>
    a.edgePath.length !== b.edgePath.length
      ? a.edgePath.length - b.edgePath.length
      : a.sourcePath.localeCompare(b.sourcePath),
  );
}
