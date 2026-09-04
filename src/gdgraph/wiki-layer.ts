// LWG wiki layer builder (flow 223, phase 0).
//
// Turns wiki pages into `WikiPageNode`s and their describe-sets into
// `DescribesEdge`s, written to `storage/wiki-pages.jsonl` /
// `storage/describes.jsonl`. Mirrors the tree-sitter symbol layer: an
// additive pass AFTER the unchanged file-level build, into its own files.
// `nodes.jsonl` and `edges.jsonl` are never touched (flow 223 AC13) —
// see the "why a separate layer" note in `types.ts` for the regression that
// forced this.
//
// Also writes `storage/build-manifest.json` (LWG-2): a `FileFingerprint` per
// source file, for the incremental rebuild in phase 4. Free of extra I/O
// because `buildGraph` already holds every file's content in memory.

import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectPages } from "../wiki/collect";
import { computeModuleKeyFiles } from "../wiki/collect";
import { resolveDescribeSet } from "../wiki/describes";
import type { DescribesEdge, FileFingerprint, GraphData, WikiLayer, WikiPageNode } from "./types";

export const WIKI_PAGES_FILE = "wiki-pages.jsonl";
export const DESCRIBES_FILE = "describes.jsonl";
export const BUILD_MANIFEST_FILE = "build-manifest.json";

function storageDir(projectRoot: string): string {
  return path.join(projectRoot, ".metaproject", "data", "gdgraph", "storage");
}

/** Stable id for a page node. */
export function wikiPageId(relativePath: string): string {
  return `wiki:${relativePath}`;
}

export interface BuildWikiLayerInput {
  projectRoot: string;
  graph: GraphData;
  /**
   * The current module set, from `validModuleNames`. `undefined` means the
   * graph has not been built — see {@link buildWikiLayer} for why that is not
   * the same as an empty set.
   */
  validModules: Set<string> | undefined;
  /** Page contents keyed by wiki-relative path. Injected for testability. */
  pageContents: ReadonlyMap<string, string>;
  pages: Array<{
    relativePath: string;
    title: string;
    pageType: string;
    status: string | null;
    version: string | null;
  }>;
}

/**
 * Build the layer in memory. Pure apart from its inputs.
 *
 * **Graph-unavailable posture.** `validModules === undefined` means the graph
 * has not been built yet, and the layer is skipped entirely — an empty layer
 * is emitted, not a layer full of "describes nothing" pages. This inherits
 * the rule `validModuleNames` states in its own doc comment: an empty module
 * set would make every scoped item look orphaned, so callers must read
 * "graph unavailable" as *nothing to say yet*, never as *everything is
 * invalid* (flow 223 AC6).
 */
export function buildWikiLayer(input: BuildWikiLayerInput): WikiLayer {
  if (input.validModules === undefined) {
    return { pages: [], describes: [] };
  }

  // Explicitly `=== "file"`, not `!== "asset"`. The negative form is exactly
  // the over-broad filter that made putting wiki nodes into `nodes.jsonl`
  // dangerous in the first place (see `types.ts`); repeating it here would
  // silently admit any future node kind as a describable target.
  const knownPaths = new Set(
    input.graph.nodes.filter((node) => node.kind === "file").map((node) => node.path),
  );
  const keyFilesIndex = computeModuleKeyFiles(input.graph);

  const pages: WikiPageNode[] = [];
  const describes: DescribesEdge[] = [];

  for (const page of input.pages) {
    const content = input.pageContents.get(page.relativePath) ?? "";
    const resolved = resolveDescribeSet({
      page: { relativePath: page.relativePath },
      content,
      knownPaths,
      keyFilesIndex,
    });

    const id = wikiPageId(page.relativePath);
    pages.push({
      id,
      path: page.relativePath,
      title: page.title,
      pageType: page.pageType,
      status: page.status,
      version: page.version,
      undecidable: resolved.undecidable,
    });

    for (const entry of resolved.entries) {
      for (const target of entry.resolvedPaths) {
        describes.push({
          id: `describes:${describes.length + 1}`,
          from: id,
          to: target,
          pattern: entry.pattern,
          origin: entry.origin,
        });
      }
    }
  }

  pages.sort((a, b) => a.path.localeCompare(b.path));
  describes.sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));
  return { pages, describes };
}

/** Content fingerprints for the incremental rebuild (LWG-2, phase 4 reader). */
export function computeFingerprints(
  fileRecords: ReadonlyArray<{ path: string; content: string }>,
  mtimes: ReadonlyMap<string, number>,
): FileFingerprint[] {
  return fileRecords
    .map((record) => ({
      path: record.path,
      contentHash: createHash("sha256").update(record.content).digest("hex"),
      mtimeMs: mtimes.get(record.path) ?? 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(filePath, rows.length > 0 ? `${body}\n` : "", "utf8");
}

/**
 * Collect pages, build the layer and persist it. Called from `buildGraph`
 * behind a defensive dynamic import, exactly as the symbol layer is: any
 * failure here degrades to "no wiki layer", never to a failed graph build.
 */
export async function enrichBuildWithWikiLayer(input: {
  projectRoot: string;
  graph: GraphData;
  fileRecords: ReadonlyArray<{ path: string; content: string }>;
  /** Injected in tests; defaults to the real `validModuleNames`. */
  validModules?: Set<string> | undefined;
  loadValidModules?: (projectRoot: string) => Promise<Set<string> | undefined>;
}): Promise<WikiLayer> {
  const dir = storageDir(input.projectRoot);
  await mkdir(dir, { recursive: true });

  const mtimes = new Map<string, number>();
  for (const record of input.fileRecords) {
    try {
      const info = await stat(path.join(input.projectRoot, record.path));
      mtimes.set(record.path, info.mtimeMs);
    } catch {
      // A file readable moments ago can be gone by now; a missing mtime is
      // recorded as 0 rather than dropping the fingerprint, so the manifest
      // keeps one row per file it hashed.
    }
  }
  await writeFile(
    path.join(dir, BUILD_MANIFEST_FILE),
    `${JSON.stringify({ version: 1, files: computeFingerprints(input.fileRecords, mtimes) }, null, 2)}\n`,
    "utf8",
  );

  const validModules =
    input.validModules !== undefined
      ? input.validModules
      : await (input.loadValidModules ?? defaultLoadValidModules)(input.projectRoot);

  const wikiPages = await collectPages(input.projectRoot);
  const contents = new Map<string, string>();
  for (const page of wikiPages) {
    try {
      contents.set(page.relativePath, await Bun.file(page.absolutePath).text());
    } catch {
      contents.set(page.relativePath, "");
    }
  }

  const layer = buildWikiLayer({
    projectRoot: input.projectRoot,
    graph: input.graph,
    validModules,
    pageContents: contents,
    pages: wikiPages.map((page) => ({
      relativePath: page.relativePath,
      title: page.title,
      pageType: page.pageType,
      status: page.status,
      version: page.version,
    })),
  });

  await writeJsonl(path.join(dir, WIKI_PAGES_FILE), layer.pages);
  await writeJsonl(path.join(dir, DESCRIBES_FILE), layer.describes);
  return layer;
}

async function defaultLoadValidModules(projectRoot: string): Promise<Set<string> | undefined> {
  // Dynamic so `gdgraph` keeps no static dependency on `wiki/service`, which
  // reads the graph itself — the same cycle-avoidance the symbol layer uses.
  const { validModuleNames } = await import("../wiki/service");
  return validModuleNames(projectRoot);
}
