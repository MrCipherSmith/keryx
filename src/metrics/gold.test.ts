import { describe, expect, test } from "bun:test";
import {
  buildImportGraph,
  parseImportSpecifiers,
  resolveImportSpecifier,
} from "../../scripts/benchmark/parse-imports";
import {
  type CoChangeCommit,
  type ImportGraph,
  goldAffectedSet,
  goldDependencyClosure,
  goldTestImpact,
  parseGitLogNameOnly,
} from "./gold";

describe("goldAffectedSet", () => {
  test("threshold rule: file above both minSupport and minCoChanges is gold-affected", () => {
    // target = "a.ts" appears in 4 commits. "b.ts" co-changes in 3/4 (support 0.75 >= 0.34,
    // coChanges 3 >= 2) -> gold. "c.ts" co-changes in 1/4 (support 0.25 < 0.34) -> not gold.
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["a.ts", "b.ts"] },
      { sha: "2", files: ["a.ts", "b.ts", "c.ts"] },
      { sha: "3", files: ["a.ts", "b.ts"] },
      { sha: "4", files: ["a.ts", "d.ts"] },
    ];
    const result = goldAffectedSet(history, "a.ts");
    expect(result.commitsWithTarget).toBe(4);
    expect(result.affected).toEqual(["b.ts"]);
    expect(result.support["b.ts"]).toEqual({ coChanges: 3, support: 0.75 });
    expect(result.support["c.ts"]).toEqual({ coChanges: 1, support: 0.25 });
    expect(result.support["d.ts"]).toEqual({ coChanges: 1, support: 0.25 });
  });

  test("minCoChanges floor excludes a file that clears support on a single co-change", () => {
    // target changes twice; "e.ts" co-changes once -> support 0.5 (>= 0.34) but
    // coChanges 1 < minCoChanges 2 -> excluded.
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["a.ts", "e.ts"] },
      { sha: "2", files: ["a.ts"] },
    ];
    const result = goldAffectedSet(history, "a.ts");
    expect(result.affected).toEqual([]);
    expect(result.support["e.ts"]).toEqual({ coChanges: 1, support: 0.5 });
  });

  test("custom thresholds are honored", () => {
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["a.ts", "e.ts"] },
      { sha: "2", files: ["a.ts"] },
    ];
    const result = goldAffectedSet(history, "a.ts", { minCoChanges: 1, minSupport: 0.4 });
    expect(result.affected).toEqual(["e.ts"]);
  });

  test("empty history: no commits, no target evidence -> empty gold set", () => {
    const result = goldAffectedSet([], "a.ts");
    expect(result).toEqual({ affected: [], commitsWithTarget: 0, support: {} });
  });

  test("target with no co-changes: every commit touching target touches only target", () => {
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["a.ts"] },
      { sha: "2", files: ["a.ts"] },
      { sha: "3", files: ["b.ts", "c.ts"] }, // does not touch target, ignored
    ];
    const result = goldAffectedSet(history, "a.ts");
    expect(result.commitsWithTarget).toBe(2);
    expect(result.affected).toEqual([]);
    expect(result.support).toEqual({});
  });

  test("target absent from all commits: commitsWithTarget is 0, gold set is empty", () => {
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["b.ts", "c.ts"] },
      { sha: "2", files: ["b.ts"] },
    ];
    const result = goldAffectedSet(history, "a.ts");
    expect(result).toEqual({ affected: [], commitsWithTarget: 0, support: {} });
  });

  test("duplicate file paths within one commit do not double-count co-changes", () => {
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["a.ts", "b.ts", "b.ts"] },
      { sha: "2", files: ["a.ts", "b.ts"] },
    ];
    const result = goldAffectedSet(history, "a.ts", { minCoChanges: 2, minSupport: 0.5 });
    expect(result.support["b.ts"]).toEqual({ coChanges: 2, support: 1 });
    expect(result.affected).toEqual(["b.ts"]);
  });

  test("result is sorted lexicographically", () => {
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["a.ts", "z.ts", "m.ts"] },
      { sha: "2", files: ["a.ts", "z.ts", "m.ts"] },
    ];
    const result = goldAffectedSet(history, "a.ts", { minCoChanges: 1, minSupport: 0.5 });
    expect(result.affected).toEqual(["m.ts", "z.ts"]);
  });
});

