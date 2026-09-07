// What survives compaction, and how an elision is disclosed.
//
// Every routed search, diff, log and large file read in this project passes
// through the gdctx summarisers. Three defects in them were measured in one
// session (flow 235 / T7), and all three are the same failure at different
// altitudes: the output described itself as more complete than it was.
//
//   1. A summary printed the true total in its header and a short body, with
//      nothing marking the gap (`Matches: 50` over four matches).
//   2. A `FAIL` line in the middle of a long log was dropped by compaction
//      while the footer reported 98% saved.
//   3. A compacted JSON document still opened `{` and closed `}` and no longer
//      parsed.
//
// This module holds the two decisions those fixes share — which lines are worth
// keeping, and how an omission is stated — so the several entry points cannot
// drift apart again. They already had: `importantLines` and `compactLines` in
// src/commands/ctx.ts carried two different regexes, and neither matched the
// bare token `FAIL`.

/** Verdict tiers, in the order they are rescued from an elided range. */
export type LineVerdict = "failure" | "warning";

// A line is worth keeping when it reports a VERDICT that is not success. That
// is the rule; the patterns below are only how it is recognised. Three
// families, and none of them is "the word FAIL":
//
//   (a) the failure vocabulary the tools this repository runs actually emit,
//   (b) the failure markers this repository's OWN summarisers already key on —
//       `(fail)` in src/health/sources/tests.ts and `✗` in src/lib/ui.ts, and
//   (c) counted verdicts (`2 fail, 8 pass`), which are how a suite reports its
//       result in one line.
//
// Matching is stem-anchored (`\bfail` catches FAIL, failed, failing, failure)
// rather than a fixed word list, because a list is exactly what let `FAIL`
// through: `failed|failure` had no spelling for the bare token.

/** (b) — the markers this repository's own code already treats as failures. */
const REPO_FAILURE_MARKERS: RegExp[] = [
  /\(fail\)/i, // bun test, parsed in src/health/sources/tests.ts
  /[✗✘✖×]/, // ✗ ✘ ✖ × — the failure glyph in src/lib/ui.ts
];

/** (a) — failure stems, anchored at a word start only. */
const FAILURE_STEMS =
  /\b(fail|error|errno|fatal|panic|exception|traceback|stacktrace|assert|abort|crash|refus|reject|denied|unhandled|segfault|segmentation fault|cannot|can't|unable to|not found|no such file|permission denied|timed out|timeout|ETIMEDOUT|ECONNREFUSED|ENOENT|EACCES)/i;

/** (a) — verdicts that carry no stem of their own. */
const FAILURE_MARKERS: RegExp[] = [
  /\bERR!/, // npm/pnpm
  /^\s*E\s{2,}\S/, // pytest's short summary gutter
  /\bexit(ed with)?\s+(code\s+)?[1-9]\d*\b/i,
  /\bnon-zero exit\b/i,
];

const WARNING_STEMS = /\b(warn|deprecat)/i;

// A success verdict is spelled with the same stems ("0 failed", "Found 0
// errors", "no warnings"). Promoting those would spend a bounded rescue budget
// on lines that say nothing is wrong — and push the real failures out of it.
// They are removed before the stems are tested, rather than matched as whole
// lines, so `0 failed, 2 errored` is still a failure.
const CLEAN_COUNT =
  /\b(0|no|zero)\s+(errors?|failures?|failed|failing|problems?|warnings?|issues?|violations?)\b/gi;

/**
 * The verdict a line reports, or null when it reports none.
 *
 * Exported so the predicate can be asserted directly: a behaviour-level test
 * over a 5,000-line log proves the rescue works for the one line it plants, but
 * not that the vocabulary is right.
 */
export function classifyLine(line: string): LineVerdict | null {
  if (REPO_FAILURE_MARKERS.some((pattern) => pattern.test(line))) {
    return "failure";
  }
  const claim = line.replace(CLEAN_COUNT, " ");
  if (FAILURE_STEMS.test(claim) || FAILURE_MARKERS.some((pattern) => pattern.test(claim))) {
    return "failure";
  }
  return WARNING_STEMS.test(claim) ? "warning" : null;
}

/** Failures first, then warnings; original order within a tier; deduplicated. */
export function rankByVerdict(lines: string[]): string[] {
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const line of lines) {
    const verdict = classifyLine(line);
    if (verdict === "failure") failures.push(line);
    else if (verdict === "warning") warnings.push(line);
  }
  return [...new Set([...failures, ...warnings])];
}

