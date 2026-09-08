// Whether a routed search answer is an enumeration, and what it never looked at.
//
// `keryx ctx rg` is this repository's mandated code-search route: CLAUDE.md
// requires every text/symbol/pattern search over project code to go through it,
// and an installed hook blocks raw `rg`/`grep`. Three reviews in one week
// refused to use it for their central task and fell back to raw search with a
// stated reason. Their objection was not that it compacts — compaction exists
// because raw output floods context — but that a caller cannot tell a complete
// answer from a truncated one without opening the raw log, and nothing tells
// them to. Eliding matches is fine for FINDING something and useless for
// PROVING a list of sites is complete, which is what a defect-class enumeration
// is.
//
// Measured on this repository before any change (flow 238 / T13; re-verified
// against the checkout this fix lands on — the exact counts drift as the
// codebase grows, the shape of each defect does not):
//
//   1. Per file, `RG_EXAMPLES_PER_FILE = 4` hits are rendered; per result,
//      `maxGroupItems = 12` files are rendered AT ALL. `keryx ctx rg "omitted"
//      src` printed `Matches: 380` above 48 rendered hits drawn from 12 of 139
//      files — 127 files named nowhere in the body.
//   2. A small result carries no elision marker and no raw pointer at all, so a
//      caller who tests the tool on a two-hit query sees a clean, complete
//      answer and then trusts the same tool on a 380-hit one. The output
//      changes shape silently between those two runs.
//   3. `.metaproject/` is unreachable — not through any keryx exclusion and not
//      through `.gitignore` (`git check-ignore` exits 1 on it), but through
//      ripgrep's own default of not descending into dot-paths. `keryx ctx rg
//      "Enabled Modules"` (no path given) reported 8 matches in 6 files, none
//      of them under `.metaproject/`; the same search with the
//      already-allowlisted `--hidden` reported 11 in 9, including
//      `.metaproject/index.md`. An excluded directory was indistinguishable
//      from a directory with no matches.
//
// This module holds the two lines that close that gap, so every gdctx search
// summariser states them the same way and cannot drift apart:
//
//   - `Scope:` — what ripgrep was not allowed to look at on THIS run, so
//     "no match there" is distinguishable from "never searched there".
//   - `Completeness:` — whether the body below is everything found, and when it
//     is not, how to ask for everything in one step rather than two.
//
// Both are single lines with a fixed leading key, so they are greppable and so
// a small result does not grow a truncation apparatus it does not need — the
// opposite defect a sibling lane already fixed here.

/** Which of ripgrep's default exclusions a given run lifted. */
export type SearchScope = {
  /** `--hidden` was forwarded: dot-paths were traversed. */
  hidden: boolean;
  /** `--no-ignore`/`--no-ignore-vcs` was forwarded: ignore files were not applied. */
  ignored: boolean;
  /**
   * `-m`/`--max-count` was forwarded, so ripgrep itself stopped counting.
   *
   * This is the one case where the header count is not a total. Everything
   * else keryx reports is computed over the whole captured output, so
   * `Matches:` is true; with `-m` it is only what ripgrep chose to emit.
   * Measured: `keryx ctx rg -m 1 "omitted" src/ctx/lines.ts` printed
   * `Matches: 1` for a file holding 19, exit code 0, no marker anywhere. A
   * truncated count reported as a total is precisely the defect this whole
   * programme exists to stop, sitting inside its own search tool.
   */
  capped: boolean;
};

const HIDDEN_FLAGS = new Set(["--hidden"]);
const IGNORE_FLAGS = new Set(["--no-ignore", "--no-ignore-vcs"]);
const MAX_COUNT_FLAGS = new Set(["-m", "--max-count"]);

/**
 * Read the scope out of the caller's own argv.
 *
 * Scanning stops at the first bare `--` for the same reason `buildRgCommand`
 * does: after it every token is a pattern or a path by the caller's intent, and
 * a literal search for the string `--hidden` must not be reported as a widened
 * scope. Inline `--flag=value` is recognised because ripgrep accepts it and
 * `buildRgCommand` forwards it.
 */
export function rgSearchScope(args: readonly string[]): SearchScope {
  const scope: SearchScope = { hidden: false, ignored: false, capped: false };
  for (const arg of args) {
    if (arg === "--") {
      break;
    }
    const name = arg.includes("=") ? (arg.split("=", 1)[0] as string) : arg;
    if (HIDDEN_FLAGS.has(name)) scope.hidden = true;
    if (IGNORE_FLAGS.has(name)) scope.ignored = true;
    if (MAX_COUNT_FLAGS.has(name)) scope.capped = true;
  }
  return scope;
}

