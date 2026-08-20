// Pure logic for the hover provider (spec.md §2.6, T10): rendering a
// markdown hover card from a `keryx wiki ask` result, and deciding whether
// a per-file cache entry is still fresh. Zero `vscode` import so this is
// unit-testable with `bun test`; `hover-provider.ts` is the thin glue that
// registers a real `vscode.HoverProvider` and shells out via `keryx-cli.ts`.
//
// IMPORTANT FINDING (recorded here, not silently worked around): per
// spec.md §2.6, this module is supposed to surface a staleness/content-hash
// drift indicator "when the underlying MCP response exposes one." Reading
// the real CLI source (`src/commands/wiki.ts`'s `runAsk`, `src/wiki/ask.ts`,
// `src/wiki/types.ts`'s `WikiAskResult`/`WikiAskCitation`) shows that
// `keryx wiki ask` today:
//   - has NO `--json` flag at all (only `console.log(result.answerMarkdown)`
//     — plain markdown to stdout, not structured JSON);
//   - there is no `keryx wiki query` command (the CLI's only Q&A verb is
//     `ask`; `status|new|index|collect|check-links|validate|ask|enrich|
//     context|backlinks` is the complete `wiki` subcommand list);
//   - `WikiAskCitation`/`WikiAskResult` carry `{path, title, excerpt, score,
//     source}` / `{question, citations, answerMarkdown}` — no staleness or
//     content-hash field anywhere in that type or in the runtime object
//     `wikiAsk()` builds.
//   - `src/wiki/staleness.ts` DOES exist and DOES compute per-page content
//     hashes (`computePageNodeHash`, sha256 over a page's key files), but by
//     its own header comment it is scoped exclusively to `wiki enrich`'s RLM
//     resume pipeline (skip re-enriching an unchanged page) — it is not
//     wired into `wikiAsk`/`WikiAskResult` in any way.
// So today, a staleness field is genuinely ABSENT from what this extension
// can call. Per spec.md §2.6's own instruction, that absence is itself a
// finding to surface back to keryx-mcp-client-adjacent work, not a reason to
// fabricate confidence. This module is built forward-compatible: it reads an
// OPTIONAL `stale`/`staleness` field if a future CLI/JSON output exposes one
// on a citation, and renders nothing extra — never a fabricated "up to date"
// claim either — when it is absent, which is every real invocation today.

/** What this extension can obtain from `keryx wiki ask` today, plus an optional forward-compatible staleness signal a future CLI/JSON surface might add per citation. */
export interface WikiHoverCitation {
  readonly path: string;
  readonly title: string;
  readonly excerpt: string;
  readonly source: "wiki" | "memory";
  /** Forward-compatible only — no current `keryx wiki ask` output sets this (see module header finding). */
  readonly stale?: boolean;
}

export interface WikiHoverResult {
  readonly question: string;
  readonly citations: readonly WikiHoverCitation[];
  readonly answerMarkdown: string;
}

/**
 * Render a `vscode.MarkdownString`-ready markdown body for a hover card.
 * When ANY citation carries `stale: true`, a single muted "may be outdated"
 * line is appended — never fabricated when the field is absent (today's
 * reality for every real `keryx wiki ask` call). AC7's two required
 * branches: staleness-present renders the indicator; staleness-absent
 * renders cleanly with no unqualified-confidence claim either way.
 */
export function renderHoverMarkdown(result: WikiHoverResult): string {
  if (result.citations.length === 0) {
    return `_No wiki knowledge found for this symbol._`;
  }

  const lines = result.citations
    .slice(0, 3)
    .map((citation) => `**${citation.title}** — ${citation.excerpt} (\`${citation.path}\`)`);

  const hasStale = result.citations.some((citation) => citation.stale === true);
  const body = lines.join("\n\n");

  return hasStale ? `${body}\n\n_⚠ may be outdated_` : body;
}

/** True when this result has at least one citation flagged stale — used by tests and any future status-bar/tree summarisation. */
export function hasStalenessSignal(result: WikiHoverResult): boolean {
  return result.citations.some((citation) => citation.stale === true);
}

/**
 * Parse `keryx wiki ask`'s stdout (plain markdown — there is no `--json`
 * flag, see the module header finding) into `WikiHoverResult`-shaped data.
 * The markdown itself is deterministic (`assembleAnswer` in
 * `src/wiki/ask.ts`): numbered lines of the form
 * `N. **title** — excerpt (\`path\`)` followed by a `## Sources` section.
 * Citations parsed this way never carry a `stale` flag (the source markdown
 * has no such information to parse out) — this function exists so the
 * extension has *something* better than raw markdown to render today, while
 * staying honest that no staleness signal can come from this path. A parse
 * failure (unexpected format, e.g. "no matching pages" wording) degrades to
 * zero citations with the raw markdown preserved, never a thrown error.
 */
export function parseWikiAskMarkdown(question: string, markdown: string): WikiHoverResult {
  const citationLine = /^\d+\.\s+\*\*(.+?)\*\*\s+—\s+(.+?)\s+\(`(.+?)`\)\s*$/;
  const citations: WikiHoverCitation[] = [];

  for (const line of markdown.split("\n")) {
    const match = citationLine.exec(line.trim());
    if (!match) continue;
    const [, title, excerpt, path] = match;
    if (!title || !excerpt || !path) continue;
    citations.push({
      title,
      excerpt,
      path,
      source: path.startsWith("memory/") ? "memory" : "wiki",
    });
  }

  return { question, citations, answerMarkdown: markdown };
}

export interface HoverCacheEntry {
  readonly result: WikiHoverResult;
  readonly cachedAtMs: number;
}

const DEFAULT_TTL_MS = 60_000;

/** Whether a cache entry for a file is still usable (within TTL). A missing entry is always stale. */
export function isCacheEntryFresh(entry: HoverCacheEntry | undefined, nowMs: number, ttlMs = DEFAULT_TTL_MS): boolean {
  if (!entry) return false;
  return nowMs - entry.cachedAtMs < ttlMs;
}

/** Cache key: file path + the hovered word, so two different symbols in the same file don't collide. */
export function hoverCacheKey(filePath: string, word: string): string {
  return `${filePath}::${word}`;
}
