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

const REPO_ROOT = path.join(import.meta.dir, "..", "..");

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
  const found = (await tool("gdgraph.find").invoke(
    REPO_ROOT,
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
    REPO_ROOT,
    { query: "kubernetes helm chart ingress" },
    undefined,
  )) as Record<string, unknown>;
  // A completed search that found nothing is `no-match` — a different answer
  // from an index that could not answer at all, which is the whole point.
  expect(nothing.code).toBe("no-match");
  expect(nothing.nextActions).toEqual([
    'keryx ctx rg "<pattern>" — text search over file contents',
  ]);
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