/**
 * The `Scope:` line — what this run did not look at.
 *
 * Binary files are listed unconditionally because ripgrep has no flag keryx
 * forwards that changes it: a file holding a NUL byte is skipped during
 * traversal with no stdout, no stderr and exit code 0. Verified on a fixture
 * directory: a two-hit file containing one NUL produced zero output and no
 * diagnostic of any kind. That is the same silent-absence failure the
 * repository-wide guard at src/lib/searchable-sources.test.ts exists to prevent
 * on our own sources, and it still applies to anything else the search crosses.
 */
export function scopeLine(scope: SearchScope): string {
  const lifted = [scope.hidden ? "--hidden" : null, scope.ignored ? "--no-ignore" : null].filter(
    (flag): flag is string => flag !== null,
  );
  const excluded = [
    scope.hidden
      ? null
      : "hidden paths not named on the command line (any dot-directory, `.metaproject/` included)",
    scope.ignored ? null : "`.gitignore`d files",
    "binary files (anything holding a NUL byte, which ripgrep always skips silently)",
  ].filter((entry): entry is string => entry !== null);
  const widen = [scope.hidden ? null : "`--hidden`", scope.ignored ? null : "`--no-ignore`"].filter(
    (flag): flag is string => flag !== null,
  );

  return (
    `Scope: \`${lifted.length > 0 ? lifted.join(" ") : "ripgrep defaults"}\` — ` +
    `NOT searched: ${excluded.join("; ")}. ` +
    `There, a nil result means "not looked at", not "not present".` +
    (widen.length > 0 ? ` Widen with ${widen.join(" / ")}.` : "")
  );
}

/**
 * ` (capped by -m/--max-count — not a total)`, appended to a header count
 * line, or `""` when the count is a real total.
 *
 * A separate function rather than inlining the string at each call site
 * because two summarisers (`summarizeRg` and `summarizeRgFileList`) both
 * print a header count, and the whole point of this module is that the two
 * cannot say it differently. `completenessLine` below covers the same fact
 * once, in the body; this puts the same warning where a reader who only reads
 * the first line still sees it — the "Matches: 12" defect this module exists
 * to close was exactly a reader stopping at the header.
 */
export function cappedHeaderNote(scope: SearchScope): string {
  return scope.capped ? " (capped by -m/--max-count — not a total)" : "";
}

/** How much of what the search found actually reached the body. */
export type SearchTotals = {
  /** Rendered items of `unit`. */
  shown: number;
  /** Items of `unit` the search produced in total. */
  total: number;
  /** What is being counted — "matches" for a hit search, "files" for `-l`/`--count`. */
  unit: string;
  /**
   * File-level coverage, when it is a second axis of loss.
   *
   * A hit search drops on two axes independently: hits within a rendered file,
   * and whole files that are never rendered at all. The second is the one that
   * breaks an enumeration hardest — 126 of 138 files went unnamed in the
   * measured case — so it is reported separately rather than folded into a
   * single count. A file-list search has only one axis and omits this.
   */
  files?: { shown: number; total: number };
};

/**
 * The `Completeness:` line — an enumeration, or not.
 *
 * Present on every summary, including the ones that cut nothing, because the
 * realistic failure is a caller who tests with a small query and then trusts
 * the tool on a large one. A verdict that only appears when it is bad teaches
 * nobody to look for it; a fixed key that reads `complete` on the small run is
 * what makes `partial` legible on the large one.
 *
 * `capped` outranks the counts: with `-m` nothing keryx can measure is a total,
 * so claiming `complete` because it happened to render every emitted line would
 * be the header-count defect wearing a new label.
 */
export function completenessLine(totals: SearchTotals, scope: SearchScope): string {
  if (scope.capped) {
    return (
      "Completeness: `unknown` — `-m`/`--max-count` caps ripgrep's own output, so the counts " +
      "above are what ripgrep emitted, not what exists. Drop it for a countable answer."
    );
  }
  const files = totals.files;
  const partial = totals.shown < totals.total || (files !== undefined && files.shown < files.total);
  if (!partial) {
    return `Completeness: \`complete\` — every one of the ${totals.total} ${totals.unit} ripgrep emitted is listed below.`;
  }
  const across =
    files !== undefined ? ` across ${files.shown} of ${files.total} files` : "";
  return (
    `Completeness: \`partial\` — ${totals.shown} of ${totals.total} ${totals.unit}${across} ` +
    "are listed below. This is NOT an enumeration: re-run with `--all` for every match, or " +
    "`--json` for the full machine-readable set."
  );
}
