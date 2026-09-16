// Where a finding actually points.
//
// `line` used to be whatever the reviewer said it was. The schema took it as an
// integer and `review ingest` compared it to nothing, so a number that had
// drifted — or was never right — travelled into `findings.json`, into the round
// report, and into the disposition somebody later recorded against it. On a FIX
// round the file has moved under the finding by construction, which is exactly
// when the anchor is least trustworthy and most consequential.
//
// So the reviewer no longer reports a line. It reports the code: `quote`, copied
// out of the file it is talking about. This module finds that quote and the line
// is what falls out. A model is poor at counting lines and good at repeating
// text it has just read, and this asks it only for the second.
//
// Two rules keep the matcher from becoming a second guesser:
//
//   - Exact first, whitespace-normalised second, then give up. Nothing fuzzy.
//     A near-match confidently anchored to the wrong site is worse than an
//     honest `unlocatable`, because a wrong anchor is acted on and an admitted
//     one is investigated.
//   - A quote that matches in more than one place is `unlocatable`, not "the
//     first one". Ambiguity is a fact about the quote, and resolving it by
//     position would be a guess wearing a line number.
//
// Deliberately NOT implemented: a second model call that regenerates a more
// precise snippet when the match fails. It buys accuracy for tokens on a path
// we can simply label. Revisit if `unlocatable` turns out to be common — the
// re-ingest of an existing round is how that number gets measured, not guessed.

/**
 * Bounds, because matching is O(file lines x quote lines) and neither side had
 * one.
 *
 * Measured by this change's own review round, on one core with no I/O: a
 * 50,000-line file against a 10,000-line quote took 49 seconds for a SINGLE
 * finding, and a realistic case — a 20,000-line lockfile with a 50-line quote —
 * cost 118 ms per finding, which is ~2 minutes for a thousand-finding report,
 * all of it inside one sequential loop. A review report is attacker-influenced
 * data; an unbounded matcher over it is an unbounded ingest.
 *
 * Both limits are generous against the guidance the schema already gives
 * ("a few lines is enough"), so a quote that trips one has already stopped
 * being a quote. Tripping a limit is `unlocatable` with the reason named — never
 * a silent skip, and never a truncated match, which would anchor a finding to
 * the wrong place while looking successful.
 */
export const MAX_QUOTE_LINES = 200;
export const MAX_LOCATE_FILE_LINES = 50_000;
/** Read bound for the same reason, applied before the file reaches the matcher. */
export const MAX_LOCATE_FILE_BYTES = 4_000_000;

/** How a finding's `line` was arrived at. */
export type LocatorRecord =
  | { state: "derived"; method: "exact" | "whitespace-normalised"; line: number; reported_line?: number | null }
  | { state: "unlocatable"; reason: string; reported_line?: number | null };

export type LocateOutcome =
  | { state: "derived"; method: "exact" | "whitespace-normalised"; line: number }
  | { state: "unlocatable"; reason: string };

/** Lines of `quote`, with blank edges dropped and common indentation removed. */
export function quoteLines(quote: string): string[] {
  const lines = quote.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && (lines[0] as string).trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return [];
  }
  // A quote lifted out of an indented block carries that indentation; the file
  // carries it too, so exact matching still works. Stripping the COMMON indent
  // is what makes a quote copied from a markdown code fence — which is often
  // re-indented on the way in — still match exactly.
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => (line.match(/^[ \t]*/)?.[0] ?? "").length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(common));
}

/** Whitespace runs collapsed, edges trimmed — the second and last attempt. */
function normalise(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/** Drop the indentation the whole block shares, keeping relative structure. */
function deindent(lines: readonly string[]): string[] {
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => (line.match(/^[ \t]*/)?.[0] ?? "").length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(common));
}

/**
 * Every 1-based line where `needle` runs contiguously through `haystack`.
 *
 * `shape` is applied to the candidate WINDOW rather than to the whole file,
 * which is what lets a quote be compared against the file at its own
 * indentation: the window is de-indented the same way the quote was, so a
 * snippet that lost its leading spaces on the way through a code fence still
 * matches the indented original, and one that kept them matches too.
 */
/**
 * Two hits are as informative as twenty thousand.
 *
 * The scan stops at this many, because the only question it answers is "none,
 * one, or more than one" — ambiguity is already a refusal, so counting past the
 * second match buys nothing and costs the rest of the file. It also bounds the
 * REASON: a quote matching every line of a 20,000-line lockfile produced a
 * failure string carrying 19,951 line numbers, which then went into
 * `findings.json`.
 */
