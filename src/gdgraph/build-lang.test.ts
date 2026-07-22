// gdgraph Java/Python import-resolution tests (flow 002 — TDD red phase).
//
// These tests are written BEFORE implementation. Everything except the TS/JS
// byte-identical regression guard (test 3) is expected to FAIL against the
// current code and must go green only once the Java/Python resolvers, the
// metric fix, and the parser helpers land.
//
// Conventions mirror build.test.ts exactly: tmpdir() fixtures, reset(root),
// buildGraph(root), loadGraph(root). JS/TS fixtures that must not be
// pre-resolved by the Bun transpiler use the importLine() helper.
//
// ---------------------------------------------------------------------------
// PARSER CONTRACT the implementer MUST satisfy (unit tests, test 5)
//
// The implementer MUST export these two functions from `src/gdgraph/` (module
// path is their choice, e.g. `./sourceRoots` or `./build`), with these EXACT
// names and signatures. If a cleaner signature is chosen it must still return
// the repo-relative source roots described here; update the imports below to
// match, but keep the documented behavior.
//
//   parseMavenSourceRoots(pomXml: string): string[]
//     - default (no <build> overrides, single module):
//         ["src/main/java", "src/test/java"]
//     - honors <build><sourceDirectory> / <testSourceDirectory>
//     - multi-module: <modules><module>svc-a</module></modules> unions
//         "svc-a/src/main/java", "svc-a/src/test/java", ...
//
//   parseGradleSourceRoots(buildGradle: string): string[]
//     - Groovy + Kotlin DSL: sourceSets { main { java { srcDirs 'x' } } }
//     - default (no sourceSets block): ["src/main/java", "src/test/java"]
// ---------------------------------------------------------------------------

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildGraph } from "./build";
import { loadGraph } from "./query";
import { uniqueTestRoot } from "../lib/test-tmp";

// Parser API under contract — resolved from ./build at runtime (see PARSER
// CONTRACT above). We load these lazily rather than via a top-level
// `import { parseMavenSourceRoots } from "./build"` on purpose: a missing named
// export would throw at module-load time and take the whole test file down with
// it, including the AC4 byte-identical guard that MUST stay green. With a
// runtime lookup, only the parser unit tests fail (RED) until the implementer
// adds the exports; every other test still runs. If the implementer places
// these functions in a different module, update the specifier below.
type SourceRootParser = (input: string) => string[];

async function loadParser(name: string): Promise<SourceRootParser> {
  const mod = (await import("./build")) as Record<string, unknown>;
  const fn = mod[name];
  if (typeof fn !== "function") {
    throw new Error(
      `Expected ./build to export ${name}(input: string): string[] (see PARSER CONTRACT).`,
    );
  }
  return fn as SourceRootParser;
}

const parseMavenSourceRoots = (pom: string): Promise<string[]> =>
  loadParser("parseMavenSourceRoots").then((fn) => fn(pom));
const parseGradleSourceRoots = (gradle: string): Promise<string[]> =>
  loadParser("parseGradleSourceRoots").then((fn) => fn(gradle));

// ---------------------------------------------------------------------------
// Test 1 — Maven Java build-level resolution (RED now: currently 0 edges)
// AC1 / AC3 / AC8
// ---------------------------------------------------------------------------

test("buildGraph resolves Maven Java FQN imports to files and emits imports edges", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-lang-maven");
  await reset(root);
  const javaRoot = path.join(root, "src", "main", "java", "com", "example", "admin");
  await mkdir(path.join(javaRoot, "dto"), { recursive: true });

  // Minimal pom.xml with default source dirs (no <build> overrides).
  await writeFile(
    path.join(root, "pom.xml"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<project xmlns="http://maven.apache.org/POM/4.0.0">',
      "  <modelVersion>4.0.0</modelVersion>",
      "  <groupId>com.example</groupId>",
      "  <artifactId>admin</artifactId>",
      "  <version>1.0.0</version>",
      "</project>",
      "",
    ].join("\n"),
  );

  await writeFile(
    path.join(javaRoot, "dto", "FixReplicaRequest.java"),
    [
      "package com.example.admin.dto;",
      "public class FixReplicaRequest {}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(javaRoot, "AdminService.java"),
    [
      "package com.example.admin;",
      "import com.example.admin.dto.FixReplicaRequest;",
      "public class AdminService {",
      "  private FixReplicaRequest request;",
      "}",
      "",
    ].join("\n"),
  );

  await buildGraph(root);
  const graph = await loadGraph(root);

  const importEdges = graph.edges.filter((edge) => edge.kind === "imports");
  expect(importEdges.length).toBeGreaterThan(0);

  const specific = graph.edges.find(
    (edge) =>
      edge.from === "src/main/java/com/example/admin/AdminService.java" &&
      edge.to === "src/main/java/com/example/admin/dto/FixReplicaRequest.java" &&
      edge.kind === "imports",
  );
  expect(specific).toBeDefined();
});

