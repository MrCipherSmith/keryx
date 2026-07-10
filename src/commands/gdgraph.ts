import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { optionValue } from "../lib/args";
import { runAssetsSubcommand } from "../assets/command";
import { buildGraph } from "../gdgraph/build";
import { getCycles, getOrphans, loadGraph } from "../gdgraph/query";
import { computeAffected, type AffectedResult } from "../gdgraph/affected";
import { findNodes, findSymbols } from "../gdgraph/find";
import { querySymbol, resolveSymbols, transitiveCallers } from "../gdgraph/symbol";
import { findPath, labelNode } from "../gdgraph/path";
import { graphMaybeStale, STALE_NOTE } from "../gdgraph/staleness";
import { isCapabilityEnabled } from "../capability/seam";
import { loadGdgraphConfig } from "../gdgraph/config";
import { writeRepomap } from "../gdgraph/repomap";

export async function gdgraphCommand(args: string[]): Promise<void> {
  if (process.env.KERYX_GDGRAPH_LOCAL !== "1") {
    const delegated = await delegateToLocalRunner(args);
    if (delegated) {
      return;
    }
  }

  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "build") {
    const result = await buildGraph(process.cwd());
    console.log(`gdgraph build complete: ${result.nodes} nodes, ${result.edges} edges`);
    console.log(`summary: ${result.summaryPath}`);
    const { recordProvenance } = await import("../sync/provenance");
    await recordProvenance(process.cwd(), "gdgraph", new Date().toISOString());
    return;
  }

  if (command === "query") {
    const query = args.slice(1).join(" ").trim();
    const graph = await loadGraph(process.cwd());

    if (query === "cycles") {
      const cycles = getCycles(graph);
      if (cycles.length === 0) {
        console.log("No cycles found.");
        return;
      }
      for (const cycle of cycles) {
        console.log(cycle.join(" -> "));
      }
      return;
    }

    if (query === "orphans") {
      const orphans = getOrphans(graph);
      if (orphans.length === 0) {
        console.log("No orphan modules found.");
        return;
      }
      for (const orphan of orphans) {
        console.log(orphan);
      }
      return;
    }

    console.error(`gdgraph query supports only: cycles, orphans (not "${query || "<empty>"}").`);
    console.error("gdgraph query does not do semantic/natural-language search. Instead:");
    console.error(`  find files by concept:   keryx gdgraph find "${query}"`);
    console.error('  search file contents:    keryx ctx rg "<pattern>"');
    console.error("  then map relationships:  keryx gdgraph affected <file>");
    process.exitCode = 1;
    return;
  }

  if (command === "find") {
    await runFind(args.slice(1));
    return;
  }

  if (command === "symbol") {
    await runSymbol(args.slice(1));
    return;
  }

  if (command === "symbols") {
    await runSymbolsCapability(args.slice(1));
    return;
  }

  if (command === "path") {
    await runPath(args.slice(1));
    return;
  }

  if (command === "affected") {
    await runAffected(args.slice(1));
    return;
  }

  if (command === "repomap") {
    await runRepomap(args.slice(1));
    return;
  }

  if (command === "context") {
    const { graphContext } = await import("../ctx/orient");
    console.log(await graphContext(process.cwd()));
    return;
  }

  if (command === "assets") {
    const result = await runAssetsSubcommand(process.cwd(), "gdgraph", args.slice(1));
    for (const line of result.lines) {
      if (result.exitCode === 0) {
        console.log(line);
      } else {
        console.error(line);
      }
    }
    process.exitCode = result.exitCode;
    return;
  }

  console.error(`Unknown gdgraph command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function runPath(rest: string[]): Promise<void> {
  const positional = rest.filter((a) => !a.startsWith("--"));
  const from = positional[0];
  const to = positional[1];
  if (!from || !to) {
    console.error('Usage: keryx gdgraph path "<A>" "<B>"   (A/B: file path or symbol name)');
    process.exitCode = 1;
    return;
  }

  const graph = await loadGraph(process.cwd());
  const result = findPath(graph, from, to);
  const symbolsById = new Map((graph.symbols ?? []).map((s) => [s.id, s]));

  console.log(`# gdgraph path: ${from} -> ${to}`);
  console.log("");
  if (result.fromResolved.length === 0) {
    console.log(`Could not resolve "${from}" to a file or symbol. Try \`keryx gdgraph find\`.`);
    return;
  }
  if (result.toResolved.length === 0) {
    console.log(`Could not resolve "${to}" to a file or symbol. Try \`keryx gdgraph find\`.`);
    return;
  }
  if (result.nodes.length === 0) {
    console.log("No path found in the graph (they may be in disconnected components).");
    if (!graph.symbols || graph.symbols.length === 0) {
      console.log("Note: symbol layer inactive — only file imports are linked. `keryx gdgraph symbols enable`.");
    }
    return;
  }

  console.log(`${result.nodes.length} node(s), ${result.nodes.length - 1} hop(s):`);
  result.nodes.forEach((node, i) => {
    console.log(`${i === 0 ? "- " : "  ↓ "}${labelNode(node, symbolsById)}`);
  });
  await printStaleNote();
}

