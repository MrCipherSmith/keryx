// Shared graph-target resolution for `affected` / `getAffected`.
//
// Both entry points used to resolve a user-supplied path with ONE predicate:
//
//   nodes.find(n => n.path === normalized || n.path.endsWith(normalized))
//
// which has two defects. `find` returns the FIRST hit in node order, so a suffix
// match that sorts earlier beats a later exact match — with a nested checkout in
// the graph, `src/lib/fs.ts` resolved to `.claude/worktrees/<wt>/src/lib/fs.ts`.
// And `endsWith` is not path-segment aware, so `fs.ts` also matches `myfs.ts`.
// Worst of all, an ambiguous target was silently resolved to one arbitrary
// candidate and the answer was reported as if it were exact.
//
// Resolution is now two-pass — exact match first, then a suffix match anchored to
// a `/` boundary — and an ambiguous suffix REFUSES rather than guessing, the way
// `resolveFlowDir` does (`src/flow/store.ts:86`). Acting on a guessed node is how
// a blast-radius answer ends up describing a different file than the caller asked
// about.

import path from "node:path";
import type { GraphData } from "./types";

export function normalizeTarget(target: string): string {
  return target.replace(/^\.\//, "").split(path.sep).join("/");
}

// Resolve `target` to a node path. Returns the normalized target unchanged when
// nothing matches (callers then report an empty blast radius, as before).
// Throws when the target is an ambiguous suffix of several distinct nodes.
export function resolveGraphTarget(graph: GraphData, target: string): string {
  const normalized = normalizeTarget(target);

  // Pass 1 — exact path. An exact match is never ambiguous and always wins.
  if (graph.nodes.some((item) => item.path === normalized)) {
    return normalized;
  }

  // Pass 2 — suffix match on a `/` boundary, so `lib/fs.ts` matches
  // `src/lib/fs.ts` but `fs.ts` does not match `src/lib/myfs.ts`.
  const suffix = `/${normalized}`;
  const candidates = [
    ...new Set(
      graph.nodes.filter((item) => item.path.endsWith(suffix)).map((item) => item.path),
    ),
  ].sort();

  if (candidates.length > 1) {
    throw new Error(
      `Graph target "${target}" is ambiguous — ${candidates.length} files match it:\n` +
        candidates.map((candidate) => `  - ${candidate}`).join("\n") +
        "\nRe-run with the full repository-relative path.",
    );
  }

  return candidates[0] ?? normalized;
}
