/**
 * The floor guard — the diff-scoped check for changes that lower the bar
 * (flow 258, T11).
 *
 * Every other check in this repository asks whether the change is correct.
 * None of them asks whether the change made the *checks* weaker, and that is a
 * different question with a different failure mode: a coverage threshold moved
 * from 80 to 70, an `it.skip` added to a flaky test, an assertion deleted from
 * a test that still passes, a `// @ts-expect-error` above the line that would
 * not compile. Each one is individually defensible, each one is invisible in a
 * green suite, and together they are how a suite rots.
 *
 * So this module does not judge. It makes the four edits VISIBLE IN THE DIFF
 * THAT INTRODUCES THEM, with the removed line next to the added one, so the
 * question "was that deliberate?" is asked while the answer is still cheap.
 *
 * Pure, like `scope.ts`: a function of a {@link ReviewScope}, no filesystem, no
 * git, no model. The input is deliberately the scope rather than a raw diff —
 * `buildReviewScope` already drops lockfiles, generated output and vendored
 * trees, and a floor guard that fired on a regenerated `dist/` bundle would be
 * turned off in a week.
 *
 * ## Credit
 *
 * The catalogue of four weakening edits is adapted (MIT) from
 * [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), where
 * it is a reference snippet a reviewer is asked to apply by hand. Making it an
 * executable check over a {@link ReviewScope} — the skeleton match, the
 * per-region counting, the ceiling-word list and the NOT DETECTED list below —
 * is this repository's work.
 *
 * ## The pre-filter dependency, stated
 *
 * `scope.ts` drops comment-only change blocks — EXCEPT ones whose comments are
 * tool directives (`isDirectiveComment`). That carve-out is what makes
 * suppression detection possible here: a diff whose only change is
 * `+ // eslint-disable-next-line` survives the pre-filter as a retained region.
 * If that carve-out were ever removed, {@link detectFloorRegressions} would go
 * quiet rather than fail, so it is named here as a load-bearing assumption.
 *
 * ## NOT DETECTED, deliberately
 *
 * - **An assertion weakened in place.** `expect(x).toBe(3)` becoming
 *   `expect(x).toBeDefined()` removes one assertion-carrying line and adds one,
 *   so the count heuristic below sees nothing. Catching it needs a matcher
 *   taxonomy per framework, which is a different and much larger claim than
 *   "this module counts lines".
 * - **A test removed together with its assertions where the region also gains
 *   assertions.** The counting is per region and nets out; a rewrite that
 *   deletes four assertions and adds four is silent.
 * - **A threshold moved on a line that was also edited otherwise.** The
 *   skeleton match below requires the removed and added lines to be identical
 *   once numbers are erased, so `- minCoverage: 80` / `+ minimumCoverage: 70`
 *   is a false negative. Loosening that match is what turns this detector into
 *   "a number changed somewhere", which is noise, not signal. A trailing
 *   COMMENT is the one edit that does not break the pair ({@link codeOf}),
 *   because "lower it and explain on the same line" is the evasion this guard
 *   is for.
 * - **A threshold whose name says nothing.** `- limit: 10` / `+ limit: 100`
 *   fires because `limit` is a ceiling word; `- n: 10` / `+ n: 3` does not fire
 *   at all, and neither does a number with no name in front of it at all — a
 *   renumbered markdown list, an argument after a comma. A bare number moving
 *   is not evidence, and this module refuses to pretend it is.
 * - **A bar named only by the ASSERTION around it.** `expect(score.recall)
 *   .toBe(1)` becoming `.toBe(0)` is silent: the identifier adjacent to the
 *   number is `toBe`, and `recall` is a property of the subject, not the name of
 *   the literal. Measured, not supposed — it is one of the three non-list
 *   findings whole-line reading produced over the window in
 *   {@link detectLoweredThresholds}, and the only one of the three the narrowing
 *   gave up. Reading back through a matcher to its subject is a matcher taxonomy,
 *   which is the same larger claim this module declines above.
 * - **A test table built by a call.** {@link DISABLED_CALL} allows an argument
 *   list on a chained modifier, but a paren-free one: `describe.each(cases).skip(`
 *   fires and `describe.each(build(x)).skip(` does not. Balanced parentheses are
 *   a parser's job.
 * - **A resource CEILING that is also a real bar.** `maxFailedRows: 0 -> 50`
 *   is silent, because `rows` is a capacity word and `max` is a ceiling; see
 *   {@link thresholdDirection} for why that asymmetry is deliberate and why the
 *   floor half (`minItems: 3 -> 0`) is not silent.
 * - **A test disabled without being called.** The detector requires `(` after
 *   the keyword, so a `skip` assigned and invoked later — `const t = it.skip; t(…)`
 *   — is invisible. Bought deliberately: without the `(`, English punctuation put
 *   every sentence mentioning `it.skip` into the output.
 * - **A suppression that moved AND changed.** A marker re-added with one more
 *   rule in its list is reported as added, because the trimmed text no longer
 *   matches what was removed. That is the right side to err on, but it means a
 *   reindent that also reflows the comment is a finding.
 * - **A weakening spread across files** — a threshold lowered in one file to
 *   accommodate a test disabled in another. Each half is reported on its own or
 *   not at all; nothing here correlates them.
 * - **Anything in a file the pre-filter dropped.** A coverage gate lowered
 *   inside a vendored or generated path is invisible, by construction.
 */

import { TEST_FILE_RE } from "../testing/selection";
import type { ReviewScope, ScopedRegion } from "./scope";

export const FLOOR_FINDING_KINDS = [
  "threshold-lowered",
  "test-disabled",
  "assertion-removed",
  "suppression-added",
] as const;
export type FloorFindingKind = (typeof FLOOR_FINDING_KINDS)[number];

