import { readFile } from "node:fs/promises";
import path from "node:path";
import { computeAffected } from "../gdgraph/affected";
import type { GraphData } from "../gdgraph/types";
import { shellQuote } from "../lib/shell-quote";
import { collectEntries } from "../memory/store";
import { relatedByNamingAndDirectory, TEST_FILE_RE, normalizePath } from "../testing/selection";
import { collectPages, computeModuleKeyFiles } from "../wiki/collect";
import { resolveDescribeSet } from "../wiki/describes";
import { moduleNameFromProjectPath } from "../wiki/service";
import { loadPackageGraph, packageGraphDir } from "./layers";

export const LAYERS_BLOCK_VERSION = 1;
export const DEFAULT_LAYERS_BLOCK_MAX_BYTES = 8192;
const MAX_SYMBOLS_PER_FILE = 6;
const MAX_NEIGHBOURS_PER_SYMBOL = 4;
const MAX_REASON_CHARS = 160;
/** The block names the reviewer's files; a slice larger than this lists the first ones and records the rest. */
export const MAX_BLOCK_FILES = 100;

export const LAYERS_BLOCK_SECTIONS = ["affected", "symbols", "relatedTests", "wiki", "memory"] as const;
export type LayersBlockSection = (typeof LAYERS_BLOCK_SECTIONS)[number];

export interface LayersBlockSymbol {
  file: string;
  name: string;
  kind: string;
  line: number;
  callers: string[];
  callees: string[];
}

export interface LayersBlockTruncation {
  section: LayersBlockSection | "files";
  shown: number;
  total: number;
  /** The command that fetches the rest. */
  command: string;
}

/** A section that could not be read: empty because the reader failed, which is not the same as nothing found. */
export interface LayersBlockUnavailable {
  section: "affected" | "wiki" | "memory";
  reason: string;
}

export interface LayersBlock {
  version: typeof LAYERS_BLOCK_VERSION;
  files: string[];
  prHead: string | null;
  graphCommit: string | null;
  maxBytes: number;
  affected: { depth: 1 | 2; files: string[] };
  symbols: LayersBlockSymbol[];
  relatedTests: string[];
  wiki: Array<{ page: string; title: string }>;
  memory: Array<{ path: string; title: string; status: string; module: string }>;
  truncated: LayersBlockTruncation[];
  unavailable: LayersBlockUnavailable[];
}

export interface BuildLayersBlockInput {
  /** The operator's project: wiki and memory are read from its working copy. */
  projectRoot: string;
  packageDir: string;
  /** The reviewer's files, repository-relative. */
  files: readonly string[];
  maxBytes?: number;
  /** Reads one wiki page's text; a test replaces it to fail one page after the collection step has read it. */
  readPage?: (absolutePath: string) => Promise<string>;
}

function sizeOf(block: LayersBlock): number {
  return Buffer.byteLength(JSON.stringify(block), "utf8");
}

