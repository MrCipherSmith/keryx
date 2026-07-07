# Specification: Block B — Code Understanding (`gdgraph` upgrades)

Version: 1.0.0
Module extended: `gdgraph`
Depends on: Block 0 — Capability Seam
Section order per `DOC-3`.

---

## 1. Purpose

Raise `gdgraph` from a **file-level** import graph to a **symbol-level**
code-understanding layer while keeping the deterministic, zero-dependency,
zero-network core as the default floor. Three additions:

- **B1** — an opt-in `web-tree-sitter` (WASM) parser emitting
  function/class/method **symbol nodes** and **import + CALL edges**, behind the
  Block 0 capability seam, with a **byte-identical regex fallback** as the default.
- **B2** — a pure **N-hop transitive `affected`** (BFS/DFS closure over dependents)
  with `--depth` and a ranked blast-radius.
- **B3** — a pure **personalized-PageRank** ranked, **token-budgeted** `repomap.md`.

This spec defines the new schema, the adapter contract, the algorithms, and — most
importantly — the **fallback contract** that guarantees today's artifacts stay
byte-identical when tree-sitter is absent (`B-1`, `C0-7`, `F-3`).

---

## 2. Module Identity

| Property | Value |
|----------|-------|
| Module key | `gdgraph` (existing; `.metaproject/metaproject.json → modules.gdgraph`) |
| New capability | `gdgraph.treesitter` (B1 only; B2/B3 need **no** capability) |
| New optional dep | `web-tree-sitter` — `optionalDependencies`, lazy-imported in the adapter (`C0-1`,`C0-2`) |
| New assets | tree-sitter WASM grammars (`tree-sitter-<lang>.wasm`) — XP3, via Block 0 Asset Resolver |
| Data root | `.metaproject/data/gdgraph/` (existing) |
| Determinism | all outputs deterministic + git-diffable (`B-5`, `XP4`) |
| Language | code + docs EN for this upgrade (`DOC-4` note: base gdgraph docs are RU; this 2026 package is EN — flagged as a concern) |

**Dependency direction (unchanged, `architecture.md` §1):** `cli → commands →
services → lib`. The tree-sitter adapter lives beside the service
(`src/gdgraph/treesitter/adapter.ts`) and is the **only** place that may
`await import("web-tree-sitter")`; the service imports the adapter *interface*,
never the dep (`C0-14`).

---

## 3. Structure

```
src/gdgraph/
  types.ts                 # (extended) file-level types UNCHANGED; symbol types ADDED
  build.ts                 # (extended) after file-level build, optionally enrich via adapter
  query.ts                 # (extended) getAffected gains transitive closure; loadGraph gains symbol layer
  pagerank.ts              # (new) pure personalized PageRank + edge weights
  repomap.ts               # (new) rank → token-budgeted repomap.md renderer
  affected.ts              # (new) pure N-hop BFS/DFS closure + ranking (or added into query.ts)
  treesitter/
    adapter.ts             # (new) CapabilityAdapter<BuildInput, SymbolLayer>; lazy web-tree-sitter import
    grammars.ts            # (new) grammar resolution via Block 0 resolveAsset
    extract.ts             # (new) tree-sitter query → SymbolNode[] + CallEdge[]
src/commands/gdgraph.ts    # (extended) --depth/--ranked/--json on affected; repomap; assets subcommand
fixtures/
  symbol-graph/            # B1 acceptance corpus (F-1)
  transitive-closure/      # B2 acceptance corpus (F-1)
  repomap/                 # B3 acceptance corpus (F-1)
```

**Additive-storage rule (core of the fallback contract):** the tree-sitter layer
writes to **new** files `storage/symbols.jsonl` and `storage/calls.jsonl`. The
legacy `storage/nodes.jsonl`, `storage/edges.jsonl`, `artifacts/module-map.json`,
and `artifacts/summary.md` are produced by the **unchanged** file-level code path
and therefore stay byte-identical whether or not the capability is active.

---

## 4. Manifest Entry (`.metaproject/metaproject.json`)

Extends the existing `modules.gdgraph` block. Adds `commands` and a `capabilities`
array (four-part opt-in, `C0-3`(b); read like `isSecurityEnabled`, `C0-9`):

```jsonc
"gdgraph": {
  "enabled": true,
  "core": ".metaproject/core/gdgraph",
  "data": ".metaproject/data/gdgraph",
  "manifest": ".metaproject/modules/gdgraph.md",
  "commands": ["build", "query", "affected", "repomap"],   // + repomap
  "capabilities": [
    { "name": "treesitter", "enabled": false }              // default OFF (ceiling)
  ],
  "hooks": { "...": "unchanged" }
}
```