async function runSymbolsCapability(rest: string[]): Promise<void> {
  const action = rest[0] ?? "status";
  const cwd = process.cwd();
  const manifestPath = path.join(cwd, ".metaproject", "metaproject.json");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { setTreesitterEnabled, isTreesitterEnabled } = await import("../gdgraph/symbols-capability");

  if (!existsSync(manifestPath)) {
    console.error("No .metaproject/metaproject.json found (run `keryx init` first).");
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;

  if (action === "enable" || action === "disable") {
    const next = setTreesitterEnabled(manifest, action === "enable");
    await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`# gdgraph symbols ${action}d`);
    console.log("");
    if (action === "enable") {
      console.log("Next:");
      console.log("  1. keryx gdgraph assets pull tree-sitter-typescript tree-sitter-tsx tree-sitter-javascript");
      console.log("  2. keryx gdgraph build        # writes symbols.jsonl / calls.jsonl");
      console.log("  3. keryx gdgraph symbol \"<name>\"");
      console.log("");
      console.log("Requires the `web-tree-sitter` dependency; degrades to file-level if absent.");
    }
    return;
  }

  // status
  const enabled = isTreesitterEnabled(manifest);
  const graph = await loadGraph(cwd);
  console.log("# gdgraph symbols");
  console.log("");
  console.log(`capability: ${enabled ? "enabled" : "disabled"}`);
  console.log(`symbols: ${graph.symbols?.length ?? 0}`);
  console.log(`calls: ${graph.calls?.length ?? 0}`);
  if (enabled && (graph.symbols?.length ?? 0) === 0) {
    console.log("");
    console.log("Enabled but no symbols — run `keryx gdgraph build` (and pull grammars if missing).");
  }
}

