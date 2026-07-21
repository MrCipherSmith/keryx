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
import { defaultModelFor, hasCredential, runModelTurn } from "../harness/provider/single-turn";
import type { ProviderFactory } from "../harness/provider/single-turn";
import { pathExists } from "../lib/fs";
import { envWithSavedApiKeys, loadShellConfig } from "../lib/shell-config";
import { collectPages, wikiValidate } from "./service";
import type { WikiPage } from "./types";

export type { ProviderFactory } from "../harness/provider/single-turn";
export { hasCredential } from "../harness/provider/single-turn";

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
   * Pages skipped without contacting the provider. Today that is only the
   * fail-closed no-credential case, where every selected page is skipped and
   * the run returns early; a normal run leaves this at 0. Pages dropped by
   * `resume` or `limit` are never selected, so they are not counted here.
   */
  skipped: number;
  failed: number;
}

interface ResumeState {
  updatedAt: string;
  provider?: string;
  model?: string;
  completed: string[];
  failed: Array<{ path: string; reason: string }>;
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

function resumeStatePath(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "wiki", "enrich-resume.json");
}

function loadResumeState(cwd: string): ResumeState {
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

function saveResumeState(cwd: string, state: ResumeState): void {
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
  const pageResults = await mapPool(pages, concurrency, async (page, i) => {
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

  const resumeState = resumeStateEarly ?? loadResumeState(input.cwd);
  const completed = new Set(resumeState.completed);

  // `pageResults` is only "enriched" | "dry-run" | "failed" — "skipped" is
  // accounted for in the fail-closed early return above, so a `skipped` branch
  // here would be unreachable (and TS2367 on the narrowed union).
  for (const entry of pageResults) {
    result.pages.push(entry);
    if (entry.action === "enriched") {
      result.enriched += 1;
      completed.add(entry.path);
    } else if (entry.action === "dry-run") {
      result.dryRun += 1;
    } else if (entry.action === "failed") {
      result.failed += 1;
      resumeState.failed.push({ path: entry.path, reason: entry.reason ?? "failed" });
    }
  }

  if (input.resume === true || result.enriched > 0) {
    saveResumeState(input.cwd, {
      ...resumeState,
      provider,
      model,
      completed: [...completed],
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
