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
 *   "a number changed somewhere", which is noise, not signal.
 * - **A threshold whose name says nothing.** `- limit: 10` / `+ limit: 100`
 *   fires because `limit` is a ceiling word; `- n: 10` / `+ n: 3` does not fire
 *   at all. A bare number moving is not evidence, and this module refuses to
 *   pretend it is.
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

export type FloorReport = {
  schemaVersion: 1;
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

/** Identifier tokens on a line: camelCase and snake_case both split. */
function tokensOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** The line with every numeric literal erased — two lines match iff only numbers differ. */
function numericSkeleton(text: string): string {
  return text.replace(NUMBER, " ");
}

function numbersOf(text: string): number[] {
  return (text.match(NUMBER) ?? []).map(Number);
}

type ThresholdDirection = { weakenedBy: "decrease" | "increase"; word: string } | undefined;

/**
 * Which direction weakens this line, decided by the WORDS on it, not by the
 * numbers.
 *
 * A line that names both a floor and a ceiling (`minTimeout`) is ambiguous and
 * returns `undefined`: the guard would have to guess which number the words
 * belong to, and a guess in a guard is worse than a gap. A line that names a
 * capacity ({@link CAPACITY_WORDS}) is not a bar at all and is silent in both
 * directions.
 */
function thresholdDirection(text: string): ThresholdDirection {
  const tokens = tokensOf(text);
  if (tokens.some((token) => CAPACITY_WORDS.has(token))) {
    return undefined;
  }
  const floorWord = tokens.find((token) => FLOOR_WORDS.has(token));
  const ceilingWord = tokens.find((token) => CEILING_WORDS.has(token));
  if (floorWord !== undefined && ceilingWord !== undefined) {
    return undefined;
  }
  if (floorWord !== undefined) {
    return { weakenedBy: "decrease", word: floorWord };
  }
  if (ceilingWord !== undefined) {
    return { weakenedBy: "increase", word: ceilingWord };
  }
  return undefined;
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
 *    positional and total.
 * 2. **A named direction.** The line must name a floor or a ceiling
 *    ({@link FLOOR_WORDS}, {@link CEILING_WORDS}), and only the direction that
 *    weakens THAT kind of number fires. A coverage minimum moving up is silent;
 *    a timeout moving down is silent. A bare `count: 5` -> `count: 3` is silent
 *    in both directions, because nothing on the line says which way is worse.
 * 3. **An unmixed move.** If some numbers on the line went up and others went
 *    down, nothing fires: `retry(3, 100)` -> `retry(5, 50)` is a redesign, and
 *    reporting half of it as a weakening would be a claim this module cannot
 *    support.
 *
 * Residual false positives, measured and accepted: `limit` and `max` are
 * ordinary words, so `limit: 10` -> `limit: 100` in a pagination query fires.
 * That is the shape of noise this design chooses, because the alternative — a
 * whitelist of known config keys — is silent on every threshold a project
 * invents for itself.
 */
function detectLoweredThresholds(region: ScopedRegion, lines: readonly RegionLine[]): FloorFinding[] {
  const findings: FloorFinding[] = [];
  const adds = lines.filter((line) => line.kind === "add" && !COMMENTED_LINE.test(line.text));
  const used = new Set<number>();

  for (const removed of lines) {
    if (removed.kind !== "del" || COMMENTED_LINE.test(removed.text)) {
      continue;
    }
    const skeleton = numericSkeleton(removed.text);
    if (skeleton === removed.text) {
      continue; // no numbers at all
    }
    const oldNumbers = numbersOf(removed.text);

    for (const [index, added] of adds.entries()) {
      if (used.has(index) || numericSkeleton(added.text) !== skeleton) {
        continue;
      }
      const newNumbers = numbersOf(added.text);
      const moved = oldNumbers
        .map((value, position) => ({ from: value, to: newNumbers[position] ?? value }))
        .filter((pair) => pair.from !== pair.to);
      if (moved.length === 0) {
        continue;
      }
      used.add(index);

      const direction = thresholdDirection(removed.text);
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
            ? `a floor named by "${direction.word}" moved down (${movement}); the line is otherwise unchanged`
            : `a ceiling named by "${direction.word}" moved up (${movement}); the line is otherwise unchanged`,
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
 * A test turned off, in statement position.
 *
 * `.only` counts: it disables every OTHER test in the file, which is the same
 * loss with a friendlier name and no trace in the run output.
 *
 * The leading `(?:^|[{;}]|=>)\s*` is the narrowing. Without it the detector
 * fires on any line that merely CONTAINS the token — a marker in a string
 * array, a regex in a linter, a sentence in this very file — and a guard that
 * flags its own source is a guard nobody keeps.
 */
const DISABLED_CALL =
  /(?:^|[{;}]|=>)\s*((?:x(?:it|test|describe|context|specify))\s*\(|(?:it|test|describe|context|suite|scenario|specify)\s*\.\s*(?:skip|only|todo|failing)\b)/;

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
 * What that misses: a suppression written inside a string that is later
 * evaluated, and a marker in a language whose comments this does not recognise.
 * Both are false negatives, which is the direction a guard should fail in when
 * the alternative is being ignored.
 */
function detectAddedSuppressions(region: ScopedRegion, lines: readonly RegionLine[]): FloorFinding[] {
  const findings: FloorFinding[] = [];
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
