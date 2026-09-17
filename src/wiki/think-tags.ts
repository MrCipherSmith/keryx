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

export interface StripThinkBlocksResult {
  /** Input with every complete think/thinking block removed. */
  content: string;
  /**
   * True when, after removing complete blocks, an unmatched opening or
   * closing `<think>`/`</think>`/`<thinking>`/`</thinking>` tag remains
   * (unclosed block, stray close with no open, etc). Callers should treat
   * this as "do not trust this output" rather than write it.
   */
  hasStrayTag: boolean;
}

/**
 * Remove every complete `<think>...</think>` / `<thinking>...</thinking>`
 * block from model output, case-insensitively, across newlines. Multiple
 * blocks are all removed. Reports whether a stray (unmatched) opening or
 * closing tag remains afterward — that case means the model's output was
 * truncated or malformed mid-reasoning-block and should not be trusted as-is.
 *
 * Pure and side-effect free.
 */
export function stripThinkBlocks(text: string): StripThinkBlocksResult {
  const content = text.replace(THINK_BLOCK_RE, "");
  return { content, hasStrayTag: STRAY_THINK_TAG_RE.test(content) };
}

/** Fenced code blocks (```...```), removed before scanning existing pages for tags. */
const FENCE_RE = /```[\s\S]*?```/g;

/**
 * True when `text` contains a `<think>`, `</think>`, `<thinking>`, or
 * `</thinking>` tag. Used by `wiki status` to flag already-written pages that
 * leaked reasoning before this guard existed. Ignores matches inside fenced
 * code blocks (a page legitimately documenting this guard, or showing a
 * `<think>` tag as an example, should not itself be flagged).
 */
export function containsThinkTags(text: string): boolean {
  return STRAY_THINK_TAG_RE.test(text.replace(FENCE_RE, ""));
}
