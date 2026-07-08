// Selection helpers (Block D · D2/D3). Pure, deterministic, dependency-free.
//
// - `resolveSmokeSet` expands `smoke.selectors` (globs / tags / explicit paths)
//   over the known test files into a stable list. Empty selectors ⇒ `[]` ⇒ the
//   union in `service.ts` is a no-op (byte-identical default, AC14).
// - `relatedByNamingAndDirectory` / `staticChangedSelection` reproduce the
//   existing static changed-file selection EXACTLY so the coverage-map path can
//   reuse the naming heuristic for map-absent files without diverging (AC11).

import path from "node:path";

export const TEST_FILE_RE = /(^|\/)(__tests__\/.*|.*\.(test|spec)\.[cm]?[tj]sx?$|e2e\/.*\.[cm]?[tj]sx?$|tests\/.*\.[cm]?[tj]sx?$)/;

export function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

// The existing naming/directory heuristic (kept byte-identical to service.ts).
export function relatedByNamingAndDirectory(target: string, testFiles: string[]): string[] {
  const normalized = normalizePath(target);
  const ext = path.extname(normalized);
  const withoutExt = ext ? normalized.slice(0, -ext.length) : normalized;
  const base = path.basename(withoutExt);
  const dir = path.dirname(normalized);
  return testFiles
    .filter((file) => {
      const fileDir = path.dirname(file);
      const fileBase = path.basename(file);
      return (
        file.startsWith(`${withoutExt}.`) ||
        file.includes(`${withoutExt}.`) ||
        (fileDir === dir && fileBase.startsWith(`${base}.`)) ||
        (fileDir.startsWith(dir) && fileBase.includes(base))
      );
    })
    .sort();
}

// Today's static selection over a set of changed files: a changed test file
// selects itself; each changed file selects its naming/directory-related tests.
export function staticChangedSelection(changedFiles: string[], testFiles: string[]): Set<string> {
  const selected = new Set<string>();
  for (const file of changedFiles) {
    if (TEST_FILE_RE.test(file)) {
      selected.add(file);
    }
    for (const related of relatedByNamingAndDirectory(file, testFiles)) {
      selected.add(related);
    }
  }
  return selected;
}

// Expand smoke selectors over the known test files. A selector matches a test
// file when it is an exact path, a glob (`*`/`**`) match, or a plain tag/segment
// substring. Returns a sorted, de-duplicated list (⊆ testFiles).
export function resolveSmokeSet(
  smoke: { selectors: string[] } | undefined,
  testFiles: string[],
): string[] {
  const selectors = smoke?.selectors ?? [];
  if (selectors.length === 0) {
    return [];
  }
  const matched = new Set<string>();
  for (const rawSelector of selectors) {
    const selector = normalizePath(rawSelector.trim());
    if (selector.length === 0) {
      continue;
    }
    for (const file of testFiles) {
      if (smokeSelectorMatches(selector, file)) {
        matched.add(file);
      }
    }
  }
  return Array.from(matched).sort();
}

function smokeSelectorMatches(selector: string, file: string): boolean {
  if (selector === file) {
    return true;
  }
  if (/[*?[\]]/.test(selector)) {
    return globToRegExp(selector).test(file);
  }
  // Plain tag/segment: match a path segment or substring.
  return file === selector || file.includes(selector);
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (char === "?") {
      re += "[^/]";
    } else if (char && ".+^${}()|[]\\".includes(char)) {
      re += `\\${char}`;
    } else {
      re += char;
    }
  }
  return new RegExp(`^${re}$`);
}
