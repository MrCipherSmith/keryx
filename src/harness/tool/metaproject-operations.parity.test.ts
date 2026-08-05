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

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { computeAffected } from "../../gdgraph/affected";
import type { GraphData } from "../../gdgraph/types";
import { createMetaprojectAdapter } from "./metaproject-adapter";
import type { MetaprojectPort } from "./metaproject-port";
import { METAPROJECT_OPERATIONS, toInteractiveTools } from "./metaproject-operations";
import {
  forwardedRgOptions,
  RG_FORWARDED_VALUE_FLAGS,
  SEARCH_TOOL_REJECTED_OPTIONS,
} from "../../lib/rg-options";
import { builtinMetaprojectTools } from "./builtin/metaproject-tools";

const REPO_ROOT = path.join(import.meta.dir, "..", "..", "..");

/**
 * Extract the body of a named top-level function, of the `if (<guard>) { … }`
 * block a verb is dispatched from, or of an exported constant's initialiser, by
 * brace/bracket counting from the anchor.
 *
 * The anchor must be UNIQUE. The first version used `indexOf("function
 * runSymbol")`, which prefix-matched `runSymbolsCapability` earlier in the same
 * file and scanned a function that reads no options at all — so `graph_symbol`'s
 * parity passed by luck rather than by check. A substring that names two things
 * names neither.
 */
function extractBlock(source: string, anchor: string, open: "{" | "[" = "{"): string {
  const close = open === "{" ? "}" : "]";
  const occurrences = source.split(anchor).length - 1;
  if (occurrences === 0) {
    throw new Error(`parity: anchor not found in source: ${anchor}`);
  }
  if (occurrences > 1) {
    throw new Error(
      `parity: anchor "${anchor}" matches ${occurrences} places; it must identify exactly one`,
    );
  }
  const at = source.indexOf(anchor);
  const start = source.indexOf(open, at);
  if (start < 0) {
    throw new Error(`parity: no ${open} block after anchor: ${anchor}`);
  }
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`parity: unbalanced block after anchor: ${anchor}`);
}

/**
 * Every option literal a block reads — SHORT flags included.
 *
 * The first version matched only `/"(--[a-z]…)"/`, so `-g`, `-t`, `-A/-B/-C`,
 * `-i`, `-m`, `-l` and `-c` were invisible for every verb. A parity test that
 * cannot see half the option space is not a parity test; it is a formality that
 * makes the docs' "widening the CLI without widening the tool fails the build"
 * claim false.
 */
function flagsIn(block: string): string[] {
  const matches = [...block.matchAll(/"(-{1,2}[A-Za-z][A-Za-z0-9-]*)"/g)].map((m) => m[1] ?? "");
  return [...new Set(matches)].sort();
}

/**
 * Resolve a SCREAMING_CASE constant referenced by a scanned block to the file
 * that exports it, following `source`'s own import statements.
 *
 * Without this the CLI side of the comparison is only as complete as the
 * declaration: dropping a `passthrough` entry would remove the options from BOTH
 * sides at once and the test would go quiet. Discovering them from the code the
 * verb actually runs is what makes the check adversarial rather than agreeable.
 */
function resolveConstantSource(source: string, sourcePath: string, constant: string): string | undefined {
  if (new RegExp(`export const ${constant}\\b`).test(source)) {
    return sourcePath;
  }
  for (const match of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    const names = (match[1] ?? "").split(",").map((n) => n.trim().split(/\s+as\s+/)[0]?.trim() ?? "");
    if (!names.includes(constant)) {
      continue;
    }
    const specifier = match[2] ?? "";
    if (!specifier.startsWith(".")) {
      continue;
    }
    const resolved = `${path.normalize(path.join(path.dirname(sourcePath), specifier))}.ts`;
    if (existsSync(path.join(REPO_ROOT, resolved))) {
      return resolved;
    }
  }
  return undefined;
}

