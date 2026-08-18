// Per-page staleness primitives for `wiki enrich` RLM mode (TRD §3.3, flow
// 169 T5). Extends `enrich.ts`'s `ResumeState.completedNodeHashes`: hash each
// page's key files' content, and let a caller skip re-enriching a page whose
// hash is unchanged since its last successful enrich — regardless of
// classification tier (PRD FR-7). This module builds the primitives only;
// it is NOT wired into `wikiEnrich`'s per-page worker loop yet (that is a
// later task, T6/T7) and `wikiEnrich`'s existing per-page behavior is
// unchanged.
//
// Grounding correction (flow 169 T5, mirrors T2's `computeGraphFanIn` note in
// `journal.md`): `GraphNode` (`gdgraph/types.ts`) stores NO content hash or
// mtime for a file — only `{id, kind, path, language}` — and
// `gdgraph/build.ts` never persists one either (grep for hash/mtime across
// `src/gdgraph` turns up nothing file-content-related). So "hash ... of its
// key-files' graph node content" cannot mean "read a hash field off
// GraphNode" — there is none to read. This module instead hashes each key
// file's CURRENT on-disk content (sha256), scoped to only the page's key
// files (typically <= 6, via `collect.ts`'s `computeModuleKeyFiles`) — not a
// repo-wide re-hash pass.
//
// CORRECTION (flow 169 T10, review finding #1): an earlier version of this
// comment claimed `graphMaybeStale()` (`gdgraph/staleness.ts`) could be used
// to skip the per-page hash computation entirely whenever the repo "has not
// moved" since the last graph build. That is WRONG: `graphMaybeStale` only
// compares `.git/HEAD`'s mtime to the graph build's, and by its own doc
// comment does not fire on ordinary uncommitted working-tree edits — only on
// checkout/branch-switch/a commit that moves HEAD. A key file can change on
// disk without ever touching `.git/HEAD`. `checkPageStalenessGate`'s
// `repoMaybeStale` below is kept as an advisory per-run signal for other
// purposes, but `wikiEnrich`'s RLM pipeline (`enrich.ts`) now ALWAYS computes
// and compares each page's hash — that is the correctness-critical check,
// and it is cheap enough on its own (a handful of file hashes per page) to
// never need a fast-skip.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { graphMaybeStale } from "../gdgraph/staleness";
import type { GraphData } from "../gdgraph/types";
import type { ResumeState } from "./resume-state";

/**
 * Deterministic hash over a page's key files' current on-disk content.
 * Sorted `{path, content-sha256}` pairs (sorted by path) are hashed together
 * so file ORDER in `keyFiles` never affects the result, only content and
 * membership. A key file that is no longer a known graph node, or fails to
 * read from disk, hashes as a stable `"<missing>"` sentinel rather than being
 * skipped — so a deleted/renamed key file changes the page hash instead of
 * silently preserving an "unchanged" verdict.
 */
export async function computePageNodeHash(
  cwd: string,
  keyFiles: readonly string[],
  graph: GraphData,
): Promise<string> {
  const knownPaths = new Set(
    graph.nodes.filter((node) => node.kind === "file").map((node) => node.path),
  );

  const entries: Array<{ path: string; digest: string }> = [];
  for (const file of keyFiles) {
    let digest = "<missing>";
    if (knownPaths.has(file)) {
      try {
        const content = await readFile(path.join(cwd, file), "utf8");
        digest = createHash("sha256").update(content).digest("hex");
      } catch {
        digest = "<missing>";
      }
    }
    entries.push({ path: file, digest });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const combined = entries.map((entry) => `${entry.path}:${entry.digest}`).join("\n");
  return createHash("sha256").update(combined).digest("hex");
}

/**
 * True when `currentHash` matches the page's last recorded successful-enrich
 * hash (PRD FR-7: "unchanged since last successful enrich", regardless of
 * classification tier). No prior entry (never enriched successfully, or an
 * old resume-state file predating `completedNodeHashes`) ⇒ not unchanged.
 */
export function isPageUnchangedSinceLastEnrich(
  pagePath: string,
  currentHash: string,
  completedNodeHashes: ResumeState["completedNodeHashes"],
): boolean {
  const previous = completedNodeHashes?.[pagePath];
  return previous !== undefined && previous === currentHash;
}

export interface PageStalenessGate {
  /**
   * `false` ⇒ `.git/HEAD`'s mtime does not postdate the built graph's
   * (`graphMaybeStale(cwd)` returned false) — the repo has not moved via a
   * commit that advanced HEAD, checkout, or branch switch since the graph
   * was built.
   *
   * CORRECTION (flow 169 T10, review finding #1): this does NOT mean a
   * page's key-file CONTENT is guaranteed unchanged, and must NOT be used to
   * skip per-page hash computation. `.git/HEAD` does not change on ordinary
   * uncommitted edits (see `gdgraph/staleness.ts`'s own doc comment: "does
   * NOT fire on every working-tree edit during active development"), so a
   * key file can be edited on disk while `repoMaybeStale` stays `false`.
   * `wikiEnrich`'s RLM pipeline (`enrich.ts`) previously trusted `false` here
   * to skip recomputing/comparing a page's hash entirely, which produced
   * false "unchanged" verdicts for exactly that (very common) case. It now
   * always computes and compares the per-page hash, independent of this
   * gate's value. This field remains useful only as an advisory/cheap signal
   * for OTHER per-run decisions (e.g. whether a `gdgraph build` refresh is
   * worth suggesting) — never as a substitute for the per-page comparison.
   */
  repoMaybeStale: boolean;
}

/**
 * Single per-run entry point (not per-page): reports whether the repo has
 * moved (via `graphMaybeStale`) since the last graph build. See the
 * correction on {@link PageStalenessGate.repoMaybeStale} — this is an
 * advisory per-run signal only, NOT a valid basis for skipping per-page hash
 * computation/comparison (that per-page check must always run; it is cheap
 * on its own, a handful of file hashes per page).
 */
export async function checkPageStalenessGate(cwd: string): Promise<PageStalenessGate> {
  return { repoMaybeStale: await graphMaybeStale(cwd) };
}