/** Verdict lines, ranked, with the total so the caller can disclose the cut. */
export function importantLines(lines: string[], max: number): { kept: string[]; total: number } {
  const ranked = rankByVerdict(lines);
  return { kept: ranked.slice(0, max), total: ranked.length };
}

// ---------------------------------------------------------------------------
// Disclosure
//
// One sentence, one shape, everywhere something is dropped. The existing
// artifact pointer is how a reader RECOVERS what was cut; this is how they
// learn there was anything to recover. Both halves are needed — the pointer
// alone was already printed above eight summaries that read as complete.

/** `… omitted 46 of 50 matches …`, or null when nothing was dropped. */
export function omissionNote(shown: number, total: number, unit: string): string | null {
  const omitted = total - shown;
  if (omitted <= 0) {
    return null;
  }
  return `… omitted ${omitted} of ${total} ${unit} — full output in raw`;
}

/** `(4 shown below)` for a header count, or "" when the body shows them all. */
export function shownSuffix(shown: number, total: number): string {
  return shown < total ? ` (${shown} shown below; full output in raw)` : "";
}

// ---------------------------------------------------------------------------
// Compaction

export type Compaction = {
  lines: string[];
  /** Source lines not present in `lines`. */
  omitted: number;
  /** Verdict lines rescued out of the omitted range. */
  rescued: number;
  /** Verdict lines in the omitted range that did not fit the budget. */
  droppedVerdicts: number;
};

/**
 * Head + tail of `lines`, with the verdict lines from the elided middle carried
 * across, and a marker that says what happened.
 *
 * Previously the middle was searched with a regex that did not know the token
 * `FAIL`, the rescue budget was an unnamed `limit - head - tail` (twelve lines),
 * and the marker said only how many lines went missing — never that a failure
 * had gone with them.
 */
export function compactLines(
  lines: string[],
  limit: number,
  verdictBudget: number,
): Compaction {
  if (lines.length <= limit) {
    return { lines, omitted: 0, rescued: 0, droppedVerdicts: 0 };
  }

  const head = Math.ceil(limit * 0.45);
  const tail = Math.floor(limit * 0.45);
  const middle = lines.slice(head, lines.length - tail);
  const verdicts = rankByVerdict(middle);
  const rescued = verdicts.slice(0, Math.max(0, verdictBudget));
  const omitted = middle.length - rescued.length;

  return {
    lines: [
      ...lines.slice(0, head),
      compactionMarker(omitted, lines.length, rescued.length, verdicts.length - rescued.length),
      ...rescued,
      ...lines.slice(lines.length - tail),
    ],
    omitted,
    rescued: rescued.length,
    droppedVerdicts: verdicts.length - rescued.length,
  };
}

function compactionMarker(
  omitted: number,
  total: number,
  rescued: number,
  dropped: number,
): string {
  const head = `... omitted ${omitted} of ${total} lines`;
  if (rescued === 0) {
    return `${head} (no failure or warning lines in that range) — full output in raw ...`;
  }
  const tail =
    dropped > 0
      ? `; ${dropped} more not shown — full output in raw`
      : " — full output in raw";
  return `${head}; the ${rescued} failure/warning line(s) found there are kept below${tail} ...`;
}

// ---------------------------------------------------------------------------
// Structured output
//
// A compacted document that still opens `{` and closes `}` and no longer parses
// is worse than an obvious fragment: the reader has no cue to stop trusting it.
// Detection requires the SOURCE to parse, so "this excerpt does not parse" is a
// claim about the compaction and never about input that was already broken.

export type StructuredFormat = "json" | "jsonl";

/** The structured format `content` is a whole, parseable document of, or null. */
export function detectStructuredFormat(content: string): StructuredFormat | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not a whole JSON document; it may still be JSON Lines.
    }
  }
  const rows = trimmed.split("\n").filter((line) => line.trim().length > 0);
  if (rows.length < 2 || !rows.every((row) => row.trimStart().startsWith("{"))) {
    return null;
  }
  try {
    for (const row of rows) JSON.parse(row);
    return "jsonl";
  } catch {
    return null;
  }
}

/** The line that stops an elided structured document from reading as whole. */
export function excerptNotice(
  format: StructuredFormat,
  shownLines: number,
  totalLines: number,
): string {
  return (
    `Excerpt: \`${shownLines} of ${totalLines} lines\` — a fragment of a ${format} ` +
    `document, which does not parse. Read the full document from the raw artifact.`
  );
}