/** SCREAMING_CASE identifiers a block references (candidate option tables). */
function referencedConstants(block: string): string[] {
  return [...new Set([...block.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map((m) => m[1] ?? ""))];
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
      "fn" in parity.handler ? `function ${parity.handler.fn}(` : `if (${parity.handler.guard})`;
    const blocks = [
      extractBlock(source, anchor),
      ...(parity.helpers ?? []).map((helper) => extractBlock(source, `function ${helper}(`)),
    ];

    // Options the verb keeps in a module-level table rather than in its handler.
    // DISCOVERED from the scanned blocks, not read off the declaration: scanning
    // only the handler missed these entirely (which is how `search_code`
    // declared `expresses: {}` against a verb forwarding forty ripgrep options),
    // and reading them off the declaration would let a dropped declaration
    // remove them from both sides of the comparison at once.
    const tableFlags = new Set<string>();
    const tablesFound: string[] = [];
    for (const constant of blocks.flatMap((block) => referencedConstants(block))) {
      const owner = resolveConstantSource(source, parity.source, constant);
      if (owner === undefined) {
        continue;
      }
      const ownerSource =
        owner === parity.source ? source : readFileSync(path.join(REPO_ROOT, owner), "utf8");
      const initialiser = extractBlock(ownerSource, `export const ${constant}`, "[");
      const flags = flagsIn(initialiser);
      if (flags.length === 0) {
        continue; // not an option table
      }
      tablesFound.push(constant);
      for (const flag of flags) {
        tableFlags.add(flag);
      }
    }

    const cliFlags = [
      ...new Set([...blocks.flatMap((block) => flagsIn(block)), ...tableFlags]),
    ].sort();
    const declared = new Set([
      ...Object.keys(parity.expresses),
      ...(parity.presentation ?? []),
      // Only a DECLARED passthrough excuses a table's options. An undeclared
      // table leaves them in `cliFlags` and out of `declared`, which fails.
      ...(parity.passthrough !== undefined ? tableFlags : []),
    ]);
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
    if (parity.passthrough !== undefined) {
      expect(
        properties.has(parity.passthrough.property),
        `${op.name} forwards its verb's option table through "${parity.passthrough.property}", ` +
          "which its inputSchema does not declare",
      ).toBe(true);
      // Every subtraction from the passthrough must be declared, and declared as
      // one of two DIFFERENT things: routed elsewhere, or not offered. Without
      // this the tool could quietly narrow and the scanner would agree with it.
      for (const option of parity.passthrough.except ?? []) {
        const routed = Object.prototype.hasOwnProperty.call(parity.expresses, option);
        const refused = Object.prototype.hasOwnProperty.call(parity.refuses ?? {}, option);
        expect(
          routed || refused,
          `${op.name} excepts ${option} from its passthrough but says nothing about it: put it in ` +
            "`expresses` (same question, another field) or `refuses` (not offered, with a reason)",
        ).toBe(true);
        if (refused) {
          expect((parity.refuses ?? {})[option]?.length ?? 0).toBeGreaterThan(20);
        }
      }
      expect(
        tableFlags.size,
        `${op.name} declares a passthrough, but no option table was reachable from the code its ` +
          "verb runs — an empty table would make this check vacuous",
      ).toBeGreaterThan(0);
      for (const table of parity.passthrough.options) {
        expect(
          tablesFound,
          `${op.name} declares passthrough table ${table.constant}, which the verb's own code ` +
            "does not reach",
        ).toContain(table.constant);
      }
    }
    checked.push(op.name);
  }
  // Guards the enumeration itself: a descriptor list that quietly emptied would
  // otherwise make this test pass by checking nothing.
  expect(checked.length).toBeGreaterThanOrEqual(10);
  expect(checked).toContain("graph_affected");
  expect(checked).toContain("memory_search");
  expect(checked).toContain("graph_symbol");
  expect(checked).toContain("search_code");
});

test("the parity scanner sees short flags and refuses an ambiguous anchor", () => {
  // Both guards are here because both were broken and neither failed anything.
  expect(flagsIn('const t = ["-g", "--glob", "-A", "--max-depth"];')).toEqual([
    "--glob",
    "--max-depth",
    "-A",
    "-g",
  ]);
  // `function runSymbol` is a prefix of `function runSymbolsCapability`; the
  // scanner must refuse rather than pick whichever comes first.
  const gdgraph = readFileSync(path.join(REPO_ROOT, "src/commands/gdgraph.ts"), "utf8");
  expect(() => extractBlock(gdgraph, "function runSymbol")).toThrow(/matches 2 places/);
  expect(flagsIn(extractBlock(gdgraph, "function runSymbol("))).toEqual(["--depth", "--impact"]);
});

test("AC2: search_code forwards every ripgrep option `keryx ctx rg` forwards", () => {
  const searchCode = METAPROJECT_OPERATIONS.find((op) => op.name === "search_code");
  expect(schemaProperties(searchCode?.inputSchema ?? {})).toContain("flags");

  const parity = searchCode?.cliParity;
  const declaredExceptions = new Set(
    parity !== undefined && parity.verb !== null ? (parity.passthrough?.except ?? []) : [],
  );
  // The implementation's rejection set and the declared exceptions must agree —
  // otherwise "declared" and "enforced" drift and the loop below checks neither.
  expect([...declaredExceptions].sort()).toEqual([...SEARCH_TOOL_REJECTED_OPTIONS].sort());

  const forwarded = forwardedRgOptions();
  expect(forwarded.length).toBeGreaterThan(30);
  expect(forwarded).toContain("-g");
  expect(forwarded).toContain("-t");
  expect(forwarded).toContain("-C");
  expect(forwarded).toContain("--max-depth");
  expect(forwarded).toContain("--hidden");

  // Every one of them is accepted by the tool's own validator…
  const seen: Array<{ pattern: string; flags?: string[] }> = [];
  const port = {
    async searchCode(input: { pattern: string; flags?: string[] }) {
      seen.push(input);
      return { pattern: input.pattern, output: "", isError: false };
    },
  } as unknown as MetaprojectPort;

  return (async () => {
    for (const option of forwarded) {
      const flags = RG_FORWARDED_VALUE_FLAGS.has(option) ? [option, "x"] : [option];
      const result = await searchCode?.invoke(port, { pattern: "needle", flags });
      // Compared against the CONTRACT, not against the implementation's own
      // rejection set. Reading the set the code uses meant the code could add to
      // it and the test would follow along agreeing — which is how a tool can
      // become materially weaker than its verb with the scanner silent.
      if (declaredExceptions.has(option)) {
        expect(result?.isError, `${option} is declared excepted, so flags must refuse it`).toBe(true);
        continue;
      }
      expect(result?.isError, `search_code must accept ${option}, which the verb forwards`).toBe(false);
    }
    // …and an option the verb refuses, the tool refuses too — parity runs both
    // ways, or the tool becomes a wider hole than the CLI it wraps.
    const refused = await searchCode?.invoke(port, { pattern: "needle", flags: ["--pre=/tmp/pwn.sh"] });
    expect(refused?.isError).toBe(true);
    expect(refused?.output ?? "").toContain("unsupported ripgrep option");

    // The regexp capability the rejected options carry is not lost — it is the
    // `pattern` field, which is where the tool can confine the operand.
    const viaPattern = await searchCode?.invoke(port, { pattern: "^needle$" });
    expect(viaPattern?.isError).toBe(false);
    expect(seen.at(-1)?.pattern).toBe("^needle$");
  })();
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
