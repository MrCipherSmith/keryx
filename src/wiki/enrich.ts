// gdwiki enrichment via a model provider (flow 087 + enrich batch/swarm prep).
//
// Targets draft wiki pages by default (or all statuses with `--force`), rewrites
// prose through provider turns, validates each result, optionally marks
// Status: accepted, and can run a bounded parallel worker pool (same shape a
// future subagent swarm would use — one worker per page, concurrency-capped).
//
// FAIL-CLOSED without credentials. Provider/model default from shell auth.json
// (not a hard-coded anthropic-only path). Progress via onPage + stderr.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildGraph } from "../gdgraph/build";
import { loadGdgraphConfig } from "../gdgraph/config";
import { personalizedPageRank } from "../gdgraph/pagerank";
import { loadGraph } from "../gdgraph/query";
import { buildRankEdges, estimateTokens } from "../gdgraph/repomap";
import type { GraphData } from "../gdgraph/types";
import { defaultModelFor, hasCredential, runModelTurn } from "../harness/provider/single-turn";
import type { ProviderFactory } from "../harness/provider/single-turn";
import { pathExists } from "../lib/fs";
import { envWithSavedApiKeys, loadShellConfig } from "../lib/shell-config";
import { classifyPage, computeGraphFanIn, computePageGraphSignals } from "./classify";
import { collectPages, computeModuleKeyFiles, keyFilesForPage } from "./collect";
import { loadWikiConfig, type WikiConfig } from "./config";
import { enrichPageDeep } from "./deep-enrich";
import type { ResumeState } from "./resume-state";
import { wikiValidate } from "./service";
import { computePageNodeHash, isPageUnchangedSinceLastEnrich } from "./staleness";
import type { WikiPage } from "./types";

export type { ProviderFactory } from "../harness/provider/single-turn";
export { hasCredential } from "../harness/provider/single-turn";
// Re-exported for existing consumers (e.g. `enrich.test.ts`) that import
// `ResumeState` from this module — the type itself now lives in
// `./resume-state` so `staleness.ts` can import it without an `enrich.ts`
// <-> `staleness.ts` cycle (flow 169 T9, code-verifier finding #1).
export type { ResumeState } from "./resume-state";

/** Default completion budget per page — wiki pages with frontmatter + prose need headroom. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** Default parallel workers. 1 = sequential; raise for a page swarm. */
export const DEFAULT_CONCURRENCY = 1;

/** Hard ceiling so a typo cannot open hundreds of provider streams. */
export const MAX_CONCURRENCY = 8;

/** Fallback only when neither CLI flags nor auth.json provide a provider. */
const FALLBACK_PROVIDER = "anthropic";

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
   * CLI: `--force`. Single `page` already matches any status.
   */
  force?: boolean;
  /** Extra instruction merged into the enrichment prompt. */
  prompt?: string;
  /** Provider name; defaults to shell auth.json then {@link FALLBACK_PROVIDER}. */
  provider?: string;
  /** Model id; defaults to shell auth.json then provider default. */
  model?: string;
  /** Print the enriched draft without writing it. */
  dryRun?: boolean;
  /** Max pages this run (after filters / resume). CLI: `--limit`. */
  limit?: number;
  /**
   * Parallel page workers (1..{@link MAX_CONCURRENCY}). Lays the groundwork for
   * a multi-agent enrich swarm (one logical worker per page).
   */
  concurrency?: number;
  /** Skip paths already recorded as completed in the resume state file. */
  resume?: boolean;
  /** After a successful write, set frontmatter Status to accepted (default true). */
  markAccepted?: boolean;
  /** Keep model Status field as returned (disables markAccepted). */
  keepStatus?: boolean;
  /** Run `gdgraph build` before enriching. */
  refreshGraph?: boolean;
  /** Validate each page after enrich (frontmatter + wikiValidate). Default true. */
  validate?: boolean;
  /** Completion token budget per page. Default {@link DEFAULT_MAX_OUTPUT_TOKENS}. */
  maxOutputTokens?: number;
  /** Called before each page is sent to the model (1-based index of this run). */
  onPage?: (info: {
    index: number;
    total: number;
    path: string;
    status: string;
    phase: "start" | "model" | "validate" | "done" | "failed";
  }) => void;
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
  /**
   * RLM classification tier this page went through (flow 169 T7,
   * `rlm.enabled: true` only). Additive/optional — absent entirely on the
   * RLM-off path, so existing consumers of this shape see no new fields
   * (NFR-4/AC1).
   */
  tier?: "skip" | "light" | "deep";
  /** Ordered tool-call count from a `deep`-tier child turn (AC7 summary). */
  deepToolCalls?: number;
  /**
   * `computePageNodeHash` result recorded for this page on a successful
   * (`action: "enriched"`) RLM-path run — the caller (`wikiEnrich`) folds
   * this into `ResumeState.completedNodeHashes` so a future run's staleness
   * gate (PRD FR-7) can skip this page without a new LLM call.
   */
  nodeHash?: string;
}

export interface WikiEnrichResult {
  provider: string;
  model: string;
  credentialAvailable: boolean;
  concurrency: number;
  pages: WikiEnrichPageResult[];
  enriched: number;
  dryRun: number;
  /**
   * Pages skipped without contacting the provider. With `rlm.enabled: false`
   * (or absent config), this is only the fail-closed no-credential case,
   * where every selected page is skipped and the run returns early; a normal
   * run leaves this at 0. With `rlm.enabled: true` (flow 169 T7), it also
   * counts per-page RLM outcomes that never call the model: classify-`skip`
   * pages, staleness-gate "unchanged since last enrich" pages (FR-7), and
   * `deep`-tier pages that fell back after exhausting their budget (AC5).
   * Pages dropped by `resume` or `limit` are never selected, so they are not
   * counted here.
   */
  skipped: number;
  failed: number;
}

const DEFAULT_SYSTEM_PROMPT = `You are a technical writer maintaining a software project's knowledge wiki.
You are given ONE wiki page whose prose is a stub or draft. Rewrite it into clear,
accurate, well-structured Markdown documentation.

Rules:
- The page ALWAYS starts with a YAML frontmatter block between leading --- lines.
  Preserve that block's structure (Title, Version, Type, Status, Summary keys).
  You may set Status to accepted when prose is solid.
- If the provided page somehow lacks frontmatter, CREATE a valid block that starts
  with --- and includes Title and Status, then the body.
- Keep the existing H1 title.
- Do not invent APIs, files, or behavior that are not implied by the page's own
  title, type, and summary. When unsure, describe intent at a high level.
- Prefer short paragraphs and bullet lists over walls of text.
- Return ONLY the full Markdown page (frontmatter + body), no commentary.`;

/** Resolve provider/model: explicit input → shell auth.json → fallbacks. */
export function resolveEnrichProviderModel(input: {
  provider?: string;
  model?: string;
}): { provider: string; model: string } {
  const cfg = loadShellConfig();
  const provider =
    (input.provider && input.provider.trim()) ||
    (typeof cfg.provider === "string" && cfg.provider.trim().length > 0 ? cfg.provider.trim() : "") ||
    FALLBACK_PROVIDER;
  const model =
    (input.model && input.model.trim()) ||
    (typeof cfg.model === "string" && cfg.model.trim().length > 0 ? cfg.model.trim() : "") ||
    defaultModelFor(provider);
  return { provider, model };
}