- Missing `capabilities` / missing manifest ⇒ capability **off** ⇒ regex path
  (`C0-9`). B2/B3 are core and need no capability entry.

---

## 5. Config (`.metaproject/gdgraph.config.json`)

New optional file, deep-merged over defaults, malformed JSON ⇒ defaults
(`C0-8`, mirroring `mergeSecurityConfig`/`gdctx loadConfig`):

```jsonc
{
  "treesitter": {
    "grammarsPath": null,          // T1 user-provided dir of *.wasm (A-1); null ⇒ resolver tries cache/pull
    "languages": ["typescript", "tsx", "javascript"]  // bounded to project langs (NG-B3/B-8)
  },
  "affected": {
    "defaultDepth": 1              // MUST default 1 for back-compat (B-3)
  },
  "repomap": {
    "tokenBudget": 8000,           // hard cap; reused gdctx budget idiom (C0-8)
    "tokenEstimator": "chars-div-4",
    "maxSymbolsPerFile": 12,
    "damping": 0.85,               // PageRank damping (fixed ⇒ deterministic)
    "iterations": 50,              // fixed iteration count ⇒ deterministic convergence
    "tolerance": 1e-8
  }
}
```

**Defaults object** lives in `src/gdgraph/config.ts` (`DEFAULT_GDGRAPH_CONFIG`);
every field falls back individually (pattern: `DEFAULT_SECURITY_CONFIG` +
`DEFAULT_CONFIG` in `ctx.ts`).

---

## 6. CLI

| Command | New? | Behavior |
|---------|------|----------|
| `gd-metapro gdgraph build` | extended | File-level build unchanged & byte-identical; if `treesitter` capability active + grammars resolved, additionally emit `symbols.jsonl` + `calls.jsonl`. On capability-enabled-but-unavailable: one stderr warning, skip symbol layer, exit 0 (`C0-5`). |
| `gd-metapro gdgraph affected <file> [--depth N] [--ranked] [--json]` | extended | Default / `--depth 1` == today's stdout byte-for-byte (`B-3`). `--depth N` = transitive closure to N. `--ranked`/`--json` = additive blast-radius ranking. |
| `gd-metapro gdgraph repomap [--budget N] [--seed <path...>\|--changed]` | new | Personalized PageRank → token-budgeted `artifacts/repomap.md`. Deterministic; re-run diff empty. |
| `gd-metapro gdgraph assets pull\|list\|verify <id>` | new | Block 0 Asset Resolver surface for grammar WASM; sha256-verified against `assets.lock.json` (`A-2`). Only path allowed to touch the network (`A-6`). |
| `gd-metapro gdgraph query cycles\|orphans` | unchanged | — |

Arg parsing reuses `src/lib/args` (`optionValue`), matching `ctx.ts`. The local
`GD_METAPRO_GDGRAPH_LOCAL` delegation path in `commands/gdgraph.ts` is preserved.

---

## 7. Service Contract