describe("goldDependencyClosure", () => {
  test("linear chain: dependencies and dependents follow the transitive chain in each direction", () => {
    // a -> b -> c -> d. Target b: dependencies = {c, d} (transitive forward), dependents = {a}.
    const graph: ImportGraph = {
      "a.js": ["b.js"],
      "b.js": ["c.js"],
      "c.js": ["d.js"],
      "d.js": [],
    };
    const result = goldDependencyClosure(graph, "b.js");
    expect(result.dependencies).toEqual(["c.js", "d.js"]);
    expect(result.dependents).toEqual(["a.js"]);
    expect(result.affected).toEqual(["a.js", "c.js", "d.js"]);
    expect(result.target).toBe("b.js");
  });

  test("diamond: two independent paths converge without duplicating the shared node", () => {
    // top imports left and right, both of which import bottom.
    const graph: ImportGraph = {
      "top.js": ["left.js", "right.js"],
      "left.js": ["bottom.js"],
      "right.js": ["bottom.js"],
      "bottom.js": [],
    };
    const top = goldDependencyClosure(graph, "top.js");
    expect(top.dependencies).toEqual(["bottom.js", "left.js", "right.js"]);
    expect(top.dependents).toEqual([]);

    const bottom = goldDependencyClosure(graph, "bottom.js");
    expect(bottom.dependencies).toEqual([]);
    // top reaches bottom via two paths but must appear exactly once.
    expect(bottom.dependents).toEqual(["left.js", "right.js", "top.js"]);
    expect(bottom.affected).toEqual(["left.js", "right.js", "top.js"]);
  });

  test("cycle: mutual imports terminate the walk instead of looping, and exclude the target itself", () => {
    // a -> b -> c -> a (cycle). Target a's forward closure reaches b and c but never re-adds a.
    const graph: ImportGraph = {
      "a.js": ["b.js"],
      "b.js": ["c.js"],
      "c.js": ["a.js"],
    };
    const result = goldDependencyClosure(graph, "a.js");
    expect(result.dependencies).toEqual(["b.js", "c.js"]);
    expect(result.dependencies).not.toContain("a.js");
    expect(result.dependents).toEqual(["b.js", "c.js"]);
    expect(result.dependents).not.toContain("a.js");
  });

  test("isolated node: no edges in or out yields empty dependencies, dependents, and affected", () => {
    const graph: ImportGraph = {
      "lonely.js": [],
      "other.js": ["another.js"],
      "another.js": [],
    };
    const result = goldDependencyClosure(graph, "lonely.js");
    expect(result).toEqual({
      target: "lonely.js",
      dependencies: [],
      dependents: [],
      affected: [],
    });
  });

  test("maxDepth bounds the closure independently in each direction", () => {
    const graph: ImportGraph = {
      "a.js": ["b.js"],
      "b.js": ["c.js"],
      "c.js": ["d.js"],
      "d.js": [],
    };
    const result = goldDependencyClosure(graph, "a.js", { maxDepth: 1 });
    expect(result.dependencies).toEqual(["b.js"]);
    expect(result.dependents).toEqual([]);
  });

  test("a file referenced as an edge target with no entry of its own terminates the walk, not an error", () => {
    const graph: ImportGraph = {
      "a.js": ["external-leaf.js"],
    };
    const result = goldDependencyClosure(graph, "a.js");
    expect(result.dependencies).toEqual(["external-leaf.js"]);
    // external-leaf.js has no key in the graph, so its own dependencies are empty, not an error.
    const leaf = goldDependencyClosure(graph, "external-leaf.js");
    expect(leaf.dependencies).toEqual([]);
    expect(leaf.dependents).toEqual(["a.js"]);
  });
});

