// Parameter parity between a metaproject tool and the `keryx` verb it wraps
// (flow 136, AC1 + AC2).
//
// The rule: a tool that wraps a CLI verb exposes that verb's arguments. It is not
// a style preference. `graph_affected` took `{ file }` while `keryx gdgraph
// affected` takes `--depth` and `--ranked`, so when benchmark case A1 asked for
// dependents "directly and transitively" the model could not ask the tool — it
// shelled out, hit default-deny, and the run ended with no answer. A tool weaker
// than its own CLI teaches the model to bypass it.
//
// The enumeration below does NOT trust the descriptors' `cliParity` tables. It
// reads each verb's handler out of the command source and fails when the handler
// consults an option the table does not account for, so widening the CLI without
// widening the tool breaks the build instead of the next agent run.

import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { computeAffected } from "../../gdgraph/affected";
import type { GraphData } from "../../gdgraph/types";
import { createMetaprojectAdapter } from "./metaproject-adapter";
import type { MetaprojectPort } from "./metaproject-port";
import { METAPROJECT_OPERATIONS, toInteractiveTools } from "./metaproject-operations";
import { builtinMetaprojectTools } from "./builtin/metaproject-tools";

const REPO_ROOT = path.join(import.meta.dir, "..", "..", "..");

/**
 * Extract the body of a named top-level function, or of the `if (<guard>) { … }`
 * block a verb is dispatched from, by brace counting from the first `{` after the
 * anchor. Good enough to be exact for this codebase's command routers and, unlike
 * a whole-file scan, it cannot borrow a sibling verb's flags.
 */
function extractBlock(source: string, anchor: string): string {
  const at = source.indexOf(anchor);
  if (at < 0) {
    throw new Error(`parity: anchor not found in source: ${anchor}`);
  }
  const open = source.indexOf("{", at);
  if (open < 0) {
    throw new Error(`parity: no block after anchor: ${anchor}`);
  }
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, i + 1);
      }
    }
  }
  throw new Error(`parity: unbalanced block after anchor: ${anchor}`);
}

/** Every `--flag` string literal the block reads. */
function flagsIn(block: string): string[] {
  return [...new Set([...block.matchAll(/"(--[a-z][a-z0-9-]*)"/g)].map((m) => m[1] ?? ""))].sort();
}

/** Property names a JSON Schema object declares. */
function schemaProperties(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  return properties !== null && typeof properties === "object" ? Object.keys(properties) : [];
}

test("every metaproject operation declares the CLI verb it wraps", () => {
  for (const op of METAPROJECT_OPERATIONS) {
    expect(op.cliParity).toBeDefined();
    if (op.cliParity.verb === null) {
      // A tool with no wrapped verb has to say why, so "no parity contract" is a
      // decision on the record rather than an omission.
      expect(op.cliParity.reason.length).toBeGreaterThan(0);
    } else {
      expect(op.cliParity.verb.length).toBeGreaterThan(0);
      // The declared source must be the command module the verb lives in, so a
      // parity table pointed at the wrong file cannot pass by scanning a stranger.
      expect(op.cliParity.source).toBe(`src/commands/${op.cliParity.verb.split(" ")[0] ?? ""}.ts`);
    }
  }
});

test("AC2: no metaproject tool accepts a strict subset of its CLI verb's arguments", () => {
  const checked: string[] = [];
  for (const op of METAPROJECT_OPERATIONS) {
    const parity = op.cliParity;
    if (parity.verb === null) {
      continue;
    }
    const source = readFileSync(path.join(REPO_ROOT, parity.source), "utf8");
    const anchor =
      "fn" in parity.handler ? `function ${parity.handler.fn}` : `if (${parity.handler.guard})`;
    const blocks = [
      extractBlock(source, anchor),
      ...(parity.helpers ?? []).map((helper) => extractBlock(source, `function ${helper}`)),
    ];
    const cliFlags = [...new Set(blocks.flatMap((block) => flagsIn(block)))].sort();
    const declared = new Set([...Object.keys(parity.expresses), ...(parity.presentation ?? [])]);
    const properties = new Set(schemaProperties(op.inputSchema));

    for (const flag of cliFlags) {
      expect(
        declared.has(flag),
        `${op.name} wraps \`keryx ${parity.verb}\`, which reads ${flag}, but the tool's ` +
          "cliParity declares neither a mapping for it nor that it is presentation-only",
      ).toBe(true);
    }
    for (const [flag, property] of Object.entries(parity.expresses)) {
      expect(
        properties.has(property),
        `${op.name} maps ${flag} to input property "${property}", which its inputSchema does not declare`,
      ).toBe(true);
    }
    checked.push(op.name);
  }
  // Guards the enumeration itself: a descriptor list that quietly emptied would
  // otherwise make this test pass by checking nothing.
  expect(checked.length).toBeGreaterThanOrEqual(10);
  expect(checked).toContain("graph_affected");
  expect(checked).toContain("memory_search");
  expect(checked).toContain("graph_symbol");
});

test("AC1: graph_affected declares depth and ranked and passes both to the port", async () => {
  const affected = METAPROJECT_OPERATIONS.find((op) => op.name === "graph_affected");
  expect(affected).toBeDefined();
  const properties = schemaProperties(affected?.inputSchema ?? {});
  expect(properties).toContain("depth");
  expect(properties).toContain("ranked");

  const seen: Array<{ target: string; depth?: number; ranked?: boolean }> = [];
  const port = {
    async graphAffected(input: { target: string; depth?: number; ranked?: boolean }) {
      seen.push(input);
      return { target: input.target, depth: input.depth ?? 1, ranked: input.ranked ?? false, affected: [] };
    },
  } as unknown as MetaprojectPort;

  await affected?.invoke(port, { file: "src/a.ts", depth: 2, ranked: true });
  expect(seen[0]).toEqual({ target: "src/a.ts", depth: 2, ranked: true });

  // Omitted stays omitted: the tool must not invent a depth the caller did not
  // ask for, or the port loses its own default.
  await affected?.invoke(port, { file: "src/a.ts" });
  expect(seen[1]).toEqual({ target: "src/a.ts" });
});