async function runSymbol(rest: string[]): Promise<void> {
  const name = rest.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!name) {
    console.error('Usage: keryx gdgraph symbol "<name>"');
    process.exitCode = 1;
    return;
  }

  const graph = await loadGraph(process.cwd());
  if (!graph.symbols || graph.symbols.length === 0) {
    console.log("# gdgraph symbol");
    console.log("");
    console.log("Symbol layer not active (no symbols.jsonl).");
    console.log("Enable it:  keryx gdgraph symbols enable   then   keryx gdgraph build");
    console.log(`Meanwhile:  keryx gdgraph find "${name}"  ·  keryx ctx rg "${name}"`);
    return;
  }

  const matches = resolveSymbols(graph.symbols, name);
  if (matches.length === 0) {
    console.log(`# gdgraph symbol: ${name}`);
    console.log("");
    console.log("No matching symbol. Try `keryx gdgraph find` or `keryx ctx rg`.");
    return;
  }

  // Ambiguity guard: a loose query (e.g. "clone") matches several DIFFERENT
  // names, and unioning their callers/callees/impact is noise. List the matches
  // and ask for an exact name. Same-name overloads (one name, N defs) proceed.
  const distinctNames = [...new Set(matches.map((m) => m.name))];
  if (distinctNames.length > 1) {
    console.log(`# gdgraph symbol: ${name}`);
    console.log("");
    console.log(`"${name}" matches ${matches.length} symbols across ${distinctNames.length} names — pick an exact one:`);
    for (const m of matches.slice(0, 25)) {
      console.log(`- ${m.name} (${m.kind}) — ${m.path}:${m.startLine}`);
    }
    if (matches.length > 25) console.log(`- … +${matches.length - 25} more`);
    return;
  }

  const result = querySymbol(graph, name);

  console.log(`# gdgraph symbol: ${name}`);
  console.log("");
  console.log(`## Definitions (${result.definitions.length})`);
  for (const def of result.definitions) {
    const container = def.container ? ` in ${def.container}` : "";
    console.log(`- ${def.name} (${def.kind})${container} — ${def.path}:${def.startLine}`);
    if (def.signature) {
      console.log(`  ${def.signature}`);
    }
  }
  console.log("");
  console.log(`## Callers (${result.callers.length})`);
  printRefs(result.callers);
  console.log("");
  console.log(`## Callees (${result.callees.length})`);
  printRefs(result.callees);

  if (rest.includes("--impact")) {
    const depthArg = optionValue(rest, "--depth");
    const depth = depthArg !== undefined && Number.isFinite(Number.parseInt(depthArg, 10))
      ? Number.parseInt(depthArg, 10)
      : 3;
    const impact = transitiveCallers(graph, result.definitions.map((d) => d.id), depth);
    console.log("");
    console.log(`## Impact — transitive callers, depth ${depth} (${impact.length})`);
    if (impact.length === 0) {
      console.log("- none");
    }
    for (const node of impact.slice(0, 60)) {
      console.log(`- [hop ${node.hop}] ${node.label}`);
    }
    if (impact.length > 60) {
      console.log(`- … +${impact.length - 60} more`);
    }
  }
  await printDocumentedIn([...new Set(result.definitions.map((d) => d.path))]);
  await printStaleNote();
}

// code -> knowledge: wiki pages that document the given file(s). Best-effort and
// lazy so gdgraph never hard-depends on the wiki; silent when the wiki is empty.
async function printDocumentedIn(files: string[]): Promise<void> {
  try {
    const { wikiPagesForFile } = await import("../wiki/service");
    const cwd = process.cwd();
    const pages = new Set<string>();
    for (const file of files) {
      for (const page of await wikiPagesForFile(cwd, file)) pages.add(page);
    }
    if (pages.size === 0) return;
    console.log("");
    console.log(`## Documented in (wiki, ${pages.size})`);
    for (const page of [...pages].sort()) console.log(`- ${page}`);
  } catch {
    // wiki unavailable ⇒ skip silently.
  }
}

async function printStaleNote(): Promise<void> {
  if (await graphMaybeStale(process.cwd())) {
    console.log("");
    console.log(STALE_NOTE);
  }
}

function printRefs(refs: Array<{ label: string; resolved: boolean }>): void {
  if (refs.length === 0) {
    console.log("- none");
    return;
  }
  for (const ref of refs.slice(0, 40)) {
    console.log(`- ${ref.label}${ref.resolved ? "" : "  (unresolved)"}`);
  }
  if (refs.length > 40) {
    console.log(`- … +${refs.length - 40} more`);
  }
}

