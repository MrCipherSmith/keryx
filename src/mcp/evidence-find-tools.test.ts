// AFC (flow 240) — `wiki.evidence` and `gdgraph.find` on the MCP boundary.
//
// MEASURED BEFORE THIS LANE, by enumerating `buildToolRegistry()`: forty-one
// tools, none of them named `find`, none of them named `evidence`. An MCP
// client could ask `wiki.ask` for prose and `gdgraph.affected` for a blast
// radius it already had a path for, and had no way at all to reach either the
// evidence envelope or the explainable seed search.
//
// These two entries return the STRUCTURED value, not the agent's rendered
// text: an MCP caller branches on `status`/`code` in JSON. The unified
// `toMcpTools` projection renders through the descriptor's own `invoke`, which
// is right for a model reading text and wrong for a client parsing a result —
// hence a second, structured entry for each.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildToolRegistry } from "./tools";
// The renderer's own field registry, imported rather than re-typed: a hand
// written copy of the envelope's fields in a test is the same drift the
// projection itself must not have.
import { EVIDENCE_ITEM_FIELDS } from "../harness/tool/metaproject-operations";
// `gdgraph.find` reads a BUILT graph off disk (`loadGraph` ->
// `.metaproject/data/gdgraph/storage/*.jsonl`), never the module's in-memory
// state. This repository's own `.metaproject/data/gdgraph/storage` is
// `.gitignore`d (`.metaproject/data/**/storage/`) and exists only on a machine
// where `keryx gdgraph build` happened to run — this repository's checked-out
// state is not this test's to depend on, and CI checks out a clean tree with
// no such directory. So the tests that exercise `gdgraph.find` build THEIR OWN
// graph, over a fixture project they own and tear down (`graphFixture` below).
import { buildGraph } from "../gdgraph/build";

function tool(name: string) {
  const found = buildToolRegistry().find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`MCP tool "${name}" is not registered`);
  }
  return found;
}

const RULE_PAGE = `<!-- keryx:page id="retry-policy" v=1 -->
# Retry Policy

Version: 2.0.0
Type: business-rule
Status: accepted

## Summary

Delivery retry limits for outbound webhooks.

<!-- keryx:section id="retry-limit" v=1 -->
## Webhook retry limit

Claim-Type: instruction
Conflicts-With: keryx:page/retry-history#retry-limit-old

A failed webhook delivery is retried at most three times, then parked.
<!-- /keryx:section -->
`;

const HISTORY_PAGE = `<!-- keryx:page id="retry-history" v=1 -->
# Retry Decision Record

Version: 1.0.0
Type: decision
Status: accepted

## Summary

The earlier accepted webhook retry decision.

<!-- keryx:section id="retry-limit-old" v=1 -->
## Webhook retry limit

A failed webhook delivery is retried at most ten times before it is parked.
<!-- /keryx:section -->
`;

function filler(slug: string, words: string[]): string {
  return `<!-- keryx:page id="${slug}" v=1 -->
# ${slug}

Version: 1.0.0
Type: architecture
Status: accepted

## Summary

${slug} covers ${words.join(", ")}.

<!-- keryx:section id="${slug}-detail" v=1 -->
## Details

The ${words[0]} subsystem coordinates ${words[1]} and reports ${words[2]}.
<!-- /keryx:section -->
`;
}