describe("parseGitLogNameOnly", () => {
  test("parses multiple commits with changed files", () => {
    const output = [
      "commit aaa111",
      "",
      "src/a.ts",
      "src/b.ts",
      "commit bbb222",
      "",
      "src/c.ts",
    ].join("\n");
    expect(parseGitLogNameOnly(output)).toEqual([
      { sha: "aaa111", files: ["src/a.ts", "src/b.ts"] },
      { sha: "bbb222", files: ["src/c.ts"] },
    ]);
  });

  test("a commit with zero changed files still emits an entry with an empty files array", () => {
    const output = ["commit aaa111", "", "commit bbb222", "", "src/c.ts"].join("\n");
    expect(parseGitLogNameOnly(output)).toEqual([
      { sha: "aaa111", files: [] },
      { sha: "bbb222", files: ["src/c.ts"] },
    ]);
  });

  test("empty input yields no commits", () => {
    expect(parseGitLogNameOnly("")).toEqual([]);
  });

  test("blank lines are ignored as separators, not paths", () => {
    const output = "commit aaa111\n\n\nsrc/a.ts\n\n\n";
    expect(parseGitLogNameOnly(output)).toEqual([{ sha: "aaa111", files: ["src/a.ts"] }]);
  });
});

describe("goldTestImpact", () => {
  test("a test covering a changed file is gold-impacted", () => {
    const coverage = {
      "test/a.test.ts": ["src/a.ts", "src/util.ts"],
      "test/b.test.ts": ["src/b.ts"],
    };
    expect(goldTestImpact(coverage, ["src/a.ts"])).toEqual(["test/a.test.ts"]);
  });

  test("multiple impacted tests are returned sorted", () => {
    const coverage = {
      "test/z.test.ts": ["src/a.ts"],
      "test/a.test.ts": ["src/a.ts"],
      "test/unrelated.test.ts": ["src/other.ts"],
    };
    expect(goldTestImpact(coverage, ["src/a.ts"])).toEqual(["test/a.test.ts", "test/z.test.ts"]);
  });

  test("empty coverage map yields no impacted tests", () => {
    expect(goldTestImpact({}, ["src/a.ts"])).toEqual([]);
  });

  test("empty changed-files list yields no impacted tests", () => {
    const coverage = { "test/a.test.ts": ["src/a.ts"] };
    expect(goldTestImpact(coverage, [])).toEqual([]);
  });

  test("a test covering zero files never appears in the result", () => {
    const coverage = { "test/empty.test.ts": [] };
    expect(goldTestImpact(coverage, ["src/a.ts"])).toEqual([]);
  });

  test("duplicate changed-file entries do not change the result", () => {
    const coverage = { "test/a.test.ts": ["src/a.ts"] };
    expect(goldTestImpact(coverage, ["src/a.ts", "src/a.ts"])).toEqual(["test/a.test.ts"]);
  });
});

describe("parseImportSpecifiers", () => {
  test("extracts a require() call", () => {
    const source = `const utils = require('./utils');`;
    expect(parseImportSpecifiers(source)).toEqual([{ specifier: "./utils", kind: "require" }]);
  });

  test("extracts a dynamic import() call", () => {
    const source = `const mod = await import('./lazy-module');`;
    expect(parseImportSpecifiers(source)).toEqual([{ specifier: "./lazy-module", kind: "dynamic-import" }]);
  });

  test("extracts a static import ... from '...' with named bindings", () => {
    const source = `import { Router } from './router';`;
    expect(parseImportSpecifiers(source)).toEqual([{ specifier: "./router", kind: "import" }]);
  });

  test("extracts a default import and a namespace import", () => {
    const source = [`import App from './app';`, `import * as utils from '../utils';`].join("\n");
    expect(parseImportSpecifiers(source)).toEqual([
      { specifier: "./app", kind: "import" },
      { specifier: "../utils", kind: "import" },
    ]);
  });

  test("extracts a bare/package specifier the same as a relative one (resolution decides internal vs external)", () => {
    const source = `const debug = require('debug');`;
    expect(parseImportSpecifiers(source)).toEqual([{ specifier: "debug", kind: "require" }]);
  });

  test("ignores require.resolve and other property access on require", () => {
    // Not a direct call — `require.resolve(...)` calls a different function. The regex only
    // matches `require(<string>)` (word immediately followed by a parenthesized call).
    const source = `const p = require.resolve('./x');`;
    expect(parseImportSpecifiers(source)).toEqual([]);
  });

  test("source with no imports yields an empty list", () => {
    expect(parseImportSpecifiers("const x = 1;\nfunction f() { return x; }")).toEqual([]);
  });

  test("multiple mixed requires and imports in one file are all extracted", () => {
    const source = [
      `const a = require('./a');`,
      `import { b } from './b';`,
      `const c = require('c-package');`,
    ].join("\n");
    const result = parseImportSpecifiers(source);
    expect(result).toContainEqual({ specifier: "./a", kind: "require" });
    expect(result).toContainEqual({ specifier: "./b", kind: "import" });
    expect(result).toContainEqual({ specifier: "c-package", kind: "require" });
    expect(result).toHaveLength(3);
  });
});

