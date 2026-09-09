import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isNotFound } from "../lib/fs";
import type { GraphData } from "../gdgraph/types";
import { parseProvenance } from "./provenance";
import type { WikiPage, WikiPageType } from "./types";
import { WIKI_PAGE_TYPES } from "./types";

function wikiRootPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "wiki");
}

/**
 * Flow 242 (forgetting), lane C: the wiki store failing to read must not read
 * as "no pages". `code` is always `"store-unreadable"` today — a single
 * member rather than a bare string so a caller can `instanceof` this without
 * string-matching a message, the same shape `ContainedReadError`
 * (`../lib/contained-read.ts`) uses for its own code.
 */
export class WikiCollectionError extends Error {
  readonly code = "store-unreadable" as const;
  constructor(readonly dir: string, message: string) {
    super(message);
    this.name = "WikiCollectionError";
  }
}

/**
 * List every wiki page under `.metaproject/wiki/`.
 *
 * `readdir` failing on a page-type folder used to be swallowed identically
 * whether the folder simply did not exist (ENOENT — a legitimate empty
 * project, or a project that has not authored, say, any `decisions/` pages
 * yet) or the wiki store itself could not be read (EACCES, a stale/corrupt
 * mount, …). Both produced the SAME empty page list, so `keryx wiki sections`
 * and every caller built on it (`wiki status`, `wiki ask`, the section
 * registry, the agent/MCP wiki surface) reported a clean, empty wiki over a
 * store it never actually looked at — exit 0 next to a hard read failure.
 * ENOENT alone is still "no folder of that type" and is skipped; anything
 * else THROWS a `WikiCollectionError` naming the exact directory, so a caller
 * that does not need this distinction still fails loudly instead of silently
 * losing pages, and a caller that does (the section-tombstone registry, the
 * agent-facing `wikiResolve` operation) can catch it and answer
 * `store-unreadable` rather than "found nothing".
 */
export async function collectPages(cwd: string): Promise<WikiPage[]> {
  const root = wikiRootPath(cwd);
  const pages: WikiPage[] = [];

  for (const { type, folder } of WIKI_PAGE_TYPES) {
    const dir = path.join(root, folder);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new WikiCollectionError(
        dir,
        `the wiki store could not be read (${message}). This is not the same as "no pages": ` +
          `${dir} may hold pages that could not be listed.`,
      );
    }

    for (const entry of names) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      const absolutePath = path.join(dir, entry);
      let content: string;
      try {
        content = await readFile(absolutePath, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new WikiCollectionError(
          absolutePath,
          `the wiki store could not be read (${message}). This is not the same as "no pages": ` +
            `${absolutePath} exists but could not be read.`,
        );
      }
      pages.push(
        parsePage(absolutePath, `${folder}/${entry}`, type, content),
      );
    }
  }

  return pages.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function parsePage(
  absolutePath: string,
  relativePath: string,
  pageType: WikiPageType,
  content: string,
): WikiPage {
  const lines = content.split("\n");
  const titleLine = lines.find((line) => line.startsWith("# "));
  const provenance = parseProvenance(content);

  return {
    absolutePath,
    relativePath,
    pageType,
    title: titleLine ? titleLine.slice(2).trim() : relativePath,
    version: field(lines, "Version"),
    type: field(lines, "Type"),
    status: field(lines, "Status"),
    summary: extractSummary(lines),
    verifiedAt: provenance.verifiedAt,
    verifiedScope: provenance.verifiedScope,
    describes: provenance.describes,
    // AFC-06 (flow 234) AC1: same fields `MemoryEntry` carries, read the same
    // way `Status` already is here, so `computeLifecycle` (via
    // `parsePageLifecycle`, `./provenance.ts`) sees a populated page instead
    // of undefined for every field.
    // Both spellings, because the two surfaces disagree and always have:
    // memory frontmatter hyphenates these names, wiki frontmatter does not.
    // An author who copies a working entry from one to the other otherwise
    // gets a field that parses to nothing and a page admitted when the rule
    // says reject it — a silent trap in the direction that releases.
    validFrom: field(lines, "ValidFrom") ?? field(lines, "Valid-From"),
    validTo: field(lines, "ValidTo") ?? field(lines, "Valid-To"),
    supersededBy: field(lines, "SupersededBy") ?? field(lines, "Superseded-By"),
  };
}

