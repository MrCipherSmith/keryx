import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GraphData, GraphEdge, GraphNode } from "./types";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const SOURCE_RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".d.ts"];
const ASSET_EXTENSIONS = [
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".hbs",
  ".html",
  ".glsl",
  ".md",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
];
const IGNORE_DIRS = new Set([
  ".git",
  ".metaproject",
  "node_modules",
  ".cache",
  ".docusaurus",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  "generated",
  "out",
  "public",
  "storybook-static",
]);

type BuildResult = {
  nodes: number;
  edges: number;
  summaryPath: string;
};

type SourceCollection = {
  files: string[];
  skippedDirectories: string[];
};

type PathMapping = {
  pattern: string;
  targets: string[];
};

type TsconfigResolver = {
  matchesAlias(specifier: string): boolean;
  candidateBases(specifier: string): string[];
};

export async function buildGraph(projectRoot: string): Promise<BuildResult> {
  const collection = await collectSourceFiles(projectRoot);
  const files = collection.files;
  const fileSet = new Set(files);
  const resolver = await loadTsconfigResolver(projectRoot);
  const nodes: GraphNode[] = files.map((file) => ({
    id: file,
    kind: "file",
    path: file,
    language: getLanguage(file),
  }));

  const edges: GraphEdge[] = [];
  const assetNodes = new Map<string, GraphNode>();
  const fileRecords: Array<{ path: string; content: string }> = [];
  for (const file of files) {
    const absolutePath = path.join(projectRoot, file);
    const content = await readFile(absolutePath, "utf8");
    fileRecords.push({ path: file, content });
    const specifiers = extractImportSpecifiers(content);

    for (const specifier of specifiers) {
      const resolved = resolveImport(projectRoot, file, specifier, fileSet, resolver);
      const asset = resolved ? null : resolveAssetImport(projectRoot, file, specifier, resolver);
      const shouldTrackUnresolved = specifier.startsWith(".") || resolver.matchesAlias(specifier);
      if (!resolved && !asset && !shouldTrackUnresolved) {
        continue;
      }
      if (asset && !assetNodes.has(asset)) {
        assetNodes.set(asset, {
          id: asset,
          kind: "asset",
          path: asset,
          language: "asset",
        });
      }

      edges.push({
        id: `edge:${edges.length + 1}`,
        from: file,
        to: resolved ?? asset ?? specifier,
        kind: resolved ? "imports" : asset ? "asset" : "unresolved",
        specifier,
      });
    }
  }

  const graph = { nodes: [...nodes, ...assetNodes.values()].sort((a, b) => a.path.localeCompare(b.path)), edges };
  await writeGraph(projectRoot, graph);
  const summaryPath = await writeSummary(projectRoot, graph, collection);

  // B1: after the UNCHANGED file-level build, optionally enrich with the
  // tree-sitter symbol layer behind the Block 0 capability seam. Loaded
  // DYNAMICALLY + defensively so an environment lacking the seam (e.g. the
  // copied core runner) degrades cleanly to file-level output. When the
  // capability is disabled/unavailable this is a no-op and the four legacy
  // artifacts stay byte-identical (the golden rule, B-1/C0-7/F-3).
  try {
    const { enrichBuildWithSymbols } = await import("./enrich");
    await enrichBuildWithSymbols(projectRoot, fileRecords);
  } catch {
    // Enrichment module or seam unavailable ⇒ file-level graph only.
  }

  return {
    nodes: nodes.length,
    edges: edges.length,
    summaryPath,
  };
}

async function collectSourceFiles(projectRoot: string): Promise<SourceCollection> {
  const result: string[] = [];
  const skippedDirectories: string[] = [];

  async function walk(relativeDir: string): Promise<void> {
    const absoluteDir = path.join(projectRoot, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) {
          skippedDirectories.push(normalizePath(path.posix.join(relativeDir, entry.name)).replace(/^\.\//, ""));
          continue;
        }
        await walk(normalizePath(path.posix.join(relativeDir, entry.name)));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        continue;
      }

      result.push(
        normalizePath(path.posix.join(relativeDir, entry.name)).replace(/^\.\//, ""),
      );
    }
  }

  await walk(".");
  return { files: result.sort(), skippedDirectories: skippedDirectories.sort() };
}

function extractImportSpecifiers(content: string): string[] {
  try {
    const scanner = new Bun.Transpiler({ loader: "tsx" });
    return [...new Set(scanner
      .scanImports(content)
      .map((entry) => entry.path)
      .filter((specifier): specifier is string => typeof specifier === "string" && specifier.length > 0))]
      .sort();
  } catch {
    return extractImportSpecifiersFallback(content);
  }
}

function extractImportSpecifiersFallback(content: string): string[] {
  const withoutComments = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  const specifiers = new Set<string>();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of withoutComments.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) {
        specifiers.add(specifier);
      }
    }
  }

  return [...specifiers].sort();
}

