// gdwiki enrichment via a model provider (flow 087, item 2 — first model-backed
// command). Targets DRAFT wiki pages (the work-front `wiki collect` already
// flags) and rewrites their prose through a provider turn.
//
// Reuses the harness provider boundary (`makeProvider` + the neutral
// `ProviderPort.stream`) for a single-shot completion — no tools, no policy
// loop. FAIL-CLOSED: without a credential for the requested provider the command
// refuses BEFORE any network attempt and reports a clear reason (never a silent
// no-op, never a partial write). Deterministic given an injected provider
// factory; the default factory is the same one `keryx harness run` uses.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultModelFor, hasCredential, runModelTurn } from "../harness/provider/single-turn";
import type { ProviderFactory } from "../harness/provider/single-turn";
import { pathExists } from "../lib/fs";
import { envWithSavedApiKeys } from "../lib/shell-config";
import { collectPages } from "./service";
import type { WikiPage } from "./types";

export type { ProviderFactory } from "../harness/provider/single-turn";
export { hasCredential } from "../harness/provider/single-turn";

export interface WikiEnrichInput {
  cwd: string;
  /** Enrich only this page (slug or wiki-relative path). Default: all drafts. */
  page?: string;
  /**
   * Batch mode marker (CLI `--all`). Without {@link force}, still means
   * **draft pages only** — same as omitting a page argument.
   */
  all?: boolean;
  /**
   * Include non-draft pages (e.g. `accepted`) in batch mode.
   * CLI: `--force`. Ignored when a single `page` is specified (single page
   * already matches regardless of status).
   */
  force?: boolean;
  /** Extra instruction merged into the enrichment prompt. */
  prompt?: string;
  /** Provider name (anthropic | ollama | openrouter | grok | …). */
  provider?: string;
  /** Model id; a per-provider default is used when absent. */
  model?: string;
  /** Print the enriched draft without writing it. */
  dryRun?: boolean;
  /** Called before each page is sent to the model (1-based index). */
  onPage?: (info: { index: number; total: number; path: string; status: string }) => void;
  // Injected, all-optional for deterministic offline tests:
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  baseUrl?: string;
  providerFactory?: ProviderFactory;
}

/** Draft vs accepted (and other) split for planning / agent prompts. */
export interface WikiEnrichPlan {
  drafts: WikiPage[];
  accepted: WikiPage[];
  other: WikiPage[];
  /** Pages that would run without `--force` (drafts only). */
  defaultTargets: WikiPage[];
  /** Pages that would run with `--force` (all wiki pages). */
  forceTargets: WikiPage[];
}

export type WikiEnrichAction = "enriched" | "dry-run" | "skipped" | "failed";

export interface WikiEnrichPageResult {
  path: string;
  action: WikiEnrichAction;
  reason?: string;
  bytesBefore?: number;
  bytesAfter?: number;
  /** The enriched body, only populated on `dry-run`. */
  preview?: string;
}

export interface WikiEnrichResult {
  provider: string;
  model: string;
  credentialAvailable: boolean;
  pages: WikiEnrichPageResult[];
  enriched: number;
  dryRun: number;
  skipped: number;
  failed: number;
}

const DEFAULT_PROVIDER = "anthropic";

const DEFAULT_SYSTEM_PROMPT = `You are a technical writer maintaining a software project's knowledge wiki.
You are given ONE wiki page whose prose is a stub or draft. Rewrite it into clear,
accurate, well-structured Markdown documentation.

Rules:
- Preserve the YAML frontmatter block (between the leading --- lines) EXACTLY.
- Keep the existing H1 title.
- Do not invent APIs, files, or behavior that are not implied by the page's own
  title, type, and summary. When unsure, describe intent at a high level.
- Prefer short paragraphs and bullet lists over walls of text.
- Return ONLY the full Markdown page (frontmatter + body), no commentary.`;

/** Load the enrichment system prompt, preferring a project-local override. */
async function loadSystemPrompt(cwd: string): Promise<string> {
  const overridePath = path.join(cwd, ".metaproject", "wiki", "enrich.prompt.md");
  if (await pathExists(overridePath)) {
    const custom = (await readFile(overridePath, "utf8")).trim();
    if (custom.length > 0) {
      return custom;
    }
  }
  return DEFAULT_SYSTEM_PROMPT;
}

/**
 * Select pages to enrich:
 * - `page` set → match that slug/path (any status);
 * - `force` → every wiki page;
 * - else → draft pages only (`--all` does not change this).
 */
export async function selectPages(input: WikiEnrichInput): Promise<WikiPage[]> {
  const pages = await collectPages(input.cwd);
  if (input.page) {
    const needle = input.page.replace(/\.md$/, "");
    return pages.filter(
      (page) =>
        page.relativePath === input.page ||
        page.relativePath.replace(/\.md$/, "") === needle ||
        page.relativePath.replace(/\.md$/, "").endsWith(`/${needle}`),
    );
  }
  if (input.force) {
    return pages;
  }
  return pages.filter((page) => (page.status ?? "draft") === "draft");
}