function field(lines: string[], name: string): string | null {
  const pattern = new RegExp(`^${name}:\\s*(.+)$`, "i");
  for (const line of lines) {
    const match = line.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * Resolve a wiki `component` page (as `collectPages` emits it — `relativePath`
 * like `components/<slug>.md`) back to the same "key files" list
 * `collectGraphWikiCandidates` (`service.ts:503-510`) renders into that
 * page's "Key files" section: the top 6 files of the page's module, ranked
 * by combined incoming+outgoing (non-`unresolved`) import-edge count.
 *
 * `WikiPage` has no structured key-files field (flow 169 T2 finding,
 * `.metaproject/flows/169-.../journal.md`): `collect.ts`/`service.ts` only
 * render key files into markdown prose today. T5 is the first consumer that
 * needs the paths back programmatically (per-page staleness hashing,
 * `staleness.ts`) — exported here (once, reusable) so later per-page
 * consumers (deep-path context, batching) resolve the SAME key files
 * instead of re-deriving them or parsing rendered markdown.
 *
 * Pure over `GraphData` (no I/O), mirroring `classify.ts`'s
 * `computeGraphFanIn`/`computePageGraphSignals` purity contract.
 *
 * Grouping (`moduleNameFromProjectPath`) and slugging (`slugifyPath`) are
 * duplicated locally rather than imported from `./service`: `service.ts`
 * already imports `collectPages` from this module, so importing back from
 * `./service` would create a collect.ts <-> service.ts cycle. Both helpers
 * are tiny, pure string transforms — keep in sync with `service.ts:1212-1226`
 * if either changes.
 */
export function computeModuleKeyFiles(graph: GraphData): Map<string, string[]> {
  const moduleFiles = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.kind === "asset") {
      continue;
    }
    const moduleName = moduleNameFromPath(node.path);
    const list = moduleFiles.get(moduleName) ?? [];
    list.push(node.path);
    moduleFiles.set(moduleName, list);
  }

  const fileIn = new Map<string, number>();
  const fileOut = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind === "unresolved") {
      continue;
    }
    fileOut.set(edge.from, (fileOut.get(edge.from) ?? 0) + 1);
    fileIn.set(edge.to, (fileIn.get(edge.to) ?? 0) + 1);
  }

  const byPagePath = new Map<string, string[]>();
  for (const [moduleName, files] of moduleFiles) {
    const keyFiles = files
      .map((file) => ({ file, weight: (fileIn.get(file) ?? 0) + (fileOut.get(file) ?? 0) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 6)
      .map((entry) => entry.file);
    byPagePath.set(`components/${slugForModule(moduleName)}.md`, keyFiles);
  }
  return byPagePath;
}

/** Look up a page's key files in a `computeModuleKeyFiles` index. Empty for non-`component` pages (no module key-files concept applies). */
export function keyFilesForPage(
  index: ReadonlyMap<string, string[]>,
  page: Pick<WikiPage, "relativePath">,
): string[] {
  return index.get(page.relativePath) ?? [];
}

// Mirrors `service.ts:1212-1218`'s `moduleNameFromProjectPath` exactly.
function moduleNameFromPath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return "root";
  }
  return parts.slice(0, -1).join("/");
}

// Mirrors `service.ts:1220-1226`'s (private) `slugifyPath` exactly.
function slugForModule(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "root"
  );
}

function extractSummary(lines: string[]): string {
  const start = lines.findIndex((line) => /^##\s+Summary\s*$/i.test(line));
  if (start < 0) {
    return "";
  }

  const collected: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,6}\s/.test(line)) {
      break;
    }
    if (line.trim().length === 0) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }
    collected.push(line.trim());
  }

  const summary = collected.join(" ").trim();
  return summary === "One paragraph summary." ? "" : summary;
}
