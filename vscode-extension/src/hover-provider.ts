// HoverProvider glue (spec.md §2.6, T10). Thin `vscode`-calling shell: all
// rendering/parsing/caching decisions live in the pure `hover-logic.ts`
// sibling. Calls `keryx wiki ask "<symbol>"` via `keryx-cli.ts`'s existing
// shell-out seam (`runKeryx`) — the CLI's actual Q&A surface (confirmed by
// reading `src/commands/wiki.ts`: there is no `keryx wiki query`, only
// `ask`, and no `--json` output — see `hover-logic.ts`'s header comment for
// the full finding on the missing staleness field).

import * as vscode from "vscode";
import { KeryxAbortedError, runKeryx } from "./keryx-cli";
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
  // Real cancellation, not just a "latest wins" flag: the previous in-flight
  // request (its debounce timer AND its child process, if already spawned)
  // is aborted whenever a newer hover request supersedes it. This stops
  // rapid hovers over different symbols from racing — and stops burning
  // CPU/child-process work on a result nobody will see, not just hiding a
  // stale result after the fact.
  private currentAbort: AbortController | undefined;

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

    // Supersede any still-in-flight request from a previous hover — cancels
    // both its debounce wait and (if it already started) its `runKeryx` child
    // process via the shared AbortSignal.
    this.currentAbort?.abort();
    const abortController = new AbortController();
    this.currentAbort = abortController;

    try {
      await debounce(DEBOUNCE_MS, abortController.signal);

      const result = await runKeryx(["wiki", "ask", word], this.cwd, undefined, undefined, abortController.signal);
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
    } catch (error) {
      // Aborted because a newer hover request superseded this one — not a
      // real error, just discard the stale result.
      if (error instanceof KeryxAbortedError || abortController.signal.aborted) {
        return undefined;
      }
      throw error;
    } finally {
      if (this.currentAbort === abortController) {
        this.currentAbort = undefined;
      }
    }
  }
}

function debounce(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new KeryxAbortedError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new KeryxAbortedError());
      },
      { once: true },
    );
  });
}

/**
 * Register the hover provider for all source files AND wire cache
 * invalidation on save, returning a single composite Disposable (matching
 * `context.subscriptions.push(...)`'s pattern elsewhere in `extension.ts`).
 * Previously this returned only the hover-provider registration and
 * discarded the `KeryxHoverProvider` instance itself, so nothing could ever
 * call `invalidateFile` — the hover cache would silently serve stale answers
 * past an edit for its full TTL.
 */
export function registerKeryxHoverProvider(cwd: string): vscode.Disposable {
  const provider = new KeryxHoverProvider(cwd);
  const providerRegistration = vscode.languages.registerHoverProvider({ scheme: "file" }, provider);
  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    provider.invalidateFile(document.uri.fsPath);
  });
  return vscode.Disposable.from(providerRegistration, saveListener);
}