/**
 * One edit that lowered the bar, with the evidence that says so.
 *
 * `removed`/`added` carry the lines verbatim (trimmed) rather than a summary:
 * the whole value of this guard is that a human can answer "deliberate?" from
 * the finding alone, without opening the diff again.
 */
export type FloorFinding = {
  kind: FloorFindingKind;
  path: string;
  /** New-file line the evidence sits at. For a removal, the line it was at. */
  line: number;
  /** Why this fired, in words, including what narrowed it. */
  detail: string;
  removed?: string;
  added?: string;
};

/**
 * The report's discriminant, and the reason the CLI has a third exit code.
 *
 * `scanned` means the guard looked; `cannot-scan` means it could not — an
 * unresolvable ref, an unreadable diff file, a shallow clone. Those are not the
 * same answer as "found nothing", and `rules/core/cli-interface-design.mdc`
 * reserves exit **2** for exactly that difference. Without the discriminant the
 * `scanned` counts below are simply ABSENT on every failure path, so the one
 * distinction this module was built around — 0 findings versus 0 input —
 * collapses precisely when it matters.
 */
export type FloorOutcome = "scanned" | "cannot-scan";

/**
 * What `--json` emits when the guard could not look.
 *
 * Data on stdout rather than prose on stderr, because a machine reader that
 * only ever receives prose has to parse English to tell a bad ref from a clean
 * diff. Same `schemaVersion` as {@link FloorReport}: one shape family, two arms,
 * told apart by `outcome`.
 */
export type FloorCannotScan = {
  schemaVersion: 1;
  outcome: "cannot-scan";
  /** Why, in the words the plain-text mode would have printed. */
  error: string;
};

export function floorCannotScan(error: string): FloorCannotScan {
  return { schemaVersion: 1, outcome: "cannot-scan", error };
}

export type FloorReport = {
  schemaVersion: 1;
  outcome: "scanned";
  findings: FloorFinding[];
  counts: {
    total: number;
    byKind: Record<FloorFindingKind, number>;
  };
  /** What the guard actually looked at, so "0 findings" can be told from "0 input". */
  scanned: {
    files: number;
    regions: number;
    changedLines: number;
  };
};

// ---------------------------------------------------------------------------
// Region lines
// ---------------------------------------------------------------------------

type RegionLine = { kind: "add" | "del" | "context"; text: string; line: number };

/**
 * A scoped region's lines with their new-file line numbers.
 *
 * Mirrors the anchor rule in `scope.ts`: a removed line has no new-file line,
 * so it is anchored to the position it was removed from.
 */
function regionLines(region: ScopedRegion): RegionLine[] {
  const lines: RegionLine[] = [];
  let cursor = region.startLine;
  for (const raw of region.text.split("\n")) {
    const marker = raw.charAt(0);
    if (marker === "+") {
      lines.push({ kind: "add", text: raw.slice(1), line: cursor });
      cursor += 1;
      continue;
    }
    if (marker === "-") {
      lines.push({ kind: "del", text: raw.slice(1), line: cursor });
      continue;
    }
    lines.push({ kind: "context", text: raw.slice(1), line: cursor });
    cursor += 1;
  }
  return lines;
}

/** True when the match at `index` has a quote before it on the same line. */
function quotedBefore(text: string, index: number): boolean {
  return /["'`]/.test(text.slice(0, index));
}

const COMMENT_OPENER = /(^|\s)(\/\/|\/\*|\*|#|--|<!--|;;)/;

// ---------------------------------------------------------------------------
// 1. Lowered thresholds
// ---------------------------------------------------------------------------

/**
 * Words whose number is a FLOOR: higher is stricter, so moving it DOWN weakens.
 *
 * Matched as whole identifier tokens (`minCoverage` tokenises to `min`,
 * `coverage`), never as substrings — a substring rule makes `admin` a minimum.
 *
 * Deliberately short. Coverage-report keys (`lines`, `branches`, `functions`,
 * `statements`) are absent: they carry a threshold in a jest config and an
 * ordinary count everywhere else, and a guard that fires on `lines: 3` is a
 * guard somebody switches off.
 */
const FLOOR_WORDS = new Set([
  "coverage",
  "threshold",
  "thresholds",
  "minimum",
  "min",
  "atleast",
  "least",
  "required",
  "requires",
  "precision",
  "recall",
  "accuracy",
  "floor",
  "quorum",
  "passrate",
  "slo",
  "sla",
]);

/**
 * Words whose number is a CEILING: higher is looser, so moving it UP weakens.
 *
 * `timeout`, `wait`, `sleep` and `delay` are here because the canonical way to
 * silence a flaky test is to give it more time, and `retry`/`attempts` because
 * the second canonical way is to give it more goes. `max`, `limit`, `budget`
 * and `tolerance` are here because `--max-warnings 0` becoming `50` is the
 * plainest bar-lowering there is.
 */
const CEILING_WORDS = new Set([
  "max",
  "maximum",
  "limit",
  "limits",
  "ceiling",
  "cap",
  "budget",
  "timeout",
  "timeouts",
  "deadline",
  "wait",
  "sleep",
  "delay",
  "retry",
  "retries",
  "attempts",
  "tolerance",
  "epsilon",
  "grace",
  "allowed",
  "allowance",
  "slack",
]);

/**
 * Words that make the number a RESOURCE DIMENSION rather than a bar.
 *
 * Not a guess: the first run of this guard over four merged commits on `main`
 * produced exactly one finding, `maxOutputTokens: 16 -> 256` in a TUI modal.
 * `max` is a ceiling word and the number went up, so the rule fired — but a
 * ceiling on how much DATA a thing may carry is not a quality bar, and nothing
 * was weakened. A line naming any of these is silent in both directions, which
 * is the honest fix: the alternative is a guard whose first real finding is
 * noise.
 *
 * The cost is stated rather than hidden: a bar that genuinely weakened on a
 * line that also names a unit — `maxFailedRows: 0 -> 50` — is now invisible.
 */
const CAPACITY_WORDS = new Set([
  "token",
  "tokens",
  "byte",
  "bytes",
  "kb",
  "mb",
  "gb",
  "size",
  "width",
  "height",
  "length",
  "char",
  "chars",
  "characters",
  "px",
  "pixels",
  "rows",
  "cols",
  "columns",
  "items",
  "entries",
  "records",
  "results",
  "buffer",
  "chunk",
  "page",
  "offset",
  "capacity",
  "depth",
  "memory",
  "workers",
  "threads",
  "concurrency",
  "parallel",
  "batch",
]);

const NUMBER = /[0-9]+(?:\.[0-9]+)?/g;

/** Identifier tokens in a fragment: camelCase and snake_case both split. */
function tokensOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * The line with its trailing comment removed, so the pairing below compares
 * CODE with CODE.
 *
 * Without this, `- minCoverage: 80,` / `+ minCoverage: 70, // keeps the page
 * size sane` is not a paired edit at all — the skeletons differ by the comment
 * — and the guard whose whole purpose is to be hard to slip past is evaded by
 * typing a justification on the same line. {@link COMMENTED_LINE} does not help:
 * it only skips lines that are *entirely* comment.
 *
 * Quote state is tracked so a `//` inside a URL or a `#` inside a string is not
 * mistaken for an opener. `--` needs a following space to count, because
 * `--max-warnings` is a flag, not a SQL comment.
 */
function stripTrailingComment(text: string): string {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quote !== undefined) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    const priorIsSpace = index === 0 || /\s/.test(text.charAt(index - 1));
    if (text.startsWith("//", index) || text.startsWith("/*", index)) {
      return text.slice(0, index);
    }
    if (char === "#" && priorIsSpace) {
      return text.slice(0, index);
    }
    if (text.startsWith("-- ", index) && priorIsSpace) {
      return text.slice(0, index);
    }
  }
  return text;
}

