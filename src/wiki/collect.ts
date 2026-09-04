import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import type { GraphData } from "../gdgraph/types";
import { parseProvenance } from "./provenance";
import type { WikiPage, WikiPageType } from "./types";
import { WIKI_PAGE_TYPES } from "./types";

function wikiRootPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "wiki");
}

export async function collectPages(cwd: string): Promise<WikiPage[]> {
  const root = wikiRootPath(cwd);
  const pages: WikiPage[] = [];

  for (const { type, folder } of WIKI_PAGE_TYPES) {
    const dir = path.join(root, folder);
    if (!(await pathExists(dir))) {
      continue;
    }

    for (const entry of await readdir(dir)) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      const absolutePath = path.join(dir, entry);
      const content = await readFile(absolutePath, "utf8");
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