export function resumeStatePath(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "wiki", "enrich-resume.json");
}

export function loadResumeState(cwd: string): ResumeState {
  try {
    const file = resumeStatePath(cwd);
    if (!existsSync(file)) {
      return { updatedAt: new Date().toISOString(), completed: [], failed: [] };
    }
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (raw === null || typeof raw !== "object") {
      return { updatedAt: new Date().toISOString(), completed: [], failed: [] };
    }
    const o = raw as Partial<ResumeState>;
    return {
      updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : new Date().toISOString(),
      ...(typeof o.provider === "string" ? { provider: o.provider } : {}),
      ...(typeof o.model === "string" ? { model: o.model } : {}),
      completed: Array.isArray(o.completed) ? o.completed.filter((p): p is string => typeof p === "string") : [],
      ...(isStringRecord(o.completedNodeHashes) ? { completedNodeHashes: o.completedNodeHashes } : {}),
      failed: Array.isArray(o.failed)
        ? o.failed.filter(
            (e): e is { path: string; reason: string } =>
              e !== null &&
              typeof e === "object" &&
              typeof (e as { path?: unknown }).path === "string" &&
              typeof (e as { reason?: unknown }).reason === "string",
          )
        : [],
    };
  } catch {
    return { updatedAt: new Date().toISOString(), completed: [], failed: [] };
  }
}

// Defensive check for `completedNodeHashes`: a plain object whose values are
// all strings. Malformed/unknown shapes (array, null, non-string values)
// degrade to "absent", same tolerance as `completed`/`failed` above.
function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export function saveResumeState(cwd: string, state: ResumeState): void {
  try {
    const file = resumeStatePath(cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  } catch {
    // best-effort
  }
}

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
  const ru = t.includes("вики") && (t.includes("обогат") || t.includes("обогащ"));
  const en = (/\benrich\b/.test(t) && /\bwiki\b/.test(t)) || /\bwiki\s+enrich\b/.test(t);
  return ru || en;
}

/** True when markdown already has a leading YAML frontmatter fence. */
export function hasYamlFrontmatter(markdown: string): boolean {
  return markdown.replace(/^\uFEFF/, "").trimStart().startsWith("---");
}

/**
 * Extract the leading `--- ... ---` frontmatter block (including fences), or null.
 * Tolerates optional UTF-8 BOM and leading whitespace.
 */
export function extractYamlFrontmatterBlock(markdown: string): string | null {
  const text = markdown.replace(/^\uFEFF/, "").trimStart();
  if (!text.startsWith("---")) {
    return null;
  }
  const close = text.indexOf("\n---", 3);
  if (close < 0) {
    return null;
  }
  // Include the closing --- line (and optional trailing newline after it).
  let end = close + 4; // \n---
  if (text[end] === "\n") {
    end += 1;
  } else if (text[end] === "\r" && text[end + 1] === "\n") {
    end += 2;
  }
  return text.slice(0, end);
}