/** A line reduced to the code the pairing compares: comment gone, tail trimmed. */
function codeOf(text: string): string {
  return stripTrailingComment(text).trimEnd();
}

/** The line with every numeric literal erased — two lines match iff only numbers differ. */
function numericSkeleton(text: string): string {
  return text.replace(NUMBER, "\u0000");
}

type NumberHit = { value: number; index: number };

function numbersOf(text: string): NumberHit[] {
  return [...text.matchAll(NUMBER)].map((match) => ({ value: Number(match[0]), index: match.index ?? 0 }));
}

/**
 * Trailing separators between a key and its value: whitespace, the assignment
 * and key punctuation, an opening bracket, a quote. Deliberately NOT `,` and
 * not a closing bracket — `foo(bar, 5)` must not attribute `5` to `bar`.
 */
const KEY_SEPARATORS = /[\s:=(["'`{<]*$/;
const TRAILING_IDENTIFIER = /[A-Za-z0-9_$.-]+$/;
/** A constant index between the key and its value: `minScores[0] = 80`. */
const TRAILING_INDEX = /\[\s*[0-9]*\s*\]$/;
/** A separator through which the identifier further left ENCLOSES this one. */
const OPENS_CONTAINER = /[{([<]/;

/**
 * Words that state a number's TYPE rather than what it measures.
 *
 * `const minCoverage: number = 80` is how a threshold constant is ordinarily
 * written in the language this repository is itself written in, and the
 * identifier adjacent to the `80` is `number` — so reading only the adjacent
 * token made the plainest TypeScript spelling of a coverage floor silent. These
 * are skipped and the walk continues left rather than being read as a name:
 * a type annotation never says whether higher is stricter.
 */
const TYPE_KEYWORDS = new Set([
  "number",
  "int",
  "integer",
  "float",
  "double",
  "long",
  "short",
  "decimal",
  "bigint",
  "boolean",
  "bool",
  "string",
  "i8",
  "i16",
  "i32",
  "i64",
  "u8",
  "u16",
  "u32",
  "u64",
  "f32",
  "f64",
  "usize",
  "isize",
]);

/**
 * The identifiers the number at `index` belongs to, INNERMOST FIRST — one group
 * of tokens per step of the walk, and the groups are never merged.
 *
 * Reading the WHOLE line, which is what this did first, let one unrelated word
 * silence a real weakening or invent a fake one. Both halves were measured:
 *
 * - `"lint": "eslint --max-warnings 0 --max-size 10"` with the `0` becoming
 *   `50` — this module's own headline example, see {@link CEILING_WORDS} — went
 *   silent, because `--max-size` elsewhere on the same line put `size` in
 *   {@link CAPACITY_WORDS}.
 * - Whole-line reading over the 200 commits ending at `main` (see
 *   {@link detectLoweredThresholds} for the command and the counts) produced 25
 *   `threshold-lowered` findings, 22 of them a renumbered list or step heading:
 *   `5. Explicitly allowed global fallback skills` becoming `6.` fired on the
 *   word `allowed`, sitting four words away from the number.
 *
 * The walk goes left from the number, and it takes up to four steps rather than
 * one because one step lost real threshold shapes — every one of these was
 * silent and each is an ordinary way to write a bar:
 *
 * - `const minCoverage: number = 80` — the adjacent identifier is the TYPE.
 *   {@link TYPE_KEYWORDS} are stepped over, not read.
 * - `thresholds: { global: 80 }` — the adjacent key is `global`, and the word
 *   that says what the number is sits one container out. The walk continues to
 *   an enclosing key only through an opener ({@link OPENS_CONTAINER}), so
 *   `foo(bar, 5)` still attributes `5` to nothing: a comma is not an opener.
 * - `minScores[0] = 80` — a constant index between the key and its value
 *   ({@link TRAILING_INDEX}).
 *
 * A number with no identifier in front of it — a list marker, a bare argument
 * after a comma — still yields no groups and therefore no direction, which is
 * the honest answer rather than a guess.
 *
 * ## The walk both ADDS and REMOVES findings, and the groups are why
 *
 * Widening the reach of a name is not a one-way widening of the guard: a step
 * outward brings in a word that can CONTRADICT the one next to the number, and
 * a contradiction is silence ({@link thresholdDirection}). Flattening every
 * step into one bag of tokens is how that happened. Each of these is silent with
 * the steps flattened and fires with them kept apart — measured at T24, both
 * readings, and pinned as fixtures in `floor.test.ts` so the pair stays testable:
 *
 * - `"coverage": { "maxWarnings": 0 -> 50 }` — this module's own headline
 *   bar-lowering ({@link CEILING_WORDS}), voided by `coverage` being a floor word.
 * - `thresholds: { maxLatencyMs: 500 -> 900 }`, `"slo": { "timeoutMs": 100 -> 900 }`
 *   — a ceiling raised under a floor-named container.
 * - `"budget": { "minScore": 90 -> 50 }` — a floor lowered under a ceiling-named
 *   container.
 * - `maxRows: { minItems: 3 -> 0 }` — the very sentence {@link CAPACITY_WORDS}
 *   was narrowed to protect, voided by the `max` one container out.
 *
 * So the groups stay separate and the INNERMOST name that speaks about direction
 * decides; see {@link thresholdDirection} for what "speaks" means and why an
 * enclosing key is never allowed to overrule it.
 */
function enclosingNames(code: string, index: number): string[][] {
  const names: string[][] = [];
  let before = code.slice(0, index);
  for (let step = 0; step < 4; step += 1) {
    const separator = KEY_SEPARATORS.exec(before)?.[0] ?? "";
    before = before.slice(0, before.length - separator.length).replace(TRAILING_INDEX, "");
    const identifier = TRAILING_IDENTIFIER.exec(before)?.[0];
    if (identifier === undefined) {
      break;
    }
    before = before.slice(0, before.length - identifier.length);
    const here = tokensOf(identifier);
    if (here.length > 0 && here.every((token) => TYPE_KEYWORDS.has(token))) {
      continue; // a type annotation names nothing about the bar
    }
    if (here.length > 0) {
      names.push(here);
    }
    if (!OPENS_CONTAINER.test(KEY_SEPARATORS.exec(before)?.[0] ?? "")) {
      break; // nothing encloses this key: it is the whole name
    }
  }
  return names;
}

type ThresholdDirection = { weakenedBy: "decrease" | "increase"; word: string } | undefined;

/**
 * Which direction weakens this number, decided by the words in the identifier
 * that NAMES it — not by the numbers, and not by the rest of the line.
 *
 * One name decides, and it is the innermost one that says anything about
 * direction. The names arrive as separate groups, innermost first
 * ({@link enclosingNames}); a group holding neither a floor nor a ceiling word
 * names nothing about the bar, so the walk asks the key enclosing it, and the
 * first group that does hold one answers for the number — including when its
 * answer is "no direction". An enclosing key never overrules a nearer one,
 * because that veto is the bug this shape was written to fix: the flat version
 * let `coverage` silence `maxWarnings: 0 -> 50`.
 *
 * A name carrying both a floor and a ceiling (`minTimeout`) is ambiguous and
 * returns `undefined`: the guard would have to guess which one the number
 * belongs to, and a guess in a guard is worse than a gap. That `undefined` is
 * final rather than a reason to keep walking — `coverage: { minTimeout: 500 }`
 * is a number the nearest name genuinely cannot read, and an outer word is not
 * evidence about it.
 *
 * {@link CAPACITY_WORDS} suppresses a CEILING and not a FLOOR, and that
 * asymmetry is load-bearing. A ceiling on a resource — `maxOutputTokens`,
 * `maxRows`, `bufferSize` — is a budget, and raising it weakens nothing; that
 * was the measured false positive the list was added for. A *minimum* stated in
 * the same units is still a demand: `minItems: 3` becoming `minItems: 0` is a
 * required-count guard relaxed to nothing, and a rule that sees `items` and
 * falls silent hides exactly the edit this module exists to show.
 *
 * The units are read from the deciding name only, which has a stated cost: a
 * capacity word that sits ONLY in an enclosing key — `tokens: { max: 16 -> 256 }`
 * — no longer suppresses, so that shape is noise. It is the price of the rule
 * above, and the alternative is the veto this fix removed.
 */
function thresholdDirection(names: readonly (readonly string[])[]): ThresholdDirection {
  for (const tokens of names) {
    const floorWord = tokens.find((token) => FLOOR_WORDS.has(token));
    const ceilingWord = tokens.find((token) => CEILING_WORDS.has(token));
    if (floorWord !== undefined && ceilingWord !== undefined) {
      return undefined;
    }
    if (floorWord !== undefined) {
      return { weakenedBy: "decrease", word: floorWord };
    }
    if (ceilingWord !== undefined) {
      return tokens.some((token) => CAPACITY_WORDS.has(token)) ? undefined : { weakenedBy: "increase", word: ceilingWord };
    }
    // this name says nothing about direction; ask the key enclosing it
  }
  return undefined;
}

/**
 * The one direction every NAMED moved number on the line agrees on.
 *
 * Unanimity among the names, not a majority: two moved numbers whose names
 * disagree about which way is worse are a line doing two things at once, and
 * this module cannot say which of them the reader should be asked about.
 *
 * A moved number this cannot give a direction — nothing named in front of it, a
 * name pulling both ways, a ceiling in resource units — is carried rather than
 * voiding the line, and contributes nothing of its own. Demanding a
 * direction from every moved number is what made `{ minCoverage: 80, count: 7 }`
 * becoming `{ 70, 4 }` silent: `count` names nothing, so the coverage floor next
 * to it was voided by its neighbour. Nothing is guessed about the unnamed
 * number — its movement still has to agree in SIGN with the named one, because
 * {@link detectLoweredThresholds} requires every moved number on the line to
 * move the same way before anything fires. A line with no named number at all
 * still returns `undefined`, so a renumbered markdown list stays silent.
 */
function agreedDirection(code: string, moved: readonly { index: number }[]): ThresholdDirection {
  let decided: ThresholdDirection;
  for (const pair of moved) {
    const here = thresholdDirection(enclosingNames(code, pair.index));
    if (here === undefined) {
      continue;
    }
    if (decided === undefined) {
      decided = here;
      continue;
    }
    if (decided.weakenedBy !== here.weakenedBy) {
      return undefined;
    }
  }
  return decided;
}

const COMMENTED_LINE = /^\s*(\/\/|\/\*|\*|#|--)/;

/**
 * Thresholds that moved the wrong way.
 *
 * Three things narrow this, and all three are needed:
 *
 * 1. **A paired edit.** The removed and added lines must be identical once
 *    every number is erased, so this is one expression being re-tuned rather
 *    than two unrelated lines that happen to hold digits. This also guarantees
 *    the two lines carry the same count of numbers, so the comparison below is
 *    positional and total. Compared on CODE ({@link codeOf}), not on the raw
 *    line: a trailing comment added in the same edit must not break the pair,
 *    or the evasion is "lower the number and explain yourself on the same line".
 * 2. **A named direction.** The identifier the moved number BELONGS to — found
 *    by walking left from it, see {@link enclosingNames} — must name a floor or
 *    a ceiling ({@link FLOOR_WORDS}, {@link CEILING_WORDS}), and only the
 *    direction that weakens THAT kind of number fires. A coverage minimum moving
 *    up is silent; a timeout moving down is silent. A line whose every moved
 *    number is unnamed is silent in both directions — `count: 5` -> `count: 3`,
 *    and `5.` -> `6.` in a renumbered markdown list, which has no name in front
 *    of it at all. The walk reaches PAST the adjacent identifier to the keys
 *    enclosing it, and that reach cuts both ways: a further name can supply a
 *    direction the adjacent one lacked, and — if the two are merged instead of
 *    kept apart — it can also CONTRADICT the adjacent one and take a real
 *    finding away. {@link enclosingNames} keeps them apart for exactly that
 *    reason, and the shapes it cost are listed there.
 * 3. **An unmixed move.** If some numbers on the line went up and others went
 *    down, nothing fires: `retry(3, 100)` -> `retry(5, 50)` is a redesign, and
 *    reporting half of it as a weakening would be a claim this module cannot
 *    support. {@link agreedDirection} adds the same demand to the naming: two
 *    moved numbers whose NAMES disagree about which way is worse fire nothing.
 *    An unnamed number no longer voids its named neighbour — it is still bound
 *    by this rule, so `{ minCoverage: 80, count: 7 }` -> `{ 70, 4 }` fires and
 *    `{ 70, 9 }` does not.
 *
 * Residual false positives, measured and accepted: `limit` and `max` are
 * ordinary words, so `limit: 10` -> `limit: 100` in a pagination query fires.
 * That is the shape of noise this design chooses, because the alternative — a
 * whitelist of known config keys — is silent on every threshold a project
 * invents for itself.
 *
 * ## The window, and how to re-derive it
 *
 * The 200 commits ending at `main` = `5d5e1acc`, enumerated as
 * `git log -n 200 --format=%H 5d5e1acc` and each read as
 * `git diff <sha>^ <sha> -U3`, scoped with
 * `buildReviewScope(diff, { contextLines: 3 })`; the merge commits among them
 * contribute their first-parent diff, which is what that command gives. The
 * enumeration is pinned because `git log`'s default ordering is not the only one
 * available, and a different 200 is a different measurement:
 *
 * | reading | `threshold-lowered` |
 * |---|---|
 * | whole line | **25** — 22 a renumbered ordered list (14, `5.` -> `6.`) or step heading (8, `Step 9:` -> `Step 7:`); 3 not a list |
 * | adjacent identifier only | **2** |
 * | the walk in {@link enclosingNames}, as it stands now | **2** |
 *
 * Both survivors are the same edit in two copies of one file,
 * `"maximum": 2` -> `3` in a JSON schema — a real ceiling, correctly reported.
 * Of the three non-list findings whole-line reading produced, the narrowing kept
 * those two and gave up `expect(score.recall).toBe(1)` -> `toBe(0)`, which is
 * named in NOT DETECTED above rather than left unsaid.
 *
 * Re-run over that window at T24, before and after the walk stopped flattening
 * its steps: 37 `suppression-added`, 17 `assertion-removed`, 11 `test-disabled`,
 * 2 `threshold-lowered` — the same 67 findings on both sides, byte-identical
 * once serialised. So the shapes {@link enclosingNames} recovers are shapes this
 * window does not contain, and nothing in it changed hands; the recovery is
 * evidenced by the fixtures named there, not by a count that moved.
 */
function detectLoweredThresholds(region: ScopedRegion, lines: readonly RegionLine[]): FloorFinding[] {
  const findings: FloorFinding[] = [];
  const adds = lines.filter((line) => line.kind === "add" && !COMMENTED_LINE.test(line.text));
  const used = new Set<number>();

  for (const removed of lines) {
    if (removed.kind !== "del" || COMMENTED_LINE.test(removed.text)) {
      continue;
    }
    const removedCode = codeOf(removed.text);
    const skeleton = numericSkeleton(removedCode);
    if (skeleton === removedCode) {
      continue; // no numbers at all
    }
    const oldNumbers = numbersOf(removedCode);

    for (const [index, added] of adds.entries()) {
      if (used.has(index) || numericSkeleton(codeOf(added.text)) !== skeleton) {
        continue;
      }
      const newNumbers = numbersOf(codeOf(added.text));
      const moved = oldNumbers
        .map((hit, position) => ({ from: hit.value, to: newNumbers[position]?.value ?? hit.value, index: hit.index }))
        .filter((pair) => pair.from !== pair.to);
      if (moved.length === 0) {
        continue;
      }
      used.add(index);

      const direction = agreedDirection(removedCode, moved);
      if (direction === undefined) {
        break;
      }
      const allDown = moved.every((pair) => pair.to < pair.from);
      const allUp = moved.every((pair) => pair.to > pair.from);
      const weakened = direction.weakenedBy === "decrease" ? allDown : allUp;
      if (!weakened) {
        break;
      }
      const movement = moved.map((pair) => `${pair.from} -> ${pair.to}`).join(", ");
      findings.push({
        kind: "threshold-lowered",
        path: region.path,
        line: added.line,
        detail:
          direction.weakenedBy === "decrease"
            ? `a floor named by "${direction.word}" moved down (${movement}); the code on the line is otherwise unchanged`
            : `a ceiling named by "${direction.word}" moved up (${movement}); the code on the line is otherwise unchanged`,
        removed: removed.text.trim(),
        added: added.text.trim(),
      });
      break;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 2. Disabled tests
// ---------------------------------------------------------------------------

/**
 * A test turned off, in statement position AND in call position.
 *
 * `.only` counts: it disables every OTHER test in the file, which is the same
 * loss with a friendlier name and no trace in the run output.
 *
 * Two narrowings, and the second was bought with a false positive:
 *
 * - The leading `(?:^|[{;}]|=>)\s*` puts the token in statement position, so a
 *   marker inside a string array or a linter's own rule list does not fire.
 * - The trailing `\s*\(` requires it to be CALLED. Statement position alone was
 *   not enough, because `;`, `{` and `}` are ordinary punctuation in English:
 *   `We ban this; it.skip is the usual culprit.` and `Bad: { describe.only is
 *   worse }` both fired, and this branch ships thousands of lines of prose about
 *   skipped tests. A sentence does not call anything.
 *
 * Up to TWO modifier segments are allowed on EACH side of the disabling keyword,
 * and a segment may carry an argument list. The bound is stated rather than left
 * to the pattern because it is a real edge, measured here (T24):
 * `test.concurrent.failing.skip(` fires and `test.a.b.c.skip(` — one segment more
 * — is silent. Two per side is what the spellings below need; a longer chain is
 * a shape nobody writes, and this is a regex, so every repetition it admits is
 * one a pathological line can make it walk. One bare segment before the keyword was
 * the first rule, and it did not match the shapes its own comment cited: the
 * pattern admitted no call between segments, so the table-driven spellings
 * (`describe.each(cases).skip(…)`, and the one jest and vitest actually
 * document, `describe.skip.each(table)(…)`) were quiet, and so was a second
 * chained modifier (`test.concurrent.failing.skip(…)`). Each is a whole table of
 * tests turned off by one added line, which is the largest thing this detector
 * can be asked to see, so the pattern was widened to the claim rather than the
 * claim narrowed to the pattern. The narrowings that matter — statement
 * position, and a terminal `(` — are untouched, and the argument list is
 * paren-free by design, because this is a regex and not a parser: a computed
 * table, `describe.each(build(x)).skip(`, is in NOT DETECTED.
 *
 * `skipIf`/`runIf` are vitest's conditional forms, which take their predicate
 * first and the test body in a second call.
 */
const MODIFIER_SEGMENT = /(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*(?:\s*\([^()]*\))?)/.source;
const DISABLED_CALL = new RegExp(
  `(?:^|[{;}]|=>)\\s*((?:x(?:it|test|describe|context|specify))\\s*\\(|` +
    `(?:it|test|describe|context|suite|scenario|specify)` +
    `${MODIFIER_SEGMENT}{0,2}` +
    `\\s*\\.\\s*(?:skip|only|todo|failing|skipIf|runIf)` +
    `${MODIFIER_SEGMENT}{0,2}\\s*\\()`,
);

/** Annotation and attribute forms, which are always their own line. */
const DISABLED_ANNOTATION =
  /^\s*(@(?:unittest\.)?(?:pytest\.mark\.)?(?:skip|skipIf|skipif|skipUnless|Ignore|Disabled|disabled)\b|#\[ignore\]|t\.Skip(?:Now)?\(|self\.skipTest\()/;

function detectDisabledTests(region: ScopedRegion, lines: readonly RegionLine[]): FloorFinding[] {
  const findings: FloorFinding[] = [];
  for (const line of lines) {
    if (line.kind !== "add") {
      continue;
    }
    const call = DISABLED_CALL.exec(line.text);
    const annotation = DISABLED_ANNOTATION.exec(line.text);
    const match = call ?? annotation;
    if (match === null) {
      continue;
    }
    const token = (match[1] ?? match[0]).trim();
    if (quotedBefore(line.text, match.index + match[0].indexOf(token))) {
      continue;
    }
    findings.push({
      kind: "test-disabled",
      path: region.path,
      line: line.line,
      detail: `this line adds \`${token}\`, which stops a test running while the suite still reports green`,
      added: line.text.trim(),
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 3. Removed assertions
// ---------------------------------------------------------------------------

/**
 * Test paths, wider than `TEST_FILE_RE`.
 *
 * `TEST_FILE_RE` is the JS/TS selection rule the testing module already owns
 * and is reused rather than restated; the extra patterns cover the languages it
 * was never asked about, because an assertion deleted from a Go or Python test
 * rots a suite exactly as fast.
 */
const OTHER_TEST_PATHS = [/_test\.(go|py|rb|rs|exs?)$/, /(^|\/)test_[^/]+\.py$/, /Tests?\.(java|kt|cs|swift)$/, /_spec\.rb$/];

function isTestPath(path: string): boolean {
  return TEST_FILE_RE.test(path) || OTHER_TEST_PATHS.some((pattern) => pattern.test(path));
}

/**
 * The HEAD of an assertion, never its matcher tail.
 *
 * `expect(` matches and `.toEqual(` deliberately does not: counting both would
 * score a three-line `expect(...).toEqual(...)` as three assertions, and the
 * whole detection below is a comparison of counts.
 */
const ASSERTION_HEAD =
  /\b(expect|assert|assertEqual|assertEquals|assertTrue|assertFalse|assertThat|assertRaises|XCTAssert\w*|EXPECT_\w+|ASSERT_\w+)\s*\(|\bshould\s*[.(]|\.should\b|\bassert\s+[A-Za-z_"'(]/;

function countAssertions(lines: readonly RegionLine[], kind: "add" | "del"): RegionLine[] {
  return lines.filter((line) => line.kind === kind && !COMMENTED_LINE.test(line.text) && ASSERTION_HEAD.test(line.text));
}

/**
 * Assertions that left a test file and did not come back.
 *
 * Deliberately a COUNT, not a parse. A parser would have to be right about
 * every framework in every language to say anything at all; a count is right
 * about the only question that matters here — did this region end up checking
 * fewer things than it checked before? — and is honest about what it cannot
 * see (see the module header: an assertion weakened in place is invisible).
 *
 * Two things narrow it:
 *
 * 1. **Test files only.** An `assert(` removed from production code is a
 *    different conversation and would drown this one.
 * 2. **Net, per region.** A refactor that moves an assertion a few lines is one
 *    removal and one addition inside the same +/-20-line window, so it nets to
 *    zero. Only a region that ends with FEWER assertion-carrying lines than it
 *    started with is reported, and the finding states both counts so the reader
 *    can see how close the call was.
 */
function detectRemovedAssertions(region: ScopedRegion, lines: readonly RegionLine[]): FloorFinding[] {
  if (!isTestPath(region.path)) {
    return [];
  }
  const removed = countAssertions(lines, "del");
  const added = countAssertions(lines, "add");
  if (removed.length <= added.length) {
    return [];
  }
  const first = removed[0];
  if (first === undefined) {
    return [];
  }
  const net = removed.length - added.length;
  return [
    {
      kind: "assertion-removed",
      path: region.path,
      line: first.line,
      detail: `this region removes ${removed.length} assertion-carrying line(s) and adds ${added.length}: ${net} fewer thing(s) are checked here than before`,
      removed: first.text.trim(),
    },
  ];
}

// ---------------------------------------------------------------------------
// 4. Added suppressions
// ---------------------------------------------------------------------------

/**
 * Markers that switch a checker off for a line, a block or a file.
 *
 * Written as plain strings and matched case-insensitively: an alternation regex
 * holding these same words would make THIS FILE trip its own detector on the
 * diff that introduces it, which is not a hypothetical — it is what the first
 * draft did.
 */
const SUPPRESSION_MARKERS = [
  "eslint-disable",
  "@ts-expect-error",
  "@ts-ignore",
  "@ts-nocheck",
  "type: ignore",
  "type:ignore",
  "noqa",
  "pylint: disable",
  "mypy: ignore",
  "@suppresswarnings",
  "@suppress",
  "nolint",
  "istanbul ignore",
  "c8 ignore",
  "v8 ignore",
  "biome-ignore",
  "rome-ignore",
  "oxlint-disable",
  "stylelint-disable",
  "prettier-ignore",
  "nosec",
  "shellcheck disable",
  "deno-lint-ignore",
  "#[allow(",
  "#[ignore]",
  "pragma warning disable",
];

/**
 * The markers that are ATTRIBUTES rather than comments, and so must be the
 * first thing on their line.
 *
 * Named explicitly rather than inferred from a leading `@`, because
 * `@ts-expect-error` also starts with one and lives inside a `//` comment — a
 * rule that read the first character would demand an impossible position for it
 * and the whole TypeScript half of this list would go quiet.
 */
const ANNOTATION_MARKERS = new Set(["@suppresswarnings", "@suppress", "#[allow(", "#[ignore]"]);

/**
 * A suppression added by this diff.
 *
 * The position rule is the narrowing, and it is what keeps this module — and
 * every linter config, marker list and test fixture in the repository — out of
 * its own output:
 *
 * - An attribute marker ({@link ANNOTATION_MARKERS}) must be the first thing
 *   on its line.
 * - Every other marker must sit after a comment opener on its line, with no
 *   quote before it. `// eslint-disable-next-line` fires; `"eslint-disable"` in
 *   a string array does not, and neither does a bare mention in prose that
 *   never reaches a comment opener.
 *
 * A marker that merely MOVED is not added. {@link detectRemovedAssertions} nets
 * per region on purpose and this does the same, for the same reason: a region
 * that deletes an `eslint-disable-next-line` and re-adds the identical line two
 * lines down has changed nothing a reader needs to be asked about, and a guard
 * that demands a justification for a reindent is a guard that gets switched off.
 * Matched on the trimmed text, so only a byte-identical suppression is forgiven
 * — a marker whose rule list grew is still a finding.
 *
 * It nets by COUNT, which is what "the same way as {@link detectRemovedAssertions}"
 * has to mean. Set membership was the first spelling and it was not netting at
 * all: one removed marker forgave every identical marker the region added, so a
 * region deleting one stale `@ts-ignore` and adding three reported nothing while
 * the same three with nothing removed reported three. Deleting one stale marker
 * bought unlimited new ones inside the window — the exact evasion this module is
 * supposed to be hard to slip past. Each removal now forgives exactly one
 * addition, and the fourth identical marker is a finding.
 *
 * What that misses: a suppression written inside a string that is later
 * evaluated, and a marker in a language whose comments this does not recognise.
 * Both are false negatives, which is the direction a guard should fail in when
 * the alternative is being ignored.
 */
function detectAddedSuppressions(region: ScopedRegion, lines: readonly RegionLine[]): FloorFinding[] {
  const findings: FloorFinding[] = [];
  const removedHere = new Map<string, number>();
  for (const line of lines) {
    if (line.kind !== "del") {
      continue;
    }
    const key = line.text.trim();
    removedHere.set(key, (removedHere.get(key) ?? 0) + 1);
  }

  for (const line of lines) {
    if (line.kind !== "add") {
      continue;
    }
    const lowered = line.text.toLowerCase();
    for (const marker of SUPPRESSION_MARKERS) {
      const index = lowered.indexOf(marker);
      if (index < 0) {
        continue;
      }
      const prefix = line.text.slice(0, index);
      const annotation = ANNOTATION_MARKERS.has(marker);
      const positioned = annotation ? prefix.trim().length === 0 : COMMENT_OPENER.test(prefix) && !/["'`]/.test(prefix);
      if (!positioned) {
        continue;
      }
      // Spend one removal of the identical line, if the region still has one.
      // Checked here rather than before the marker scan so that an ordinary line
      // which happens to repeat does not consume a suppression's allowance.
      const outstanding = removedHere.get(line.text.trim()) ?? 0;
      if (outstanding > 0) {
        removedHere.set(line.text.trim(), outstanding - 1);
        break;
      }
      findings.push({
        kind: "suppression-added",
        path: region.path,
        line: line.line,
        detail: `this line adds \`${marker}\`, which switches a checker off for code the checker would otherwise refuse`,
        added: line.text.trim(),
      });
      break;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Every floor regression the scope carries, in diff order.
 *
 * Pure: same scope, same report. The counts are reported next to what was
 * scanned on purpose — "0 findings" over 0 regions is not the same fact as "0
 * findings" over 200, and a guard that cannot tell them apart is how an empty
 * input comes to read as a clean bill of health.
 */
export function detectFloorRegressions(scope: ReviewScope): FloorReport {
  const findings: FloorFinding[] = [];
  for (const region of scope.regions) {
    const lines = regionLines(region);
    findings.push(
      ...detectLoweredThresholds(region, lines),
      ...detectDisabledTests(region, lines),
      ...detectRemovedAssertions(region, lines),
      ...detectAddedSuppressions(region, lines),
    );
  }

  const byKind = Object.fromEntries(FLOOR_FINDING_KINDS.map((kind) => [kind, 0])) as Record<FloorFindingKind, number>;
  for (const finding of findings) {
    byKind[finding.kind] += 1;
  }

  return {
    schemaVersion: 1,
    outcome: "scanned",
    findings,
    counts: { total: findings.length, byKind },
    scanned: {
      files: scope.counts.filesRetained,
      regions: scope.regions.length,
      changedLines: scope.counts.changedLinesRetained,
    },
  };
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/**
 * The record form: the findings, and what was scanned to produce them.
 *
 * Prints the scanned counts even when nothing fired, for the same reason
 * `scope.ts` prints its drops: a report that says only "nothing found" cannot
 * be told apart from a report that looked at nothing.
 */
export function renderFloorMarkdown(report: FloorReport): string {
  const lines: string[] = [];
  lines.push("## Floor guard");
  lines.push("");
  lines.push(`files_scanned: ${report.scanned.files}`);
  lines.push(`regions_scanned: ${report.scanned.regions}`);
  lines.push(`changed_lines_scanned: ${report.scanned.changedLines}`);
  lines.push(`findings: ${report.counts.total}`);
  lines.push("");

  if (report.findings.length === 0) {
    lines.push(
      report.scanned.regions === 0
        ? "_nothing was scanned — the diff was empty or the pre-filter retained no region. This is not the same fact as a clean diff._"
        : "_nothing in this diff lowers a threshold, disables a test, removes an assertion or adds a suppression._",
    );
    lines.push("");
    return lines.join("\n");
  }

  lines.push("| kind | where | evidence | why |");
  lines.push("|---|---|---|---|");
  for (const finding of report.findings) {
    const evidence = [
      finding.removed === undefined ? "" : `- ${finding.removed}`,
      finding.added === undefined ? "" : `+ ${finding.added}`,
    ]
      .filter(Boolean)
      .join("<br>");
    lines.push(
      `| ${finding.kind} | ${escapePipes(finding.path)}:${finding.line} | ${escapePipes(evidence)} | ${escapePipes(finding.detail)} |`,
    );
  }
  lines.push("");
  lines.push("Counts by kind: " + FLOOR_FINDING_KINDS.map((kind) => `${kind}=${report.counts.byKind[kind]}`).join(", "));
  lines.push("");
  lines.push(
    "Each of these is individually defensible. The guard does not claim any of them is wrong — it claims the diff should say why.",
  );
  lines.push("");
  return lines.join("\n");
}
