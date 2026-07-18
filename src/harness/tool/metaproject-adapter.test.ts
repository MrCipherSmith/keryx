import { expect, test } from "bun:test";
import type { AffectedOptions, AffectedResult } from "../../gdgraph/affected";
import type { GdgraphService } from "../../gdgraph/service";
import type {
  MemoryEntry,
  MemorySearchInput,
  MemorySearchResult,
  MemoryService,
  ScoredEntry,
} from "../../memory/types";
import { createMetaprojectAdapter, type MetaprojectAdapterDeps } from "./metaproject-adapter";

const CWD = "/proj";

/** Minimal MemoryEntry stub for a ScoredEntry hit. */
function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    absolutePath: "/proj/.metaproject/memory/decisions/x.md",
    relativePath: "decisions/x.md",
    type: "decision",
    title: "Offline determinism",
    version: null,
    status: "accepted",
    confidence: "high",
    summary: "Keep the harness core offline and deterministic.",
    details: "",
    tags: [],
    scopes: { module: null, entity: null, files: [], skills: [] },
    created: null,
    updated: null,
    provenance: { source: null, link: null },
    ...overrides,
  };
}

/** Build injectable deps whose factories return fakes and record their calls. */
function fakeDeps(opts: {
  affected?: AffectedResult;
  affectedThrows?: boolean;
  query?: string[] | string[][];
  search?: MemorySearchResult;
}): {
  deps: Partial<MetaprojectAdapterDeps>;
  calls: { affected: Array<[string, string, AffectedOptions | undefined]>; search: MemorySearchInput[] };
} {
  const calls = {
    affected: [] as Array<[string, string, AffectedOptions | undefined]>,
    search: [] as MemorySearchInput[],
  };
  const gdgraph = {
    async build() {
      return { nodes: 0, edges: 0, summaryPath: "" };
    },
    async loadGraph() {
      return { nodes: [], edges: [] };
    },
    async affected(cwd: string, target: string, options?: AffectedOptions) {
      calls.affected.push([cwd, target, options]);
      if (opts.affectedThrows) {
        throw new Error("no graph on disk");
      }
      return (
        opts.affected ?? { target, depth: 1, dependencies: [], dependents: [], ranked: [] }
      );
    },
    async repomap() {
      return { path: "", nodeCount: 0, edgeCount: 0 } as never;
    },
    async query() {
      return opts.query ?? [];
    },
  } satisfies GdgraphService;

  const memory = {
    async create() {
      throw new Error("not used");
    },
    async index() {
      throw new Error("not used");
    },
    async search(input: MemorySearchInput) {
      calls.search.push(input);
      return (
        opts.search ?? {
          schemaVersion: 1,
          query: input.query,
          results: [],
          markdownPath: "",
          jsonPath: "",
        }
      );
    },
    async ingest() {
      throw new Error("not used");
    },
    async supersede() {
      throw new Error("not used");
    },
    async check() {
      throw new Error("not used");
    },
  } satisfies MemoryService;

  return {
    calls,
    deps: { createGdgraphService: () => gdgraph, createMemoryService: () => memory },
  };
}

test("graphAffected delegates to the injected gdgraph fake and maps ranked dependents", async () => {
  const { deps, calls } = fakeDeps({
    affected: {
      target: "src/a.ts",
      depth: 2,
      dependencies: [],
      dependents: ["src/b.ts", "src/c.ts"],
      ranked: [
        { path: "src/b.ts", hop: 1, fanIn: 3 },
        { path: "src/c.ts", hop: 2, fanIn: 1 },
      ],
    },
  });
  const port = createMetaprojectAdapter(CWD, deps);
  const result = await port.graphAffected({ target: "src/a.ts" });

  expect(calls.affected).toHaveLength(1);
  expect(calls.affected[0]?.[0]).toBe(CWD);
  expect(calls.affected[0]?.[1]).toBe("src/a.ts");
  expect(calls.affected[0]?.[2]).toEqual({ ranked: true });
  expect(result.target).toBe("src/a.ts");
  expect(result.depth).toBe(2);
  expect(result.affected).toEqual([
    { id: "src/b.ts", path: "src/b.ts", hop: 1, fanIn: 3 },
    { id: "src/c.ts", path: "src/c.ts", hop: 2, fanIn: 1 },
  ]);
});