describe("resolveImportSpecifier", () => {
  test("resolves a relative specifier with an explicit .js extension", () => {
    const known = new Set(["lib/application.js", "lib/utils.js"]);
    expect(resolveImportSpecifier("lib/application.js", "./utils.js", known)).toBe("lib/utils.js");
  });

  test("resolves a relative specifier by appending .js when omitted", () => {
    const known = new Set(["lib/application.js", "lib/utils.js"]);
    expect(resolveImportSpecifier("lib/application.js", "./utils", known)).toBe("lib/utils.js");
  });

  test("resolves a directory specifier to its index.js", () => {
    const known = new Set(["lib/application.js", "lib/router/index.js"]);
    expect(resolveImportSpecifier("lib/application.js", "./router", known)).toBe("lib/router/index.js");
  });

  test("resolves a parent-directory (../) specifier", () => {
    const known = new Set(["lib/application.js", "test/support/utils.js"]);
    // fromFile's directory is "test/sub"; "../support/utils" steps up to "test", then into
    // "support/utils" -> "test/support/utils".
    expect(resolveImportSpecifier("test/sub/app.test.js", "../support/utils", known)).toBe("test/support/utils.js");
  });

  test("excludes a bare/package specifier as external", () => {
    const known = new Set(["node_modules/debug/index.js"]);
    expect(resolveImportSpecifier("lib/application.js", "debug", known)).toBeNull();
  });

  test("excludes a node:-prefixed builtin as external", () => {
    const known = new Set<string>();
    expect(resolveImportSpecifier("lib/application.js", "node:fs", known)).toBeNull();
  });

  test("returns null when no candidate exists in the known-files set", () => {
    const known = new Set(["lib/application.js"]);
    expect(resolveImportSpecifier("lib/application.js", "./missing", known)).toBeNull();
  });

  test("returns null for a specifier that escapes the repo root", () => {
    const known = new Set(["outside.js"]);
    expect(resolveImportSpecifier("lib/application.js", "../../outside", known)).toBeNull();
  });
});

describe("buildImportGraph", () => {
  test("builds a graph from an in-memory source corpus, resolving relatives and dropping externals", () => {
    const sources = {
      "lib/application.js": [`const utils = require('./utils');`, `const debug = require('debug');`].join("\n"),
      "lib/utils.js": `module.exports = {};`,
    };
    const graph = buildImportGraph(sources);
    expect(graph).toEqual({
      "lib/application.js": ["lib/utils.js"],
      "lib/utils.js": [],
    });
  });

  test("the built graph feeds goldDependencyClosure directly", () => {
    const sources = {
      "a.js": `require('./b');`,
      "b.js": `require('./c');`,
      "c.js": `module.exports = {};`,
    };
    const graph = buildImportGraph(sources);
    const result = goldDependencyClosure(graph, "a.js");
    expect(result.dependencies).toEqual(["b.js", "c.js"]);
  });

  test("a self-reference (require of one's own path) is excluded from its own edge list", () => {
    const sources = {
      "a.js": [`require('./a');`, `require('./b');`].join("\n"),
      "b.js": `module.exports = {};`,
    };
    const graph = buildImportGraph(sources);
    expect(graph["a.js"]).toEqual(["b.js"]);
  });
});
