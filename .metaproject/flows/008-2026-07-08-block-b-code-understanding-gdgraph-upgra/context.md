# Context

Collected deterministically by `gd-metapro flow init` at 2026-07-08T00:23:45.112Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `gd-metapro gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-07-07T13:53:28.505Z)
- refresh: `gd-metapro health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security

## Agent Findings

### Authoritative source (read first)
- docs/requirements/roadmap-2026/B-code-understanding/{prd,specification,acceptance-criteria,tasks}.md — spec is the contract; AC1..AC5 are fixture-backed gates.

### Existing gdgraph module (extend, do NOT rewrite)
- `src/gdgraph/build.ts` (15.6K) — the file-level regex/scan build writing `storage/nodes.jsonl`, `storage/edges.jsonl`, `artifacts/module-map.json`, `artifacts/summary.md`. These four artifacts MUST stay byte-identical when tree-sitter is off.
- `src/gdgraph/query.ts` — `loadGraph(projectRoot)`, `getOrphans(graph)`, `getAffected(graph, file[, depth])`, `getCycles(graph)`. `getAffected` today has NO real depth traversal — B2 adds the N-hop closure; depth-1 must equal today's dependents set.
- `src/gdgraph/types.ts` — `GraphNode{id,kind:'file'|'asset',path,language}`, `GraphEdge{id,from,to,kind:'imports'|'asset'|'unresolved',specifier}`, `GraphData{nodes,edges}`. B1 ADDS `SymbolNode`/`CallEdge`/`SymbolLayer` — the file-level types stay untouched.
- `src/commands/gdgraph.ts` (3.3K) — CLI surface; add `--depth/--ranked/--json` to `affected` (default renderer unchanged) and a `repomap` subcommand.
- `src/gdgraph/build.test.ts` — the pre-existing suite; must pass unchanged.
- There is NO `src/gdctx/` dir and no shared token estimator — implement a small `chars/4` estimator locally for repomap (AC3 default estimator is `chars-div-4`).

### Block 0 seam to instantiate (landed on main; Block A also uses it)
- `src/capability/seam.ts` — `resolveCapability(cwd, spec) → Adapter|null`, `runCapabilityOrFallback`, `warnCapabilityDegraded`. The `gdgraph.treesitter` ceiling gates through this (never throws → null → regex fallback).
- `src/assets/{resolver,lock,pull}.ts` + `.metaproject/assets.lock.json` — grammar WASM assets resolve via `resolveAsset` (sha256 on every load; tampered/missing → unavailable → fallback). `web-tree-sitter` is ALREADY declared in `optionalDependencies` (Block 0). Register grammar asset ids in the lock.
- `src/capability/registry.ts` — `registerCapabilitiesFromArgs`/`reconcileCapabilitiesOnUpdate`; wire the `--treesitter` flag + `capabilities` manifest entry here (see how Block A wired `--mcp`).
- `src/harness/` — `runCorpus`/`gateCorpus`; the three B fixtures plug into this.
- Static guard `src/capability/no-optional-imports.test.ts` — EXTEND to cover `web-tree-sitter` (only `await import` in `treesitter/adapter.ts`).

### Hard invariants (the golden rule, B-1/C0-7/F-3)
- The four legacy file-level artifacts stay byte-for-byte identical when the capability is off/absent; symbol layer (`symbols.jsonl`/`calls.jsonl`) is ADDITIVE, only present when active.
- `web-tree-sitter` imported ONLY via `await import()` in `treesitter/adapter.ts`; `dependencies` stays `{}`.
- `affected --depth 1`/no-flag stdout byte-identical to today; `--ranked`/`--json` additive.
- No network on build/affected/repomap (no-network sandbox test); PageRank + closure are pure (no dep, no vectors).
- The 235 pre-existing tests unchanged.

### Baseline
- main @ 8dc9417; `bun run check` green (235 tests); Block 0 + Block A landed.
