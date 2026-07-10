# Context

Collected by `keryx flow init`, enriched by flow-orchestrator on 2026-07-10.

## Source of truth (requirements package)

- `docs/requirements/gdgraph-java-import-resolution/README.md` — purpose, scope.
- `docs/requirements/gdgraph-java-import-resolution/prd.md` — problem, root cause,
  requirements (F1–F7), success criteria, risks, recommendation.
- `docs/requirements/gdgraph-java-import-resolution/specification.md` — resolver
  design, config shape, data contracts, 7 acceptance criteria.
- `docs/requirements/gdgraph-java-import-resolution/metrics-and-validation.md` —
  the `0/0 = 100%` metric bug, baselines, validation plan.

## Impacted files (verified by direct read, 2026-07-10)

- `src/gdgraph/build.ts` (575 lines) — the file graph builder. Key seams:
  - `extractImportSpecifiers()` → tries `Bun.Transpiler` (tsx), falls back to
    `extractImportSpecifiersFallback()` (regex). `javaPatterns` and
    `pythonPatterns` already exist in the fallback; **Python relative pattern is
    missing** (regex requires leading `[a-zA-Z_]`, so `from . import x` and
    `from ..a import b` are dropped).
  - `resolveImport()` → `importCandidateBases()` → `resolver.candidateBases()`.
    Only a **tsconfig** resolver exists (`createTsconfigResolver` /
    `loadTsconfigResolver`). Non-relative specifier with no tsconfig ⇒ `[]` ⇒
    import silently dropped (never recorded `unresolved`).
  - `resolveSourceCandidate(base, fileSet)` — tries `base`, `base+ext`,
    `base/index+ext` over `SOURCE_RESOLUTION_EXTENSIONS` (already includes
    `.java`, `.py`). **No dot→slash for Java packages, no `__init__.py`.**
  - `resolveImport()`/`resolveAssetImport()` take a `TsconfigResolver` param —
    this is the type to generalize into `ImportResolver`.
  - Metric bug lives in `writeSummary()`:
    `importTotal = imports.length + unresolved.length`;
    `resolvedPercent = importTotal > 0 ? imports/importTotal*100 : 100`. The `:100`
    branch fires at `0/0`. Rendered as `- Import resolution: ${resolvedPercent}%`.
  - `getLanguage(file)` already returns `"typescript"|"javascript"|"java"|"python"`
    — use it to dispatch the resolver.
  - `edge.kind` union: `"imports" | "asset" | "unresolved"` (unchanged shape).
  - Note the `shouldTrackUnresolved` guard at build.ts:94 —
    `specifier.startsWith(".") || resolver.matchesAlias(specifier)`. Non-relative
    Java/Python imports must ALSO be trackable as unresolved (metric fix); adjust
    this guard so a language resolver's failed non-relative specifier is recorded.
- `src/gdgraph/config.ts` (163 lines) — `detectSupportedLanguages()` and
  `renderGdgraphConfig()` exist but are **never called** (dead code, confirmed by
  read). `DEFAULT_GDGRAPH_CONFIG.treesitter.languages` = ts/tsx/js only.
- `src/assets/seed.ts` (86 lines) — `GRAMMAR_ASSETS` has ts/tsx/js only. Add
  `tree-sitter-java` + `tree-sitter-python` entries (same jsDelivr
  `tree-sitter-wasms@0.1.13` source, pinned sha256/size). `mergeGrammarAssets()`
  is merge-safe and already adds any missing entry — just extend the map.
- Existing tests: `src/gdgraph/build.test.ts` (2 tests: asset resolution +
  tsconfig aliases — these encode the TS/JS behavior that must stay identical),
  `src/gdgraph/config.test.ts`, `src/gdgraph/fallback.test.ts` (predecessor
  Java/Python extraction on mock content), plus affected/find/path/repomap/
  service/symbol tests.

## Grammar asset pins (needed for seed.ts, F6/AC6)

Source: `tree-sitter-wasms@0.1.13` on jsDelivr, ABI 14 (matches existing entries).
The implementer must fetch the real files to compute pinned `sha256` + `size`:

```
https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out/tree-sitter-java.wasm
https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out/tree-sitter-python.wasm
```

Compute: `curl -sL <url> -o /tmp/g.wasm && shasum -a 256 /tmp/g.wasm && wc -c </tmp/g.wasm`.
Do NOT invent hashes — a wrong pin fails asset verification.

**Verified pins (fetched 2026-07-10, use these verbatim in seed.ts):**

```
tree-sitter-java   version 0.1.13
  url    https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out/tree-sitter-java.wasm
  sha256 637aac4415fb39a211a4f4292d63c66b5ce9c32fa2cd35464af4f681d91b9a1f
  size   430239
tree-sitter-python version 0.1.13
  url    https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out/tree-sitter-python.wasm
  sha256 9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b
  size   476105
```

## E2E target

`/path/to/example-backend` — Spring Boot,
3733 nodes / 0 edges baseline. Spot-check import:
`com.example.admin.dto.FixReplicaRequest` →
`src/main/java/com/example/admin/dto/FixReplicaRequest.java`.

## Invariants (must not break)

1. **Zero behavior change for TS/JS** — a TS/JS-only project graph must be
   byte-identical (`nodes.jsonl` + `edges.jsonl`). Dedicated regression test.
2. Resolver is **language-aware** (dispatch by file language). Do NOT touch the
   tsconfig/relative path for ts/js.
3. Metric: at zero extracted imports show **n/a**, never 100%; non-relative
   unresolved imports become `unresolved` edges, never dropped.

## Routing audit

graph_used: no (direct read of the 3 in-scope files — package pinpoints exact
symbols; gdgraph blast-radius not needed for a self-contained resolver change).
wiki_used: not-relevant (no domain/architecture concept beyond the package).
ctx_used: yes (compact reads). raw_rg_used: no.