/**
 * a ← b ← c: `b` depends on `a`, `c` depends on `b`. So `a` has one dependent at
 * depth 1 and two at depth 2 — the transitive dependent A1 asked for.
 */
function chainGraph(): GraphData {
  const file = (p: string) => ({ id: p, kind: "file" as const, path: p, language: "typescript" as const });
  const edge = (from: string, to: string) => ({
    id: `${from}->${to}`,
    from,
    to,
    kind: "imports" as const,
    specifier: to,
  });
  return {
    nodes: [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")],
    edges: [edge("src/b.ts", "src/a.ts"), edge("src/c.ts", "src/b.ts")],
  };
}

test("AC1: depth 2 returns the transitive dependent that depth 1 does not", async () => {
  const graph = chainGraph();
  const port = createMetaprojectAdapter("/fixture", {
    createGdgraphService: () =>
      ({
        // The REAL depth-limited traversal over a fixture graph — a fake that
        // reimplemented the hop logic would be testing itself.
        affected: async (_cwd: string, target: string, options?: { depth?: number; ranked?: boolean }) =>
          computeAffected(graph, target, { depth: options?.depth ?? 1, ranked: options?.ranked ?? false }),
        loadGraph: async () => graph,
      }) as never,
  });
  const tools = toInteractiveTools(METAPROJECT_OPERATIONS, port);
  const graphAffected = tools.find((tool) => tool.definition.name === "graph_affected");
  expect(graphAffected).toBeDefined();

  const depth1 = await graphAffected?.invoke({ file: "src/a.ts", depth: 1 });
  const depth2 = await graphAffected?.invoke({ file: "src/a.ts", depth: 2 });

  expect(depth1?.isError).toBe(false);
  expect(depth2?.isError).toBe(false);
  expect(depth1?.output).toContain("src/b.ts");
  expect(depth1?.output).not.toContain("src/c.ts");
  expect(depth2?.output).toContain("src/b.ts");
  expect(depth2?.output).toContain("src/c.ts");
  expect(depth2?.output).not.toBe(depth1?.output);
});

test("AC2: the subprocess fallback forwards depth, ranked and the memory filters", async () => {
  const invocations: string[][] = [];
  const tools = builtinMetaprojectTools("/fixture", async (args) => {
    invocations.push(args);
    return { output: "ok", isError: false };
  });

  const graphAffected = tools.find((tool) => tool.definition.name === "graph_affected");
  await graphAffected?.invoke({ file: "src/a.ts", depth: 3, ranked: true });
  expect(invocations[0]).toEqual(["gdgraph", "affected", "src/a.ts", "--depth", "3", "--ranked"]);

  const memorySearch = tools.find((tool) => tool.definition.name === "memory_search");
  await memorySearch?.invoke({ query: "sandbox", module: "harness", status: "accepted", limit: 5 });
  expect(invocations[1]).toEqual([
    "memory",
    "search",
    "sandbox",
    "--module",
    "harness",
    "--status",
    "accepted",
    "--limit",
    "5",
  ]);

  // Absent filters add no flags — the default invocation is unchanged.
  await memorySearch?.invoke({ query: "sandbox" });
  expect(invocations[2]).toEqual(["memory", "search", "sandbox"]);
});

test("AC2: memory_search, graph_symbol, repomap and wiki_ask forward their widened inputs", async () => {
  const calls: Record<string, unknown> = {};
  const port = {
    async memorySearch(input: unknown) {
      calls.memorySearch = input;
      return { query: "q", hits: [] };
    },
    async graphSymbol(input: unknown) {
      calls.graphSymbol = input;
      return { name: "f", definitions: [], callers: [], callees: [] };
    },
    async repomap(input: unknown) {
      calls.repomap = input;
      return { budget: 1, files: [], tokens: 0, omitted: 0 };
    },
    async wikiAsk(input: unknown) {
      calls.wikiAsk = input;
      return { question: "q", citations: [], answer: "a" };
    },
  } as unknown as MetaprojectPort;

  const byName = new Map(METAPROJECT_OPERATIONS.map((op) => [op.name, op]));
  await byName.get("memory_search")?.invoke(port, {
    query: "q",
    module: "m",
    entity: "e",
    status: "accepted",
    class: "semantic",
    limit: 7,
    asOf: "2026-01-01",
    semantic: true,
  });
  expect(calls.memorySearch).toEqual({
    query: "q",
    module: "m",
    entity: "e",
    status: "accepted",
    class: "semantic",
    limit: 7,
    asOf: "2026-01-01",
    semantic: true,
  });

  await byName.get("graph_symbol")?.invoke(port, { name: "f", impact: true, depth: 4 });
  expect(calls.graphSymbol).toEqual({ name: "f", impact: true, depth: 4 });

  await byName.get("repomap")?.invoke(port, { budget: 2000, seed: ["src/a.ts"] });
  expect(calls.repomap).toEqual({ budget: 2000, seed: ["src/a.ts"] });

  await byName.get("wiki_ask")?.invoke(port, { question: "q", k: 3, rerank: true });
  expect(calls.wikiAsk).toEqual({ question: "q", k: 3, rerank: true });
});