The service facade (`createGdgraphService()` — introduced here as the canonical
in-process contract that Block A's MCP Tools will wrap, `architecture.md` §4.1)
exposes pure, transport-independent methods:

```ts
interface GdgraphService {
  build(cwd: string): Promise<BuildResult>;                 // extended
  affected(cwd: string, target: string, opts?: {            // B2
    depth?: number; ranked?: boolean;
  }): Promise<AffectedResult>;
  repomap(cwd: string, opts?: {                             // B3
    budget?: number; seed?: string[];
  }): Promise<{ path: string; entries: RepomapEntry[]; tokens: number }>;
  query(cwd: string, q: "cycles" | "orphans"): Promise<...>; // unchanged
}
```

- **Purity**: `affected` and `repomap` take the in-memory graph from `loadGraph`
  and perform no I/O beyond reading storage + writing their artifact. No dep, no
  network (`B-3`,`B-4`).
- **Adapter isolation**: `build` calls `resolveCapability(cwd, "gdgraph.treesitter")`;
  `null` ⇒ file-level only. Never throws out (`C0-11`): adapter/runtime error is
  caught → deterministic result.
- Each method is unit-testable independent of MCP (`T-1`).

---

## 8. Actions

### 8.1 B1 — Tree-sitter symbol graph

**Adapter contract** (implements Block 0 `CapabilityAdapter<In,Out>`):

```ts
// src/gdgraph/treesitter/adapter.ts
const treesitterAdapter: CapabilityAdapter<{ files: FileRecord[] }, SymbolLayer> = {
  name: "gdgraph.treesitter",
  async isAvailable() {
    // (1) web-tree-sitter importable AND (2) at least one grammar asset resolved+verified
    try { await import("web-tree-sitter"); } catch { return false; }
    return resolveAsset(cfg, "tree-sitter-<lang>") !== null;  // Block 0 resolver (A-3)
  },
  async run({ files }) { /* parse each file → SymbolNode[] + CallEdge[] */ },
};
```

**Extraction pipeline** (`extract.ts`):
1. For each source file, select the grammar for its language (`getLanguage` reused).
2. Parse to a tree-sitter tree; run a fixed, committed **query** per language to
   capture: `function_declaration`, `method_definition`, `class_declaration`
   (and arrow/const-assigned functions) → **symbol nodes**; `call_expression` /
   `new_expression` → **CALL edges**; import specifiers → **import edges** (these
   still also feed the file-level graph so `nodes/edges.jsonl` is unaffected).
3. Resolve a CALL target to a symbol id when the callee is import-resolvable or
   file-local; otherwise emit an `unresolved-call` edge (never dropped silently,
   mirrors today's `unresolved` handling).
4. Emit sorted, stable output (see Schema §9) so re-runs are byte-identical (`B-5`).

**Determinism guards:** files processed in sorted order; symbols sorted by
`(path, startLine, name)`; edges sorted by `(from, to, kind)`; ids are content-independent
positional (`<path>#<Container>.<name>` with a positional disambiguator suffix
`@<startLine>` only on name collision).

### 8.2 B2 — Transitive `affected`

Pure BFS over the **reverse-dependent** relation (an edge `from → to` means `from`
depends on `to`; `to`'s dependents are all `from`). Operates on file-level edges by
default, and — when the symbol layer is present — can be run at symbol granularity.

```
affected(graph, target, depth):
  frontier = { resolve(target) }; seen = {}; byHop = []
  for h in 1..depth:
    next = { e.from for e in edges where e.kind in {imports} and e.to in frontier } \ seen
    if next empty: break
    byHop[h] = sort(next); seen ∪= next; frontier = next
  dependents = sort(⋃ byHop)          # exact closure to `depth`
  dependencies = one-hop forward set  # unchanged from today
```

- **Back-compat (`B-3`):** `depth` defaults to `config.affected.defaultDepth`
  (=1). At depth 1 the dependents set equals today's `getAffected().dependents`,
  and the **stdout renderer is unchanged**, so output is byte-identical. `--depth`/
  `--ranked`/`--json` are the only new surface.
- **Termination:** `seen` set makes cycles safe (today's graph can contain cycles;
  see `getCycles`).
- **Ranking (`--ranked`):** each dependent carries `hop` (BFS distance) and
  `fanIn` (# inbound import edges); blast-radius order = `hop` asc, then `fanIn`
  desc, then `path` asc — a total, deterministic order.

### 8.3 B3 — Ranked, token-budgeted repo map

**Personalized PageRank** (`pagerank.ts`), pure:

```
nodes = graph nodes (file-level, or symbol nodes if layer present)
edges = weighted:  import edge w=1.0 ; CALL edge w=CALL_WEIGHT ; defines w=0.5
personalization p:  uniform, OR mass on --seed/--changed nodes
PR = personalizedPageRank(nodes, edges, damping, personalization,
                          iterations, tolerance)   # fixed params ⇒ deterministic
rank = sort nodes by (PR desc, path asc)           # total order, reproducible
```

**Rendering + token budget** (`repomap.ts`), reusing the gdctx budget idiom
(`ctx.ts` `CtxConfig`/`compactLines`):

```
budget = --budget ?? config.repomap.tokenBudget
out = header
for entry in rank:
   block = render(path, topSymbols(entry, maxSymbolsPerFile), signatures)
   if estimateTokens(out + block) > budget: append "… N entries omitted …"; break
   out += block
write .metaproject/data/gdgraph/artifacts/repomap.md (out)
```

- `estimateTokens` = documented estimator (default `chars-div-4`), the token
  analogue of gdctx's byte budget.
- **Determinism (`B-4`,`B-5`):** fixed damping/iterations/tolerance + total-order
  tie-break ⇒ re-run diff empty.

---

## 9. Schema (new node / edge / symbol schema)

**Unchanged (byte-identical) file-level types** (`types.ts`, verbatim from today):

```ts
type GraphNode = { id; kind: "file" | "asset"; path; language: "typescript"|"javascript"|"asset" };
type GraphEdge = { id; from; to; kind: "imports" | "asset" | "unresolved"; specifier };
```

**Added symbol types** (new, only materialized in `symbols.jsonl` / `calls.jsonl`):

```ts
type SymbolKind = "function" | "class" | "method" | "interface";

type SymbolNode = {
  id: string;            // "<path>#<Container>.<name>" (+ "@<startLine>" on collision)
  kind: SymbolKind;
  path: string;          // owning file (matches a file GraphNode.path)
  name: string;
  container: string | null;  // enclosing class/namespace, or null
  startLine: number;     // 1-based; positional, for stable disambiguation
  endLine: number;
  language: "typescript" | "javascript";
  signature?: string;    // rendered for repomap
};

type CallEdge = {
  id: string;
  from: string;          // SymbolNode.id of caller (or file path when caller unknown)
  to: string;            // SymbolNode.id of callee, or raw callee text when unresolved
  kind: "calls" | "defines" | "unresolved-call";  // "defines": file → symbol containment
  resolved: boolean;
};

type SymbolLayer = { symbols: SymbolNode[]; calls: CallEdge[] };
```

**Storage layout:**

| File | When | Ordering |
|------|------|----------|
| `storage/nodes.jsonl`, `storage/edges.jsonl` | always (unchanged) | as today |
| `storage/symbols.jsonl` | only if treesitter active | sort by `(path, startLine, name)` |
| `storage/calls.jsonl` | only if treesitter active | sort by `(from, to, kind)` |
| `artifacts/module-map.json`, `artifacts/summary.md` | always (unchanged) | as today |
| `artifacts/repomap.md` | only on `repomap` command | PageRank rank order |

`loadGraph` is extended to load the symbol layer **if present** (missing files ⇒
empty layer, never an error — mirrors `readJsonl` tolerance).

---

## 10. Integration

- **gdctx**: `repomap` reuses the budget-awareness idiom from `src/commands/ctx.ts`
  (config-driven cap + truncation marker). No code dependency is forced; the
  pattern is mirrored (`C0-8`).
- **Block 0**: B1 consumes `resolveCapability` + `resolveAsset` + `assets.lock.json`
  + `optionalDependencies` policy + the fixture-corpus harness — all defined once
  in Block 0; B does not redefine them.
- **Block A (MCP)**: `createGdgraphService().affected` and `.repomap` are the exact
  in-process methods Block A wraps as MCP Tools (`gdgraph.affected`) — no new logic
  in `mcp/` (`architecture.md` §4.1, `M-2`). This block only needs to expose the
  service facade; MCP wiring is Block A's job.
- **flow / health**: unaffected by this block.

---

## 11. Hooks

No new hooks. The existing `modules.gdgraph.hooks` (`gitPostCommit`,
`postUpdate`) already trigger `build`; because `build` stays byte-identical on the
default path, post-commit behavior is unchanged. Symbol-layer emission piggybacks
on the same `build` invocation only when the capability is active.

---

## 12. Standard Profile

- `repomap.md` is a generated artifact (like `summary.md`), safe to expose as a
  read-only MCP Resource under `data/gdgraph/artifacts` (Block A) and referenceable
  from `llms.txt`.
- Symbol/call storage is derived and reproducible; it is git-diffable JSONL,
  consistent with the module's existing storage convention.

---

## 13. Acceptance (summary; full list in `acceptance-criteria.md`)

- **AC1** symbol + CALL graph present and ≥ precision target when tree-sitter present.
- **AC2** transitive `affected` returns exact N-hop closure on the fixture; `--depth 1` byte-identical to today.
- **AC3** ranked `repomap.md` fits the token budget and matches expected centrality; re-run diff empty.
- **AC4** with tree-sitter absent, `build` output is byte-identical to today; no dep loaded, no socket opened; capability-enabled-but-missing warns once and exits 0.

---

## 14. Phases

1. **Phase B-0 (pure early wins, no capability):** B2 transitive `affected` + B3
   PageRank/repomap over the existing file-level graph. Ship independently of the
   grammar-asset path (`B-9`). Lands first.
2. **Phase B-1 (opt-in symbol layer):** tree-sitter adapter + grammar assets +
   symbol/call storage; B2/B3 automatically gain symbol granularity.
3. **Phase B-2 (ranking/UX polish):** `--ranked`/`--json` blast-radius,
   `--seed`/`--changed` personalization.

---

## 15. Open Questions

1. Exact **recall** floor for the symbol graph (precision floor is 0.9); propose ≥ 0.85 on `fixtures/symbol-graph/`.
2. `CALL_WEIGHT` value and whether CALL edges should be included in `repomap.md` bodies (budget impact) — default: weight 1.5, signatures-only bodies.
3. Directory naming reconciliation (`B-code-understanding/` vs `B-gdgraph/`).
4. Whether to also expose a `--json` symbol dump for external agents now or defer to Block A.