const MAX_HITS = 2;

function findRuns(
  haystack: readonly string[],
  needle: readonly string[],
  shape: (window: readonly string[]) => string[],
): number[] {
  const hits: number[] = [];
  if (needle.length === 0 || needle.length > haystack.length) {
    return hits;
  }
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    const window = shape(haystack.slice(start, start + needle.length));
    if (window.every((line, offset) => line === needle[offset])) {
      hits.push(start + 1); // 1-based, like every line number a human reads
      if (hits.length >= MAX_HITS) {
        return hits;
      }
    }
  }
  return hits;
}

/** "at least 2 places (lines 1, 2)" — bounded, and honest that it stopped counting. */
function ambiguity(hits: readonly number[], pass: string): LocateOutcome {
  return {
    state: "unlocatable",
    reason: `the quote matches at least ${hits.length} places${pass}(lines ${hits.join(", ")}, and the scan stopped there); an anchor chosen among them would be a guess`,
  };
}

/**
 * Locate `quote` in `fileText`, or say why not.
 *
 * Pure: the caller reads the file, so a test can state the tree in a string and
 * the production path can state it from disk.
 */
export function locateQuote(fileText: string, quote: string): LocateOutcome {
  const needle = quoteLines(quote);
  if (needle.length === 0) {
    return { state: "unlocatable", reason: "the quote is empty" };
  }
  if (needle.length > MAX_QUOTE_LINES) {
    return {
      state: "unlocatable",
      reason: `the quote is ${needle.length} lines, past the ${MAX_QUOTE_LINES}-line bound; quote the few lines the finding is about`,
    };
  }
  const haystack = fileText.replace(/\r\n/g, "\n").split("\n");
  if (haystack.length > MAX_LOCATE_FILE_LINES) {
    return {
      state: "unlocatable",
      reason: `the file is ${haystack.length} lines, past the ${MAX_LOCATE_FILE_LINES}-line bound for locating`,
    };
  }

  // Exact: both sides de-indented and right-trimmed. Trailing spaces are
  // invisible to whoever copied the quote, so treating them as a difference
  // would reject a match nobody could see was not one.
  const exact = findRuns(
    haystack,
    deindent(needle).map((line) => line.trimEnd()),
    (window) => deindent(window).map((line) => line.trimEnd()),
  );
  if (exact.length === 1) {
    return { state: "derived", method: "exact", line: exact[0] as number };
  }
  if (exact.length > 1) {
    return ambiguity(exact, " in the file ");
  }

  const loose = findRuns(haystack, needle.map(normalise), (window) => window.map(normalise));
  if (loose.length === 1) {
    return { state: "derived", method: "whitespace-normalised", line: loose[0] as number };
  }
  if (loose.length > 1) {
    return ambiguity(loose, " once whitespace is normalised ");
  }
  return { state: "unlocatable", reason: "the quote does not appear in the file" };
}

/**
 * The same, against a tree.
 *
 * `readFile` returns null for a path that is not there — which is its own
 * reason, distinct from "the quote is not in it", because the two send whoever
 * reads the record to different places.
 */
export async function locateFinding(
  finding: { file?: string | null | undefined; quote?: string | null | undefined; line?: number | null | undefined },
  readFile: (relativePath: string) => Promise<string | null>,
): Promise<LocatorRecord | undefined> {
  const quote = typeof finding.quote === "string" ? finding.quote : "";
  if (quote.trim() === "") {
    return undefined; // Nothing to locate against; `line` stays as reported.
  }
  const reported = typeof finding.line === "number" ? finding.line : null;
  const file = typeof finding.file === "string" ? finding.file : "";
  if (file === "") {
    return { state: "unlocatable", reason: "the finding quotes code but names no file", reported_line: reported };
  }
  const text = await readFile(file);
  if (text === null) {
    return { state: "unlocatable", reason: `no such file at this round's head: ${file}`, reported_line: reported };
  }
  const outcome = locateQuote(text, quote);
  return outcome.state === "derived"
    ? { state: "derived", method: outcome.method, line: outcome.line, reported_line: reported }
    : { state: "unlocatable", reason: outcome.reason, reported_line: reported };
}