function reasonOf(error: unknown): string {
  const first = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "unknown error";
  return first.length > MAX_REASON_CHARS ? `${first.slice(0, MAX_REASON_CHARS)}…` : first;
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

const MAX_NAMED_FAILURES = 3;

function affectedFor(graph: GraphData, files: readonly string[], depth: 1 | 2): { files: string[]; unavailable: string | null } {
  const own = new Set(files);
  const found = new Set<string>();
  const failures: string[] = [];
  for (const file of files) {
    let result;
    try {
      result = computeAffected(graph, file, { depth });
    } catch (error) {
      failures.push(`${file}: ${reasonOf(error)}`);
      continue;
    }
    for (const dependent of result.dependents) if (!own.has(dependent)) found.add(dependent);
  }
  const named = failures.slice(0, MAX_NAMED_FAILURES).join("; ");
  const more = failures.length > MAX_NAMED_FAILURES ? ` (and ${failures.length - MAX_NAMED_FAILURES} more)` : "";
  return {
    files: [...found].sort(),
    unavailable: failures.length === 0 ? null : `not computed for ${failures.length} of ${files.length} file(s) — ${named}${more}`,
  };
}

function symbolsFor(graph: GraphData, files: readonly string[]): LayersBlockSymbol[] {
  const symbols = graph.symbols ?? [];
  if (symbols.length === 0) return [];
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const label = (id: string): string => {
    const symbol = byId.get(id);
    return symbol === undefined ? id : `${symbol.name} (${symbol.path}:${symbol.startLine})`;
  };
  const callers = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();
  for (const edge of graph.calls ?? []) {
    if (edge.kind !== "calls") continue;
    (callers.get(edge.to) ?? callers.set(edge.to, new Set()).get(edge.to)!).add(label(edge.from));
    (callees.get(edge.from) ?? callees.set(edge.from, new Set()).get(edge.from)!).add(label(edge.to));
  }
  const out: LayersBlockSymbol[] = [];
  for (const file of files) {
    const own = symbols
      .filter((symbol) => symbol.path === file)
      .sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name))
      .slice(0, MAX_SYMBOLS_PER_FILE);
    for (const symbol of own) {
      out.push({
        file,
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.startLine,
        callers: [...(callers.get(symbol.id) ?? [])].sort().slice(0, MAX_NEIGHBOURS_PER_SYMBOL),
        callees: [...(callees.get(symbol.id) ?? [])].sort().slice(0, MAX_NEIGHBOURS_PER_SYMBOL),
      });
    }
  }
  return out;
}

function relatedTestsFor(graph: GraphData, files: readonly string[], affected: readonly string[]): string[] {
  const testFiles = graph.nodes.map((node) => node.path).filter((file) => TEST_FILE_RE.test(file));
  const found = new Set<string>();
  for (const file of files) {
    if (TEST_FILE_RE.test(file)) found.add(file);
    else for (const test of relatedByNamingAndDirectory(file, testFiles)) found.add(test);
  }
  for (const dependent of affected) if (TEST_FILE_RE.test(dependent)) found.add(dependent);
  return [...found].sort();
}

interface Read<T> {
  items: T[];
  unavailable: string | null;
}

async function wikiFor(
  projectRoot: string,
  graph: GraphData,
  files: readonly string[],
  readPage: (absolutePath: string) => Promise<string> = (absolutePath) => readFile(absolutePath, "utf8"),
): Promise<Read<{ page: string; title: string }>> {
  let pages;
  try {
    pages = await collectPages(projectRoot);
  } catch (error) {
    return { items: [], unavailable: `the wiki could not be read — ${reasonOf(error)}` };
  }
  const knownPaths = new Set(graph.nodes.map((node) => node.path));
  const keyFilesIndex = computeModuleKeyFiles(graph);
  const wanted = new Set(files);
  const out: Array<{ page: string; title: string }> = [];
  const unreadable: string[] = [];
  for (const page of pages) {
    let content: string;
    try {
      content = await readPage(page.absolutePath);
    } catch {
      unreadable.push(page.relativePath);
      continue;
    }
    const set = resolveDescribeSet({ page, content, knownPaths, keyFilesIndex });
    if (set.paths.some((candidate) => wanted.has(candidate))) out.push({ page: page.relativePath, title: page.title });
  }
  return {
    items: out.sort((a, b) => a.page.localeCompare(b.page)),
    unavailable: unreadable.length === 0 ? null : `${unreadable.length} of ${pages.length} wiki page(s) could not be read — ${unreadable.slice(0, MAX_NAMED_FAILURES).join(", ")}`,
  };
}

function modulesOf(file: string): string[] {
  const parts = file.split("/").filter(Boolean);
  const modules: string[] = [];
  for (let end = parts.length - 1; end >= 1; end -= 1) modules.push(parts.slice(0, end).join("/").toLowerCase());
  modules.push(moduleNameFromProjectPath(file).toLowerCase());
  return unique(modules);
}

