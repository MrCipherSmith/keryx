// Test support: the source scanner the two `config-dir` guards are built on.
//
// `config-dir.writers.test.ts` came out of four review rounds in which each
// round wrote a behavioural test over "every writer", honestly believed it
// complete, and covered a subset. The construction that finally held derives the
// denominator from the source and asserts the complement is empty. The reader
// side then repeated the whole history in miniature: its guard is a hand-written
// list of six entries, and two raw reads in `session/store.ts` sat outside it
// from the day it was written.
//
// So the machinery lives here once and both guards import it. A second copy of
// the comment stripper is the third-copy mistake `config-dir.ts` was extracted
// to stop, and it is worse here than there: two strippers that drift produce two
// guards that disagree about what the source says.
//
// This file is itself scanned by both guards. That is deliberate — it must not
// be exempt from the rules it implements. It stays clean because `code()` blanks
// string literals before anything is matched, so the resolver and call names
// below are invisible to the scan that reads them.
//
// Not a `.test.` file on purpose: `sourceFiles()` filters those out, and a
// scanner that cannot see itself is a scanner with a blind spot by construction.

import { readFileSync } from "node:fs";
import { Glob } from "bun";
import path from "node:path";

/**
 * Functions that resolve a path inside the shared user-global directory.
 *
 * Shared by both guards, because "which files count as touching the shared
 * directory" is one question and two answers to it is how a file ends up
 * governed on write and unguarded on read — which is exactly what happened.
 */
export const CONFIG_PATH_RESOLVERS = [
  "keryxConfigDir(",
  "keryxDataDir(",
  "shellConfigPath(",
  "shellPermissionsPath(",
  "sandboxConfigPath(",
  "serveConfigPath(",
  "serveCredentialPath(",
  "projectRegistryPath(",
  // The session store resolves its own paths below the shared root through
  // these, and neither name appeared in the writers list. Absent them, every
  // reader and writer under `sessions/` is outside both guards' numerator —
  // which is how `store.ts` stayed invisible.
  "projectSessionsDir(",
  "sessionDir(",
] as const;

// LIMIT, stated rather than discovered later: matching on `name(` misses a
// resolver imported under an alias. `session/store.ts` does exactly that
// (`sessionDir as sessionDirPath`), and it lands in the numerator only because
// it ALSO calls `projectSessionsDir` unaliased. A file that aliased every
// resolver it used would be invisible to both guards. Dropping the `(` to match
// the import instead trades this for false positives on every identifier that
// merely contains the name, which is the noise that teaches people to ignore a
// guard. The alias shape has not occurred outside `store.ts`; it is recorded
// here so the next reader finds it rather than measures it.

/**
 * A file excused from a guard, with the reason it is excused.
 *
 * A bare path is not accepted anywhere in either guard: an exemption without a
 * reason is indistinguishable from an oversight, and an oversight is the failure
 * both guards exist to prevent.
 */
export interface Exemption {
  file: string;
  reason: string;
  /**
   * When present, only these raw calls are excused in this file; every other
   * call in `calls` is still reported.
   *
   * A whole-file exemption is the blunt form and it is wrong wherever a file has
   * one legitimate raw call and one illegitimate one. `session/store.ts` is
   * exactly that on the read side — its `readdirSync` enumerates session
   * directories and is fine, while its `readFileSync` is the finding this guard
   * was built for. Excusing the file would have excused the defect.
   */
  calls?: readonly string[];
}

/** One file caught making one kind of raw call. */
export interface Offence {
  file: string;
  raw: string;
}

/**
 * The source with comments removed — and with string literals blanked first.
 *
 * Both halves are necessary and the second was missing for a while. Comments
 * must go because the very comment explaining why a writer stopped calling
 * `writeFileSync` mentions `writeFileSync`, and a guard whose first finding is
 * spurious teaches everyone to ignore it. String literals must go FIRST because
 * a `/*` inside one — a glob such as `"**` + `/*.json"`, which this codebase
 * already contains — opened a block comment that swallowed everything up to the
 * next `*` + `/`, taking any real call with it. A review measured a file reduced
 * to seven characters.
 *
 * Literals are replaced by an empty string of the same kind rather than deleted,
 * so nothing downstream sees an unterminated quote.
 */
export function code(source: string): string {
  const withoutStrings = source
    .replace(/`(?:\\.|[^`\\])*`/gs, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
  return withoutStrings.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Every non-test source file under `srcRoot`, as repo-relative POSIX paths. */
export function sourceFiles(srcRoot: string): string[] {
  return [...new Glob("**/*.ts").scanSync(srcRoot)]
    .map((relative) => relative.split(path.sep).join("/"))
    .filter((relative) => !relative.includes(".test."))
    .sort();
}

/** The real source tree, as the map the scan consumes. */
export function treeSources(srcRoot: string): Map<string, string> {
  return new Map(sourceFiles(srcRoot).map((relative) => [relative, readFileSync(path.join(srcRoot, relative), "utf8")]));
}

/**
 * Files that both resolve a config path and make one of `calls` raw.
 *
 * PURE over a `{ path -> source }` map, deliberately. The writers guard's first
 * version read the tree itself, and its "the detector can fail" test then
 * re-implemented the predicate inline rather than calling it — so replacing the
 * whole body with `return []` left the file green with a real offender planted
 * in the tree. A guard whose self-check does not exercise the guard is the
 * decorative shape both guards exist to prevent, reproduced inside one of them.
 */
export function scanFor(
  sources: ReadonlyMap<string, string>,
  spec: { readonly calls: readonly string[]; readonly exemptions: ReadonlyArray<Exemption> },
): Offence[] {
  // `null` excuses the whole file; a set excuses only those calls.
  const exempt = new Map<string, ReadonlySet<string> | null>(
    spec.exemptions.map((exemption) => [
      exemption.file,
      exemption.calls === undefined ? null : new Set(exemption.calls),
    ]),
  );
  const found: Offence[] = [];
  for (const [relative, raw] of [...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const excused = exempt.get(relative);
    if (excused === null) {
      continue;
    }
    const source = code(raw);
    if (!CONFIG_PATH_RESOLVERS.some((resolver) => source.includes(resolver))) {
      continue;
    }
    for (const call of spec.calls) {
      if (excused?.has(call) === true) {
        continue;
      }
      if (source.includes(call)) {
        found.push({ file: relative, raw: call });
      }
    }
  }
  return found;
}
