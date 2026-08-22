// RLM-mode (`rlm.enabled: true`) integration tests for `wikiEnrich` (flow 169
// T7, TRD §1.2/§1.5/§5 NFR-4). Deliberately a SEPARATE file from
// `enrich.test.ts` (mirrors this module's existing split — `deep-enrich.test.ts`,
// `staleness.test.ts`, `classify.test.ts` are all their own files) so the
// RLM-off regression suite in `enrich.test.ts` stays focused on the
// pre-flow-169 behavior, and this file owns everything gated by
// `wiki.config.json`'s `rlm.enabled`.
//
// Covers (see `.metaproject/flows/169-.../acceptance-criteria.md`):
//   AC1 — RLM-off parity (rlm.enabled:false explicit vs. absent config).
//   AC2 — classify `skip` tier: no LLM call, content equals the template.
//   AC4 — staleness gate skips regardless of tier, and is bypassed on real change.
//   AC5 — a `deep` child that exhausts its budget never fails the run.
//   AC6 — `light` batching splits (not truncates) on overflow.
// AC3/AC7 (deep tool-grant + provenance) are T6's own unit tests
// (`deep-enrich.test.ts`); this file adds one deep-tier happy-path
// integration test to confirm T7's wiring actually calls `enrichPageDeep`.

import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGraph } from "../gdgraph/query";
import type {
  NormalizedEvent,
  NormalizedRequest,
  ProviderDescription,
  ProviderPort,
  StreamOptions,
} from "../harness/provider/types";
import { computeModuleKeyFiles, keyFilesForPage } from "./collect";
import {
  batchGroupKey,
  buildBatchUserPrompt,
  groupLightPagesIntoBatches,
  parseBatchResponse,
  saveResumeState,
  wikiEnrich,
  type LightBatchItem,
  type ProviderFactory,
} from "./enrich";
import { wikiCollect } from "./service";
import { computePageNodeHash } from "./staleness";
import type { WikiPage } from "./types";

const jsonl = (rows: object[]): string => rows.map((r) => JSON.stringify(r)).join("\n");

async function writeWikiConfig(root: string, config: unknown): Promise<void> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "wiki.config.json"), JSON.stringify(config), "utf8");
}

/**
 * Seed a temp workspace with two graph-backed draft component modules
 * (`src/alpha`, `src/beta`), REAL on-disk source files (needed so
 * `computePageNodeHash` hashes real content, not the `"<missing>"`
 * sentinel), plus draft wiki pages via `wikiCollect` (same shape
 * `enrich.test.ts`'s own `seedDrafts` produces).
 */
async function seedRlmRoot(edges: Array<{ from: string; to: string }> = []): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-rlm-"));
  const graphDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(graphDir, { recursive: true });
  await writeFile(
    path.join(graphDir, "nodes.jsonl"),
    jsonl([
      { id: "src/alpha/a.ts", kind: "file", path: "src/alpha/a.ts", language: "typescript" },
      { id: "src/alpha/b.ts", kind: "file", path: "src/alpha/b.ts", language: "typescript" },
      { id: "src/beta/a.ts", kind: "file", path: "src/beta/a.ts", language: "typescript" },
      { id: "src/beta/b.ts", kind: "file", path: "src/beta/b.ts", language: "typescript" },
    ]),
    "utf8",
  );
  await writeFile(
    path.join(graphDir, "edges.jsonl"),
    jsonl(edges.map((e, i) => ({ id: `e${i}`, from: e.from, to: e.to, kind: "imports", specifier: "" }))),
    "utf8",
  );

  await mkdir(path.join(root, "src/alpha"), { recursive: true });
  await mkdir(path.join(root, "src/beta"), { recursive: true });
  await writeFile(path.join(root, "src/alpha/a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(path.join(root, "src/alpha/b.ts"), "export const b = 1;\n", "utf8");
  await writeFile(path.join(root, "src/beta/a.ts"), "export const a = 2;\n", "utf8");
  await writeFile(path.join(root, "src/beta/b.ts"), "export const b = 2;\n", "utf8");

  await wikiCollect({ cwd: root });
  return root;
}

function stubProvider(reply: string): ProviderPort {
  return {
    describe(): ProviderDescription {
      return {
        capabilities: {
          streaming: true,
          toolCalls: false,
          parallelToolCalls: false,
          structuredOutput: false,
          reasoningMetadata: false,
          promptCaching: false,
          vision: false,
          tokenCounting: false,
          modelListing: false,
        },
        descriptor: { providerId: "stub" },
      };
    },
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: reply };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

/** A provider that throws if it is ever invoked — proves "no LLM call" (AC2/AC4). */
function forbiddenProviderFactory(): ProviderFactory {
  return () => {
    throw new Error("provider must not be called for this page");
  };
}

/** A provider whose `stream()` never resolves — for the deep budget-exhaustion test (AC5). */
function hangingProviderFactory(): ProviderFactory {
  const description: ProviderDescription = {
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: false,
      structuredOutput: false,
      reasoningMetadata: false,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    },
    descriptor: { providerId: "hanging" },
  };
  const provider: ProviderPort = {
    describe: () => description,
    stream: () =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        await new Promise(() => {
          // never resolves
        });
      })(),
  };
  return () => provider;
}

