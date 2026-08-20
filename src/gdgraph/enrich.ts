// Symbol-layer enrichment behind the capability seam (specification.md §7, §8.1;
// T-B13). Called by `build.ts` AFTER the unchanged file-level build. When
// `gdgraph.treesitter` resolves to an adapter it writes `storage/symbols.jsonl`
// and `storage/calls.jsonl` ADDITIVELY; when it degrades to `null` (default /
// dep or grammar missing) nothing is written and the four legacy artifacts stay
// byte-identical (the golden rule, B-1/C0-7/F-3).
//
// `build.ts` imports this module DYNAMICALLY inside a try/catch, so an
// environment that lacks the seam (e.g. the copied `.metaproject/core/gdgraph`
// runner) simply falls back to file-level output — the exact degraded behavior.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runCapabilityOrFallback,
  type CapabilityAdapter,
  type CapabilitySpec,
} from "../capability/seam";
import { loadGdgraphConfig } from "./config";
import {
  createTreesitterSpec,
  resolveTreesitterCapability,
  type BuildInput,
  type FileRecord,
} from "./treesitter/adapter";
import type { SymbolLayer } from "./types";

export interface EnrichResult {
  enriched: boolean;
  symbols: number;
  calls: number;
}

// Seam resolver, injectable for tests so the availability-true write path can be
// proven with a mock adapter (the real optional dep is not installed offline).
export type CapabilityResolver = (
  cwd: string,
  spec: CapabilitySpec<BuildInput, SymbolLayer>,
) => Promise<CapabilityAdapter<BuildInput, SymbolLayer> | null>;

export async function enrichBuildWithSymbols(
  cwd: string,
  files: FileRecord[],
  // `undefined` (the default) selects the T6 literal-import fast path via
  // `resolveTreesitterCapability`; tests pass an explicit `CapabilityResolver`
  // (e.g. a mock adapter, or the raw seam) to bypass it.
  resolve?: CapabilityResolver,
): Promise<EnrichResult> {
  const config = await loadGdgraphConfig(cwd);
  const treesitterConfig = {
    languages: config.treesitter.languages,
    grammarsPath: config.treesitter.grammarsPath,
  };

  // Gate 1 (manifest-enabled) + dep + grammar + isAvailable. `null` ⇒ degrade
  // with NO symbol files written; the seam emits the single warn-once on an
  // enabled-but-unavailable ceiling. The default resolver additionally tries a
  // literal `await import("web-tree-sitter")` fast path first (T6) so a
  // `bun build --compile` binary can genuinely parse instead of always
  // degrading — see `resolveTreesitterCapability`.
  //
  // `createTreesitterSpec` is only built here when an injected `resolve` is
  // supplied (tests): `resolveTreesitterCapability` builds its own equivalent
  // spec internally from `treesitterConfig`, so building one unconditionally
  // on the default path would be dead work on every real `gdgraph build` call.
  const adapter = resolve
    ? await resolve(cwd, createTreesitterSpec(cwd, treesitterConfig))
    : await resolveTreesitterCapability(cwd, treesitterConfig);
  if (!adapter) {
    return { enriched: false, symbols: 0, calls: 0 };
  }

  const layer = await runCapabilityOrFallback<BuildInput, SymbolLayer>(
    adapter,
    { files },
    () => ({ symbols: [], calls: [] }),
  );

  await writeSymbolLayer(cwd, layer);
  return { enriched: true, symbols: layer.symbols.length, calls: layer.calls.length };
}

async function writeSymbolLayer(cwd: string, layer: SymbolLayer): Promise<void> {
  const storageDir = path.join(cwd, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(storageDir, { recursive: true });
  await writeFile(
    path.join(storageDir, "symbols.jsonl"),
    layer.symbols.map((symbol) => JSON.stringify(symbol)).join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    path.join(storageDir, "calls.jsonl"),
    layer.calls.map((call) => JSON.stringify(call)).join("\n") + "\n",
    "utf8",
  );
}