/** Split the wiki into draft / accepted / other for planning UIs and `--list`. */
export async function planWikiEnrich(cwd: string): Promise<WikiEnrichPlan> {
  const pages = await collectPages(cwd);
  const drafts: WikiPage[] = [];
  const accepted: WikiPage[] = [];
  const other: WikiPage[] = [];
  for (const page of pages) {
    const status = page.status ?? "draft";
    if (status === "draft") {
      drafts.push(page);
    } else if (status === "accepted") {
      accepted.push(page);
    } else {
      other.push(page);
    }
  }
  return {
    drafts,
    accepted,
    other,
    defaultTargets: drafts,
    forceTargets: pages,
  };
}

/**
 * True when the user message is an enrich-wiki intent (RU/EN).
 * Used by the TUI pre-router so the harness does not thrash read tools.
 */
export function isWikiEnrichIntent(line: string): boolean {
  const t = line.trim().toLowerCase();
  if (t.length === 0) {
    return false;
  }
  // Cyrillic: do not use \w (ASCII-only without /u). Match stems loosely.
  const ru =
    t.includes("вики") && (t.includes("обогат") || t.includes("обогащ"));
  const en =
    (/\benrich\b/.test(t) && /\bwiki\b/.test(t)) || /\bwiki\s+enrich\b/.test(t);
  return ru || en;
}

export async function wikiEnrich(input: WikiEnrichInput): Promise<WikiEnrichResult> {
  const provider = input.provider ?? DEFAULT_PROVIDER;
  const model = input.model ?? defaultModelFor(provider);
  // `runModelTurn` also merges auth.json; we mirror that here so the early
  // fail-closed skip message matches what the turn will actually use.
  const env = envWithSavedApiKeys(input.env ?? process.env);
  const credentialAvailable = hasCredential(provider, env);
  const result: WikiEnrichResult = {
    provider,
    model,
    credentialAvailable,
    pages: [],
    enriched: 0,
    dryRun: 0,
    skipped: 0,
    failed: 0,
  };

  const pages = await selectPages(input);
  if (pages.length === 0) {
    return result;
  }

  // Fail-closed: no credential ⇒ refuse every page with a clear reason rather
  // than fall back to an offline FakeProvider. An injected factory (tests)
  // bypasses the credential requirement.
  if (!credentialAvailable && input.providerFactory === undefined) {
    for (const page of pages) {
      result.pages.push({
        path: page.relativePath,
        action: "skipped",
        reason: `no credential for provider "${provider}" (set its API key env var)`,
      });
      result.skipped += 1;
    }
    return result;
  }

  const systemPrompt = await loadSystemPrompt(input.cwd);
  const total = pages.length;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    input.onPage?.({
      index: i + 1,
      total,
      path: page.relativePath,
      status: page.status ?? "draft",
    });

    const original = await readFile(page.absolutePath, "utf8");
    const turn = await runModelTurn({
      provider,
      model,
      system: systemPrompt,
      user: buildUserPrompt(page, original, input.prompt),
      maxOutputTokens: 2048,
      requestId: `wiki-enrich:${page.relativePath}`,
      env,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.providerFactory ? { providerFactory: input.providerFactory } : {}),
    });

    if (turn.error) {
      result.pages.push({
        path: page.relativePath,
        action: "failed",
        reason: `${turn.error.kind}: ${turn.error.message}`,
      });
      result.failed += 1;
      continue;
    }

    const enriched = turn.text.trim();
    if (enriched.length === 0) {
      result.pages.push({ path: page.relativePath, action: "failed", reason: "empty model response" });
      result.failed += 1;
      continue;
    }

    if (input.dryRun) {
      result.pages.push({
        path: page.relativePath,
        action: "dry-run",
        bytesBefore: original.length,
        bytesAfter: enriched.length,
        preview: enriched,
      });
      result.dryRun += 1;
      continue;
    }

    await writeFile(page.absolutePath, `${enriched}\n`, "utf8");
    result.pages.push({
      path: page.relativePath,
      action: "enriched",
      bytesBefore: original.length,
      bytesAfter: enriched.length,
    });
    result.enriched += 1;
  }

  return result;
}

/** Assemble the per-page user prompt. */
function buildUserPrompt(page: WikiPage, original: string, extra?: string): string {
  const parts = [
    `Wiki page type: ${page.pageType}`,
    `Title: ${page.title}`,
    `Summary: ${page.summary || "(none)"}`,
    "",
    "Current page content (enrich the prose, keep frontmatter and title):",
    "```markdown",
    original.trimEnd(),
    "```",
  ];
  if (extra && extra.trim().length > 0) {
    parts.push("", `Additional instruction: ${extra.trim()}`);
  }
  return parts.join("\n");
}
