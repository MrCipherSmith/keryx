// HoverProvider glue (spec.md §2.6, T10). Thin `vscode`-calling shell: all
// rendering/parsing/caching decisions live in the pure `hover-logic.ts`
// sibling. Calls `keryx wiki ask "<symbol>"` via `keryx-cli.ts`'s existing
// shell-out seam (`runKeryx`) — the CLI's actual Q&A surface (confirmed by
// reading `src/commands/wiki.ts`: there is no `keryx wiki query`, only
// `ask`, and no `--json` output — see `hover-logic.ts`'s header comment for
// the full finding on the missing staleness field).

import * as vscode from "vscode";
import { runKeryx } from "./keryx-cli";
import {
  hoverCacheKey,
  isCacheEntryFresh,
  parseWikiAskMarkdown,
  renderHoverMarkdown,
  type HoverCacheEntry,
} from "./hover-logic";

const DEBOUNCE_MS = 300;

export class KeryxHoverProvider implements vscode.HoverProvider {
  private readonly cache = new Map<string, HoverCacheEntry>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly cwd: string) {}

  /** Invalidate every cached entry for one file, e.g. on save. */
  invalidateFile(filePath: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${filePath}::`)) {
        this.cache.delete(key);
      }
    }
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const range = document.getWordRangeAtPosition(position);
    if (!range) return undefined;
    const word = document.getText(range);
    if (!word) return undefined;

    const filePath = document.uri.fsPath;
    const key = hoverCacheKey(filePath, word);
    const cached = this.cache.get(key);
    if (isCacheEntryFresh(cached, Date.now())) {
      // cached is guaranteed defined when fresh (isCacheEntryFresh returns
      // false for undefined), but TypeScript's narrowing doesn't see through
      // the helper call — assert explicitly rather than duplicating the check.
      return new vscode.Hover(new vscode.MarkdownString(renderHoverMarkdown(cached!.result)), range);
    }

    await debounce(DEBOUNCE_MS);

    const result = await runKeryx(["wiki", "ask", word], this.cwd);
    if (result.exitCode !== 0) {
      return undefined;
    }

    const parsed = parseWikiAskMarkdown(word, result.stdout);
    this.cache.set(key, { result: parsed, cachedAtMs: Date.now() });

    if (parsed.citations.length === 0) {
      return undefined;
    }

    const markdown = new vscode.MarkdownString(renderHoverMarkdown(parsed));
    markdown.isTrusted = false;
    return new vscode.Hover(markdown, range);
  }
}

function debounce(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Register the hover provider for all source files, returning its Disposable. */
export function registerKeryxHoverProvider(cwd: string): vscode.Disposable {
  return vscode.languages.registerHoverProvider({ scheme: "file" }, new KeryxHoverProvider(cwd));
}