async function memoryFor(
  projectRoot: string,
  files: readonly string[],
): Promise<Read<{ path: string; title: string; status: string; module: string }>> {
  let entries;
  try {
    entries = await collectEntries(projectRoot);
  } catch (error) {
    return { items: [], unavailable: `the memory could not be read — ${reasonOf(error)}` };
  }
  const modules = new Set(files.flatMap(modulesOf));
  const wanted = new Set(files);
  const out: Array<{ path: string; title: string; status: string; module: string }> = [];
  for (const entry of entries) {
    if (entry.status === "deprecated" || entry.status === "superseded") continue;
    const module = entry.scopes.module?.toLowerCase() ?? null;
    const byModule = module !== null && modules.has(module);
    const byFile = entry.scopes.files.some((file) => wanted.has(normalizePath(file)));
    if (byModule || byFile) out.push({ path: entry.relativePath, title: entry.title, status: entry.status, module: module ?? "" });
  }
  return { items: out.sort((a, b) => a.path.localeCompare(b.path)), unavailable: null };
}

// eslint-disable-next-line no-control-regex -- the point is to refuse exactly these bytes
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function fetchCommand(section: LayersBlockSection | "files", files: readonly string[], packageDir: string, projectRoot: string): string {
  const first = files[0] ?? "<file>";
  const dataDir = shellQuote(path.relative(projectRoot, packageGraphDir(packageDir)));
  switch (section) {
    case "affected":
      return `keryx gdgraph affected ${shellQuote(first)} --depth 2 --data-dir ${dataDir}`;
    case "symbols":
      return `keryx gdgraph symbol '<name>' --data-dir ${dataDir}`;
    case "relatedTests":
      return `keryx test related ${shellQuote(first)}`;
    case "wiki":
      return `keryx wiki ask ${shellQuote(`what describes ${first}?`)}`;
    case "memory":
      return `keryx memory search ${shellQuote(moduleNameFromProjectPath(first))}`;
    case "files":
      return `keryx review layers block --package ${shellQuote(path.relative(projectRoot, packageDir) || ".")} --files <the rest>`;
  }
}

/**
 * The bounded `layers` block of one reviewer payload: what the graph, the tests,
 * the wiki and the memory know about that reviewer's files.
 *
 * Deterministic for a given package and working copy: every list is sorted, depth 2
 * is used only when the result still fits, and an over-cap block is cut by removing
 * the last item of the longest section (ties in section order) until it fits. Every
 * cut is recorded with the command that fetches the rest.
 */
