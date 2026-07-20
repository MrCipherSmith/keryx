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
import { collectPages } from "./service";
import type { WikiPage } from "./types";

export type { ProviderFactory } from "../harness/provider/single-turn";
export { hasCredential } from "../harness/provider/single-turn";

export interface WikiEnrichInput {
  cwd: string;
  /** Enrich only this page (slug or wiki-relative path). Default: all drafts. */
  page?: string;
  /** Enrich every draft page (explicit; default behavior when no `page`). */
  all?: boolean;
  /** Extra instruction merged into the enrichment prompt. */
  prompt?: string;
  /** Provider name (anthropic | ollama | openrouter | grok | …). */
  provider?: string;
  /** Model id; a per-provider default is used when absent. */
  model?: string;
  /** Print the enriched draft without writing it. */
  dryRun?: boolean;
  // Injected, all-optional for deterministic offline tests:
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  baseUrl?: string;
  providerFactory?: ProviderFactory;
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

/** Select the pages to enrich: a named page, or every draft page. */
async function selectPages(input: WikiEnrichInput): Promise<WikiPage[]> {
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
  return pages.filter((page) => (page.status ?? "draft") === "draft");
}

export async function wikiEnrich(input: WikiEnrichInput): Promise<WikiEnrichResult> {
  const provider = input.provider ?? DEFAULT_PROVIDER;
  const model = input.model ?? defaultModelFor(provider);
  const env = input.env ?? process.env;
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

  for (const page of pages) {
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
