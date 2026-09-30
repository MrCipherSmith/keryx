// Flow 361: detecting and REMOVING the managed `keryx:index` block as public
// functions. Until now removal existed only privately in `distill.ts`
// (`stripManagedBlock`, which trims the result and truncates an unterminated
// block) and replacement in `agent-entrypoints.ts` (`replaceManagedBlock`,
// which collapses blank lines across the whole file). The migration off a
// tracked entrypoint needs neither side effect: it must take out the block
// and leave every other byte where it was, so the file can be compared with —
// and keep its unrelated edits against — `HEAD`.

import { UnterminatedMetaprojectReferenceError } from "./agent-entrypoints";
import { computeFencedRanges, hasMarkerLine, indexOfMarkerLine } from "./marker-matching";

export const MANAGED_INDEX_BLOCK_START = "<!-- keryx:index -->";
export const MANAGED_INDEX_BLOCK_END = "<!-- /keryx:index -->";

/** True when `content` carries a real block start: a whole marker line outside any fenced code block. */
export function hasManagedIndexBlock(content: string): boolean {
  return hasMarkerLine(content, MANAGED_INDEX_BLOCK_START);
}

/**
 * `content` with every managed `keryx:index` block removed and everything
 * else byte-for-byte intact — no trimming, no blank-line collapsing, no
 * line-ending changes. What goes is exactly the lines from the start marker
 * line through the end marker line, including that last line's own
 * terminator; blank lines around the block are the caller's content and stay.
 *
 * Markers are matched as whole, fence-aware lines through the shared matcher,
 * so a prose mention or a fenced worked example is never a boundary. A start
 * marker with no matching end throws `UnterminatedMetaprojectReferenceError`
 * naming `filePath`, as `replaceManagedBlock` does: nothing is guessed at.
 * Content with no block is returned unchanged.
 */
export function stripManagedIndexBlock(content: string, filePath: string): string {
  let kept = "";
  let rest = content;
  for (;;) {
    const start = indexOfMarkerLine(rest, MANAGED_INDEX_BLOCK_START, computeFencedRanges(rest));
    if (start < 0) return kept + rest;
    const afterStartLine = endOfLine(rest, start);
    const tail = rest.slice(afterStartLine);
    const endOffset = indexOfMarkerLine(tail, MANAGED_INDEX_BLOCK_END, computeFencedRanges(tail));
    if (endOffset < 0) {
      throw new UnterminatedMetaprojectReferenceError(
        `${filePath}: unterminated ${MANAGED_INDEX_BLOCK_START} block: found ${MANAGED_INDEX_BLOCK_START} with no matching ${MANAGED_INDEX_BLOCK_END} — fix it by hand`,
      );
    }
    kept += rest.slice(0, start);
    rest = tail.slice(endOfLine(tail, endOffset));
  }
}

/** The offset just past the line starting at `lineStart`, its `\n` included when it has one. */
function endOfLine(content: string, lineStart: number): number {
  const newline = content.indexOf("\n", lineStart);
  return newline < 0 ? content.length : newline + 1;
}