export async function buildLayersBlock(input: BuildLayersBlockInput): Promise<LayersBlock> {
  const maxBytes = input.maxBytes ?? DEFAULT_LAYERS_BLOCK_MAX_BYTES;
  const allFiles = unique(input.files.map(normalizePath).filter((file) => file.length > 0));
  const unsafe = allFiles.find((file) => CONTROL_CHARACTER.test(file));
  if (unsafe !== undefined) throw new Error(`Refusing to build a layers block: ${JSON.stringify(unsafe)} has a control character in its path.`);
  const files = allFiles.slice(0, MAX_BLOCK_FILES);
  const { graph, layers } = await loadPackageGraph(input.packageDir);

  const base = async (depth: 1 | 2): Promise<LayersBlock> => {
    const affected = affectedFor(graph, files, depth);
    const wiki = await wikiFor(input.projectRoot, graph, files, input.readPage);
    const memory = await memoryFor(input.projectRoot, files);
    const unavailable: LayersBlockUnavailable[] = [];
    if (affected.unavailable !== null) unavailable.push({ section: "affected", reason: affected.unavailable });
    if (wiki.unavailable !== null) unavailable.push({ section: "wiki", reason: wiki.unavailable });
    if (memory.unavailable !== null) unavailable.push({ section: "memory", reason: memory.unavailable });
    return {
      version: LAYERS_BLOCK_VERSION,
      files,
      prHead: layers.prHead,
      graphCommit: layers.graphCommit,
      maxBytes,
      affected: { depth, files: affected.files },
      symbols: symbolsFor(graph, files),
      relatedTests: relatedTestsFor(graph, files, affected.files),
      wiki: wiki.items,
      memory: memory.items,
      truncated: [],
      unavailable,
    };
  };

  let block = await base(1);
  if (sizeOf(block) < maxBytes) {
    const deeper = await base(2);
    if (sizeOf(deeper) <= maxBytes) block = deeper;
  }

  const totals: Record<LayersBlockSection, number> = {
    affected: block.affected.files.length,
    symbols: block.symbols.length,
    relatedTests: block.relatedTests.length,
    wiki: block.wiki.length,
    memory: block.memory.length,
  };
  const lists: Record<LayersBlockSection, unknown[]> = {
    affected: block.affected.files,
    symbols: block.symbols,
    relatedTests: block.relatedTests,
    wiki: block.wiki,
    memory: block.memory,
  };
  const withTruncation = (): LayersBlock => ({
    ...block,
    truncated: [
      ...(allFiles.length > files.length
        ? [{ section: "files" as const, shown: files.length, total: allFiles.length, command: fetchCommand("files", allFiles, input.packageDir, input.projectRoot) }]
        : []),
      ...LAYERS_BLOCK_SECTIONS.filter((section) => lists[section].length < totals[section]).map((section) => ({
        section,
        shown: lists[section].length,
        total: totals[section],
        command: fetchCommand(section, allFiles, input.packageDir, input.projectRoot),
      })),
    ],
  });

  // The truncation record itself costs bytes, so measure with it included. Entries leave one at a time in
  // effect: a batch takes only as many as are certain to be cut anyway (the victim stays the longest list and
  // the block stays over the cap after each), so the result is the one-by-one result at a fraction of the cost.
  for (let size = sizeOf(withTruncation()); size > maxBytes; size = sizeOf(withTruncation())) {
    let victim: LayersBlockSection | null = null;
    for (const section of LAYERS_BLOCK_SECTIONS) {
      if (lists[section].length > 0 && (victim === null || lists[section].length > lists[victim].length)) victim = section;
    }
    if (victim === null) {
      if (files.length === 0) throw new Error(`The layers block needs ${size} bytes with every list empty; maxBytes is ${maxBytes}.`);
      files.pop();
      continue;
    }
    const list = lists[victim];
    const runnerUp = Math.max(0, ...LAYERS_BLOCK_SECTIONS.filter((section) => section !== victim).map((section) => lists[section].length));
    const overshoot = size - maxBytes;
    let removed = 0;
    for (let taken = 0; taken < Math.max(1, list.length - runnerUp) && list.length > 0; taken += 1) {
      const entryBytes = Buffer.byteLength(JSON.stringify(list[list.length - 1]), "utf8");
      if (taken > 0 && removed + entryBytes >= overshoot) break;
      removed += entryBytes + 2;
      list.pop();
    }
  }
  return withTruncation();
}

export function layersBlockLines(block: LayersBlock): string[] {
  const lines = [
    `layers block for ${block.files.join(", ")} (graph@${(block.graphCommit ?? "none").slice(0, 7)})`,
    `  affected (depth ${block.affected.depth}): ${block.affected.files.length}`,
    `  symbols: ${block.symbols.length}`,
    `  related tests: ${block.relatedTests.length}`,
    `  wiki pages: ${block.wiki.length}`,
    `  memory entries: ${block.memory.length}`,
  ];
  for (const gap of block.unavailable) lines.push(`  ${gap.section}: unavailable (${gap.reason})`);
  for (const cut of block.truncated) lines.push(`  truncated ${cut.section}: ${cut.shown}/${cut.total} — ${cut.command}`);
  return lines;
}
