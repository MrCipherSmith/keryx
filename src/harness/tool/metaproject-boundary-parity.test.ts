// Boundary parity: what the underlying function accepts and what the CLI shows
// must both survive the agent-facing tool boundary (flow 235 T8).
//
// Three lanes independently found the same defect class: a capability lands in
// the service facade and on the command line, and the boundary an agent
// actually reads never gains it. These tests assert the boundary itself — every
// case is driven through the REAL dispatch (`METAPROJECT_OPERATIONS[…].invoke`,
// or the MCP `ToolEntry.invoke` produced by `toMcpTools`), never through a
// formatter or a port method called directly, because it is the dispatch that
// was blind.

import { expect, test } from "bun:test";
import type { RepomapOptions, RepomapResult as GdgraphRepomapResult } from "../../gdgraph/repomap";
import type { StalenessCheck } from "../../gdgraph/staleness";
import type { WikiAskInput, WikiAskResult as WikiAskFacadeResult } from "../../wiki/types";
import { toMcpTools } from "../../mcp/metaproject-tools";
import { createMetaprojectAdapter, type MetaprojectAdapterDeps } from "./metaproject-adapter";
import { METAPROJECT_OPERATIONS } from "./metaproject-operations";
import type { MetaprojectPort, RepomapResult, WikiAskResult } from "./metaproject-port";

const CWD = "/proj";