/** Quote a YAML scalar when it would be ambiguous unquoted. */
function yamlScalar(value: string): string {
  const v = value.trim();
  if (v.length === 0) {
    return '""';
  }
  // Safe unquoted tokens (no colon, #, quotes, leading specials).
  if (/^[A-Za-z0-9_./+-][A-Za-z0-9_./+ -]*$/.test(v) && !v.includes(": ")) {
    return v;
  }
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const PSEUDO_META_KEYS = new Set(["version", "type", "status", "summary", "title"]);

export interface EnsureWikiFrontmatterHints {
  /** Fallback Title when no H1 / Title: line is present. */
  title?: string;
  /** Fallback Type (e.g. page.pageType from collectPages). */
  pageType?: string;
}

export interface EnsureWikiFrontmatterResult {
  markdown: string;
  /** True when a YAML block was synthesized (legacy page). */
  normalized: boolean;
}

/**
 * Ensure the page starts with a valid YAML frontmatter block.
 *
 * Legacy wiki pages often use:
 *   # Title
 *   Version: 1.0.0
 *   Type: component
 *   Status: accepted
 * without `---` fences. Enrich validation requires real YAML frontmatter, so
 * pre-normalize before the model turn so "preserve frontmatter" is meaningful.
 *
 * Idempotent for pages that already start with `---`.
 */
export function ensureWikiFrontmatter(
  source: string,
  hints: EnsureWikiFrontmatterHints = {},
): EnsureWikiFrontmatterResult {
  const raw = source.replace(/^\uFEFF/, "");
  if (hasYamlFrontmatter(raw)) {
    // Already fenced — ensure Title/Status exist when possible (non-destructive).
    const block = extractYamlFrontmatterBlock(raw);
    if (block !== null) {
      let fm = block;
      const body = raw.trimStart().slice(block.length);
      if (!/^Title:\s*\S+/im.test(fm) && !/\nTitle:\s*\S+/im.test(fm)) {
        const title =
          hints.title?.trim() ||
          body.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
          "Untitled";
        fm = fm.replace(/^---\n/, `---\nTitle: ${yamlScalar(title)}\n`);
      }
      if (!/^Status:\s*\S+/im.test(fm) && !/\nStatus:\s*\S+/im.test(fm)) {
        fm = fm.replace(/^---\n/, "---\nStatus: draft\n");
      }
      if (fm !== block) {
        return { markdown: `${fm}${body.startsWith("\n") ? body : `\n${body}`}`, normalized: true };
      }
    }
    return { markdown: raw, normalized: false };
  }

  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") {
    i += 1;
  }

  let title = hints.title?.trim() ?? "";
  if (i < lines.length) {
    const h1 = lines[i]!.match(/^#\s+(.+)$/);
    if (h1) {
      title = h1[1]!.trim();
      i += 1;
      while (i < lines.length && lines[i]!.trim() === "") {
        i += 1;
      }
    }
  }

  const meta: Record<string, string> = {};
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i += 1;
      // Stop pseudo-meta after first blank once we have at least one field,
      // OR continue if next non-empty is still Key: value meta.
      let j = i;
      while (j < lines.length && lines[j]!.trim() === "") {
        j += 1;
      }
      if (j >= lines.length) {
        break;
      }
      const next = lines[j]!;
      const m = next.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!m || !PSEUDO_META_KEYS.has(m[1]!.toLowerCase())) {
        break;
      }
      i = j;
      continue;
    }
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m || !PSEUDO_META_KEYS.has(m[1]!.toLowerCase())) {
      break;
    }
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "title" && val.length > 0) {
      title = val;
    } else if (key !== "title") {
      meta[key] = val;
    }
    i += 1;
  }

  while (i < lines.length && lines[i]!.trim() === "") {
    i += 1;
  }
  const bodyLines = lines.slice(i);
  let body = bodyLines.join("\n").replace(/^\n+/, "");

  // Prefer an explicit ## Summary section's first paragraph for Summary when missing.
  if (!meta.summary) {
    const sumMatch = body.match(/^##\s+Summary\s*\n+([\s\S]*?)(?=\n##\s|\n#\s|$)/i);
    if (sumMatch) {
      const para = sumMatch[1]!
        .trim()
        .split(/\n\n+/)[0]
        ?.replace(/\n/g, " ")
        .trim();
      if (para && para.length > 0 && para.length < 400) {
        meta.summary = para;
      }
    }
  }

  if (title.length === 0) {
    title = "Untitled";
  }
  const version = meta.version ?? "0.1.0";
  const type = meta.type ?? hints.pageType ?? "component";
  const status = meta.status ?? "draft";
  const summary = meta.summary ?? "";

  const fmLines = [
    "---",
    `Title: ${yamlScalar(title)}`,
    `Version: ${yamlScalar(version)}`,
    `Type: ${yamlScalar(type)}`,
    `Status: ${yamlScalar(status)}`,
    `Summary: ${yamlScalar(summary)}`,
    "---",
    "",
  ];

  // Keep original H1 in body when we stripped it for Title.
  if (!body.match(/^#\s+/m)) {
    body = `# ${title}\n\n${body}`.replace(/\n+$/, "\n");
  } else if (!body.startsWith("#")) {
    body = `# ${title}\n\n${body}`;
  }

  const out = `${fmLines.join("\n")}${body.endsWith("\n") ? body : `${body}\n`}`;
  return { markdown: out, normalized: true };
}

/**
 * If the model returned a body without YAML frontmatter, re-attach the
 * frontmatter from the (already normalized) original. Returns `enriched`
 * unchanged when it already has a valid leading frontmatter block.
 */
export function repairEnrichedFrontmatter(original: string, enriched: string): string {
  const text = enriched.replace(/^\uFEFF/, "").trim();
  if (text.length === 0) {
    return enriched;
  }
  if (hasYamlFrontmatter(text)) {
    return text;
  }
  const fm = extractYamlFrontmatterBlock(original);
  if (fm === null) {
    // Last resort: synthesize from the model body alone.
    return ensureWikiFrontmatter(text).markdown.trimEnd();
  }
  const body = text.replace(/^\uFEFF/, "").trimStart();
  const joined = `${fm.endsWith("\n") ? fm : `${fm}\n`}${body.endsWith("\n") ? body : `${body}\n`}`;
  return joined.trimEnd();
}

/**
 * Lightweight structural validation of model output before write.
 * Returns null if OK, or a reason string.
 */
export function validateEnrichedMarkdown(original: string, enriched: string): string | null {
  const text = enriched.trim();
  if (text.length === 0) {
    return "empty model response";
  }
  if (!text.startsWith("---")) {
    return "missing YAML frontmatter (must start with ---)";
  }
  const close = text.indexOf("\n---", 3);
  if (close < 0) {
    return "unclosed YAML frontmatter";
  }
  const fm = text.slice(0, close + 4);
  if (!/^Status:\s*\S+/im.test(fm) && !/\nStatus:\s*\S+/im.test(fm)) {
    return "frontmatter missing Status field";
  }
  if (!/^Title:\s*\S+/im.test(fm) && !/\nTitle:\s*\S+/im.test(fm)) {
    return "frontmatter missing Title field";
  }
  // Body should still look like markdown docs (at least one heading or paragraph).
  const body = text.slice(close + 4).trim();
  if (body.length < 20) {
    return "body too short after frontmatter";
  }
  // Reject pure commentary wrappers the model sometimes adds.
  if (/^(here is|here's|ниже|вот)\b/i.test(body) && body.length < 80) {
    return "looks like commentary, not a full page";
  }
  // Size sanity: model should not delete almost everything or explode 20×.
  // Compare against the body of the original when original has frontmatter so
  // pre-normalization does not inflate the baseline unfairly.
  const originalBody = (() => {
    const block = extractYamlFrontmatterBlock(original);
    if (block === null) {
      return original;
    }
    return original.trimStart().slice(block.length);
  })();
  const baselineLen = Math.max(originalBody.length, original.length * 0.5);
  if (baselineLen > 200 && text.length < baselineLen * 0.15) {
    return "enriched content much shorter than original (possible truncation)";
  }
  return null;
}

/** Set or replace Status in YAML frontmatter. */
export function setFrontmatterStatus(markdown: string, status: string): string {
  if (/\nStatus:\s*\S+/i.test(markdown)) {
    return markdown.replace(/\nStatus:\s*\S+/i, `\nStatus: ${status}`);
  }
  if (/^Status:\s*\S+/im.test(markdown)) {
    return markdown.replace(/^Status:\s*\S+/im, `Status: ${status}`);
  }
  // Insert after opening ---
  if (markdown.startsWith("---\n")) {
    return `---\nStatus: ${status}\n${markdown.slice(4)}`;
  }
  return markdown;
}

/** Run async work over items with a concurrency cap (page swarm primitive). */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Default stderr progress printer (CLI). */
export function defaultEnrichProgress(info: {
  index: number;
  total: number;
  path: string;
  status: string;
  phase: string;
}): void {
  const pct = info.total > 0 ? Math.round((info.index / info.total) * 100) : 0;
  console.error(`[enrich ${info.index}/${info.total} ${pct}%] ${info.phase} · ${info.path} (${info.status})`);
}

export async function wikiEnrich(input: WikiEnrichInput): Promise<WikiEnrichResult> {
  const { provider, model } = resolveEnrichProviderModel(input);
  const env = envWithSavedApiKeys(input.env ?? process.env);
  const credentialAvailable = hasCredential(provider, env);
  const concurrency = Math.max(
    1,
    Math.min(MAX_CONCURRENCY, input.concurrency ?? DEFAULT_CONCURRENCY),
  );
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const validate = input.validate !== false;
  const markAccepted = input.keepStatus === true ? false : input.markAccepted !== false;
  // Flow 169 T7: `.metaproject/wiki.config.json`'s `rlm.enabled` is the
  // single NFR-4/AC1 branch point below — absent config (or `rlm.enabled:
  // false`) takes the untouched pre-flow-169 per-page path.
  const wikiConfig = await loadWikiConfig(input.cwd);

  const result: WikiEnrichResult = {
    provider,
    model,
    credentialAvailable,
    concurrency,
    pages: [],
    enriched: 0,
    dryRun: 0,
    skipped: 0,
    failed: 0,
  };

  if (input.refreshGraph) {
    try {
      await buildGraph(input.cwd);
    } catch (cause) {
      // Non-fatal: enrich can still run on existing graph/wiki.
      console.error(
        `[enrich] gdgraph build failed (continuing): ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  let pages = await selectPages(input);

  const resumeStateEarly = input.resume === true ? loadResumeState(input.cwd) : null;
  if (resumeStateEarly !== null) {
    const done = new Set(resumeStateEarly.completed);
    pages = pages.filter((p) => !done.has(p.relativePath));
  }

  if (typeof input.limit === "number" && input.limit > 0) {
    pages = pages.slice(0, input.limit);
  }

  if (pages.length === 0) {
    return result;
  }

  // Fail-closed: the only path that produces `action: "skipped"`. It counts
  // `result.skipped` here and returns early, so the per-page worker below never
  // has to emit (or tally) a skipped entry.
  if (!credentialAvailable && input.providerFactory === undefined) {
    for (const page of pages) {
      result.pages.push({
        path: page.relativePath,
        action: "skipped",
        reason: `no credential for provider "${provider}" (set its API key env var or enter it in keryx shell)`,
      });
      result.skipped += 1;
    }
    return result;
  }

  const systemPrompt = await loadSystemPrompt(input.cwd);
  const total = pages.length;
  const onPage = input.onPage ?? defaultEnrichProgress;

  // Ordered results matching input page order (parallel workers write by index).
  //
  // NFR-4/AC1 isolation point: when `wikiConfig.rlm.enabled` is false (the
  // default, and the behavior when `wiki.config.json` is absent), the `if`
  // branch immediately below is the COMPLETE, UNMODIFIED per-page pipeline
  // that existed before flow 169 T7 — same calls, same order, zero new
  // branches evaluated inside it. Every new classify/staleness/deep/batch
  // code path lives ONLY in `runRlmPipeline` (defined below, after
  // `wikiEnrich`), reached exclusively through the `else`.
  let pageResults: WikiEnrichPageResult[];
  if (!wikiConfig.rlm.enabled) {
    pageResults = await mapPool(pages, concurrency, async (page, i) => {
    const index = i + 1;
    const status = page.status ?? "draft";
    onPage({ index, total, path: page.relativePath, status, phase: "start" });

    try {
      const originalRaw = await readFile(page.absolutePath, "utf8");
      // Pre-normalize legacy pages (H1 + Version/Type/Status without ---) so the
      // model always sees real YAML frontmatter and validation can stay strict.
      const ensured = ensureWikiFrontmatter(originalRaw, {
        title: page.title,
        pageType: page.pageType,
      });
      const original = ensured.markdown;
      onPage({ index, total, path: page.relativePath, status, phase: "model" });

      const turn = await runModelTurn({
        provider,
        model,
        system: systemPrompt,
        user: buildUserPrompt(page, original, input.prompt),
        maxOutputTokens,
        requestId: `wiki-enrich:${page.relativePath}`,
        env,
        ...(input.fetch ? { fetch: input.fetch } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.providerFactory ? { providerFactory: input.providerFactory } : {}),
      });

      if (turn.error) {
        onPage({ index, total, path: page.relativePath, status, phase: "failed" });
        return {
          path: page.relativePath,
          action: "failed" as const,
          reason: `${turn.error.kind}: ${turn.error.message}`,
        };
      }

      let enriched = turn.text.trim();
      if (enriched.length === 0) {
        onPage({ index, total, path: page.relativePath, status, phase: "failed" });
        return { path: page.relativePath, action: "failed" as const, reason: "empty model response" };
      }

      // Model sometimes returns body-only; re-attach original frontmatter.
      enriched = repairEnrichedFrontmatter(original, enriched);

      if (validate) {
        onPage({ index, total, path: page.relativePath, status, phase: "validate" });
        const structural = validateEnrichedMarkdown(original, enriched);
        if (structural !== null) {
          onPage({ index, total, path: page.relativePath, status, phase: "failed" });
          return { path: page.relativePath, action: "failed" as const, reason: `validation: ${structural}` };
        }
      }

      if (markAccepted) {
        enriched = setFrontmatterStatus(enriched, "accepted");
      }

      if (input.dryRun) {
        onPage({ index, total, path: page.relativePath, status, phase: "done" });
        return {
          path: page.relativePath,
          action: "dry-run" as const,
          bytesBefore: originalRaw.length,
          bytesAfter: enriched.length,
          preview: enriched,
        };
      }

      await writeFile(page.absolutePath, `${enriched.endsWith("\n") ? enriched : `${enriched}\n`}`, "utf8");

      onPage({ index, total, path: page.relativePath, status: markAccepted ? "accepted" : status, phase: "done" });
      return {
        path: page.relativePath,
        action: "enriched" as const,
        bytesBefore: originalRaw.length,
        bytesAfter: enriched.length,
      };
    } catch (cause) {
      onPage({ index, total, path: page.relativePath, status, phase: "failed" });
      return {
        path: page.relativePath,
        action: "failed" as const,
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    }
    });
  } else {
    pageResults = await runRlmPipeline({
      cwd: input.cwd,
      pages,
      wikiConfig,
      systemPrompt,
      provider,
      model,
      maxOutputTokens,
      validate,
      markAccepted,
      concurrency,
      total,
      onPage,
      input,
      env,
    });
  }

  const resumeState = resumeStateEarly ?? loadResumeState(input.cwd);
  const completed = new Set(resumeState.completed);
  // RLM-mode-only (flow 169 T7): merges any new `completedNodeHashes` entries
  // (FR-7 per-page staleness cache) from this run into what was already on
  // disk. On the RLM-off path `entry.nodeHash` is never present on any
  // `pageResults` entry (only `runRlmPipeline` ever sets it), so this map is
  // always identical to what was already stored — a no-op re-write, not a
  // behavior change (AC1).
  const completedNodeHashes: Record<string, string> = { ...(resumeState.completedNodeHashes ?? {}) };

  // `pageResults` used to be only "enriched" | "dry-run" | "failed" (the
  // fail-closed early return above was the only source of "skipped"). The
  // RLM path (T7) can also return per-page "skipped" results (classify skip,
  // staleness-unchanged, deep-budget fallback), so that action is tallied
  // here too.
  for (const entry of pageResults) {
    result.pages.push(entry);
    if (entry.action === "enriched") {
      result.enriched += 1;
      completed.add(entry.path);
      if (entry.nodeHash !== undefined) {
        completedNodeHashes[entry.path] = entry.nodeHash;
      }
    } else if (entry.action === "dry-run") {
      result.dryRun += 1;
    } else if (entry.action === "failed") {
      result.failed += 1;
      resumeState.failed.push({ path: entry.path, reason: entry.reason ?? "failed" });
    } else if (entry.action === "skipped") {
      result.skipped += 1;
    }
  }

  if (input.resume === true || result.enriched > 0) {
    saveResumeState(input.cwd, {
      ...resumeState,
      provider,
      model,
      completed: [...completed],
      ...(Object.keys(completedNodeHashes).length > 0 ? { completedNodeHashes } : {}),
    });
  }

  // Batch-end validation: once for the workspace (links/index), not N× per page.
  if (validate && result.enriched > 0 && !input.dryRun) {
    try {
      const check = await wikiValidate(input.cwd);
      if (!check.ok) {
        const pageIssues = check.issues.filter((issue) =>
          result.pages.some((p) => p.action === "enriched" && issue.page.includes(p.path)),
        );
        console.error(
          `[enrich] wikiValidate: ${check.issues.length} issue(s)` +
            (pageIssues.length > 0 ? ` (${pageIssues.length} on pages just enriched)` : ""),
        );
        for (const issue of check.issues.slice(0, 12)) {
          console.error(`  - ${issue.page}: ${issue.message}`);
        }
      } else {
        console.error("[enrich] wikiValidate: ok");
      }
    } catch (cause) {
      console.error(
        `[enrich] wikiValidate failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
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
    "Current page content (enrich the prose; keep or create YAML frontmatter starting with ---,",
    "including Title and Status; keep the H1 title):",
    "```markdown",
    original.trimEnd(),
    "```",
  ];
  if (extra && extra.trim().length > 0) {
    parts.push("", `Additional instruction: ${extra.trim()}`);
  }
  return parts.join("\n");
}

// ============================================================================
// RLM mode (`rlm.enabled: true`) per-page pipeline — flow 169 T7.
//
// Everything below this line is ONLY reachable via `wikiEnrich`'s
// `else` branch (the `if (!wikiConfig.rlm.enabled)` check above). None of it
// runs, and none of it is imported/evaluated as a new branch, on the
// RLM-off path (NFR-4/AC1).
// ============================================================================

type EnrichOnPage = NonNullable<WikiEnrichInput["onPage"]>;

/** A `light`-tier page prepared for either a single-page or batched call. */
export interface LightBatchItem {
  page: WikiPage;
  /** Frontmatter-normalized current content (same as the RLM-off path's `original`). */
  original: string;
  /** Raw on-disk content, pre-normalization (for `bytesBefore`). */
  originalRaw: string;
  /** This page's key files (`collect.ts`'s `keyFilesForPage`); `[]` for non-`component` pages. */
  keyFiles: string[];
}

/** Shared, per-run context threaded through the RLM pipeline's helper functions. */
interface RlmCtx {
  cwd: string;
  wikiConfig: WikiConfig;
  systemPrompt: string;
  provider: string;
  model: string;
  maxOutputTokens: number;
  validate: boolean;
  markAccepted: boolean;
  total: number;
  onPage: EnrichOnPage;
  input: WikiEnrichInput;
  env: Record<string, string | undefined>;
  graph: GraphData;
  pageIndex: (relativePath: string) => number;
}

interface RunRlmPipelineInput {
  cwd: string;
  pages: WikiPage[];
  wikiConfig: WikiConfig;
  systemPrompt: string;
  provider: string;
  model: string;
  maxOutputTokens: number;
  validate: boolean;
  markAccepted: boolean;
  concurrency: number;
  total: number;
  onPage: EnrichOnPage;
  input: WikiEnrichInput;
  env: Record<string, string | undefined>;
}

interface FinalizeResult {
  content: string;
  structuralError: string | null;
}

/**
 * Shared repair/validate/accept pipeline for RLM-mode `light` and `deep`
 * tiers (flow 169 T7) — the SAME steps the RLM-off path already applies
 * inline (`repairEnrichedFrontmatter` -> `validateEnrichedMarkdown` ->
 * `setFrontmatterStatus`), extracted once so both tiers apply them
 * identically instead of re-deriving the pipeline per tier.
 */
function finalizeEnrichedText(
  original: string,
  rawText: string,
  options: { validate: boolean; markAccepted: boolean },
): FinalizeResult {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return { content: original, structuralError: "empty model response" };
  }
  let content = repairEnrichedFrontmatter(original, trimmed);
  let structuralError: string | null = null;
  if (options.validate) {
    structuralError = validateEnrichedMarkdown(original, content);
  }
  if (structuralError === null && options.markAccepted) {
    content = setFrontmatterStatus(content, "accepted");
  }
  return { content, structuralError };
}

/** Write (or preview) a successfully finalized page and build its `WikiEnrichPageResult`. */
async function finishSuccess(
  ctx: RlmCtx,
  page: WikiPage,
  originalRaw: string,
  content: string,
  keyFiles: readonly string[],
  extra: { tier: "light" | "deep"; deepToolCalls?: number },
): Promise<WikiEnrichPageResult> {
  const index = ctx.pageIndex(page.relativePath);
  const status = page.status ?? "draft";
  // Cache the key-files hash on success only when this page HAS resolvable
  // key files. Grounding note: `collect.ts`'s `keyFilesForPage` returns `[]`
  // for non-`component` pages — hashing an empty list is a CONSTANT value
  // (`computePageNodeHash(cwd, [], graph)` hashes the empty combined
  // string), which would make every such page look "unchanged" forever after
  // its first successful run. Guarding by `keyFiles.length > 0` here (and
  // symmetrically in `runRlmPipeline`'s staleness check below) simply keeps
  // non-component pages outside the FR-7 fast-path instead of silently
  // getting stuck on a meaningless constant hash.
  const nodeHash = keyFiles.length > 0 ? await computePageNodeHash(ctx.cwd, keyFiles, ctx.graph) : undefined;

  if (ctx.input.dryRun) {
    ctx.onPage({ index, total: ctx.total, path: page.relativePath, status, phase: "done" });
    return {
      path: page.relativePath,
      action: "dry-run",
      bytesBefore: originalRaw.length,
      bytesAfter: content.length,
      preview: content,
      tier: extra.tier,
      ...(extra.deepToolCalls !== undefined ? { deepToolCalls: extra.deepToolCalls } : {}),
    };
  }

  await writeFile(page.absolutePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  ctx.onPage({
    index,
    total: ctx.total,
    path: page.relativePath,
    status: ctx.markAccepted ? "accepted" : status,
    phase: "done",
  });
  return {
    path: page.relativePath,
    action: "enriched",
    bytesBefore: originalRaw.length,
    bytesAfter: content.length,
    tier: extra.tier,
    ...(nodeHash !== undefined ? { nodeHash } : {}),
    ...(extra.deepToolCalls !== undefined ? { deepToolCalls: extra.deepToolCalls } : {}),
  };
}

/**
 * Run one `deep`-classified page through `enrichPageDeep` (T6) and finalize
 * its output.
 *
 * Isolation guarantee (flow 169 T10, review finding #2): wraps the whole body
 * in try/catch so any exception — most notably `finishSuccess`'s `writeFile`,
 * which is unguarded at its own call site — degrades to a per-page `"failed"`
 * result instead of escaping to `runRlmPipeline`'s `mapPool` and failing the
 * ENTIRE batch run. `enrichPageDeep` itself already never throws (its own
 * AC5 contract), so this is specifically about everything AROUND that call.
 */
async function runDeepSingle(ctx: RlmCtx, item: LightBatchItem): Promise<WikiEnrichPageResult> {
  const { page, original, originalRaw, keyFiles } = item;
  const index = ctx.pageIndex(page.relativePath);
  const status = page.status ?? "draft";
  ctx.onPage({ index, total: ctx.total, path: page.relativePath, status, phase: "model" });

  try {
    const deepResult = await enrichPageDeep({
      cwd: ctx.cwd,
      page,
      original,
      systemPrompt: ctx.systemPrompt,
      ...(ctx.input.prompt !== undefined ? { extraInstruction: ctx.input.prompt } : {}),
      provider: ctx.provider,
      model: ctx.model,
      maxToolCalls: ctx.wikiConfig.rlm.deep.maxToolCalls,
      maxRuntimeMs: ctx.wikiConfig.rlm.deep.maxRuntimeMs,
      env: ctx.env,
      ...(ctx.input.fetch ? { fetch: ctx.input.fetch } : {}),
      ...(ctx.input.baseUrl !== undefined ? { baseUrl: ctx.input.baseUrl } : {}),
      ...(ctx.input.providerFactory ? { providerFactory: ctx.input.providerFactory } : {}),
    });

    const deepToolCalls = deepResult.toolCalls.length;
    let rawText: string | null = null;
    if ("enriched" in deepResult) {
      rawText = deepResult.enriched;
    } else if (deepResult.partial !== undefined && deepResult.partial.trim().length > 0) {
      rawText = deepResult.partial;
    }

    let content: string | null = null;
    if (rawText !== null) {
      const finalized = finalizeEnrichedText(original, rawText, {
        validate: ctx.validate,
        markAccepted: ctx.markAccepted,
      });
      if (finalized.structuralError === null) {
        content = finalized.content;
      }
    }

    if (content === null) {
      // AC5: a deep child that exhausted its budget (or produced unusable
      // output) must never fail the overall run — fall back to the
      // deterministic template, unmodified, and report this page as "skipped"
      // (not "enriched": nothing meaningfully changed). Deliberately no
      // `nodeHash` is cached here, so a future run gets another attempt once
      // budget/config or the underlying code changes, instead of being stuck
      // on a permanent fallback.
      const reason = "fallback" in deepResult ? deepResult.reason : "deep output failed structural validation";
      ctx.onPage({ index, total: ctx.total, path: page.relativePath, status, phase: "done" });
      return {
        path: page.relativePath,
        action: "skipped",
        reason: `deep enrich fallback: ${reason}`,
        tier: "deep",
        deepToolCalls,
      };
    }

    return await finishSuccess(ctx, page, originalRaw, content, keyFiles, { tier: "deep", deepToolCalls });
  } catch (cause) {
    ctx.onPage({ index, total: ctx.total, path: page.relativePath, status, phase: "failed" });
    return {
      path: page.relativePath,
      action: "failed",
      reason: cause instanceof Error ? cause.message : String(cause),
      tier: "deep",
    };
  }
}

function batchPageStartMarker(relativePath: string): string {
  return `<<<WIKI_PAGE path="${relativePath}">>>`;
}
const BATCH_PAGE_END_MARKER = "<<<END_WIKI_PAGE>>>";

/**
 * Render N `light`-tier pages into ONE user turn (TRD §1.5/AC6). Reuses the
 * same per-page framing `buildUserPrompt` sends for a single page, wrapped
 * per-page in stable start/end markers so the (also-batched) reply can be
 * split back into per-page content deterministically by `parseBatchResponse`.
 * Exported for direct unit testing (AC6).
 */
export function buildBatchUserPrompt(items: readonly LightBatchItem[], extra?: string): string {
  const parts: string[] = [
    `You will enrich ${items.length} wiki pages in ONE response. For EACH page below, return`,
    "its full enriched Markdown (frontmatter + body) wrapped EXACTLY between its start and end",
    "markers, in the SAME order as given, with nothing before the first marker or after the",
    "last one.",
    "",
  ];
  for (const item of items) {
    parts.push(
      batchPageStartMarker(item.page.relativePath),
      `Wiki page type: ${item.page.pageType}`,
      `Title: ${item.page.title}`,
      `Summary: ${item.page.summary || "(none)"}`,
      "```markdown",
      item.original.trimEnd(),
      "```",
      BATCH_PAGE_END_MARKER,
      "",
    );
  }
  if (extra !== undefined && extra.trim().length > 0) {
    parts.push(`Additional instruction: ${extra.trim()}`);
  }
  return parts.join("\n");
}

/** Split a batched reply back into per-page raw text, keyed by `relativePath`. */
export function parseBatchResponse(text: string, relativePaths: readonly string[]): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const relativePath of relativePaths) {
    const start = batchPageStartMarker(relativePath);
    const startIndex = text.indexOf(start);
    if (startIndex < 0) {
      continue;
    }
    const afterStart = startIndex + start.length;
    const endIndex = text.indexOf(BATCH_PAGE_END_MARKER, afterStart);
    const chunk = endIndex >= 0 ? text.slice(afterStart, endIndex) : text.slice(afterStart);
    byPath.set(relativePath, chunk.trim());
  }
  return byPath;
}

/**
 * Grouping key for `light`-tier batching (TRD §1.5, "sibling pages of the
 * same module"). Grounding note: `computeModuleKeyFiles` maps exactly ONE
 * wiki `component` page per module (flow 169 T2/T5 finding — a page IS a
 * module), so literal "same module" grouping among `component` pages is
 * never non-trivial (no two component pages ever share a module). This
 * approximates the same batching intent — group pages that live in the same
 * area of the codebase — by the first two path segments of the page's
 * primary key file (e.g. `src/wiki`); pages with no key files (non-
 * `component` types) group by `pageType` instead. Pure and deterministic.
 * Documented here as the implementer's call, same category as the flow's
 * other deferred-baseline decisions (risk log: "Numeric classification
 * thresholds... implementer must pick defaults").
 */
export function batchGroupKey(item: LightBatchItem): string {
  const primaryKeyFile = item.keyFiles[0];
  if (primaryKeyFile !== undefined) {
    const dir = primaryKeyFile.split("/").slice(0, -1).join("/");
    const segments = dir.split("/").filter((segment) => segment.length > 0);
    if (segments.length > 0) {
      return segments.slice(0, 2).join("/");
    }
  }
  return item.page.pageType;
}

/**
 * Greedily fill sibling `light` pages into batches bounded by BOTH
 * `maxPagesPerBatch` and a token budget — reusing `repomap.ts`'s
 * greedy-fill pattern (`computeRepomap`, `gdgraph/repomap.ts:144-155`)
 * rather than inventing a new one. Unlike repomap's omission marker,
 * overflow here is NEVER dropped — a page that does not fit closes the
 * current batch and starts a new one (AC6: "split, not truncate"). Pure
 * (no I/O), so it is directly unit-testable without going through a full
 * `wikiEnrich` run.
 */
export function groupLightPagesIntoBatches(
  items: readonly LightBatchItem[],
  batchConfig: { maxPagesPerBatch: number },
  tokenBudget: number,
): LightBatchItem[][] {
  const byKey = new Map<string, LightBatchItem[]>();
  for (const item of items) {
    const key = batchGroupKey(item);
    const list = byKey.get(key);
    if (list) {
      list.push(item);
    } else {
      byKey.set(key, [item]);
    }
  }

  const batches: LightBatchItem[][] = [];
  for (const group of byKey.values()) {
    let current: LightBatchItem[] = [];
    for (const item of group) {
      const trial = [...current, item];
      const fitsPages = trial.length <= Math.max(1, batchConfig.maxPagesPerBatch);
      const fitsTokens = estimateTokens(buildBatchUserPrompt(trial)) <= tokenBudget;
      if (current.length > 0 && (!fitsPages || !fitsTokens)) {
        batches.push(current);
        current = [item];
      } else {
        current = trial;
      }
    }
    if (current.length > 0) {
      batches.push(current);
    }
  }
  return batches;
}

/**
 * Run one `light`-tier unit — a single page (batching disabled, or a lone
 * page in its group) or a batch of sibling pages sharing one model turn.
 *
 * Isolation guarantee (flow 169 T10, review finding #2): unlike `turn.error`
 * (a NORMALIZED provider error the caller already handles below), a raw
 * exception THROWN out of `runModelTurn` — e.g. `providerFactory` itself
 * throwing, or `port.stream()` throwing mid-iteration, neither of which
 * `runModelTurn` catches — used to have no guard here at all and would
 * escape straight out of this function. It is now caught and degrades to a
 * `"failed"` result for every item in THIS unit (they share one model call,
 * so they legitimately fail together), never propagating further. Each
 * item's OWN `finishSuccess` write is additionally guarded per-item below so
 * one item's write failure cannot also mark an earlier, already-successful
 * item in the same batch as failed.
 */
async function runLightBatch(ctx: RlmCtx, items: readonly LightBatchItem[]): Promise<WikiEnrichPageResult[]> {
  for (const item of items) {
    ctx.onPage({
      index: ctx.pageIndex(item.page.relativePath),
      total: ctx.total,
      path: item.page.relativePath,
      status: item.page.status ?? "draft",
      phase: "model",
    });
  }

  const isBatch = items.length > 1;
  const first = items[0]!;
  const user = isBatch
    ? buildBatchUserPrompt(items, ctx.input.prompt)
    : buildUserPrompt(first.page, first.original, ctx.input.prompt);

  let turn: Awaited<ReturnType<typeof runModelTurn>>;
  try {
    turn = await runModelTurn({
      provider: ctx.provider,
      model: ctx.model,
      system: ctx.systemPrompt,
      user,
      maxOutputTokens: ctx.maxOutputTokens * items.length,
      requestId: `wiki-enrich:${isBatch ? "batch:" : ""}${items.map((item) => item.page.relativePath).join(",")}`,
      env: ctx.env,
      ...(ctx.input.fetch ? { fetch: ctx.input.fetch } : {}),
      ...(ctx.input.baseUrl !== undefined ? { baseUrl: ctx.input.baseUrl } : {}),
      ...(ctx.input.providerFactory ? { providerFactory: ctx.input.providerFactory } : {}),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return items.map((item) => {
      ctx.onPage({
        index: ctx.pageIndex(item.page.relativePath),
        total: ctx.total,
        path: item.page.relativePath,
        status: item.page.status ?? "draft",
        phase: "failed",
      });
      return {
        path: item.page.relativePath,
        action: "failed" as const,
        reason: `provider error: ${reason}`,
        tier: "light" as const,
      };
    });
  }

  if (turn.error) {
    const errorReason = `${turn.error.kind}: ${turn.error.message}`;
    return items.map((item) => {
      ctx.onPage({
        index: ctx.pageIndex(item.page.relativePath),
        total: ctx.total,
        path: item.page.relativePath,
        status: item.page.status ?? "draft",
        phase: "failed",
      });
      return {
        path: item.page.relativePath,
        action: "failed" as const,
        reason: errorReason,
        tier: "light" as const,
      };
    });
  }

  const perPage = isBatch ? parseBatchResponse(turn.text, items.map((item) => item.page.relativePath)) : null;

  const results: WikiEnrichPageResult[] = [];
  for (const item of items) {
    const index = ctx.pageIndex(item.page.relativePath);
    const status = item.page.status ?? "draft";
    const rawText = isBatch ? perPage!.get(item.page.relativePath) : turn.text;

    if (rawText === undefined || rawText.trim().length === 0) {
      ctx.onPage({ index, total: ctx.total, path: item.page.relativePath, status, phase: "failed" });
      results.push({
        path: item.page.relativePath,
        action: "failed",
        reason: isBatch ? "batched response missing this page's content" : "empty model response",
        tier: "light",
      });
      continue;
    }

    const finalized = finalizeEnrichedText(item.original, rawText, {
      validate: ctx.validate,
      markAccepted: ctx.markAccepted,
    });
    if (finalized.structuralError !== null) {
      ctx.onPage({ index, total: ctx.total, path: item.page.relativePath, status, phase: "failed" });
      results.push({
        path: item.page.relativePath,
        action: "failed",
        reason: `validation: ${finalized.structuralError}`,
        tier: "light",
      });
      continue;
    }

    try {
      results.push(
        await finishSuccess(ctx, item.page, item.originalRaw, finalized.content, item.keyFiles, { tier: "light" }),
      );
    } catch (cause) {
      // Per-item guard: `finishSuccess`'s `writeFile` is unguarded at its own
      // call site — a failure for THIS item must not retroactively affect
      // results already pushed for earlier items in the same batch.
      ctx.onPage({ index, total: ctx.total, path: item.page.relativePath, status, phase: "failed" });
      results.push({
        path: item.page.relativePath,
        action: "failed",
        reason: cause instanceof Error ? cause.message : String(cause),
        tier: "light",
      });
    }
  }
  return results;
}

/**
 * The `rlm.enabled: true` per-page pipeline (flow 169 T7): staleness gate
 * first (FR-7, regardless of tier) -> classify (T2) -> skip / light[+batch]
 * / deep (T6) branches. Called ONLY from `wikiEnrich`'s `else` branch — see
 * that call site (search this file for "NFR-4/AC1 isolation point") for the
 * exact off/on split.
 */
async function runRlmPipeline(ctxInput: RunRlmPipelineInput): Promise<WikiEnrichPageResult[]> {
  const { pages, wikiConfig, input } = ctxInput;

  const graph = await loadGraph(ctxInput.cwd);
  const gdgraphConfig = await loadGdgraphConfig(ctxInput.cwd);
  const fileNodes = graph.nodes.filter((node) => node.kind === "file").map((node) => node.path);
  const rankEdges = buildRankEdges(graph, gdgraphConfig);
  const ranked = personalizedPageRank(fileNodes, rankEdges, {
    damping: gdgraphConfig.repomap.damping,
    iterations: gdgraphConfig.repomap.iterations,
    tolerance: gdgraphConfig.repomap.tolerance,
  });
  const pageRankScores = new Map(ranked.map((entry) => [entry.id, entry.score]));
  const fanInByFile = computeGraphFanIn(graph);
  const moduleKeyFilesIndex = computeModuleKeyFiles(graph);
  // Fresh read, independent of the CLI `--resume` flag: `completedNodeHashes`
  // is a separate per-page dedup mechanism (FR-7) from the `--resume`
  // completed-path filter, and must be consulted on every RLM-enabled run
  // regardless of whether `--resume` was passed.
  const resumeState = loadResumeState(ctxInput.cwd);

  const pageIndexMap = new Map(pages.map((page, i) => [page.relativePath, i + 1]));
  const pageIndex = (relativePath: string): number => pageIndexMap.get(relativePath) ?? 0;

  const ctx: RlmCtx = {
    cwd: ctxInput.cwd,
    wikiConfig,
    systemPrompt: ctxInput.systemPrompt,
    provider: ctxInput.provider,
    model: ctxInput.model,
    maxOutputTokens: ctxInput.maxOutputTokens,
    validate: ctxInput.validate,
    markAccepted: ctxInput.markAccepted,
    total: ctxInput.total,
    onPage: ctxInput.onPage,
    input,
    env: ctxInput.env,
    graph,
    pageIndex,
  };

  type Prepared =
    | { kind: "resolved"; result: WikiEnrichPageResult }
    | { kind: "deep"; item: LightBatchItem }
    | { kind: "light"; item: LightBatchItem };

  const prepared: Prepared[] = [];
  for (const page of pages) {
    const index = pageIndex(page.relativePath);
    const status = page.status ?? "draft";
    ctx.onPage({ index, total: ctx.total, path: page.relativePath, status, phase: "start" });
    try {
      const originalRaw = await readFile(page.absolutePath, "utf8");
      const ensured = ensureWikiFrontmatter(originalRaw, { title: page.title, pageType: page.pageType });
      const original = ensured.markdown;
      const keyFiles = keyFilesForPage(moduleKeyFilesIndex, page);

      const previousHash = resumeState.completedNodeHashes?.[page.relativePath];
      let unchanged = false;
      // See `finishSuccess`'s comment: only pages with resolvable key files
      // ever get a meaningful cached hash, so only those are eligible for
      // this FR-7 fast-skip.
      //
      // Correctness-critical (flow 169 T10, review finding #1): ALWAYS
      // recompute and compare the per-page hash here — never trust
      // `previousHash` on `repoMaybeStale === false` alone. `graphMaybeStale`
      // (`gdgraph/staleness.ts`, which `checkPageStalenessGate` wraps)
      // compares `.git/HEAD`'s mtime to the built graph's mtime, and by its
      // OWN doc comment does "NOT fire on every working-tree edit during
      // active development — only after the repo state moved" (checkout /
      // branch-switch / a commit that moves HEAD). Editing a key source file
      // WITHOUT committing or switching branches never touches `.git/HEAD`,
      // so `repoMaybeStale` staying `false` in that case does NOT mean this
      // page's key files are unchanged — it only means the repo hasn't
      // moved. Trusting it to skip this comparison entirely produced false
      // "unchanged" verdicts for exactly that (very common) case, breaking
      // FR-7's actual contract. The per-repo staleness check is a legitimate
      // cheap gate for OTHER things (e.g. deciding whether a graph rebuild is
      // worth it) but was never a valid substitute for this per-page
      // comparison, which is cheap on its own (a handful of file hashes) and
      // always correct.
      if (previousHash !== undefined && keyFiles.length > 0) {
        const currentHash = await computePageNodeHash(ctx.cwd, keyFiles, graph);
        unchanged = isPageUnchangedSinceLastEnrich(page.relativePath, currentHash, resumeState.completedNodeHashes);
      }

      if (unchanged) {
        ctx.onPage({ index, total: ctx.total, path: page.relativePath, status, phase: "done" });
        prepared.push({
          kind: "resolved",
          result: {
            path: page.relativePath,
            action: "skipped",
            reason: "unchanged since last successful enrich (staleness gate)",
          },
        });
        continue;
      }

      const templateBytes = Buffer.byteLength(original, "utf8");
      const signals = computePageGraphSignals(keyFiles, pageRankScores, fanInByFile, templateBytes, false);
      const tier = classifyPage(page, signals, wikiConfig.rlm);

      if (tier === "skip") {
        ctx.onPage({ index, total: ctx.total, path: page.relativePath, status, phase: "done" });
        prepared.push({
          kind: "resolved",
          result: {
            path: page.relativePath,
            action: "skipped",
            reason: "classified skip (template below size threshold)",
            tier: "skip",
          },
        });
        continue;
      }

      const item: LightBatchItem = { page, original, originalRaw, keyFiles };
      prepared.push({ kind: tier === "deep" ? "deep" : "light", item });
    } catch (cause) {
      ctx.onPage({ index, total: ctx.total, path: page.relativePath, status, phase: "failed" });
      prepared.push({
        kind: "resolved",
        result: {
          path: page.relativePath,
          action: "failed",
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      });
    }
  }

  type Unit =
    | { kind: "resolved"; result: WikiEnrichPageResult }
    | { kind: "deep"; item: LightBatchItem }
    | { kind: "lightBatch"; items: LightBatchItem[] };

  const units: Unit[] = [];
  let pendingLight: LightBatchItem[] = [];
  const flushLight = (): void => {
    if (pendingLight.length === 0) {
      return;
    }
    if (wikiConfig.rlm.batch.enabled) {
      for (const batch of groupLightPagesIntoBatches(
        pendingLight,
        wikiConfig.rlm.batch,
        gdgraphConfig.repomap.tokenBudget,
      )) {
        units.push({ kind: "lightBatch", items: batch });
      }
    } else {
      for (const item of pendingLight) {
        units.push({ kind: "lightBatch", items: [item] });
      }
    }
    pendingLight = [];
  };

  for (const entry of prepared) {
    if (entry.kind === "resolved") {
      flushLight();
      units.push(entry);
    } else if (entry.kind === "deep") {
      flushLight();
      units.push(entry);
    } else {
      pendingLight.push(entry.item);
    }
  }
  flushLight();

  const unitResults = await mapPool(units, ctxInput.concurrency, async (unit): Promise<WikiEnrichPageResult[]> => {
    try {
      if (unit.kind === "resolved") {
        return [unit.result];
      }
      if (unit.kind === "deep") {
        return [await runDeepSingle(ctx, unit.item)];
      }
      return await runLightBatch(ctx, unit.items);
    } catch (cause) {
      // Top-level isolation guarantee (flow 169 T10, review finding #2):
      // `runDeepSingle`/`runLightBatch` now guard their own internal
      // model-turn/write failures, but this catch is the final backstop so
      // NO exception from a single unit can ever escape `mapPool`'s
      // `Promise.all` and crash the whole `wikiEnrich()` run — which would
      // also lose every OTHER already-succeeded page's resume progress,
      // since `saveResumeState` only runs after all `pageResults` assemble
      // back in `wikiEnrich`. Mirrors the RLM-off path's per-page try/catch
      // (the `if (!wikiConfig.rlm.enabled)` branch above), which has always
      // had this guarantee.
      const reason = cause instanceof Error ? cause.message : String(cause);
      const items = unit.kind === "deep" ? [unit.item] : unit.kind === "lightBatch" ? unit.items : [];
      return items.map((item) => {
        ctx.onPage({
          index: ctx.pageIndex(item.page.relativePath),
          total: ctx.total,
          path: item.page.relativePath,
          status: item.page.status ?? "draft",
          phase: "failed",
        });
        return {
          path: item.page.relativePath,
          action: "failed" as const,
          reason,
        };
      });
    }
  });

  const flat = unitResults.flat();
  const byPath = new Map(flat.map((entry) => [entry.path, entry]));
  return pages.map((page) => byPath.get(page.relativePath)!);
}
