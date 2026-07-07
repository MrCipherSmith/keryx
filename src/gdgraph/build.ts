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

export async function buildGraph(projectRoot: string): Promise<BuildResult> {
  const collection = await collectSourceFiles(projectRoot);
  const files = collection.files;
  const fileSet = new Set(files);
  const nodes: GraphNode[] = files.map((file) => ({
    id: file,
    kind: "file",
    path: file,
    language: getLanguage(file),
  }));

  const edges: GraphEdge[] = [];
  const assetNodes = new Map<string, GraphNode>();
  for (const file of files) {
    const absolutePath = path.join(projectRoot, file);
    const content = await readFile(absolutePath, "utf8");
    const specifiers = extractImportSpecifiers(content);

    for (const specifier of specifiers) {
      const resolved = resolveImport(file, specifier, fileSet);
      const asset = resolved ? null : resolveAssetImport(projectRoot, file, specifier);
      if (!resolved && !asset && !specifier.startsWith(".")) {
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
  fromFile: string,
  specifier: string,
  fileSet: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const fromDir = path.posix.dirname(fromFile);
  const base = normalizePath(path.posix.normalize(path.posix.join(fromDir, specifier)));
  const candidates = [
    base,
    ...SOURCE_RESOLUTION_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_RESOLUTION_EXTENSIONS.map((extension) => path.posix.join(base, `index${extension}`)),
  ];

  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function resolveAssetImport(
  projectRoot: string,
  fromFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const normalizedSpecifier = stripImportSuffix(specifier);
  const extension = path.posix.extname(normalizedSpecifier);
  if (!ASSET_EXTENSIONS.includes(extension)) {
    return null;
  }

  const fromDir = path.posix.dirname(fromFile);
  const candidate = normalizePath(path.posix.normalize(path.posix.join(fromDir, normalizedSpecifier)));
  return existsSync(path.join(projectRoot, candidate)) ? candidate : null;
}

function stripImportSuffix(specifier: string): string {
  return specifier.replace(/[?#].*$/, "");
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
