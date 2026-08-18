// Pre-LLM classification gate for `wiki enrich` RLM mode (TRD §1.2/§3.2, flow
// 169 T2). `classifyPage` is pure over its inputs — no I/O of its own; this
// mirrors `computeRepomap`'s existing purity contract (`gdgraph/repomap.ts`:
// "Pure over the in-memory graph + config; no I/O"). The caller (`wikiEnrich`,
// a later task) gathers `PageGraphSignals` once per run and passes them in per
// page.
//
// `signals.stale` is intentionally NOT consulted here: per-page staleness-skip
// applies "regardless of classification tier" (PRD FR-7) and is composed by
// the caller around `classifyPage`'s result, not inside this function (TRD
// §3.3 — that composition, and the `completedNodeHashes` mechanism that
// computes `stale`, land in a later task).

import type { GraphData } from "../gdgraph/types";
import type { WikiConfig } from "./config";
import type { WikiPage } from "./types";

export interface PageGraphSignals {
  // `collect.ts` output size for this page, in bytes.
  templateBytes: number;
  // From `personalizedPageRank` over this page's key files (0..1, normalized).
  pageRankScore: number;
  // Max fan-in (inbound non-unresolved edges) across the page's key files.
  fanIn: number;
  // Per-page staleness (computed by a later task, T5). Present on the
  // interface but read only by the caller, never inside `classifyPage`.
  stale: boolean;
}

export type PageClassification = "skip" | "light" | "deep";

// skip:  templateBytes below skipMaxBytes AND below both deep thresholds.
// deep:  pageRankScore at/above deepMinPageRank OR fanIn at/above deepMinFanIn.
// light: everything else.
export function classifyPage(
  _page: WikiPage,
  signals: PageGraphSignals,
  config: WikiConfig["rlm"],
): PageClassification {
  const thresholds = config.classify;
  const meetsDeepBar =
    signals.pageRankScore >= thresholds.deepMinPageRank || signals.fanIn >= thresholds.deepMinFanIn;
  if (meetsDeepBar) {
    return "deep";
  }
  if (signals.templateBytes < thresholds.skipMaxBytes) {
    return "skip";
  }
  return "light";
}

// Inbound (non-unresolved) edge count per node — the same fan-in centrality
// `gdgraph/affected.ts`'s `computeAffected` derives inline (`fanIn` is NOT a
// stored `GraphNode` field; `affected.ts:53-64` computes it from
// `graph.edges` on demand, and `metaproject-operations.ts`'s `formatAffected`
// only ever prints a value it was handed). Exposed here so the per-run caller
// can build this map once (alongside one `personalizedPageRank` pass) and
// reuse it across every page, instead of rebuilding it per page.
export function computeGraphFanIn(graph: GraphData): Map<string, number> {
  const fanIn = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind === "unresolved") {
      continue;
    }
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
  }
  return fanIn;
}

// Compute `PageGraphSignals` for one page from per-run-precomputed maps
// (`pageRankScores` from one `personalizedPageRank` pass, `fanInByFile` from
// `computeGraphFanIn`, both computed once per `wikiEnrich` run per TRD §3.2 —
// "not a per-page graph rebuild"). `keyFiles` is the page's key-file list;
// `collect.ts`/`service.ts`'s module `keyFiles` computation (`service.ts:503`)
// is today only rendered into page markdown, not stored as a structured field
// on `WikiPage` — resolving a page back to its key-file paths is the calling
// task's concern (T5/T6/T7), not this pure module's. `templateBytes` and
// `stale` are supplied by the caller for the same reason.
export function computePageGraphSignals(
  keyFiles: readonly string[],
  pageRankScores: ReadonlyMap<string, number>,
  fanInByFile: ReadonlyMap<string, number>,
  templateBytes: number,
  stale: boolean,
): PageGraphSignals {
  return {
    templateBytes,
    pageRankScore: maxOverFiles(keyFiles, pageRankScores),
    fanIn: maxOverFiles(keyFiles, fanInByFile),
    stale,
  };
}

function maxOverFiles(files: readonly string[], values: ReadonlyMap<string, number>): number {
  let max = 0;
  for (const file of files) {
    const value = values.get(file) ?? 0;
    if (value > max) {
      max = value;
    }
  }
  return max;
}