async function runFind(rest: string[]): Promise<void> {
  const query = positionals(rest).join(" ").trim() || rest.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!query) {
    console.error('Usage: keryx gdgraph find "<terms>"');
    process.exitCode = 1;
    return;
  }

  const graph = await loadGraph(process.cwd());
  const symbols = findSymbols(graph, query);
  const results = findNodes(graph, query);

  if (results.length === 0 && symbols.length === 0) {
    console.log(`# gdgraph find: ${query}`);
    console.log("");
    console.log("No files or symbols matched. For content search use:");
    console.log(`  keryx ctx rg "<pattern>"`);
    return;
  }

  console.log(`# gdgraph find: ${query}`);
  console.log("");

  if (symbols.length > 0) {
    console.log(`## Symbols (${symbols.length})`);
    for (const symbol of symbols) {
      console.log(`- ${symbol.name} (${symbol.kind}) — ${symbol.path}:${symbol.startLine}`);
    }
    console.log("");
  }

  console.log(`## Files (${results.length})`);
  if (results.length === 0) {
    console.log("- none");
  }
  for (const result of results) {
    console.log(`- ${result.path}  (score ${result.score}, dependents ${result.dependents})`);
  }
  console.log("");
  console.log('Next: keryx gdgraph symbol "<name>" · keryx gdgraph affected <file>');
  await printStaleNote();
}

async function runAffected(rest: string[]): Promise<void> {
  let target = positionals(rest)[0];
  if (!target) {
    console.error("Usage: keryx gdgraph affected <file-or-symbol> [--depth N] [--ranked] [--json]");
    process.exitCode = 1;
    return;
  }

  const ranked = rest.includes("--ranked");
  const asJson = rest.includes("--json");
  const config = await loadGdgraphConfig(process.cwd());
  const depthArg = optionValue(rest, "--depth");
  const depth = depthArg !== undefined ? Number.parseInt(depthArg, 10) : config.affected.defaultDepth;

  const graph = await loadGraph(process.cwd());

  // Symbol-aware: if the target isn't a known file but names a symbol, resolve
  // it to its owning file so `affected "clonePipeline"` just works.
  const isFile = graph.nodes.some((n) => n.kind === "file" && n.path === target);
  let resolutionNote = "";
  if (!isFile && graph.symbols && graph.symbols.length > 0) {
    const hits = resolveSymbols(graph.symbols, target, 5);
    const files = [...new Set(hits.map((s) => s.path))];
    if (files.length > 0) {
      resolutionNote = `resolved symbol "${target}" → ${files[0]}${files.length > 1 ? ` (+${files.length - 1} more file)` : ""}`;
      target = files[0]!;
    }
  }

  const affected = computeAffected(graph, target, {
    depth: Number.isFinite(depth) ? depth : config.affected.defaultDepth,
    ranked: ranked || asJson,
  });

  if (resolutionNote && !asJson) {
    console.log(`# ${resolutionNote}`);
    console.log("");
  }

  if (asJson) {
    console.log(JSON.stringify(affected, null, 2));
    return;
  }

  // Default / --depth 1 output is byte-for-byte identical to the pre-block
  // renderer (Dependencies + Dependents sections, sorted). `--ranked` is
  // strictly additive below.
  console.log(`# Affected context for ${affected.target}`);
  console.log("");
  console.log("## Dependencies");
  printList(affected.dependencies);
  console.log("");
  console.log("## Dependents");
  printList(affected.dependents);

  if (ranked) {
    console.log("");
    console.log("## Blast Radius (ranked)");
    if (affected.ranked.length === 0) {
      console.log("- none");
    } else {
      for (const entry of affected.ranked) {
        console.log(`- ${entry.path} (hop ${entry.hop}, fanIn ${entry.fanIn})`);
      }
    }
  }
}

async function runRepomap(rest: string[]): Promise<void> {
  const budgetArg = optionValue(rest, "--budget");
  const budget = budgetArg !== undefined ? Number.parseInt(budgetArg, 10) : undefined;
  const seed = collectSeeds(rest);
  if (rest.includes("--changed")) {
    seed.push(...(await changedFiles()));
  }

  const config = await loadGdgraphConfig(process.cwd());
  const graph = await loadGraph(process.cwd());
  const result = await writeRepomap(process.cwd(), graph, config, {
    ...(budget !== undefined && Number.isFinite(budget) ? { budget } : {}),
    ...(seed.length > 0 ? { seed } : {}),
  });

  console.log(`gdgraph repomap complete: ${result.entries.length} entries, ~${result.tokens} tokens`);
  if (result.omitted > 0) {
    console.log(`omitted (over budget): ${result.omitted}`);
  }
  console.log(`repomap: ${result.path}`);
}

