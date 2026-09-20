import type { NormalizedSearchResult, SearchResponse } from "./types";

export const DUCKDUCKGO_LITE_ORIGIN = "https://lite.duckduckgo.com/lite/";
export const DUCKDUCKGO_MAX_RESULTS = 10;
export const DUCKDUCKGO_HEALTHCHECK_QUERY = "keryx healthcheck";

const ANOMALY_MARKERS = [
  "anomaly-modal",
  "/anomaly.js",
  "Unfortunately, bots use DuckDuckGo too",
] as const;

const MIN_GAP_MS = 500;
const MAX_GAP_MS = 2000;

let lastSearchAt = 0;

export function duckduckgoLiteUrl(query: string): string {
  return `${DUCKDUCKGO_LITE_ORIGIN}?q=${encodeURIComponent(query)}`;
}

export function isDuckDuckGoAnomaly(status: number, body: string): boolean {
  if (status === 202) return true;
  return ANOMALY_MARKERS.some((marker) => body.includes(marker));
}

/** Test seam: consecutive searches in one process otherwise wait 500–2000 ms. */
export function resetDuckDuckGoRateLimitForTests(): void {
  lastSearchAt = 0;
}

export async function maybeDelayDuckDuckGoSearch(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  if (lastSearchAt === 0) {
    lastSearchAt = now;
    return;
  }
  const gap = MIN_GAP_MS + Math.floor(Math.random() * (MAX_GAP_MS - MIN_GAP_MS + 1));
  const wait = gap - (now - lastSearchAt);
  if (wait > 0) await sleep(wait, signal);
  lastSearchAt = Date.now();
}

export type DuckDuckGoParseResult =
  | { kind: "anomaly" }
  | { kind: "ok"; results: readonly { title: string; canonicalUrl: string; snippet: string }[] };

export function parseDuckDuckGoLiteHtml(html: string): DuckDuckGoParseResult {
  if (isDuckDuckGoAnomaly(200, html)) return { kind: "anomaly" };
  const links = collectResultLinks(html);
  const snippets = collectSnippets(html);
  const results: { title: string; canonicalUrl: string; snippet: string }[] = [];
  for (let index = 0; index < links.length && results.length < DUCKDUCKGO_MAX_RESULTS; index += 1) {
    const link = links[index];
    if (link === undefined) continue;
    results.push({
      title: link.title,
      canonicalUrl: link.canonicalUrl,
      snippet: snippets[index] ?? "",
    });
  }
  return { kind: "ok", results };
}

export function duckduckgoSearchResponse(
  query: string,
  html: string,
): { ok: true; value: SearchResponse } | { ok: false; reason: "anomaly" } {
  const parsed = parseDuckDuckGoLiteHtml(html);
  if (parsed.kind === "anomaly") return { ok: false, reason: "anomaly" };
  const rawResultCount = parsed.results.length;
  const results: NormalizedSearchResult[] = parsed.results.map((result) => ({
    title: result.title,
    canonicalUrl: result.canonicalUrl,
    snippet: result.snippet,
    providerId: "duckduckgo",
    provenance: { source: "search-provider", providerId: "duckduckgo", rawResultCount },
  }));
  return { ok: true, value: { query, providerId: "duckduckgo", results } };
}

function collectResultLinks(html: string): { title: string; canonicalUrl: string }[] {
  const links: { title: string; canonicalUrl: string }[] = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchor)) {
    const attrs = match[1] ?? "";
    if (!classList(attrs).includes("result-link")) continue;
    const href = attribute(attrs, "href");
    const canonicalUrl = href === undefined ? undefined : unwrapDuckDuckGoUrl(href);
    const title = visibleText(match[2] ?? "");
    if (!canonicalUrl || !title) continue;
    links.push({ title, canonicalUrl });
  }
  return links;
}

function collectSnippets(html: string): string[] {
  const snippets: string[] = [];
  const cell = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
  for (const match of html.matchAll(cell)) {
    if (!classList(match[1] ?? "").includes("result-snippet")) continue;
    snippets.push(visibleText(match[2] ?? ""));
  }
  return snippets;
}

export function unwrapDuckDuckGoUrl(rawHref: string): string | undefined {
  const href = decodeEntities(rawHref.trim());
  const uddg = href.match(/[?&]uddg=([^&]+)/);
  if (uddg?.[1] !== undefined) {
    try {
      const decoded = decodeURIComponent(uddg[1].replace(/\+/g, "%20"));
      return publicHttpsUrl(decoded);
    } catch {
      return undefined;
    }
  }
  if (href.startsWith("//")) return publicHttpsUrl(`https:${href}`);
  return publicHttpsUrl(href);
}

function publicHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function classList(attrs: string): string[] {
  const value = attribute(attrs, "class");
  return value === undefined ? [] : value.split(/\s+/).filter((part) => part.length > 0);
}

function attribute(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return match?.[2] ?? match?.[3];
}

function visibleText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
