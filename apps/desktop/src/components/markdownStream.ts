// Incremental rendering of a Markdown message that is still growing. Pure (marked's lexer only):
// the caller supplies how a run of tokens becomes HTML, so this can be tested without a DOM.
import { marked, type Token } from "marked";

/** How a run of top-level tokens becomes the HTML that is shown (parse, sanitize, decorate). */
export type RenderTokens = (tokens: Token[]) => string;

/**
 * The completed top-level blocks of a growing message, `src.slice(0, end)`, each already rendered.
 * `epoch` changes whenever earlier blocks are thrown away, so a view knows to rebuild, not append.
 */
export interface StreamCache {
  src: string;
  end: number;
  blocks: string[];
  epoch: number;
}

export const emptyCache = (): StreamCache => ({ src: "", end: 0, blocks: [], epoch: 0 });

export interface StreamFrame {
  /** Rendered completed blocks; a view keeps the ones it already shows and appends the rest. */
  blocks: readonly string[];
  /** The rendered open tail: the only part that changes from frame to frame. */
  tail: string;
  epoch: number;
}

/**
 * Render `text`, reusing the cached blocks while it only grows. A top-level block followed by another
 * block is complete: it is rendered once, decorated like the final rendering, and cached; only the open
 * tail is lexed and rendered again. A text that no longer extends the cached prefix starts over.
 */
export function renderStreaming(text: string, c: StreamCache, render: RenderTokens): StreamFrame {
  if (c.end > text.length || text.slice(0, c.end) !== c.src.slice(0, c.end)) {
    c.end = 0;
    c.blocks = [];
    c.epoch += 1;
  }
  c.src = text;
  const tail = text.slice(c.end);
  const tokens = marked.lexer(tail);
  let open = tokens.length - 1;
  while (open > 0 && tokens[open]?.type === "space") open--;
  let rest: Token[] = tokens;
  if (open > 0) {
    const done = tokens.slice(0, open);
    const raw = done.map((t) => t.raw).join("");
    // The lexer normalises line endings; commit only when the raw text maps back onto the source.
    if (tail.startsWith(raw)) {
      c.blocks.push(render(done));
      c.end += raw.length;
      rest = tokens.slice(open);
    }
  }
  return { blocks: c.blocks, tail: render(rest), epoch: c.epoch };
}