// ---------------------------------------------------------------------------
// Test 2 — Python build-level resolution (RED now)
// AC2 / AC8 — absolute + relative + __init__.py packages
// ---------------------------------------------------------------------------

test("buildGraph resolves Python absolute, relative, and __init__.py imports", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-lang-python");
  await reset(root);
  await mkdir(path.join(root, "pkg", "sub"), { recursive: true });

  await writeFile(path.join(root, "pkg", "__init__.py"), "\n");
  await writeFile(path.join(root, "pkg", "mod.py"), "thing = 1\n");
  await writeFile(path.join(root, "pkg", "sub", "__init__.py"), "\n");
  await writeFile(path.join(root, "pkg", "sub", "child.py"), "child = 1\n");

  // consumer.py exercises: absolute import, a relative sibling import, and a
  // relative parent-package import.
  await writeFile(
    path.join(root, "pkg", "consumer.py"),
    [
      "from pkg.mod import thing",
      "from . import mod",
      "from .sub import child",
      "",
      "def use():",
      "    return thing",
      "",
    ].join("\n"),
  );

  await buildGraph(root);
  const graph = await loadGraph(root);

  const importEdges = graph.edges.filter((edge) => edge.kind === "imports");
  expect(importEdges.length).toBeGreaterThan(0);

  // Absolute import resolves to the module file.
  expect(importEdges.some((edge) => edge.to === "pkg/mod.py")).toBe(true);

  // At least one edge resolves to a package __init__.py (either pkg or pkg/sub).
  expect(importEdges.some((edge) => edge.to.endsWith("__init__.py"))).toBe(true);

  // A relative-import edge is produced (exercises the extraction fix that adds
  // the leading-dot Python patterns). `from . import mod` resolves to a module
  // or package inside pkg; assert at least one edge originates from consumer.py
  // and resolves to a sibling within pkg/ that is not the absolute-import path.
  const relativeEdges = importEdges.filter(
    (edge) => edge.from === "pkg/consumer.py",
  );
  expect(relativeEdges.length).toBeGreaterThan(1);
});

// ---------------------------------------------------------------------------
// Test 3 — TS/JS byte-identical regression GUARD (MUST PASS now and forever)
// AC4 — zero behavior change for TS/JS.
//
// The golden strings below were captured from the CURRENT build output on
// 2026-07-10. They encode the invariant that TS/JS nodes.jsonl / edges.jsonl
// output does not change when Java/Python support is added.
//
// !!! NEVER regenerate these goldens to make a diff disappear. If this test
// !!! fails, the TS/JS code path changed and AC4 is violated — fix the code,
// !!! not the golden.
// ---------------------------------------------------------------------------

const GOLDEN_NODES_JSONL =
  `{"id":"src/feature/helper.js","kind":"file","path":"src/feature/helper.js","language":"javascript"}\n` +
  `{"id":"src/feature/index.ts","kind":"file","path":"src/feature/index.ts","language":"typescript"}\n` +
  `{"id":"src/feature/style.css","kind":"asset","path":"src/feature/style.css","language":"asset"}\n` +
  `{"id":"src/feature/value.ts","kind":"file","path":"src/feature/value.ts","language":"typescript"}\n`;

const GOLDEN_EDGES_JSONL =
  `{"id":"edge:1","from":"src/feature/helper.js","to":"src/feature/value.ts","kind":"imports","specifier":"./value"}\n` +
  `{"id":"edge:2","from":"src/feature/index.ts","to":"src/feature/style.css","kind":"asset","specifier":"./style.css"}\n` +
  `{"id":"edge:3","from":"src/feature/index.ts","to":"src/feature/value.ts","kind":"imports","specifier":"./value"}\n`;

test("buildGraph output is byte-identical for a TS/JS-only project (AC4 guard)", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-lang-regression");
  await reset(root);
  await mkdir(path.join(root, "src", "feature"), { recursive: true });

  await writeFile(
    path.join(root, "src", "feature", "index.ts"),
    [
      importLine("{ value } from './value';"),
      importLine("'./style.css';"),
      "export const result = `${value}`;",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(root, "src", "feature", "value.ts"), "export const value = 'ok';\n");
  await writeFile(path.join(root, "src", "feature", "style.css"), ".x { color: red; }\n");
  await writeFile(
    path.join(root, "src", "feature", "helper.js"),
    importLine("{ value } from './value';\nexport const helper = value;\n"),
  );

  await buildGraph(root);

  const storageDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  const nodes = await readFile(path.join(storageDir, "nodes.jsonl"), "utf8");
  const edges = await readFile(path.join(storageDir, "edges.jsonl"), "utf8");

  // Exact byte comparison — any divergence in TS/JS output must fail here.
  expect(nodes).toBe(GOLDEN_NODES_JSONL);
  expect(edges).toBe(GOLDEN_EDGES_JSONL);
});

