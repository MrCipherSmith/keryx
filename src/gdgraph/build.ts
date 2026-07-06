import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GraphData, GraphEdge, GraphNode } from "./types";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const IGNORE_DIRS = new Set([
  ".git",
  ".metaproject",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

type BuildResult = {
  nodes: number;
  edges: number;
  summaryPath: string;
};

export async function buildGraph(projectRoot: string): Promise<BuildResult> {
  const files = await collectSourceFiles(projectRoot);
  const fileSet = new Set(files);
  const nodes: GraphNode[] = files.map((file) => ({
    id: file,
    kind: "file",
    path: file,
    language: getLanguage(file),
  }));

  const edges: GraphEdge[] = [];
  for (const file of files) {
    const absolutePath = path.join(projectRoot, file);
    const content = await readFile(absolutePath, "utf8");
    const specifiers = extractImportSpecifiers(content);

    for (const specifier of specifiers) {
      const resolved = resolveImport(file, specifier, fileSet);
      if (!resolved && !specifier.startsWith(".")) {
        continue;
      }

      edges.push({
        id: `edge:${edges.length + 1}`,
        from: file,
        to: resolved ?? specifier,
        kind: resolved ? "imports" : "unresolved",
        specifier,
      });
    }
  }

  const graph = { nodes, edges };
  await writeGraph(projectRoot, graph);
  const summaryPath = await writeSummary(projectRoot, graph);

  return {
    nodes: nodes.length,
    edges: edges.length,
    summaryPath,
  };
}

async function collectSourceFiles(projectRoot: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(relativeDir: string): Promise<void> {
    const absoluteDir = path.join(projectRoot, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) {
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
  return result.sort();
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
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.posix.join(base, `index${extension}`)),
  ];

  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
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

async function writeSummary(projectRoot: string, graph: GraphData): Promise<string> {
  const artifactsDir = path.join(projectRoot, ".metaproject", "data", "gdgraph", "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const unresolved = graph.edges.filter((edge) => edge.kind === "unresolved");
  const summaryPath = path.join(artifactsDir, "summary.md");
  const content = `# gdgraph Summary

## Stats

- Files: ${graph.nodes.length}
- Edges: ${graph.edges.length}
- Unresolved relative imports: ${unresolved.length}

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
  for (const node of graph.nodes) {
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

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}
