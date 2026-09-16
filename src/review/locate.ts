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
// Deliberately NOT implemented: the second model call that regenerates a more
// precise snippet when the match fails (`internal/diff/relocation.go` in
// alibaba/open-code-review). It buys accuracy for tokens on a path we can
// simply label. Revisit if `unlocatable` turns out to be common — the re-ingest
// of an existing round is how that number gets measured, not guessed.

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
    }
  }
  return hits;
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
  const haystack = fileText.replace(/\r\n/g, "\n").split("\n");

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
    return {
      state: "unlocatable",
      reason: `the quote matches ${exact.length} places in the file (lines ${exact.join(", ")}); an anchor chosen among them would be a guess`,
    };
  }

  const loose = findRuns(haystack, needle.map(normalise), (window) => window.map(normalise));
  if (loose.length === 1) {
    return { state: "derived", method: "whitespace-normalised", line: loose[0] as number };
  }
  if (loose.length > 1) {
    return {
      state: "unlocatable",
      reason: `the quote matches ${loose.length} places once whitespace is normalised (lines ${loose.join(", ")}); an anchor chosen among them would be a guess`,
    };
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
