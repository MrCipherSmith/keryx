import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import type { AffectedOptions, AffectedResult } from "../../gdgraph/affected";
import type { GdgraphService } from "../../gdgraph/service";
import type { GraphData } from "../../gdgraph/types";
import type {
  MemoryEntry,
  MemorySearchInput,
  MemorySearchResult,
  MemoryService,
  ScoredEntry,
} from "../../memory/types";
import type { FlowService } from "../../flow/types";
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
        }
      );
    },
    async writeReport() {
      throw new Error("not used");
    },
    async ingest() {
      throw new Error("not used");
    },
    async supersede() {
      throw new Error("not used");
    },
    async transition() {
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
    search: { schemaVersion: 1, query: "offline", results: [scored] },
  });
  const port = createMetaprojectAdapter(CWD, deps);
  const result = await port.memorySearch({ query: "offline", module: "harness", limit: 5 });

  expect(calls.search).toHaveLength(1);
  expect(calls.search[0]?.cwd).toBe(CWD);
  expect(calls.search[0]?.query).toBe("offline");
  expect(calls.search[0]?.filters).toMatchObject({ module: "harness", status: "accepted", limit: 5 });
  expect(calls.search[0]?.filters?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(result.filters).toMatchObject({ module: "harness", status: "accepted" });
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

test("memorySearch validates automatic-recall inputs at the port boundary", async () => {
  const { deps, calls } = fakeDeps({});
  const port = createMetaprojectAdapter(CWD, deps);
  for (const input of [
    { query: "" },
    { query: "x".repeat(4097) },
    { query: "x", status: "unknown" },
    { query: "x", status: "draft" },
    { query: "x", class: "unknown" },
    { query: "x", limit: 0 },
  ]) {
    const result = await port.memorySearch(input);
    expect(result.hits).toEqual([]);
    expect(result.error).toBeDefined();
  }
  expect(calls.search).toEqual([]);
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

// --- flow_status: Task Manager flow listing (read-risk alternative to `shell_exec`ing `keryx flow list`) ---

test("flowStatus delegates to the injected flow service and lists all flows", async () => {
  const fakeFlowService = {
    list: async () => [
      { id: "1", status: "in-progress", title: "Do X", tasksDone: 1, tasksTotal: 3, dir: "1-do-x" },
      { id: "2", status: "done", title: "Do Y", tasksDone: 2, tasksTotal: 2, dir: "2-do-y" },
    ],
  } as unknown as FlowService;
  const adapter = createMetaprojectAdapter("/proj", { createFlowService: () => fakeFlowService });

  const all = await adapter.flowStatus?.({});
  expect(all?.flows).toHaveLength(2);
  expect(all?.error).toBeUndefined();
});

test("flowStatus filters to one flow by id", async () => {
  const fakeFlowService = {
    list: async () => [
      { id: "1", status: "in-progress", title: "Do X", tasksDone: 1, tasksTotal: 3, dir: "1-do-x" },
      { id: "2", status: "done", title: "Do Y", tasksDone: 2, tasksTotal: 2, dir: "2-do-y" },
    ],
  } as unknown as FlowService;
  const adapter = createMetaprojectAdapter("/proj", { createFlowService: () => fakeFlowService });

  const filtered = await adapter.flowStatus?.({ id: "2" });
  expect(filtered?.flows).toEqual([
    { id: "2", status: "done", title: "Do Y", tasksDone: 2, tasksTotal: 2, dir: "2-do-y" },
  ]);
});

test("flowStatus returns a structured error (never throws) when the service fails", async () => {
  const fakeFlowService = {
    list: async () => {
      throw new Error("flow boom");
    },
  } as unknown as FlowService;
  const adapter = createMetaprojectAdapter("/proj", { createFlowService: () => fakeFlowService });

  const result = await adapter.flowStatus?.({});
  expect(result?.flows).toEqual([]);
  expect(result?.error).toMatch(/flow boom/);
});

// --- flow 044: batch-2 adapter methods (graph_symbol / repomap / wiki_ask) ----

/** A GdgraphService fake whose loadGraph/repomap are injectable per test. */
function graphDeps(overrides: {
  graph?: GraphData;
  loadThrows?: boolean;
  repomapResult?: RepomapServiceResult;
  repomapThrows?: boolean;
}): Partial<MetaprojectAdapterDeps> {
  const gdgraph = {
    async build() {
      return { nodes: 0, edges: 0, summaryPath: "" };
    },
    async loadGraph() {
      if (overrides.loadThrows) {
        throw new Error("no graph on disk");
      }
      return overrides.graph ?? { nodes: [], edges: [] };
    },
    async affected(_cwd: string, target: string) {
      return { target, depth: 1, dependencies: [], dependents: [], ranked: [] };
    },
    async repomap() {
      if (overrides.repomapThrows) {
        throw new Error("repomap boom");
      }
      return (overrides.repomapResult ?? {
        path: "",
        content: "",
        entries: [],
        tokens: 0,
        omitted: 0,
      }) as never;
    },
    async query() {
      return [];
    },
  } satisfies GdgraphService;
  // repomap now flows through the injectable NON-writing `repomapCompute` (flow 046),
  // not the writing gdgraph.repomap service method.
  const repomapCompute = async () => {
    if (overrides.repomapThrows) {
      throw new Error("repomap boom");
    }
    return (overrides.repomapResult ?? {
      path: "",
      content: "",
      entries: [],
      tokens: 0,
      omitted: 0,
    }) as never;
  };
  return { createGdgraphService: () => gdgraph, repomapCompute };
}

type RepomapServiceResult = {
  path: string;
  content: string;
  entries: Array<{ path: string; score: number; symbols: string[] }>;
  tokens: number;
  omitted: number;
};

test("graphSymbol loads the graph and maps querySymbol definitions/callers/callees", async () => {
  const graph: GraphData = {
    nodes: [{ id: "src/a.ts", kind: "file", path: "src/a.ts", language: "typescript" }],
    edges: [],
    symbols: [
      {
        id: "src/a.ts#foo",
        kind: "function",
        path: "src/a.ts",
        name: "foo",
        container: null,
        startLine: 3,
        endLine: 5,
        language: "typescript",
      },
      {
        id: "src/b.ts#bar",
        kind: "function",
        path: "src/b.ts",
        name: "bar",
        container: null,
        startLine: 1,
        endLine: 2,
        language: "typescript",
      },
    ],
    calls: [{ id: "c1", from: "src/b.ts#bar", to: "src/a.ts#foo", kind: "calls", resolved: true }],
  };
  const adapter = createMetaprojectAdapter(CWD, graphDeps({ graph }));
  const result = await adapter.graphSymbol?.({ name: "foo" });
  expect(result?.definitions).toEqual([
    { id: "src/a.ts#foo", name: "foo", kind: "function", path: "src/a.ts", startLine: 3, container: null },
  ]);
  expect(result?.callers).toEqual(["bar (src/b.ts:1)"]);
  expect(result?.callees).toEqual([]);
  expect(result?.error).toBeUndefined();
});

test("graphSymbol returns a structured error (never throws) when the graph load fails", async () => {
  const adapter = createMetaprojectAdapter(CWD, graphDeps({ loadThrows: true }));
  const result = await adapter.graphSymbol?.({ name: "foo" });
  expect(result?.definitions).toEqual([]);
  expect(result?.error).toContain("no graph on disk");
});

test("repomap delegates to the gdgraph facade and maps ranked entries", async () => {
  const adapter = createMetaprojectAdapter(
    CWD,
    graphDeps({
      repomapResult: {
        path: "/proj/.metaproject/data/gdgraph/artifacts/repomap.md",
        content: "# map",
        entries: [{ path: "src/a.ts", score: 0.5, symbols: ["function foo()"] }],
        tokens: 12,
        omitted: 3,
      },
    }),
  );
  const result = await adapter.repomap?.({ budget: 100 });
  expect(result?.budget).toBe(100);
  expect(result?.files).toEqual([{ path: "src/a.ts", score: 0.5, symbols: ["function foo()"] }]);
  expect(result?.tokens).toBe(12);
  expect(result?.omitted).toBe(3);
  expect(result?.error).toBeUndefined();
});

test("repomap returns a structured error (never throws) when the facade fails", async () => {
  const adapter = createMetaprojectAdapter(CWD, graphDeps({ repomapThrows: true }));
  const result = await adapter.repomap?.({ budget: 50 });
  expect(result?.files).toEqual([]);
  expect(result?.budget).toBe(50);
  expect(result?.error).toContain("repomap boom");
});

test("wikiAsk delegates to the injected resolver and maps citations + answer", async () => {
  const adapter = createMetaprojectAdapter(CWD, {
    wikiAsk: async ({ cwd, question }) => {
      expect(cwd).toBe(CWD);
      return {
        question,
        citations: [{ path: "wiki/arch.md", title: "Arch", excerpt: "e", score: 0.5, source: "wiki" }],
        answerMarkdown: "# Answer",
      };
    },
  });
  const result = await adapter.wikiAsk?.({ question: "why offline" });
  expect(result?.question).toBe("why offline");
  expect(result?.citations).toEqual([
    { path: "wiki/arch.md", title: "Arch", excerpt: "e", score: 0.5, source: "wiki" },
  ]);
  expect(result?.answer).toBe("# Answer");
  expect(result?.error).toBeUndefined();
});

test("wikiAsk returns a structured error (never throws) when the resolver fails", async () => {
  const adapter = createMetaprojectAdapter(CWD, {
    wikiAsk: async () => {
      throw new Error("wiki boom");
    },
  });
  const result = await adapter.wikiAsk?.({ question: "q" });
  expect(result?.citations).toEqual([]);
  expect(result?.answer).toBe("");
  expect(result?.error).toMatch(/wiki boom/);
});

// --- flow 122: wikiBacklinks adapter method (MP-5a) ---------------------------

test("wikiBacklinks delegates to the injected wikiPagesForFile facade and sorts the results", async () => {
  const calls: Array<[string, string]> = [];
  const adapter = createMetaprojectAdapter(CWD, {
    wikiPagesForFile: async (cwd, target) => {
      calls.push([cwd, target]);
      return [".metaproject/wiki/domain/policy.md", ".metaproject/wiki/architecture/harness.md"];
    },
  });
  const result = await adapter.wikiBacklinks?.({ file: "src/harness/run/run.ts" });
  expect(calls).toEqual([[CWD, "src/harness/run/run.ts"]]);
  expect(result?.file).toBe("src/harness/run/run.ts");
  expect(result?.backlinks).toEqual([
    ".metaproject/wiki/architecture/harness.md",
    ".metaproject/wiki/domain/policy.md",
  ]);
  expect(result?.error).toBeUndefined();
});

test("wikiBacklinks returns a structured error (never throws) when the facade fails", async () => {
  const adapter = createMetaprojectAdapter(CWD, {
    wikiPagesForFile: async () => {
      throw new Error("backlinks boom");
    },
  });
  const result = await adapter.wikiBacklinks?.({ file: "src/x.ts" });
  expect(result?.backlinks).toEqual([]);
  expect(result?.error).toMatch(/backlinks boom/);
});

// --- skillsCatalog / loadSkill (docs/requirements/keryx-skills-runtime-tools) -----
// Real filesystem, mkdtemp-isolated (matches src/gdskills/install.test.ts's own
// convention for testing real fs walks rather than mocking one).

/** Build a temp project root with a small synthetic .metaproject/skills/gdskills/ tree. */
async function withSkillsFixture(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-skills-catalog-"));
  try {
    const gdskillsRoot = path.join(root, ".metaproject", "skills", "gdskills");

    const flowOrchestratorDir = path.join(gdskillsRoot, "orchestration", "flow-orchestrator");
    await mkdir(flowOrchestratorDir, { recursive: true });
    await writeFile(
      path.join(flowOrchestratorDir, "SKILL.md"),
      '---\nname: flow-orchestrator\ndescription: "Task Manager-aware implementation orchestrator."\ntriggers:\n  - "создай фло"\n  - "create flow"\n---\n\n# Flow Orchestrator\n',
    );
    // A per-assistant variant that must NOT become its own catalog entry.
    await writeFile(
      path.join(flowOrchestratorDir, "SKILL.opencode.md"),
      "---\nname: flow-orchestrator\n---\nopencode-only variant body\n",
    );
    // A non-SKILL.md file in the same directory, to prove loadSkill only ever
    // resolves catalog-discovered paths, never an arbitrary sibling file.
    await writeFile(path.join(flowOrchestratorDir, "orchestrator-prompt.md"), "not a skill file\n");

    const noFrontmatterDir = path.join(gdskillsRoot, "core", "gdgraph-router");
    await mkdir(noFrontmatterDir, { recursive: true });
    await writeFile(path.join(noFrontmatterDir, "SKILL.md"), "no frontmatter here, just a plain body\n");

    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("skillsCatalog discovers every skill, excluding per-assistant SKILL.*.md variants", async () => {
  await withSkillsFixture(async (root) => {
    const adapter = createMetaprojectAdapter(root);
    const result = await adapter.skillsCatalog?.({});
    expect(result?.skills).toHaveLength(2);

    const byName = new Map(result?.skills.map((s) => [s.name, s]));
    const flowOrchestrator = byName.get("flow-orchestrator");
    expect(flowOrchestrator?.category).toBe("orchestration");
    expect(flowOrchestrator?.path).toBe(path.join(".metaproject", "skills", "gdskills", "orchestration", "flow-orchestrator", "SKILL.md"));
    expect(flowOrchestrator?.description).toBe("Task Manager-aware implementation orchestrator.");
    expect(flowOrchestrator?.triggers).toEqual(["создай фло", "create flow"]);

    // No entry sourced from the SKILL.opencode.md variant or the sibling non-skill file.
    expect([...byName.keys()].sort()).toEqual(["flow-orchestrator", "gdgraph-router"]);
  });
});

test("skillsCatalog degrades a skill with no/malformed frontmatter instead of failing the whole catalog", async () => {
  await withSkillsFixture(async (root) => {
    const adapter = createMetaprojectAdapter(root);
    const result = await adapter.skillsCatalog?.({});
    const noFrontmatter = result?.skills.find((s) => s.name === "gdgraph-router");
    expect(noFrontmatter?.description).toBe("");
    expect(noFrontmatter?.triggers).toBeUndefined();
  });
});

test("skillsCatalog falls back to catalog.md's one-line summary when a SKILL.md has no description", async () => {
  await withSkillsFixture(async (root) => {
    await mkdir(path.join(root, ".metaproject", "skills"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "skills", "catalog.md"),
      [
        "# Metaproject Skills Catalog",
        "",
        "| Skill | Category | Purpose | Entry |",
        "|---|---|---|---|",
        "| gdgraph-router | core | Route graph questions to gdgraph. | gdskills/core/gdgraph-router/SKILL.md |",
        "",
      ].join("\n"),
    );
    const adapter = createMetaprojectAdapter(root);
    const result = await adapter.skillsCatalog?.({});
    const noFrontmatter = result?.skills.find((s) => s.name === "gdgraph-router");
    expect(noFrontmatter?.description).toBe("Route graph questions to gdgraph.");
    // The skill WITH its own frontmatter description is unaffected by catalog.md.
    const flowOrchestrator = result?.skills.find((s) => s.name === "flow-orchestrator");
    expect(flowOrchestrator?.description).toBe("Task Manager-aware implementation orchestrator.");
  });
});

test("skillsCatalog returns an empty list, not an error, when the gdskills root does not exist", async () => {
  const emptyRoot = await mkdtemp(path.join(tmpdir(), "keryx-skills-empty-"));
  try {
    const adapter = createMetaprojectAdapter(emptyRoot);
    const result = await adapter.skillsCatalog?.({});
    expect(result?.skills).toEqual([]);
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }
});

test("skillsCatalog's generatedAt comes from the injected clock, never a bare Date.now call", async () => {
  await withSkillsFixture(async (root) => {
    const adapter = createMetaprojectAdapter(root, { now: () => "FIXED-TIMESTAMP" });
    const result = await adapter.skillsCatalog?.({});
    expect(result?.generatedAt).toBe("FIXED-TIMESTAMP");
  });
});

test("loadSkill by bare name returns byte-identical content to the real file", async () => {
  await withSkillsFixture(async (root) => {
    const adapter = createMetaprojectAdapter(root);
    const result = await adapter.loadSkill?.({ name: "flow-orchestrator" });
    expect(result?.found).toBe(true);
    expect(result?.path).toBe(path.join(".metaproject", "skills", "gdskills", "orchestration", "flow-orchestrator", "SKILL.md"));
    expect(result?.content).toBe(
      '---\nname: flow-orchestrator\ndescription: "Task Manager-aware implementation orchestrator."\ntriggers:\n  - "создай фло"\n  - "create flow"\n---\n\n# Flow Orchestrator\n',
    );
  });
});

test("loadSkill by exact catalog path returns the same content as by name", async () => {
  await withSkillsFixture(async (root) => {
    const adapter = createMetaprojectAdapter(root);
    const catalogPath = path.join(".metaproject", "skills", "gdskills", "orchestration", "flow-orchestrator", "SKILL.md");
    const result = await adapter.loadSkill?.({ name: catalogPath });
    expect(result?.found).toBe(true);
    expect(result?.path).toBe(catalogPath);
    expect(result?.content).toContain("# Flow Orchestrator");
  });
});

test("loadSkill returns found:false for an unknown name (never throws)", async () => {
  await withSkillsFixture(async (root) => {
    const adapter = createMetaprojectAdapter(root);
    const result = await adapter.loadSkill?.({ name: "does-not-exist" });
    expect(result?.found).toBe(false);
    expect(result?.path).toBe("");
    expect(result?.content).toBe("");
  });
});

test("loadSkill rejects a path-traversal attempt and never reads outside the gdskills root", async () => {
  await withSkillsFixture(async (root) => {
    const adapter = createMetaprojectAdapter(root);
    const result = await adapter.loadSkill?.({ name: "../../../../../../../../etc/passwd" });
    expect(result?.found).toBe(false);
    expect(result?.content).toBe("");
  });
});

test("loadSkill rejects a real on-disk path that the catalog walk never discovered (not a SKILL.md)", async () => {
  await withSkillsFixture(async (root) => {
    const adapter = createMetaprojectAdapter(root);
    // This file genuinely exists on disk, inside the gdskills root — but it is
    // not a SKILL.md, so the walk never listed it as a catalog entry. loadSkill
    // must refuse it rather than falling back to a bare confine+read.
    const strayPath = path.join(".metaproject", "skills", "gdskills", "orchestration", "flow-orchestrator", "orchestrator-prompt.md");
    const result = await adapter.loadSkill?.({ name: strayPath });
    expect(result?.found).toBe(false);
    expect(result?.content).toBe("");
  });
});
