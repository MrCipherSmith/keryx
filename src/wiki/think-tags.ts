// Reasoning-leak guard for `wiki enrich` output (flow 268 T9).
//
// A model that emits inline `<think>...</think>` (or `<thinking>...</thinking>`)
// reasoning as part of its text response — instead of, or alongside, a
// provider-native reasoning channel — can have that block land straight in a
// wiki page's persisted Markdown when the caller does not strip it before
// writing. This happened for real (9 pages in another project): the block was
// written right after the page's YAML frontmatter.
//
// This module is the single place that decides what counts as a reasoning
// block and what remains after removing it, so every page-write path in
// `enrich.ts` (RLM-off, RLM `light`, RLM `deep`) and `wiki status`'s
// detection of already-written pages agree on the same definition.

/** Matches a COMPLETE `<think>...</think>` or `<thinking>...</thinking>` pair. */
const THINK_BLOCK_RE = /<(think|thinking)>[\s\S]*?<\/\1>/gi;

/** Matches any leftover opening or closing think/thinking tag. */
const STRAY_THINK_TAG_RE = /<\/?think(?:ing)?>/i;

/** Fenced code blocks (```...```). */
const FENCE_RE = /```[\s\S]*?```/g;

/**
 * Inline code spans: double-backtick (`` `` ... `` ``) tried first so a
 * single backtick INSIDE the span (documenting a backtick itself) is not
 * mistaken for the closing delimiter, then single-backtick (` ... `).
 * Confined to one line — markdown inline code does not span a blank line,
 * and stopping at `\n` keeps a stray unmatched backtick from swallowing the
 * rest of the document.
 */
const INLINE_CODE_RE = /``[^`\n]*?``|`[^`\n]*?`/g;

/**
 * Replace every fenced code block and inline code span with same-length
 * placeholder characters (`\0`, which can never appear in a `<think>` tag or
 * in real Markdown text), preserving every other character's position and
 * length. A regex run against the MASKED text therefore reports match
 * indices usable directly against the ORIGINAL text, and can never match
 * inside a code span/block — code shown as example text (documenting this
 * guard, or a `<think>` tag mentioned in prose) is invisible to think-tag
 * detection/stripping, while a real leaked reasoning block outside code
 * still matches exactly as before. Shared by `stripThinkBlocks` (enrich's
 * write path) and `containsThinkTags` (`wiki status`'s detector) so both
 * agree on the same "counts as code" definition (flow 268 T26).
 */
function maskCodeRegions(text: string): string {
  const maskMatch = (m: string): string => "\0".repeat(m.length);
  return text.replace(FENCE_RE, maskMatch).replace(INLINE_CODE_RE, maskMatch);
}

export interface StripThinkBlocksResult {
  /** Input with every complete, OUTSIDE-CODE think/thinking block removed. */
  content: string;
  /**
   * True when, after removing complete OUTSIDE-CODE blocks, an unmatched
   * opening or closing `<think>`/`</think>`/`<thinking>`/`</thinking>` tag
   * remains outside code (unclosed block, stray close with no open, etc).
   * Callers should treat this as "do not trust this output" rather than
   * write it. A tag that only ever appeared inside a fenced code block or
   * inline code span never sets this — that is a documented EXAMPLE, not a
   * leak.
   */
  hasStrayTag: boolean;
}

/**
 * Remove every complete `<think>...</think>` / `<thinking>...</thinking>`
 * block from model output, case-insensitively, across newlines — but ONLY
 * outside a fenced code block or inline code span, so a page that documents
 * this guard (or shows a `<think>` tag as an example) keeps that example
 * intact instead of having it silently stripped or the whole page rejected
 * (flow 268 T26). Multiple blocks are all removed. Reports whether a stray
 * (unmatched) opening or closing tag remains OUTSIDE code afterward — that
 * case means the model's output was truncated or malformed mid-reasoning-
 * block and should not be trusted as-is; a bare tag mentioned inside code
 * never triggers this.
 *
 * Pure and side-effect free.
 */
export function stripThinkBlocks(text: string): StripThinkBlocksResult {
  const masked = maskCodeRegions(text);
  const ranges: Array<[number, number]> = [];
  for (const m of masked.matchAll(THINK_BLOCK_RE)) {
    if (m.index === undefined) continue;
    ranges.push([m.index, m.index + m[0].length]);
  }
  // Remove in reverse order so earlier ranges' indices stay valid as later
  // (later-in-document) ranges are spliced out first.
  let content = text;
  for (const [start, end] of ranges.reverse()) {
    content = content.slice(0, start) + content.slice(end);
  }
  return { content, hasStrayTag: containsThinkTags(content) };
}

/**
 * True when `text` contains a `<think>`, `</think>`, `<thinking>`, or
 * `</thinking>` tag OUTSIDE a fenced code block or inline code span. Used by
 * `wiki status` to flag already-written pages that leaked reasoning before
 * this guard existed, and by `stripThinkBlocks` above for its own stray-tag
 * check — the ONE shared definition of "counts as code" (flow 268 T26). A
 * page legitimately documenting this guard, or showing a `<think>` tag as an
 * example (fenced OR inline), is never flagged; a real leaked bare tag,
 * anywhere outside code, still is.
 */
export function containsThinkTags(text: string): boolean {
  return STRAY_THINK_TAG_RE.test(maskCodeRegions(text));
}
