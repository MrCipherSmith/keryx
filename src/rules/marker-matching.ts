// Flow 313 (W4 portability), round-4 fix (R2-F15): the ONE whole-line,
// fence-aware managed-block marker matcher `agent-entrypoints.ts` and
// `distill.ts` both need, extracted so they can never drift apart again.
//
// Round 2 (R2-F15) made marker matching whole-line (a marker must be a
// line's entire trimmed content, never merely a substring a prose sentence
// happens to mention) in BOTH modules, but as two independently written
// functions. Round 4 found `distill.ts`'s copy was also fence-aware (a
// marker line INSIDE a fenced code block — a worked example in a rule file
// showing what the managed block looks like — is never mistaken for a real
// one) while `agent-entrypoints.ts`'s was not: a fenced example there got
// its content REPLACED with the live managed block (destroying the example)
// while the real block elsewhere in the file went stale, because the fenced
// occurrence was matched first. This module is the single fix for both:
// every caller gets fence-awareness, and there is exactly one place left to
// get it right.

/** Char ranges (start inclusive, end exclusive) covered by fenced code blocks (``` or ~~~, >=3 backticks/tildes). */
export function computeFencedRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = content.split("\n");
  let offset = 0;
  let fenceStart: number | null = null;
  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line.trim())) {
      if (fenceStart === null) fenceStart = offset;
      else {
        ranges.push([fenceStart, offset + line.length]);
        fenceStart = null;
      }
    }
    offset += line.length + 1;
  }
  // An unterminated fence covers the rest of the file — a marker "inside" it
  // is exactly as untrustworthy as one inside a closed fence.
  if (fenceStart !== null) ranges.push([fenceStart, content.length]);
  return ranges;
}

function isWithinRanges(offset: number, ranges: ReadonlyArray<[number, number]>): boolean {
  return ranges.some(([s, e]) => offset >= s && offset < e);
}

/**
 * The character offset of the first LINE whose trimmed content equals
 * `marker` exactly, skipping any match inside a fenced code block, or -1.
 * `fenced` may be passed pre-computed (e.g. when the caller already needs it
 * for another marker over the same `content`); otherwise it is computed here.
 */
export function indexOfMarkerLine(content: string, marker: string, fenced?: ReadonlyArray<[number, number]>): number {
  const ranges = fenced ?? computeFencedRanges(content);
  const lines = content.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (line.trim() === marker && !isWithinRanges(offset, ranges)) return offset;
    offset += line.length + 1;
  }
  return -1;
}

/** True when `content` has a real (non-fenced) marker line matching `marker`. */
export function hasMarkerLine(content: string, marker: string): boolean {
  return indexOfMarkerLine(content, marker) >= 0;
}
