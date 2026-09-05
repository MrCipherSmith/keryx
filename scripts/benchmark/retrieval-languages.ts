// Which files count as source, in one place.
//
// The task extractor and the answer scorer both need this, and they had drifted:
// the extractor accepted `.mjs` but not `.cjs`, the scorer accepted both. A gold
// file the extractor rejected could still be matched by the scorer, and neither
// list had any stated reason for its contents.
//
// The reason is now explicit: **these are the languages gdgraph indexes.**
// `src/gdgraph/build.ts` builds its graph over .ts, .tsx, .js, .jsx, .java and
// .py. Measuring retrieval on a language the graph cannot see would ask the
// context arm to demonstrate an advantage it structurally does not have, and
// score the resulting nothing against keryx.
//
// This is why vantage-backend produced zero tasks on the first attempt: 4,204
// Java files, and a benchmark that only recognised TypeScript. The graph could
// have indexed every one of them.

/** Extensions gdgraph builds a graph over — kept aligned with SOURCE_EXTENSIONS there. */
export const SOURCE_EXTENSIONS: readonly string[] = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "java",
  "py",
];

/** Matches a path ending in a source extension. */
export const SOURCE_FILE = new RegExp(`\\.(${SOURCE_EXTENSIONS.join("|")})$`);

/**
 * Finds source paths inside prose.
 *
 * The leading `/?` is load-bearing: without it an absolute answer like
 * `/tmp/wt-1/src/a.ts` is captured as `tmp/wt-1/src/a.ts`, which no longer
 * starts with the worktree root, so the prefix strip silently fails and a
 * correct answer scores as a miss.
 */
export function sourcePathPattern(): RegExp {
  return new RegExp(
    `/?(?:[\\w.@-]+/)+[\\w.@-]+\\.(?:${SOURCE_EXTENSIONS.join("|")})\\b`,
    "g",
  );
}