// Collect free positional arguments, skipping flags + their consumed values.
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--depth" || arg === "--budget") {
      i += 1;
      continue;
    }
    if (arg === "--seed") {
      while (i + 1 < args.length && !args[i + 1]?.startsWith("--")) {
        i += 1;
      }
      continue;
    }
    if (arg?.startsWith("--")) {
      continue;
    }
    if (arg) {
      out.push(arg);
    }
  }
  return out;
}

function collectSeeds(args: string[]): string[] {
  const seeds: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--seed") {
      while (i + 1 < args.length && !args[i + 1]?.startsWith("--")) {
        i += 1;
        const value = args[i];
        if (value) {
          seeds.push(value);
        }
      }
    }
  }
  return seeds;
}

// Best-effort changed-file discovery for `--changed` personalization. Local git
// only; failure ⇒ no seeds (never blocks, never networks).
async function changedFiles(): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      const child = spawn("git", ["diff", "--name-only", "HEAD"], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => resolve([]));
      child.on("close", () => {
        resolve(out.split("\n").map((line) => line.trim()).filter(Boolean));
      });
    } catch {
      resolve([]);
    }
  });
}

async function delegateToLocalRunner(args: string[]): Promise<boolean> {
  const localRunner = path.join(
    process.cwd(),
    ".metaproject",
    "core",
    "gdgraph",
    "cli.ts",
  );

  if (!existsSync(localRunner)) {
    return false;
  }

  // New surfaces (repomap/assets) + affected flags are only implemented in this
  // package runner, not the copied core cli.ts. Delegate legacy commands only.
  const command = args[0];
  // The copied local runner lacks the capability seam, so it can only produce the
  // file-level graph. When `gdgraph.treesitter` is enabled, keep `build` in the
  // package process so `enrichBuildWithSymbols` runs and writes the symbol layer.
  const treesitterOn =
    command === "build" && (await isCapabilityEnabled(process.cwd(), "gdgraph.treesitter"));
  // Only delegate query for the two verbs the local runner actually implements;
  // an unsupported query must reach the package handler so it can redirect to
  // `find` / `ctx rg` / `affected`. `affected` is package-only now so it can be
  // symbol-aware (the package default output stays legacy-identical). `find` /
  // `symbol` / `path` are package-only.
  const delegatable = (command === "build" && !treesitterOn)
    || (command === "query" && (args[1] === "cycles" || args[1] === "orphans"));
  if (!delegatable) {
    return false;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [localRunner, ...args], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        KERYX_GDGRAPH_LOCAL: "1",
      },
    });

    child.on("error", reject);
    child.on("close", (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });

  return true;
}

function printHelp(): void {
  console.log(`keryx gdgraph

Usage:
  keryx gdgraph build
  keryx gdgraph query cycles
  keryx gdgraph query orphans
  keryx gdgraph find "<terms>"
  keryx gdgraph symbol "<name>"
  keryx gdgraph symbols <enable|disable|status>
  keryx gdgraph path "<A>" "<B>"
  keryx gdgraph affected <file-or-symbol> [--depth N] [--ranked] [--json]
  keryx gdgraph repomap [--budget N] [--seed <path>...] [--changed]
  keryx gdgraph context
  keryx gdgraph assets list | verify [<id>] | pull <id>
`);
}

function printList(items: string[]): void {
  if (items.length === 0) {
    console.log("- none");
    return;
  }

  for (const item of items) {
    console.log(`- ${item}`);
  }
}

export type { AffectedResult };