/**
 * A provider that inspects the outgoing user prompt for batch markers
 * (`<<<WIKI_PAGE path="...">>>`) and echoes back a valid enriched page per
 * marker found, or one plain enriched page when the prompt is un-batched.
 * Lets a single stub drive both the batched and singleton `light` call
 * shapes `runLightBatch` can produce.
 */
function batchAwareProviderFactory(calls: NormalizedRequest[]): ProviderFactory {
  const description: ProviderDescription = {
    capabilities: {
      streaming: true,
      toolCalls: false,
      parallelToolCalls: false,
      structuredOutput: false,
      reasoningMetadata: false,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    },
    descriptor: { providerId: "batch-stub" },
  };
  const provider: ProviderPort = {
    describe: () => description,
    async *stream(request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      calls.push(request);
      const userText = request.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");
      const paths = [...userText.matchAll(/<<<WIKI_PAGE path="([^"]+)">>>/g)].map((m) => m[1]!);
      const reply =
        paths.length > 0
          ? paths
              .map(
                (p) =>
                  `<<<WIKI_PAGE path="${p}">>>\n---\nTitle: Enriched\nStatus: draft\n---\n\n` +
                  `# Enriched\n\nBatched enriched prose for ${p} with enough body length to pass ` +
                  `validation checks cleanly.\n<<<END_WIKI_PAGE>>>`,
              )
              .join("\n")
          : "---\nTitle: Enriched\nStatus: draft\n---\n\n# Enriched\n\nSingle-page enriched prose " +
            "with enough body length to pass validation checks cleanly.\n";
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: reply };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
  return () => provider;
}

// --- AC1: RLM-off parity — explicit `rlm.enabled:false` vs. absent config ---

test("AC1 — explicit rlm.enabled:false produces identical output to absent config (RLM-off parity)", async () => {
  const rootA = await seedRlmRoot(); // no wiki.config.json at all
  const rootB = await seedRlmRoot();
  await writeWikiConfig(rootB, { rlm: { enabled: false } });
  const GOOD_PAGE = `---\nTitle: Enriched\nStatus: draft\n---\n\n# Enriched\n\nFull prose body with enough text for validation checks to pass cleanly.\n`;
  const factory: ProviderFactory = () => stubProvider(GOOD_PAGE);
  try {
    const resultA = await wikiEnrich({ cwd: rootA, providerFactory: factory, validate: false });
    const resultB = await wikiEnrich({ cwd: rootB, providerFactory: factory, validate: false });

    expect(resultA.pages).toEqual(resultB.pages);
    for (const page of [...resultA.pages, ...resultB.pages]) {
      // RLM-only fields must never appear on the RLM-off path (NFR-4/AC1).
      expect(page.tier).toBeUndefined();
      expect(page.nodeHash).toBeUndefined();
      expect(page.deepToolCalls).toBeUndefined();
    }
    for (const page of resultA.pages) {
      const contentA = await readFile(path.join(rootA, ".metaproject", "wiki", page.path), "utf8");
      const contentB = await readFile(path.join(rootB, ".metaproject", "wiki", page.path), "utf8");
      expect(contentA).toBe(contentB);
    }
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

// --- AC2: classify `skip` — no LLM call, content equals the template -------

test("AC2 — classify skip tier: no LLM call, content equals the collect.ts template unchanged", async () => {
  const root = await seedRlmRoot();
  await writeWikiConfig(root, {
    rlm: {
      enabled: true,
      classify: { skipMaxBytes: 1_000_000, deepMinPageRank: 999, deepMinFanIn: 999 },
    },
  });
  try {
    const pagePath = path.join(root, ".metaproject", "wiki", "components", "src-alpha.md");
    const before = await readFile(pagePath, "utf8");

    const result = await wikiEnrich({ cwd: root, providerFactory: forbiddenProviderFactory() });

    expect(result.failed).toBe(0);
    expect(result.enriched).toBe(0);
    expect(result.pages.every((p) => p.action === "skipped" && p.tier === "skip")).toBe(true);
    expect(result.skipped).toBe(result.pages.length);

    const after = await readFile(pagePath, "utf8");
    expect(after).toBe(before); // byte-for-byte unchanged — no write happened.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- AC4: staleness gate skips regardless of tier ---------------------------

test("AC4 — unchanged page (matching cached hash) is skipped with no LLM call, regardless of tier", async () => {
  const root = await seedRlmRoot();
  // skipMaxBytes:0 and very high deep thresholds ⇒ this page would classify
  // `light` (i.e. WOULD call the model) if the staleness gate did not skip it
  // first — proving FR-7 staleness is checked before, and independent of, tier.
  await writeWikiConfig(root, {
    rlm: {
      enabled: true,
      classify: { skipMaxBytes: 0, deepMinPageRank: 999, deepMinFanIn: 999 },
    },
  });
  try {
    const graph = await loadGraph(root);
    const keyFilesIndex = computeModuleKeyFiles(graph);
    const page: Pick<WikiPage, "relativePath"> = { relativePath: "components/src-alpha.md" };
    const keyFiles = keyFilesForPage(keyFilesIndex, page);
    expect(keyFiles.length).toBeGreaterThan(0);
    const hash = await computePageNodeHash(root, keyFiles, graph);

    saveResumeState(root, {
      updatedAt: new Date().toISOString(),
      completed: [],
      completedNodeHashes: { "components/src-alpha.md": hash },
      failed: [],
    });

    const pagePath = path.join(root, ".metaproject", "wiki", "components", "src-alpha.md");
    const before = await readFile(pagePath, "utf8");

    const result = await wikiEnrich({
      cwd: root,
      page: "components/src-alpha.md",
      providerFactory: forbiddenProviderFactory(),
    });

    expect(result.failed).toBe(0);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.action).toBe("skipped");
    expect(result.pages[0]?.reason).toMatch(/unchanged/i);

    const after = await readFile(pagePath, "utf8");
    expect(after).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC4 — a real content change since the cached hash is NOT skipped (LLM is called)", async () => {
  const root = await seedRlmRoot();
  await writeWikiConfig(root, {
    rlm: {
      enabled: true,
      classify: { skipMaxBytes: 0, deepMinPageRank: 999, deepMinFanIn: 999 },
    },
  });
  try {
    // Force `repoMaybeStale: true` (HEAD postdates the graph build) so the
    // pipeline actually recomputes and compares the per-page hash instead of
    // trusting the cache via the "repo hasn't moved" fast path.
    const gitDir = path.join(root, ".git");
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
    const nodesPath = path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl");
    const old = new Date(Date.now() - 60_000);
    const recent = new Date();
    await utimes(nodesPath, old, old);
    await utimes(path.join(gitDir, "HEAD"), recent, recent);

    const graph = await loadGraph(root);
    const keyFilesIndex = computeModuleKeyFiles(graph);
    const page: Pick<WikiPage, "relativePath"> = { relativePath: "components/src-alpha.md" };
    const keyFiles = keyFilesForPage(keyFilesIndex, page);
    const staleHash = await computePageNodeHash(root, keyFiles, graph);

    saveResumeState(root, {
      updatedAt: new Date().toISOString(),
      completed: [],
      completedNodeHashes: { "components/src-alpha.md": staleHash },
      failed: [],
    });

    // Change one of the page's underlying key files' content.
    await writeFile(path.join(root, "src/alpha/a.ts"), "export const a = 999;\n", "utf8");

    const GOOD_PAGE = `---\nTitle: Enriched\nStatus: draft\n---\n\n# Enriched\n\nFull prose body with enough text for validation checks to pass cleanly.\n`;
    const result = await wikiEnrich({
      cwd: root,
      page: "components/src-alpha.md",
      providerFactory: () => stubProvider(GOOD_PAGE),
      validate: false,
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.action).toBe("enriched");
    expect(result.pages[0]?.reason).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- AC6: light-tier batching splits (not truncates) on overflow -----------

function lightItem(relativePath: string, body: string, keyFiles: string[] = ["src/mod/a.ts"]): LightBatchItem {
  const page: WikiPage = {
    absolutePath: `/tmp/${relativePath}`,
    relativePath,
    pageType: "component",
    title: relativePath,
    version: null,
    type: null,
    status: "draft",
    summary: "",
  };
  const original = `---\nTitle: X\nStatus: draft\n---\n\n# X\n\n${body}\n`;
  return { page, original, originalRaw: original, keyFiles };
}

test("AC6 — groupLightPagesIntoBatches splits a group exceeding maxPagesPerBatch, drops nothing", () => {
  const items = [lightItem("components/a.md", "A"), lightItem("components/b.md", "B"), lightItem("components/c.md", "C")];
  const batches = groupLightPagesIntoBatches(items, { maxPagesPerBatch: 2 }, 1_000_000);
  expect(batches.length).toBe(2);
  expect(batches[0]).toHaveLength(2);
  expect(batches[1]).toHaveLength(1);
  const allPaths = batches
    .flat()
    .map((item) => item.page.relativePath)
    .sort();
  expect(allPaths).toEqual(["components/a.md", "components/b.md", "components/c.md"]);
});

test("AC6 — groupLightPagesIntoBatches splits (not truncates) on token-budget overflow", () => {
  const big = "y".repeat(3000);
  const items = ["components/a.md", "components/b.md", "components/c.md"].map((p) => lightItem(p, big));
  const batches = groupLightPagesIntoBatches(items, { maxPagesPerBatch: 10 }, 100);
  // Every item is oversized alone relative to the tiny budget ⇒ each becomes
  // its own single-item batch, never merged, and never truncated.
  expect(batches).toHaveLength(3);
  for (const batch of batches) {
    expect(batch).toHaveLength(1);
    const rendered = buildBatchUserPrompt(batch);
    expect(rendered).toContain(big); // full content present — not truncated.
  }
});

test("AC6 — a batched wikiEnrich run over 3 sibling light pages issues 2 calls (batch of 2 + 1) and enriches all 3", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-rlm-batch-"));
  try {
    const wikiDir = path.join(root, ".metaproject", "wiki", "decisions");
    await mkdir(wikiDir, { recursive: true });
    for (const slug of ["d1", "d2", "d3"]) {
      await writeFile(
        path.join(wikiDir, `${slug}.md`),
        `---\nTitle: Decision ${slug}\nVersion: 0.1.0\nType: decision\nStatus: draft\nSummary: stub\n---\n\n` +
          `# Decision ${slug}\n\nStub body for ${slug} with enough length for the pipeline to treat it as ` +
          "non-trivial content overall.\n",
        "utf8",
      );
    }
    await writeWikiConfig(root, {
      rlm: {
        enabled: true,
        classify: { skipMaxBytes: 0 },
        batch: { enabled: true, maxPagesPerBatch: 2 },
      },
    });

    const calls: NormalizedRequest[] = [];
    const result = await wikiEnrich({
      cwd: root,
      providerFactory: batchAwareProviderFactory(calls),
      validate: false,
    });

    expect(result.failed).toBe(0);
    expect(result.enriched).toBe(3);
    expect(calls).toHaveLength(2); // one batch of 2 siblings + one singleton call
    expect(result.pages.every((p) => p.tier === "light")).toBe(true);

    const contents = await Promise.all(
      ["d1", "d2", "d3"].map((slug) => readFile(path.join(wikiDir, `${slug}.md`), "utf8")),
    );
    // Pages are collected (and so grouped/batched) in relativePath order, so
    // d1+d2 form the batch of 2 (their reply echoes each page's OWN path,
    // proving per-page splitting of the batched reply) and d3 is the
    // trailing singleton call (un-batched prompt, no marker).
    expect(contents[0]).toContain("decisions/d1.md");
    expect(contents[1]).toContain("decisions/d2.md");
    expect(contents[2]).toContain("Single-page enriched prose");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- parseBatchResponse: round-trip and malformed-input handling (T9) ------
// AC6's own docstring on `parseBatchResponse` (`enrich.ts`) says it exists so
// a batched reply can be split back into per-page content deterministically;
// these tests cover that round-trip directly, plus the function's actual
// (not invented) behavior on malformed/partial input.

test("parseBatchResponse — well-formed multi-page batch response parses correctly", () => {
  const reply =
    '<<<WIKI_PAGE path="components/a.md">>>\n---\nTitle: A\nStatus: draft\n---\n\n# A\n\nBody A.\n<<<END_WIKI_PAGE>>>\n' +
    '<<<WIKI_PAGE path="components/b.md">>>\n---\nTitle: B\nStatus: draft\n---\n\n# B\n\nBody B.\n<<<END_WIKI_PAGE>>>\n';
  const parsed = parseBatchResponse(reply, ["components/a.md", "components/b.md"]);
  expect(parsed.size).toBe(2);
  expect(parsed.get("components/a.md")).toBe("---\nTitle: A\nStatus: draft\n---\n\n# A\n\nBody A.");
  expect(parsed.get("components/b.md")).toBe("---\nTitle: B\nStatus: draft\n---\n\n# B\n\nBody B.");
});

test("parseBatchResponse — a page whose start marker is missing from the text is simply absent (no throw)", () => {
  const reply =
    '<<<WIKI_PAGE path="components/a.md">>>\n---\nTitle: A\nStatus: draft\n---\n\n# A\n\nBody A.\n<<<END_WIKI_PAGE>>>\n';
  const parsed = parseBatchResponse(reply, ["components/a.md", "components/missing.md"]);
  expect(parsed.has("components/a.md")).toBe(true);
  expect(parsed.has("components/missing.md")).toBe(false);
  expect(parsed.size).toBe(1);
});

test("parseBatchResponse — a missing end marker takes the rest of the text instead of throwing or truncating", () => {
  const reply =
    '<<<WIKI_PAGE path="components/a.md">>>\n---\nTitle: A\nStatus: draft\n---\n\n# A\n\nBody A, no end marker.';
  const parsed = parseBatchResponse(reply, ["components/a.md"]);
  expect(parsed.get("components/a.md")).toBe("---\nTitle: A\nStatus: draft\n---\n\n# A\n\nBody A, no end marker.");
});

// --- batchGroupKey: sibling-grouping heuristic (T9) -------------------------

test("batchGroupKey — pages whose key files share the first two path segments get the same key", () => {
  const a = lightItem("components/a.md", "A", ["src/wiki/enrich.ts"]);
  const b = lightItem("components/b.md", "B", ["src/wiki/staleness.ts"]);
  expect(batchGroupKey(a)).toBe(batchGroupKey(b));
  expect(batchGroupKey(a)).toBe("src/wiki");
});

test("batchGroupKey — pages whose key files live under different module paths get different keys", () => {
  const a = lightItem("components/a.md", "A", ["src/alpha/a.ts"]);
  const b = lightItem("components/b.md", "B", ["src/beta/a.ts"]);
  expect(batchGroupKey(a)).not.toBe(batchGroupKey(b));
  expect(batchGroupKey(a)).toBe("src/alpha");
  expect(batchGroupKey(b)).toBe("src/beta");
});

test("batchGroupKey — a page with no key files falls back to grouping by pageType", () => {
  const item = lightItem("decisions/d1.md", "D1", []);
  expect(batchGroupKey(item)).toBe(item.page.pageType);
});

// --- Deep tier: happy path (T7 wiring) and AC5 budget-exhaustion fallback --

test("deep tier — a page classified deep (fan-in) is enriched via enrichPageDeep and cached", async () => {
  const root = await seedRlmRoot([{ from: "src/beta/a.ts", to: "src/alpha/a.ts" }]);
  await writeWikiConfig(root, {
    rlm: {
      enabled: true,
      classify: { skipMaxBytes: 0, deepMinPageRank: 0.99, deepMinFanIn: 1 },
      deep: { maxToolCalls: 5, maxRuntimeMs: 5_000 },
    },
  });
  try {
    const replyText =
      "---\nTitle: Alpha\nStatus: draft\n---\n\n# Alpha\n\nDeep enriched prose about src/alpha with enough " +
      "length to pass validation checks cleanly.\n";
    const factory: ProviderFactory = () => stubProvider(replyText);

    const result = await wikiEnrich({
      cwd: root,
      page: "components/src-alpha.md",
      providerFactory: factory,
      validate: false,
    });

    expect(result.pages).toHaveLength(1);
    const entry = result.pages[0]!;
    expect(entry.action).toBe("enriched");
    expect(entry.tier).toBe("deep");
    expect(entry.deepToolCalls).toBe(0);
    expect(entry.nodeHash).toBeDefined();

    const written = await readFile(
      path.join(root, ".metaproject", "wiki", "components", "src-alpha.md"),
      "utf8",
    );
    expect(written).toContain("Deep enriched prose");
    // Flow 194 / issue #391: enrich never promotes a page's Status itself —
    // this page started `Status: draft` and must remain draft after enrich.
    expect(written).toMatch(/Status:\s*draft/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC5 — a deep child that exhausts its runtime budget falls back without failing the run", async () => {
  const root = await seedRlmRoot([{ from: "src/beta/a.ts", to: "src/alpha/a.ts" }]);
  await writeWikiConfig(root, {
    rlm: {
      enabled: true,
      classify: { skipMaxBytes: 0, deepMinPageRank: 0.99, deepMinFanIn: 1 },
      deep: { maxToolCalls: 5, maxRuntimeMs: 50 },
    },
  });
  try {
    const result = await wikiEnrich({
      cwd: root,
      page: "components/src-alpha.md",
      providerFactory: hangingProviderFactory(),
    });

    expect(result.failed).toBe(0); // AC5: the run never fails outright.
    expect(result.pages).toHaveLength(1);
    const entry = result.pages[0]!;
    expect(entry.action).toBe("skipped");
    expect(entry.tier).toBe("deep");
    expect(entry.reason).toMatch(/deep enrich fallback/i);
    expect(entry.reason).toMatch(/timed out/i);
    expect(entry.nodeHash).toBeUndefined(); // never cached — a future run gets another attempt.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- T10 finding #2: isolation — one page's provider exception must not ---
// --- crash the whole run or lose other pages' progress ---------------------
//
// The RLM-off worker (the `if (!wikiConfig.rlm.enabled)` branch in
// `enrich.ts`) has always wrapped its whole per-page body in try/catch. The
// RLM-mode paths (`runLightBatch`'s `runModelTurn` call, `finishSuccess`'s
// `writeFile`, `runRlmPipeline`'s `mapPool` worker) did not, so a single
// unhandled exception — e.g. a `providerFactory`/`port.stream()` throw that
// `runModelTurn` does not itself catch (distinct from a normalized
// `turn.error`, which was already handled) — propagated out of `mapPool`'s
// `Promise.all` and failed `wikiEnrich()` for every page in the run,
// including ones that had already succeeded earlier in the same batch.

async function seedThreeModuleRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-rlm-isolation-"));
  const graphDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(graphDir, { recursive: true });
  const modules = ["alpha", "beta", "gamma"];
  // Two files per module, not one: `service.ts`'s `MIN_MODULE_FILES = 2`
  // filters out any module with fewer files before it ever becomes a wiki
  // page candidate (mirrors `seedRlmRoot`'s own two-file-per-module shape
  // above).
  await writeFile(
    path.join(graphDir, "nodes.jsonl"),
    jsonl(
      modules.flatMap((m) => [
        { id: `src/${m}/a.ts`, kind: "file", path: `src/${m}/a.ts`, language: "typescript" },
        { id: `src/${m}/b.ts`, kind: "file", path: `src/${m}/b.ts`, language: "typescript" },
      ]),
    ),
    "utf8",
  );
  await writeFile(path.join(graphDir, "edges.jsonl"), "", "utf8");
  for (const m of modules) {
    await mkdir(path.join(root, "src", m), { recursive: true });
    await writeFile(path.join(root, "src", m, "a.ts"), `export const a = "${m}";\n`, "utf8");
    await writeFile(path.join(root, "src", m, "b.ts"), `export const b = "${m}";\n`, "utf8");
  }
  await wikiCollect({ cwd: root });
  // `wikiCollect` always ALSO generates an `architecture/project-map.md`
  // draft page (unconditional, independent of module count) — remove it so
  // a default (no `page` filter) `wikiEnrich` run below only ever sees the
  // three component pages this helper is actually about.
  await rm(path.join(root, ".metaproject", "wiki", "architecture", "project-map.md"), { force: true });
  return root;
}

/**
 * A provider whose `stream()` throws SYNCHRONOUSLY (not a normalized
 * `provider_error` event) whenever the outgoing user prompt matches
 * `failMarker` — simulating an unhandled provider/network exception, the
 * exact class of failure `runModelTurn` does not itself catch. Every other
 * request gets a normal, valid reply.
 */
function flakyProviderFactory(goodReply: string, failMarker: string): ProviderFactory {
  const description: ProviderDescription = {
    capabilities: {
      streaming: true,
      toolCalls: false,
      parallelToolCalls: false,
      structuredOutput: false,
      reasoningMetadata: false,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    },
    descriptor: { providerId: "flaky" },
  };
  const provider: ProviderPort = {
    describe: () => description,
    stream(request, opts): AsyncIterable<NormalizedEvent> {
      const userText = request.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");
      if (userText.includes(failMarker)) {
        throw new Error("simulated provider network failure");
      }
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: goodReply };
        yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
      })();
    },
  };
  return () => provider;
}

test("T10 finding #2 — one page's provider exception fails only that page; the run does not throw and other pages' progress is kept", async () => {
  const root = await seedThreeModuleRoot();
  try {
    // Batching disabled so each page gets its OWN model call — proves the
    // failure is isolated to the ONE page whose call throws, not shared
    // across a batch of siblings (that would be correct too, but this
    // isolates the specific bug: an exception escaping past this unit).
    await writeWikiConfig(root, {
      rlm: { enabled: true, classify: { skipMaxBytes: 0 }, batch: { enabled: false } },
    });

    const GOOD_PAGE =
      "---\nTitle: Enriched\nStatus: draft\n---\n\n# Enriched\n\nFull prose body with enough text for " +
      "validation checks to pass cleanly.\n";
    const result = await wikiEnrich({
      cwd: root,
      providerFactory: flakyProviderFactory(GOOD_PAGE, "src/beta"),
      validate: false,
    });

    // Reaching this line at all proves `wikiEnrich` did not throw/reject.
    // Only the one page whose call threw is "failed" — the run is not
    // failed wholesale (finding #2's core bug).
    expect(result.failed).toBe(1);
    expect(result.enriched).toBe(2);

    const byPath = new Map(result.pages.map((p) => [p.path, p]));
    const failedEntry = byPath.get("components/src-beta.md");
    expect(failedEntry?.action).toBe("failed");
    expect(failedEntry?.reason).toMatch(/provider error/i);
    expect(byPath.get("components/src-alpha.md")?.action).toBe("enriched");
    expect(byPath.get("components/src-gamma.md")?.action).toBe("enriched");

    // The two successful pages were actually written...
    const alphaContent = await readFile(path.join(root, ".metaproject", "wiki", "components", "src-alpha.md"), "utf8");
    const gammaContent = await readFile(path.join(root, ".metaproject", "wiki", "components", "src-gamma.md"), "utf8");
    expect(alphaContent).toContain("Full prose body");
    expect(gammaContent).toContain("Full prose body");

    // ...and their resume/staleness-hash progress was NOT lost despite the
    // OTHER page's failure in the same run (finding #2's specific "loses
    // resume/staleness-hash progress for every OTHER page" concern).
    const resumePath = path.join(root, ".metaproject", "data", "wiki", "enrich-resume.json");
    const resumeRaw = JSON.parse(await readFile(resumePath, "utf8")) as {
      completed: string[];
      completedNodeHashes?: Record<string, string>;
    };
    expect(resumeRaw.completed).toContain("components/src-alpha.md");
    expect(resumeRaw.completed).toContain("components/src-gamma.md");
    expect(resumeRaw.completed).not.toContain("components/src-beta.md");
    expect(resumeRaw.completedNodeHashes?.["components/src-alpha.md"]).toBeDefined();
    expect(resumeRaw.completedNodeHashes?.["components/src-gamma.md"]).toBeDefined();
    expect(resumeRaw.completedNodeHashes?.["components/src-beta.md"]).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T10 finding #2 — a writeFile failure for one deep-tier page does not fail the run or a sibling page's progress", async () => {
  // Distinct code path from the light-batch test above: exercises
  // `runDeepSingle`'s guard around `finishSuccess`'s `writeFile`, not
  // `runLightBatch`'s guard around `runModelTurn`. Makes ONE page's on-disk
  // file read-only (mode 0o444) so `writeFile` throws EACCES for it
  // specifically at write time, while `collectPages`' initial scan (a
  // `readFile`, unaffected by a read-only mode bit) still finds all three
  // pages fine, and the OTHER two deep-tier pages write normally.
  const root = await seedThreeModuleRoot();
  try {
    await writeWikiConfig(root, {
      rlm: {
        enabled: true,
        classify: { skipMaxBytes: 0, deepMinPageRank: 0, deepMinFanIn: 0 }, // everything classifies deep
        deep: { maxToolCalls: 5, maxRuntimeMs: 5_000 },
      },
    });

    const betaPath = path.join(root, ".metaproject", "wiki", "components", "src-beta.md");
    await chmod(betaPath, 0o444);

    const replyText =
      "---\nTitle: Enriched\nStatus: draft\n---\n\n# Enriched\n\nDeep enriched prose with enough length to pass.\n";
    const result = await wikiEnrich({
      cwd: root,
      providerFactory: () => stubProvider(replyText),
      validate: false,
    });

    // The run itself must not throw/reject (already implied by reaching
    // here), and only the one page whose write threw is "failed".
    expect(result.pages).toHaveLength(3);
    const byPath = new Map(result.pages.map((p) => [p.path, p]));
    expect(byPath.get("components/src-beta.md")?.action).toBe("failed");
    expect(byPath.get("components/src-alpha.md")?.action).toBe("enriched");
    expect(byPath.get("components/src-gamma.md")?.action).toBe("enriched");
    expect(result.failed).toBe(1);
    expect(result.enriched).toBe(2);
  } finally {
    await chmod(path.join(root, ".metaproject", "wiki", "components", "src-beta.md"), 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