test("graphAffected returns a structured error result on a service failure (never throws)", async () => {
  const { deps } = fakeDeps({ affectedThrows: true });
  const port = createMetaprojectAdapter(CWD, deps);
  const result = await port.graphAffected({ target: "src/a.ts" });
  expect(result.affected).toEqual([]);
  expect(result.error).toContain("no graph on disk");
});

test("graphQuery delegates to the fake for orphans and cycles", async () => {
  const orphans = createMetaprojectAdapter(CWD, fakeDeps({ query: ["src/x.ts"] }).deps);
  expect(await orphans.graphQuery({ query: "orphans" })).toEqual({
    query: "orphans",
    orphans: ["src/x.ts"],
  });

  const cycles = createMetaprojectAdapter(CWD, fakeDeps({ query: [["a", "b", "a"]] }).deps);
  expect(await cycles.graphQuery({ query: "cycles" })).toEqual({
    query: "cycles",
    cycles: [["a", "b", "a"]],
  });
});

test("memorySearch delegates to the injected memory fake and maps ranked hits", async () => {
  const scored: ScoredEntry = {
    entry: entry(),
    score: 0.75,
    components: { relevance: 1, recency: 0, confidence: 1, status: 1, scope: 0 },
    reason: "match",
  };
  const { deps, calls } = fakeDeps({
    search: { schemaVersion: 1, query: "offline", results: [scored], markdownPath: "", jsonPath: "" },
  });
  const port = createMetaprojectAdapter(CWD, deps);
  const result = await port.memorySearch({ query: "offline", module: "harness", limit: 5 });

  expect(calls.search).toHaveLength(1);
  expect(calls.search[0]?.cwd).toBe(CWD);
  expect(calls.search[0]?.query).toBe("offline");
  expect(calls.search[0]?.filters).toEqual({ module: "harness", limit: 5 });
  expect(result.filters).toEqual({ module: "harness" });
  expect(result.hits).toEqual([
    {
      path: "decisions/x.md",
      title: "Offline determinism",
      type: "decision",
      status: "accepted",
      score: 0.75,
      excerpt: "Keep the harness core offline and deterministic.",
    },
  ]);
});

test("readWiki rejects a path that escapes the wiki root with a structured error result", async () => {
  const port = createMetaprojectAdapter(CWD, fakeDeps({}).deps);
  const result = await port.readWiki({ path: "../../etc/passwd" });
  expect(result.isError).toBe(true);
  expect(result.content).toBe("");
  expect(result.error).toContain("escapes the wiki root");
});

test("readWiki rejects an absolute path escape", async () => {
  const port = createMetaprojectAdapter(CWD, fakeDeps({}).deps);
  const result = await port.readWiki({ path: "/etc/passwd" });
  expect(result.isError).toBe(true);
});

// --- flow 043: new adapter methods -------------------------------------------

test("testRelated delegates to the injected resolver and sorts the results", async () => {
  const adapter = createMetaprojectAdapter("/proj", {
    findRelatedTests: async (_cwd, _target) => ["b.test.ts", "a.test.ts"],
  });
  const result = await adapter.testRelated?.({ file: "src/a.ts" });
  expect(result?.tests).toEqual(["a.test.ts", "b.test.ts"]);
  expect(result?.error).toBeUndefined();
});

test("testRelated returns a structured error (never throws) when the resolver fails", async () => {
  const adapter = createMetaprojectAdapter("/proj", {
    findRelatedTests: async () => {
      throw new Error("testing boom");
    },
  });
  const result = await adapter.testRelated?.({ file: "src/a.ts" });
  expect(result?.tests).toEqual([]);
  expect(result?.error).toMatch(/testing boom/);
});
