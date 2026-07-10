import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GraphData, GraphEdge, GraphNode } from "./types";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".java", ".py"];
const SOURCE_RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".d.ts", ".java", ".py"];
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

// A per-language import resolver, selected by the importing file's language.
// TS/JS keeps the tsconfig/relative logic; Java/Python get source-layout aware
// resolvers. `candidateBases` receives `fromFile` so language-specific resolvers
// (e.g. Python relative imports) can resolve against the importing file.
type ImportResolver = {
  matchesAlias(specifier: string): boolean;
  candidateBases(specifier: string, fromFile: string): string[];
};

// All resolvers are constructed ONCE per build (source roots parsed once, cached)
// and selected per file by `pickResolver`.
type ResolverSet = {
  tsconfig: ImportResolver;
  java: ImportResolver;
  python: ImportResolver;
};

export async function buildGraph(projectRoot: string): Promise<BuildResult> {
  const collection = await collectSourceFiles(projectRoot);
  const files = collection.files;
  const fileSet = new Set(files);
  const resolvers = await loadResolvers(projectRoot);
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
    const language = getLanguage(file);
    const resolver = pickResolver(resolvers, language);
    // Java/Python imports are always real module references — a non-relative one
    // that fails to resolve must be recorded as `unresolved` (never silently
    // dropped), so the resolution metric is honest. TS/JS keeps the exact
    // original guard (relative + tsconfig alias only) ⇒ byte-identical output.
    const isLanguageAware = language === "java" || language === "python";
    const specifiers = extractImportSpecifiers(content, language);

    for (const specifier of specifiers) {
      const resolved = resolveImport(projectRoot, file, specifier, fileSet, resolver);
      const asset = resolved ? null : resolveAssetImport(projectRoot, file, specifier, resolver);
      const shouldTrackUnresolved =
        specifier.startsWith(".") || resolver.matchesAlias(specifier) || isLanguageAware;
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

function extractImportSpecifiers(content: string, language: string): string[] {
  // Java/Python are not TS/JS syntax — the tsx transpiler cannot scan them
  // (it throws today, which is why they already reach the fallback). Route them
  // explicitly to the regex fallback that carries the java/python patterns,
  // rather than depending on the transpiler always throwing. TS/JS keep the
  // exact original transpiler-then-fallback path ⇒ byte-identical output.
  if (language === "java" || language === "python") {
    return extractImportSpecifiersFallback(content);
  }
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
  const specifiers = new Set<string>();

  // Remove comments (JavaScript/TypeScript/Java style)
  const withoutLineComments = content.replace(/\/\/.*$/gm, "");
  const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, "");
  // Python-style comments
  const cleaned = withoutBlockComments.replace(/#.*$/gm, "");

  // JavaScript/TypeScript patterns
  const jsPatterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  // Java patterns (import com.example.Class;)
  const javaPatterns = [
    /\bimport\s+(?:static\s+)?([a-zA-Z_][a-zA-Z0-9_\.]*(?:\.\*)?)\s*;/g,
  ];

  // Python patterns (import module, from module import name).
  // - `import` is anchored to statement start so the `import` in
  //   `from . import mod` is not mis-read as importing a module named `mod`.
  // - The relative form (`from . import x`, `from ..a.b import c`) was dropped
  //   before because the module regex required a leading letter; the third
  //   pattern captures the leading-dot forms.
  const pythonPatterns = [
    /^[ \t]*import\s+([a-zA-Z_][a-zA-Z0-9_\.]*)/gm,
    /\bfrom\s+([a-zA-Z_][a-zA-Z0-9_\.]*)\s+import/g,
    /\bfrom\s+(\.+[a-zA-Z0-9_\.]*)\s+import/g,
  ];

  for (const pattern of [...jsPatterns, ...javaPatterns, ...pythonPatterns]) {
    for (const match of cleaned.matchAll(pattern)) {
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
  resolver: ImportResolver,
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
  resolver: ImportResolver,
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
  resolver: ImportResolver,
): string[] {
  const normalizedSpecifier = stripImportSuffix(specifier);
  // Relative specifiers are filesystem-relative for TS/JS, but Python uses
  // dotted-level semantics (`.x`, `..a.b`) — hand those to the Python resolver.
  if (normalizedSpecifier.startsWith(".") && getLanguage(fromFile) !== "python") {
    const fromDir = path.posix.dirname(fromFile);
    return [normalizePath(path.posix.normalize(path.posix.join(fromDir, normalizedSpecifier)))];
  }
  return resolver.candidateBases(normalizedSpecifier, fromFile)
    .map((candidate) => normalizePath(path.relative(projectRoot, path.join(projectRoot, candidate))));
}

function resolveSourceCandidate(base: string, fileSet: Set<string>): string | null {
  const candidates = [
    base,
    ...SOURCE_RESOLUTION_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_RESOLUTION_EXTENSIONS.map((extension) => path.posix.join(base, `index${extension}`)),
    // Python package: `pkg` → `pkg/__init__.py`. Harmless for other languages
    // (never present in their file sets), so TS/JS resolution is unchanged.
    path.posix.join(base, "__init__.py"),
  ];

  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function stripImportSuffix(specifier: string): string {
  const queryIndex = specifier.indexOf("?");
  const hashIndex = specifier.indexOf("#", 1);
  const cutIndex = [queryIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  return cutIndex === undefined ? specifier : specifier.slice(0, cutIndex);
}

// Build every per-language resolver once. Source roots for Java are parsed a
// single time here and captured in the resolver closure (no per-file re-parse).
async function loadResolvers(projectRoot: string): Promise<ResolverSet> {
  const tsconfig = await loadTsconfigResolver(projectRoot);
  const java = await loadJavaResolver(projectRoot);
  const python = loadPythonResolver(projectRoot);
  return { tsconfig, java, python };
}

function pickResolver(resolvers: ResolverSet, language: string): ImportResolver {
  if (language === "java") {
    return resolvers.java;
  }
  if (language === "python") {
    return resolvers.python;
  }
  return resolvers.tsconfig;
}

// Java resolver — maps a fully-qualified name `a.b.C` to `<sourceRoot>/a/b/C`
// (dots→slashes) for each discovered source root; `resolveSourceCandidate`
// appends `.java`. Source roots come from `pom.xml` (Gradle: T5), defaulting to
// the Maven conventions when build config is absent/unparseable.
async function loadJavaResolver(projectRoot: string): Promise<ImportResolver> {
  const roots = await discoverJavaSourceRoots(projectRoot);
  return createJavaResolver(roots);
}

async function discoverJavaSourceRoots(projectRoot: string): Promise<string[]> {
  const pomPath = path.join(projectRoot, "pom.xml");
  if (existsSync(pomPath)) {
    try {
      const roots = parseMavenSourceRoots(await readFile(pomPath, "utf8"));
      if (roots.length > 0) {
        return roots;
      }
    } catch {
      // Unparseable pom ⇒ fall back to conventions.
    }
  }
  for (const gradleName of ["build.gradle", "build.gradle.kts"]) {
    const gradlePath = path.join(projectRoot, gradleName);
    if (existsSync(gradlePath)) {
      try {
        const roots = parseGradleSourceRoots(await readFile(gradlePath, "utf8"));
        if (roots.length > 0) {
          return roots;
        }
      } catch {
        // Unparseable build script ⇒ fall back to conventions.
      }
    }
  }
  return ["src/main/java", "src/test/java"];
}

function createJavaResolver(sourceRoots: string[]): ImportResolver {
  return {
    matchesAlias() {
      return false;
    },
    candidateBases(specifier) {
      // Wildcard `import a.b.*;` is a package reference, not a file — never
      // fabricate a file edge for it (it is tracked as `unresolved` instead).
      if (specifier.endsWith(".*")) {
        return [];
      }
      const relative = specifier.split(".").join("/");
      return sourceRoots.map((root) => normalizePath(path.posix.join(root, relative)));
    },
  };
}

// Python resolver — resolves dotted modules against the project root (and `src/`
// when present), plus relative imports against the importing file's package.
// `resolveSourceCandidate` appends `.py` / `__init__.py`.
function loadPythonResolver(projectRoot: string): ImportResolver {
  const hasSrc = existsSync(path.join(projectRoot, "src"));
  return createPythonResolver(hasSrc);
}

function createPythonResolver(hasSrc: boolean): ImportResolver {
  const roots = hasSrc ? ["", "src"] : [""];
  return {
    matchesAlias() {
      return false;
    },
    candidateBases(specifier, fromFile) {
      if (specifier.startsWith(".")) {
        // Relative import: leading dots = level. 1 dot = the importing file's
        // package; each extra dot walks one package up. The remaining dotted
        // path (if any) is appended as sub-packages.
        const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
        const rest = specifier.slice(dots);
        let baseDir = path.posix.dirname(fromFile);
        for (let level = 1; level < dots; level += 1) {
          baseDir = path.posix.dirname(baseDir);
        }
        const suffix = rest ? rest.split(".").join("/") : "";
        const base = suffix ? path.posix.join(baseDir, suffix) : baseDir;
        return [normalizePath(base)];
      }
      const relative = specifier.split(".").join("/");
      return roots.map((root) =>
        normalizePath(root ? path.posix.join(root, relative) : relative),
      );
    },
  };
}

// Parse Maven source roots from a `pom.xml` string (repo-relative, POSIX).
// - single module: honors `<build><sourceDirectory>` / `<testSourceDirectory>`,
//   defaulting to `src/main/java` / `src/test/java`.
// - multi-module: unions each `<module>`'s conventional roots.
// Lightweight string/regex scan — no XML dependency, graceful on malformed input.
export function parseMavenSourceRoots(pomXml: string): string[] {
  // Always try the Maven conventions — real poms often only reference the source
  // dir via a `${project.build.sourceDirectory}` property inside a plugin config
  // (which resolves to `src/main/java`), so the conventions must be present even
  // when an explicit-looking `<sourceDirectory>` tag exists.
  const roots = new Set<string>(["src/main/java", "src/test/java"]);

  for (const match of pomXml.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
    const moduleDir = match[1]?.trim();
    if (moduleDir && !moduleDir.includes("${")) {
      roots.add(normalizePath(path.posix.join(moduleDir, "src/main/java")));
      roots.add(normalizePath(path.posix.join(moduleDir, "src/test/java")));
    }
  }

  // Union any explicit, literal source-dir overrides. Skip Maven property
  // placeholders (`${...}`) — they cannot be statically resolved to a real path.
  for (const tag of ["sourceDirectory", "testSourceDirectory"]) {
    const pattern = new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`, "g");
    for (const match of pomXml.matchAll(pattern)) {
      const dir = match[1]?.trim();
      if (dir && !dir.includes("${")) {
        roots.add(normalizePath(dir));
      }
    }
  }

  return [...roots];
}

// Parse Gradle source roots from a `build.gradle`/`build.gradle.kts` string.
// Reads `srcDirs` entries from `sourceSets { … { java { srcDirs … } } }` in both
// the Groovy DSL (`srcDirs 'a', 'b'`) and the Kotlin DSL (`srcDirs("a", "b")`).
// Falls back to the Maven-layout conventions when no `srcDirs` are declared.
export function parseGradleSourceRoots(buildGradle: string): string[] {
  const roots = new Set<string>();
  for (const match of buildGradle.matchAll(/srcDirs\s*\(?\s*([^)\n]+)/g)) {
    for (const quoted of (match[1] ?? "").matchAll(/['"]([^'"]+)['"]/g)) {
      const dir = quoted[1]?.trim();
      if (dir) {
        roots.add(normalizePath(dir));
      }
    }
  }
  if (roots.size === 0) {
    roots.add("src/main/java");
    roots.add("src/test/java");
  }
  return [...roots];
}

async function loadTsconfigResolver(projectRoot: string): Promise<ImportResolver> {
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

function createTsconfigResolver(baseUrl: string | null, mappings: PathMapping[]): ImportResolver {
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
  // Resolution is measured over ALL extracted specifiers (resolved + unresolved).
  // Non-relative Java/Python imports that fail to resolve are now recorded as
  // `unresolved` edges (not dropped), so this denominator is honest. When zero
  // imports were extracted the rate is `n/a` — never a false `100%` from `0/0`.
  const importTotal = imports.length + unresolved.length;
  const resolutionDisplay = importTotal > 0
    ? `${Math.round((imports.length / importTotal) * 1000) / 10}%`
    : "n/a";
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
- Unresolved imports: ${unresolved.length}
- Import resolution: ${resolutionDisplay}
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
keryx gdgraph query cycles
keryx gdgraph query orphans
keryx gdgraph affected <file>
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

function getLanguage(file: string): "typescript" | "javascript" | "java" | "python" {
  if (file.endsWith(".ts") || file.endsWith(".tsx")) {
    return "typescript";
  }
  if (file.endsWith(".java")) {
    return "java";
  }
  if (file.endsWith(".py")) {
    return "python";
  }
  return "javascript";
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