async function wikiFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-mcp-evidence-"));
  const pages: Record<string, string> = {
    "architecture/telemetry.md": filler("telemetry", ["telemetry", "sampling", "counters"]),
    "architecture/storage.md": filler("storage", ["storage", "compaction", "segments"]),
    "architecture/scheduler.md": filler("scheduler", ["scheduler", "leases", "partitions"]),
    "architecture/routing.md": filler("routing", ["routing", "affinity", "shards"]),
    "business-rules/retry-policy.md": RULE_PAGE,
    "decisions/retry-history.md": HISTORY_PAGE,
  };
  for (const [relative, content] of Object.entries(pages)) {
    const absolute = path.join(root, ".metaproject", "wiki", relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return root;
}

/**
 * A tiny project this test owns, with a real graph built over it —
 * `gdgraph.find` matches file PATHS, so the fixture's paths carry the terms
 * these tests query for. None of them carries "kubernetes"/"helm"/"chart"/
 * "ingress" — the no-match probe below relies on that absence, not on
 * anything about the real repository's contents.
 */
async function graphFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-mcp-find-"));
  const files: Record<string, string> = {
    "src/retrieval/codes-vocabulary.ts": "export const vocabulary = 'retrieval codes';\n",
    "src/retrieval/codes-index.ts": "export const codes = 'retrieval index';\n",
    "src/other/unrelated-module.ts": "export const noop = true;\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  await buildGraph(root);
  return root;
}

test("both tools are registered, read-only, and declare their required input", () => {
  const evidence = tool("wiki.evidence");
  expect(evidence.module).toBe("wiki");
  expect(evidence.mutating).toBe(false);
  expect(evidence.inputSchema).toMatchObject({ required: ["question"] });

  const find = tool("gdgraph.find");
  expect(find.module).toBe("gdgraph");
  expect(find.mutating).toBe(false);
  expect(find.inputSchema).toMatchObject({ required: ["query"] });
});

test("wiki.evidence returns the envelope STRUCTURED and whole, not a summary of it", async () => {
  const root = await wikiFixture();
  try {
    const result = (await tool("wiki.evidence").invoke(
      root,
      { question: "webhook retry limit" },
      undefined,
    )) as Record<string, unknown>;

    expect(result.status).toBe("ok");
    // The envelope's own top-level shape, verbatim — a re-map here would be a
    // second place for a field to go missing.
    expect(Object.keys(result).sort()).toEqual([
      "items",
      "omittedOptional",
      "overflow",
      "partial",
      "reason",
      "refused",
      "status",
      "suggestion",
    ]);

    const items = result.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    const first = items[0];
    expect(first).toBeDefined();
    if (!first) return;
    // Every field of the envelope, not the five a hand-written re-map
    // remembers — compared against the registry, not against a list retyped
    // here.
    expect(Object.keys(first).sort()).toEqual([...EVIDENCE_ITEM_FIELDS].sort());
    expect(EVIDENCE_ITEM_FIELDS.length).toBe(15);

    // Both sides of the disagreement, each naming the other.
    const refs = items.flatMap((item) =>
      (item.conflictRefs as Array<{ ref: string }>).map((entry) => entry.ref),
    );
    expect(refs).toContain("keryx:page/retry-history");
    expect(refs).toContain("keryx:page/retry-policy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wiki.evidence reports a mandatory overflow as budget-exceeded with no items", async () => {
  const root = await wikiFixture();
  try {
    const result = (await tool("wiki.evidence").invoke(
      root,
      { question: "webhook retry limit", budgetTokens: 1 },
      undefined,
    )) as Record<string, unknown>;
    expect(result.status).toBe("budget-exceeded");
    expect(result.items).toEqual([]);
    expect(result.overflow).toMatchObject({ code: "context_overflow" });
    expect(typeof result.requiredRef).toBe("string");
    // Not a shorter answer: nothing from the excerpt is carried in the refusal.
    expect(JSON.stringify(result)).not.toContain("three times");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gdgraph.find returns the outcome CODE, so a client can branch instead of parsing prose", async () => {
  const root = await graphFixture();
  try {
    const found = (await tool("gdgraph.find").invoke(
      root,
      { query: "retrieval codes vocabulary", fileLimit: 2 },
      undefined,
    )) as Record<string, unknown>;
    expect(found.code).toBe("ok");
    expect(found.query).toBe("retrieval codes vocabulary");
    const files = found.files as Array<Record<string, unknown>>;
    expect(files.length).toBeGreaterThan(0);
    // The per-candidate explanation, not just a ranked path list.
    expect(files[0]).toHaveProperty("matched");
    expect(files[0]).toHaveProperty("discriminating");
    expect(files[0]).toHaveProperty("reason");

    const nothing = (await tool("gdgraph.find").invoke(
      root,
      { query: "kubernetes helm chart ingress" },
      undefined,
    )) as Record<string, unknown>;
    // A completed search that found nothing is `no-match` — a different answer
    // from an index that could not answer at all, which is the whole point.
    expect(nothing.code).toBe("no-match");
    expect(nothing.nextActions).toEqual([
      'keryx ctx rg "<pattern>" — text search over file contents',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gdgraph.find rejects a page size below 1 instead of answering confidently", async () => {
  // MEASURED BEFORE THIS FIX (flow 235, T15). `fileLimit` was declared as a
  // bare `number` with no `minimum`, and the invoke accepted any number:
  //
  //   fileLimit: 0   -> code "ok", reason "0 files and 0 symbols matched."
  //   fileLimit: -1  -> code "ok", reason "39 files and 0 symbols matched."
  //
  // over a corpus that held forty. The scan half is now fixed in
  // `../gdgraph/find.ts`, but a caller asking for zero results and silently
  // getting twenty is still a lie of a different kind, so the boundary refuses.
  const root = await graphFixture();
  try {
    for (const bad of [0, -1, -20, 1.5, "3", true]) {
      await expect(
        tool("gdgraph.find").invoke(root, { query: "retrieval codes", fileLimit: bad }, undefined),
      ).rejects.toThrow(/fileLimit must be an integer of at least 1/);
      await expect(
        tool("gdgraph.find").invoke(
          root,
          { query: "retrieval codes", symbolLimit: bad },
          undefined,
        ),
      ).rejects.toThrow(/symbolLimit must be an integer of at least 1/);
    }

    // Absent stays absent — the default page size, not an error.
    const fine = (await tool("gdgraph.find").invoke(
      root,
      { query: "retrieval codes vocabulary" },
      undefined,
    )) as Record<string, unknown>;
    expect(fine.code).toBe("ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("both find boundaries declare the same lower bound on their page sizes", async () => {
  // The MCP entry drifted from its sibling: `metaproject-operations`'
  // `graph_find` has declared `{ type: "integer", minimum: 1 }` and checked
  // `> 0` since it was written; this one declared a bare `number`. Comparing
  // the two schemas rather than restating one of them means the next drift
  // fails here instead of being found by a third verifier.
  const { METAPROJECT_OPERATIONS } = await import("../harness/tool/metaproject-operations");
  const sibling = METAPROJECT_OPERATIONS.find((op) => op.name === "graph_find");
  expect(sibling).toBeDefined();
  const siblingProps = (sibling?.inputSchema as { properties: Record<string, unknown> }).properties;
  const mcpProps = (tool("gdgraph.find").inputSchema as { properties: Record<string, unknown> })
    .properties;

  for (const key of ["fileLimit", "symbolLimit"]) {
    expect(mcpProps[key]).toMatchObject({ type: "integer", minimum: 1 });
    expect(siblingProps[key]).toMatchObject({ type: "integer", minimum: 1 });
  }
});

test("gdgraph.find over a directory with no graph is index-incomplete, never no-match", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "gd-mcp-find-nograph-"));
  try {
    const result = (await tool("gdgraph.find").invoke(empty, { query: "anything" }, undefined)) as
      Record<string, unknown>;
    expect(result.code).toBe("index-incomplete");
    expect(result.code).not.toBe("no-match");
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