// ---------------------------------------------------------------------------
// Test 4 — Metric honesty (RED now)
// AC5 — 0 extracted → n/a (never 100%); non-relative unresolved → unresolved edge
// ---------------------------------------------------------------------------

test("summary reports n/a (not 100%) when zero imports are extracted", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-lang-metric-na");
  await reset(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  // A source file with no extractable imports at all.
  await writeFile(path.join(root, "src", "lonely.ts"), "export const x = 1;\n");

  const result = await buildGraph(root);
  const summary = await readFile(result.summaryPath, "utf8");

  expect(summary).not.toContain("Import resolution: 100%");
  expect(summary).toMatch(/Import resolution:\s*n\/a/i);
});

test("non-relative unresolved import is recorded as an unresolved edge, not dropped", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-lang-unresolved");
  await reset(root);
  const javaRoot = path.join(root, "src", "main", "java", "com", "example", "admin");
  await mkdir(javaRoot, { recursive: true });

  await writeFile(
    path.join(root, "pom.xml"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<project xmlns="http://maven.apache.org/POM/4.0.0">',
      "  <modelVersion>4.0.0</modelVersion>",
      "  <groupId>com.example</groupId>",
      "  <artifactId>admin</artifactId>",
      "  <version>1.0.0</version>",
      "</project>",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(javaRoot, "AdminService.java"),
    [
      "package com.example.admin;",
      "import com.external.Nope;",
      "public class AdminService {}",
      "",
    ].join("\n"),
  );

  await buildGraph(root);
  const graph = await loadGraph(root);

  expect(
    graph.edges.some(
      (edge) => edge.kind === "unresolved" && edge.specifier === "com.external.Nope",
    ),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 5 — Parser unit tests (RED now: functions not yet exported)
// AC7 — Maven + Gradle source-root parsing
// ---------------------------------------------------------------------------

test("parseMavenSourceRoots returns default roots for a single-module pom", async () => {
  const pom = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<project xmlns="http://maven.apache.org/POM/4.0.0">',
    "  <modelVersion>4.0.0</modelVersion>",
    "  <groupId>com.example</groupId>",
    "  <artifactId>admin</artifactId>",
    "  <version>1.0.0</version>",
    "</project>",
  ].join("\n");

  const roots = await parseMavenSourceRoots(pom);
  expect(roots).toContain("src/main/java");
  expect(roots).toContain("src/test/java");
});

test("parseMavenSourceRoots honors <build><sourceDirectory> overrides", async () => {
  const pom = [
    '<project xmlns="http://maven.apache.org/POM/4.0.0">',
    "  <build>",
    "    <sourceDirectory>src/main/kotlin</sourceDirectory>",
    "    <testSourceDirectory>src/test/kotlin</testSourceDirectory>",
    "  </build>",
    "</project>",
  ].join("\n");

  const roots = await parseMavenSourceRoots(pom);
  expect(roots).toContain("src/main/kotlin");
  expect(roots).toContain("src/test/kotlin");
});

test("parseMavenSourceRoots unions per-module roots for a multi-module pom", async () => {
  const pom = [
    '<project xmlns="http://maven.apache.org/POM/4.0.0">',
    "  <modules>",
    "    <module>svc-a</module>",
    "    <module>svc-b</module>",
    "  </modules>",
    "</project>",
  ].join("\n");

  const roots = await parseMavenSourceRoots(pom);
  expect(roots).toContain("svc-a/src/main/java");
  expect(roots).toContain("svc-a/src/test/java");
  expect(roots).toContain("svc-b/src/main/java");
  expect(roots).toContain("svc-b/src/test/java");
});

test("parseGradleSourceRoots returns default roots when no sourceSets block", async () => {
  const gradle = [
    "plugins {",
    "  id 'java'",
    "}",
    "repositories { mavenCentral() }",
  ].join("\n");

  const roots = await parseGradleSourceRoots(gradle);
  expect(roots).toContain("src/main/java");
  expect(roots).toContain("src/test/java");
});

test("parseGradleSourceRoots reads srcDirs from a Groovy sourceSets block", async () => {
  const gradle = [
    "sourceSets {",
    "  main {",
    "    java {",
    "      srcDirs 'src/main/java', 'generated/java'",
    "    }",
    "  }",
    "}",
  ].join("\n");

  const roots = await parseGradleSourceRoots(gradle);
  expect(roots).toContain("src/main/java");
  expect(roots).toContain("generated/java");
});

test("parseGradleSourceRoots reads srcDirs from a Kotlin DSL sourceSets block", async () => {
  const gradle = [
    "sourceSets {",
    '  main {',
    "    java {",
    '      srcDirs("src/main/java", "build/generated")',
    "    }",
    "  }",
    "}",
  ].join("\n");

  const roots = await parseGradleSourceRoots(gradle);
  expect(roots).toContain("src/main/java");
  expect(roots).toContain("build/generated");
});

async function reset(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
}

function importLine(rest: string): string {
  return `im${"port"} ${rest}`;
}