function resolveImport(
  projectRoot: string,
  fromFile: string,
  specifier: string,
  fileSet: Set<string>,
  resolver: TsconfigResolver,
): string | null {
  for (const base of importCandidateBases(projectRoot, fromFile, specifier, resolver)) {
    const resolved = resolveSourceCandidate(base, fileSet);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function resolveAssetImport(
  projectRoot: string,
  fromFile: string,
  specifier: string,
  resolver: TsconfigResolver,
): string | null {
  for (const candidate of importCandidateBases(projectRoot, fromFile, specifier, resolver)) {
    const extension = path.posix.extname(candidate);
    if (ASSET_EXTENSIONS.includes(extension) && existsSync(path.join(projectRoot, candidate))) {
      return candidate;
    }
  }
  return null;
}

function importCandidateBases(
  projectRoot: string,
  fromFile: string,
  specifier: string,
  resolver: TsconfigResolver,
): string[] {
  const normalizedSpecifier = stripImportSuffix(specifier);
  if (normalizedSpecifier.startsWith(".")) {
    const fromDir = path.posix.dirname(fromFile);
    return [normalizePath(path.posix.normalize(path.posix.join(fromDir, normalizedSpecifier)))];
  }
  return resolver.candidateBases(normalizedSpecifier)
    .map((candidate) => normalizePath(path.relative(projectRoot, path.join(projectRoot, candidate))));
}

function resolveSourceCandidate(base: string, fileSet: Set<string>): string | null {
  const candidates = [
    base,
    ...SOURCE_RESOLUTION_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_RESOLUTION_EXTENSIONS.map((extension) => path.posix.join(base, `index${extension}`)),
  ];

  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function stripImportSuffix(specifier: string): string {
  const queryIndex = specifier.indexOf("?");
  const hashIndex = specifier.indexOf("#", 1);
  const cutIndex = [queryIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  return cutIndex === undefined ? specifier : specifier.slice(0, cutIndex);
}

async function loadTsconfigResolver(projectRoot: string): Promise<TsconfigResolver> {
  const empty = createTsconfigResolver(null, []);
  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    return empty;
  }

  try {
    const raw = await readFile(tsconfigPath, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw)) as {
      compilerOptions?: {
        baseUrl?: unknown;
        paths?: unknown;
      };
    };
    const options = parsed.compilerOptions ?? {};
    const baseUrl = typeof options.baseUrl === "string"
      ? normalizePath(path.posix.normalize(options.baseUrl)).replace(/^\.\//, "")
      : null;
    const paths = isRecord(options.paths)
      ? Object.entries(options.paths)
          .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
          .map(([pattern, targets]) => ({
            pattern,
            targets: targets.filter((target): target is string => typeof target === "string"),
          }))
      : [];
    return createTsconfigResolver(baseUrl, paths);
  } catch {
    return empty;
  }
}

function createTsconfigResolver(baseUrl: string | null, mappings: PathMapping[]): TsconfigResolver {
  return {
    matchesAlias(specifier) {
      const normalizedSpecifier = stripImportSuffix(specifier);
      return mappings.some((mapping) => matchPathPattern(mapping.pattern, normalizedSpecifier) !== null);
    },
    candidateBases(specifier) {
      const normalizedSpecifier = stripImportSuffix(specifier);
      const candidates: string[] = [];
      for (const mapping of mappings) {
        const match = matchPathPattern(mapping.pattern, normalizedSpecifier);
        if (match === null) {
          continue;
        }
        for (const target of mapping.targets) {
          candidates.push(applyPathTarget(baseUrl, target, match));
        }
      }
      if (baseUrl !== null) {
        candidates.push(normalizePath(path.posix.join(baseUrl, normalizedSpecifier)));
      }
      return [...new Set(candidates.map((candidate) => candidate.replace(/^\.\//, "")))];
    },
  };
}

function matchPathPattern(pattern: string, specifier: string): string | null {
  const starIndex = pattern.indexOf("*");
  if (starIndex < 0) {
    return pattern === specifier ? "" : null;
  }

  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return null;
  }
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function applyPathTarget(baseUrl: string | null, target: string, wildcard: string): string {
  const replaced = target.includes("*") ? target.replace("*", wildcard) : target;
  return normalizePath(path.posix.normalize(path.posix.join(baseUrl ?? "", replaced)));
}

function stripJsonComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: '"' | "'" | null = null;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      i += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeGraph(projectRoot: string, graph: GraphData): Promise<void> {
  const storageDir = path.join(projectRoot, ".metaproject", "data", "gdgraph", "storage");
  const artifactsDir = path.join(projectRoot, ".metaproject", "data", "gdgraph", "artifacts");
  await mkdir(storageDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  await writeFile(
    path.join(storageDir, "nodes.jsonl"),
    graph.nodes.map((node) => JSON.stringify(node)).join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    path.join(storageDir, "edges.jsonl"),
    graph.edges.map((edge) => JSON.stringify(edge)).join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    path.join(artifactsDir, "module-map.json"),
    JSON.stringify(buildModuleMap(graph), null, 2) + "\n",
    "utf8",
  );
}

async function writeSummary(
  projectRoot: string,
  graph: GraphData,
  collection: SourceCollection,
): Promise<string> {
  const artifactsDir = path.join(projectRoot, ".metaproject", "data", "gdgraph", "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const unresolved = graph.edges.filter((edge) => edge.kind === "unresolved");
  const imports = graph.edges.filter((edge) => edge.kind === "imports");
  const assets = graph.edges.filter((edge) => edge.kind === "asset");
  const codeNodes = graph.nodes.filter((node) => node.kind === "file");
  const assetNodes = graph.nodes.filter((node) => node.kind === "asset");
  const importTotal = imports.length + unresolved.length;
  const resolvedPercent = importTotal > 0
    ? Math.round((imports.length / importTotal) * 1000) / 10
    : 100;
  const moduleRows = Object.entries(buildModuleMap({ nodes: codeNodes, edges: graph.edges }))
    .map(([moduleName, files]) => ({ moduleName, files: files.length }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 20)
    .map((item) => `| ${item.moduleName} | ${item.files} |`)
    .join("\n");
  const unresolvedRows = Object.entries(groupBy(unresolved, (edge) => unresolvedType(edge.specifier)))
    .sort((a, b) => b[1].length - a[1].length)
    .map(([type, items]) => `| ${type} | ${items.length} |`)
    .join("\n");
  const skippedList = collection.skippedDirectories.length > 0
    ? collection.skippedDirectories.slice(0, 30).map((dir) => `- \`${dir}\``).join("\n")
    : "- none";
  const summaryPath = path.join(artifactsDir, "summary.md");
  const content = `# gdgraph Summary

## Stats

- Source files indexed: ${codeNodes.length}
- Imported asset files indexed: ${assetNodes.length}
- Total nodes: ${graph.nodes.length}
- Edges: ${graph.edges.length}
- Import edges: ${imports.length}
- Asset edges: ${assets.length}
- Unresolved relative imports: ${unresolved.length}
- Import resolution: ${resolvedPercent}%
- Skipped generated/static directories: ${collection.skippedDirectories.length}

## Top Modules

| Module | Source Files |
|---|---:|
${moduleRows || "| _none_ | 0 |"}

## Unresolved By Type

| Type | Count |
|---|---:|
${unresolvedRows || "| _none_ | 0 |"}

## Skipped Directories

${skippedList}

## Generated Files

- \`.metaproject/data/gdgraph/storage/nodes.jsonl\`
- \`.metaproject/data/gdgraph/storage/edges.jsonl\`
- \`.metaproject/data/gdgraph/artifacts/module-map.json\`

## Next Commands

\`\`\`bash
gd-metapro gdgraph query cycles
gd-metapro gdgraph query orphans
gd-metapro gdgraph affected <file>
\`\`\`
`;

  await writeFile(summaryPath, content, "utf8");
  return summaryPath;
}

function buildModuleMap(graph: GraphData): Record<string, string[]> {
  const modules: Record<string, string[]> = {};
  for (const node of graph.nodes.filter((item) => item.kind === "file")) {
    const [first, second] = node.path.split("/");
    const moduleName = first === "src" && second ? second : first ?? "root";
    modules[moduleName] ??= [];
    modules[moduleName].push(node.path);
  }
  return modules;
}

function getLanguage(file: string): "typescript" | "javascript" {
  return file.endsWith(".ts") || file.endsWith(".tsx")
    ? "typescript"
    : "javascript";
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Record<string, T[]> {
  const grouped: Record<string, T[]> = {};
  for (const item of items) {
    const key = getKey(item);
    grouped[key] ??= [];
    grouped[key].push(item);
  }
  return grouped;
}

function unresolvedType(specifier: string): string {
  const stripped = stripImportSuffix(specifier);
  const extension = path.posix.extname(stripped);
  if (extension) {
    return extension;
  }
  if (specifier.startsWith(".")) {
    return "relative-code";
  }
  return "package";
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}