function op(name: string) {
  const found = METAPROJECT_OPERATIONS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no such operation: ${name}`);
  return found;
}

/** Properties of an operation's input schema — the contract a caller can actually fill. */
function inputProperties(name: string): Record<string, unknown> {
  return (op(name).inputSchema.properties ?? {}) as Record<string, unknown>;
}

/**
 * A port that records the input each method received and returns a minimal
 * structured result. Used for INPUT parity: whatever the underlying function
 * accepts must be reachable through the dispatch, so the recorded input is the
 * assertion.
 */
function recordingPort(): { port: MetaprojectPort; seen: Record<string, unknown> } {
  const seen: Record<string, unknown> = {};
  const port: MetaprojectPort = {
    async searchCode(input) {
      seen.searchCode = input;
      return { pattern: input.pattern, output: "", isError: false };
    },
    async graphAffected(input) {
      seen.graphAffected = input;
      return { target: input.target, affected: [] };
    },
    async graphQuery(input) {
      seen.graphQuery = input;
      return { query: input.query };
    },
    async memorySearch(input) {
      seen.memorySearch = input;
      return { query: input.query, hits: [] };
    },
    async readWiki(input) {
      seen.readWiki = input;
      return { path: input.path, content: "", isError: false };
    },
    async describeContext() {
      return { root: CWD, graphNodes: 0, graphEdges: 0, hasWikiIndex: false };
    },
    async repomap(input) {
      seen.repomap = input;
      return { budget: 0, files: [], tokens: 0, omitted: 0 };
    },
    async wikiAsk(input) {
      seen.wikiAsk = input;
      return { question: input.question, citations: [], answer: "" };
    },
  };
  return { port, seen };
}

// --- finding 1: repomap ignores seeds, and drops the required/loss markers ----

const SEEDED_REPOMAP: GdgraphRepomapResult = {
  path: ".metaproject/data/gdgraph/artifacts/repomap.md",
  content: "",
  entries: [
    { path: "src/seed.ts", score: 0.5, symbols: ["function seed()"], required: true },
    { path: "src/tail.ts", score: 0.001, symbols: [], required: false },
  ],
  tokens: 42,
  omitted: 2,
  omittedOptional: ["src/dropped-a.ts", "src/dropped-b.ts"],
  partial: true,
};

function repomapDeps(
  result: GdgraphRepomapResult,
  sink: { options?: RepomapOptions } = {},
): Partial<MetaprojectAdapterDeps> {
  return {
    repomapCompute: async (_cwd: string, options: RepomapOptions) => {
      sink.options = options;
      return result;
    },
    checkGraphStaleness: async () => ({ status: "fresh", reasons: [] }),
  };
}

test("repomap: a seed reaches the underlying compute through the tool dispatch", async () => {
  expect(inputProperties("repomap")).toHaveProperty("seed");

  const sink: { options?: RepomapOptions } = {};
  const port = createMetaprojectAdapter(CWD, repomapDeps(SEEDED_REPOMAP, sink));
  await op("repomap").invoke(port, { budget: 400, seed: ["src/seed.ts"] });

  expect(sink.options).toEqual({ budget: 400, seed: ["src/seed.ts"] });
});

test("repomap: required / omittedOptional / partial survive to the agent's text", async () => {
  const port = createMetaprojectAdapter(CWD, repomapDeps(SEEDED_REPOMAP));
  const rendered = await op("repomap").invoke(port, { seed: ["src/seed.ts"] });

  expect(rendered.isError).toBe(false);
  // Which entry was protected, not just which scored highest.
  expect(rendered.output).toContain("required");
  // The named loss, not only the scalar count.
  expect(rendered.output).toContain("src/dropped-a.ts");
  expect(rendered.output).toContain("PARTIAL");
});

test("repomap: a mandatory overflow is not rendered as an ordinary empty map", async () => {
  const overflowed: GdgraphRepomapResult = {
    path: "",
    content: "",
    entries: [],
    tokens: 0,
    omitted: 9,
    omittedOptional: [],
    partial: false,
    overflow: { code: "context_overflow", requiredId: "src/seed.ts" },
  };
  const port = createMetaprojectAdapter(CWD, repomapDeps(overflowed));
  const rendered = await op("repomap").invoke(port, { budget: 1, seed: ["src/seed.ts"] });

  // Before this fix the adapter dropped `overflow` and the formatter printed
  // "Repomap is empty (no ranked files)." — a budget refusal read as success.
  expect(rendered.isError).toBe(true);
  expect(rendered.output).toContain("context_overflow");
  expect(rendered.output).toContain("src/seed.ts");
});

test("repomap: the port result carries the markers structurally", async () => {
  const port = createMetaprojectAdapter(CWD, repomapDeps(SEEDED_REPOMAP));
  const result: RepomapResult = await port.repomap!({ seed: ["src/seed.ts"] });

  expect(result.partial).toBe(true);
  expect(result.omittedOptional).toEqual(["src/dropped-a.ts", "src/dropped-b.ts"]);
  expect(result.files[0]?.required).toBe(true);
  expect(result.seed).toEqual(["src/seed.ts"]);
});

test("repomap: an MCP caller receives the markers too", async () => {
  // NOTE: `toMcpTools`'s `invokeStructured` has a bespoke structured case for
  // only five operations; `repomap` falls through to the descriptor's own
  // formatting invoke, so what an MCP caller actually receives here is the
  // rendered text. Asserting on what the transport really delivers rather than
  // on what its doc comment claims — see this task's residual note.
  const port = createMetaprojectAdapter(CWD, repomapDeps(SEEDED_REPOMAP));
  const tool = toMcpTools(METAPROJECT_OPERATIONS, () => port).find((t) => t.name === "repomap");
  const result = (await tool!.invoke(CWD, { seed: ["src/seed.ts"] })) as { output: string };

  expect(result.output).toContain("[required]");
  expect(result.output).toContain("src/dropped-a.ts");
});

// --- finding 2: no staleness at all on the graph-backed operations -----------

const GRAPH_OPS: Array<[string, Record<string, unknown>]> = [
  ["graph_affected", { file: "src/a.ts" }],
  ["graph_query", { query: "orphans" }],
  ["graph_path", { from: "src/a.ts", to: "src/b.ts" }],
  ["graph_symbol", { name: "wikiAsk" }],
  ["repomap", {}],
];

function stalenessDeps(check: StalenessCheck): Partial<MetaprojectAdapterDeps> {
  return {
    checkGraphStaleness: async () => check,
    repomapCompute: async () => SEEDED_REPOMAP,
    createGdgraphService: () => ({
      async build() {
        return { nodes: 0, edges: 0, summaryPath: "" };
      },
      async loadGraph() {
        return { nodes: [], edges: [] };
      },
      async affected(_cwd: string, target: string) {
        return { target, depth: 1, dependencies: [], dependents: [], ranked: [] };
      },
      async repomap() {
        return {} as never;
      },
      async query() {
        return [];
      },
    }),
  };
}

for (const [name, input] of GRAPH_OPS) {
  test(`${name}: a git failure reads as UNKNOWN, never as a confident claim`, async () => {
    const port = createMetaprojectAdapter(
      CWD,
      stalenessDeps({ status: "unknown", reasons: ["git status failed"] }),
    );
    const rendered = await op(name).invoke(port, input);
    // `UNKNOWN_NOTE`'s wording, not `STALE_NOTE`'s "repo moved".
    expect(rendered.output).toContain("could not determine whether the graph is stale");
    expect(rendered.output).toContain("git status failed");
    expect(rendered.output).not.toContain("repo moved since the last graph build");
  });

  test(`${name}: a confirmed stale graph says so with its reasons`, async () => {
    const port = createMetaprojectAdapter(
      CWD,
      stalenessDeps({ status: "stale", reasons: ["HEAD moved since the graph was built"] }),
    );
    const rendered = await op(name).invoke(port, input);
    expect(rendered.output).toContain("repo moved since the last graph build");
    expect(rendered.output).toContain("HEAD moved since the graph was built");
  });

  test(`${name}: a fresh graph adds no noise`, async () => {
    const port = createMetaprojectAdapter(CWD, stalenessDeps({ status: "fresh", reasons: [] }));
    const rendered = await op(name).invoke(port, input);
    // Neither `STALE_NOTE` nor `UNKNOWN_NOTE` — both begin "note:".
    expect(rendered.output).not.toContain("note:");
  });
}

// --- finding 3: search_code is a permanent stub on the adapter ---------------

test("search_code: the adapter has a real backing, so the MCP projection returns matches", async () => {
  const port = createMetaprojectAdapter(CWD, {
    runRipgrep: async (_cwd, argv) => ({
      stdout: "src/wiki/ask.ts:91:17:export async function wikiAsk(\n",
      stderr: "",
      exitCode: 0,
      argv,
    }),
  });
  const tool = toMcpTools(METAPROJECT_OPERATIONS, () => port).find((t) => t.name === "search_code");
  const result = (await tool!.invoke(CWD, { pattern: "wikiAsk" })) as {
    output: string;
    isError: boolean;
  };

  expect(result.isError).toBe(false);
  expect(result.output).toContain("src/wiki/ask.ts");
});

test("search_code: a genuine no-match is a successful empty answer, not an error", async () => {
  const port = createMetaprojectAdapter(CWD, {
    runRipgrep: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
  });
  const rendered = await op("search_code").invoke(port, { pattern: "zzzz-no-such-token" });
  expect(rendered.isError).toBe(false);
  expect(rendered.output).toContain("No matches");
});

test("search_code: an rg failure is an error, distinct from a no-match", async () => {
  const port = createMetaprojectAdapter(CWD, {
    runRipgrep: async () => ({ stdout: "", stderr: "regex parse error", exitCode: 2 }),
  });
  const rendered = await op("search_code").invoke(port, { pattern: "([unclosed" });
  expect(rendered.isError).toBe(true);
  expect(rendered.output).toContain("regex parse error");
});

test("search_code: a missing ripgrep is diagnosed, not surfaced as a bare spawn error", async () => {
  const port = createMetaprojectAdapter(CWD, {
    runRipgrep: async () => {
      throw new Error('Executable not found in $PATH: "rg"');
    },
  });
  const rendered = await op("search_code").invoke(port, { pattern: "wikiAsk" });
  expect(rendered.isError).toBe(true);
  expect(rendered.output).toContain("ripgrep (rg) is not installed");
  expect(rendered.output).toContain("brew install ripgrep");
});

test("search_code: a path escaping the project root is refused, not searched", async () => {
  let spawned = false;
  const port = createMetaprojectAdapter(CWD, {
    runRipgrep: async () => {
      spawned = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  const rendered = await op("search_code").invoke(port, { pattern: ".", path: "../../etc" });
  expect(rendered.isError).toBe(true);
  expect(spawned).toBe(false);
});

test("search_code: the pattern can never be re-parsed as an rg option", async () => {
  let argv: string[] = [];
  const port = createMetaprojectAdapter(CWD, {
    runRipgrep: async (_cwd, args) => {
      argv = args;
      return { stdout: "", stderr: "", exitCode: 1 };
    },
  });
  await op("search_code").invoke(port, { pattern: "--pre=/bin/sh" });
  const separator = argv.indexOf("--");
  expect(separator).toBeGreaterThan(-1);
  expect(argv.indexOf("--pre=/bin/sh")).toBeGreaterThan(separator);
});

// --- unreported: wiki_ask drops the retrieval status and every new field -----

function wikiDeps(result: WikiAskFacadeResult): Partial<MetaprojectAdapterDeps> {
  return { wikiAsk: async (_input: WikiAskInput) => result };
}

test("wiki_ask: `k` reaches the underlying facade", async () => {
  expect(inputProperties("wiki_ask")).toHaveProperty("k");
  const { port, seen } = recordingPort();
  await op("wiki_ask").invoke(port, { question: "why", k: 3 });
  expect(seen.wikiAsk).toEqual({ question: "why", k: 3 });
});

test("wiki_ask: a non-ok retrieval status survives as a code, not just prose", async () => {
  const port = createMetaprojectAdapter(
    CWD,
    wikiDeps({
      question: "the of and is a",
      status: "insufficient-evidence",
      reason: "only stop-words matched",
      citations: [],
      answerMarkdown: "_no evidence_",
    }),
  );
  const structured: WikiAskResult = await port.wikiAsk!({ question: "the of and is a" });
  expect(structured.status).toBe("insufficient-evidence");
  expect(structured.reason).toBe("only stop-words matched");

  const rendered = await op("wiki_ask").invoke(port, { question: "the of and is a" });
  expect(rendered.output).toContain("insufficient-evidence");
  expect(rendered.output).toContain("only stop-words matched");
});

test("wiki_ask: a HISTORICAL citation keeps its lifecycle marks at the tool boundary", async () => {
  const port = createMetaprojectAdapter(
    CWD,
    wikiDeps({
      question: "retry policy",
      status: "ok",
      citations: [
        {
          path: "rules/retry.md",
          title: "Retry › Rule",
          excerpt: "retry three times",
          score: 0.4,
          source: "wiki",
          sectionId: "rule-retry",
          sectionRef: "wiki:rules/retry.md#rule-retry",
          sectionStability: "stable",
          contentClass: "substantive",
          matched: ["retry"],
          startLine: 10,
          endLine: 14,
          historical: true,
          lifecycleState: "superseded",
          lifecycleReasons: ["superseded by rules/retry-v2.md"],
        },
      ],
      answerMarkdown: "answer",
    }),
  );
  const structured: WikiAskResult = await port.wikiAsk!({ question: "retry policy" });
  const citation = structured.citations[0]!;

  expect(citation.historical).toBe(true);
  expect(citation.lifecycleState).toBe("superseded");
  expect(citation.lifecycleReasons).toEqual(["superseded by rules/retry-v2.md"]);
  expect(citation.sectionRef).toBe("wiki:rules/retry.md#rule-retry");
  expect(citation.contentClass).toBe("substantive");
  expect(citation.matched).toEqual(["retry"]);

  // And the agent-visible text says it plainly, not only in the structure.
  const rendered = await op("wiki_ask").invoke(port, { question: "retry policy" });
  expect(rendered.output).toContain("NOT CURRENT");
  expect(rendered.output).toContain("superseded by rules/retry-v2.md");
});

// --- unreported: graph_affected drops depth/ranked in, dependencies out ------

test("graph_affected: depth and ranked reach the port", async () => {
  const props = inputProperties("graph_affected");
  expect(props).toHaveProperty("depth");
  expect(props).toHaveProperty("ranked");

  const { port, seen } = recordingPort();
  await op("graph_affected").invoke(port, { file: "src/a.ts", depth: 3, ranked: false });
  expect(seen.graphAffected).toEqual({ target: "src/a.ts", depth: 3, ranked: false });
});

test("graph_affected: the dependencies half of the blast radius is not dropped", async () => {
  const port = createMetaprojectAdapter(CWD, {
    checkGraphStaleness: async () => ({ status: "fresh", reasons: [] }),
    createGdgraphService: () => ({
      async build() {
        return { nodes: 0, edges: 0, summaryPath: "" };
      },
      async loadGraph() {
        return { nodes: [], edges: [] };
      },
      async affected(_cwd: string, target: string) {
        return {
          target,
          depth: 1,
          dependencies: ["src/dep.ts"],
          dependents: ["src/user.ts"],
          ranked: [{ path: "src/user.ts", hop: 1, fanIn: 1 }],
        };
      },
      async repomap() {
        return {} as never;
      },
      async query() {
        return [];
      },
    }),
  });
  const result = await port.graphAffected({ target: "src/a.ts" });
  expect(result.dependencies).toEqual(["src/dep.ts"]);

  const rendered = await op("graph_affected").invoke(port, { file: "src/a.ts" });
  expect(rendered.output).toContain("src/dep.ts");
});

// --- unreported: health_status kept only the DEPRECATED regression count -----

test("health_status: decliningScopes / regressedScopes are not dropped", async () => {
  const port = createMetaprojectAdapter(CWD, {
    createCodeHealthService: () =>
      ({
        async status() {
          return {
            enabled: true,
            lastRunAt: "2026-09-01T00:00:00.000Z",
            gate: "warn" as const,
            sources: [],
            projectScore: 72,
            // `regressions` is the DEPRECATED alias; the two real counters are
            // what `health.status` returns and what `keryx health status` shows.
            regressions: 2,
            decliningScopes: 2,
            regressedScopes: 5,
          };
        },
      }) as never,
  });
  const result = await port.healthStatus!();
  expect(result.decliningScopes).toBe(2);
  expect(result.regressedScopes).toBe(5);

  const rendered = await op("health_status").invoke(port, {});
  expect(rendered.output).toContain("regressed scopes: 5");
});

// --- unreported: flow_status drops the flow slug ----------------------------

test("flow_status: the slug survives to the tool boundary", async () => {
  const port = createMetaprojectAdapter(CWD, {
    createFlowService: () =>
      ({
        async list() {
          return [
            {
              id: "235",
              slug: "agent-first-core-phase-3",
              title: "Phase 3",
              status: "in-progress",
              dir: "235-2026-09-06-agent-first-core-phase-3",
              tasksDone: 7,
              tasksTotal: 9,
            },
          ];
        },
      }) as never,
  });
  const result = await port.flowStatus!({});
  expect(result.flows[0]?.slug).toBe("agent-first-core-phase-3");
});

// --- unreported: memory_search drops the filters the port already accepts ----

test("memory_search: module / class / limit reach the port", async () => {
  const props = inputProperties("memory_search");
  expect(props).toHaveProperty("module");
  expect(props).toHaveProperty("class");
  expect(props).toHaveProperty("limit");

  const { port, seen } = recordingPort();
  await op("memory_search").invoke(port, {
    query: "retry",
    module: "harness",
    class: "procedural",
    limit: 3,
  });
  expect(seen.memorySearch).toEqual({
    query: "retry",
    module: "harness",
    class: "procedural",
    limit: 3,
  });
});
