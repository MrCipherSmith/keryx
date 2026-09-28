// Flow 356 (A-3, audit remediation 3): `keyFilesForPage`, split out of
// `collect.ts` to break a cycle. `collect.ts` -> `provenance.ts` ->
// `describes.ts` -> `collect.ts` (for this one four-line lookup) was the
// entire loop `gdgraph query cycles` reported for this trio — this file has
// no import of any of the three, so `describes.ts` reaching it instead of
// `collect.ts` closes nothing.
//
// `collect.ts` still exports `keyFilesForPage` (re-exported below) — its
// other callers (`wiki/enrich.ts`, this module's own tests under
// `collect.test.ts`) are unaffected by the move.

import type { WikiPage } from "./types";

/** `collect.ts`'s `computeModuleKeyFiles` return shape: page path -> its key files. */
export type ModuleKeyFilesIndex = ReadonlyMap<string, string[]>;

/** Look up a page's key files in a `computeModuleKeyFiles` index. Empty for non-`component` pages (no module key-files concept applies). */
export function keyFilesForPage(index: ModuleKeyFilesIndex, page: Pick<WikiPage, "relativePath">): string[] {
  return index.get(page.relativePath) ?? [];
}
